// SPDX-License-Identifier: MIT
// System emulation: qemu-system-<arch> boots Linux 6.12 with vm/guest/init.c as
// PID 1, which runs the program and reports how it ended.
//
// The guest's channels are character devices in emscripten's FS, which QEMU
// opens as `-chardev file`; every read and write QEMU makes on them is a call
// proxied to this thread (emscripten's main runtime thread):
//   /dev/yk-in    -> hvc0 input   the program's stdin
//   /dev/yk-out   <- hvc0         stdout
//   /dev/yk-err   <- hvc1         stderr
//   /dev/yk-trace <- hvc2         strace's output (-o /dev/hvc2)
//   /dev/yk-ctl   <- hvc3         init: "exec <uptime>", then "exit N" or "signal N"
//   /dev/yk-con   <- serial port  the kernel's console ('kernel' messages)
// QEMU polls /dev/yk-in; emscripten 6's poll() waits on the device node's
// listeners, so input from the app wakes it without spinning.

import { concat, runArchive } from './cpio.js';
import { signalMessage, vmFailureMessage } from './run-linux.js';
import { pumpStdin } from './stdin.js';

/**
 * Per architecture: the board, the kernel console, the firmware loaded from
 * -L, and extra kernel parameters.
 * - x86_64: microvm with qboot, booting the uncompressed vmlinux at its PVH
 *   entry (no real-mode setup or decompressor under emulation). The default
 *   CPU model (qemu64): with `-cpu max` qemu-wasm's Wasm TCG backend traps on
 *   the first translation block. Its TSC counts nanoseconds, but microvm
 *   without ACPI has no HPET or PM timer to calibrate it against, so the
 *   kernel would fall back to jiffies (4 ms clock steps); tsc_early_khz says
 *   the rate. reboot=t: a triple fault is the fastest way out.
 * - aarch64: virt with a Cortex-A72 (the default cortex-a15 is 32-bit only).
 * - riscv64: virt with OpenSBI as M-mode firmware.
 */
export const MACHINES = {
    x86_64: { machine: ['-M', 'microvm,acpi=off,x-option-roms=off'], console: 'ttyS0', firmware: ['qboot.rom'], append: ' reboot=t tsc_early_khz=1000000 tsc=reliable' },
    aarch64: { machine: ['-M', 'virt', '-cpu', 'cortex-a72'], console: 'ttyAMA0', firmware: [], append: '' },
    riscv64: { machine: ['-M', 'virt'], console: 'ttyS0', firmware: ['opensbi-riscv64-generic-fw_dynamic.bin'], append: '' },
};

/** Guest RAM in MiB. At most 256 (plan §8); QEMU allocates and zeroes it at start. */
export const GUEST_RAM_MB = 256;
/** QEMU's translation cache in MiB: every guest block compiled to Wasm lives here. */
const TB_CACHE_MB = 64;

/**
 * The QEMU command line for one run (without the program: that is in the initrd).
 * @param {string} arch
 * @param {number} cpus
 * @returns {string[]}
 */
export function qemuArgs(arch, cpus) {
    const m = MACHINES[arch];
    return [
        ...m.machine, '-m', `${GUEST_RAM_MB}M`, '-smp', String(cpus),
        // thread=multi even for one vCPU: qemu-wasm sets up its Wasm JIT per vCPU
        // thread (init_wasm32_js), which the single-threaded round-robin loop does not.
        '-accel', `tcg,thread=multi,tb-size=${TB_CACHE_MB}`,
        '-nodefaults', '-no-user-config', '-display', 'none', '-no-reboot', '-L', '/pack',
        '-kernel', '/pack/kernel', '-initrd', '/pack/initrd',
        '-append', `console=${m.console} quiet panic=-1 rdinit=/init${m.append}`,
        '-chardev', 'file,id=con,path=/dev/yk-con', '-serial', 'chardev:con',
        '-device', 'virtio-serial-device,max_ports=4',
        '-chardev', 'file,id=io,path=/dev/yk-out,input-path=/dev/yk-in', '-device', 'virtconsole,chardev=io',
        '-chardev', 'file,id=err,path=/dev/yk-err', '-device', 'virtconsole,chardev=err',
        '-chardev', 'file,id=trace,path=/dev/yk-trace', '-device', 'virtconsole,chardev=trace',
        '-chardev', 'file,id=ctl,path=/dev/yk-ctl', '-device', 'virtconsole,chardev=ctl',
    ];
}

/**
 * A byte queue QEMU reads through /dev/yk-in. Bytes pushed before open()
 * (input typed ahead while the VM boots) are held back: until init has set
 * the console to no-echo, the guest's tty would echo them. open() releases
 * them; every push() after it wakes a poll() on the device.
 */
function inputQueue() {
    return {
        bytes: new Uint8Array(0),
        notify: null,
        isOpen: false,
        last: 10,
        ready() {
            return this.isOpen ? this.bytes.length : 0;
        },
        push(b) {
            if (b.length === 0) return;
            this.bytes = concat([this.bytes, b]);
            this.last = b[b.length - 1];
            if (this.isOpen) this.notify?.();
        },
        /** End of file: ^D (VEOF) in canonical mode, twice after a partial line (the first only ends it). */
        eof() {
            this.push(this.last === 10 ? new Uint8Array([4]) : new Uint8Array([4, 4]));
            this.last = 10;
        },
        open() {
            this.isOpen = true;
            if (this.bytes.length) this.notify?.();
        },
    };
}

/**
 * Registers a character device at `path` in emscripten's FS: `onWrite(bytes)`
 * receives what QEMU writes; `input`, if given, is the inputQueue() QEMU reads.
 */
function device(FS, path, minor, onWrite, input = null) {
    const dev = FS.makedev(64, minor);
    FS.registerDevice(dev, {
        open() {},
        close() {},
        read(stream, buffer, offset, length) {
            if (!input || input.ready() === 0) throw new FS.ErrnoError(6 /* EAGAIN */);
            const n = Math.min(length, input.bytes.length);
            buffer.set(input.bytes.subarray(0, n), offset);
            input.bytes = input.bytes.subarray(n);
            return n;
        },
        write(stream, buffer, offset, length) {
            if (length) onWrite(buffer.slice(offset, offset + length));
            return length;
        },
        poll() {
            return input && input.ready() ? 1 /* POLLIN */ : 4 /* POLLOUT */;
        },
    });
    FS.mkdev(path, 0o666, dev);
    if (input) {
        const node = FS.lookupPath(path).node;
        input.notify = () => node.notifyListeners?.(1 /* POLLIN */);
    }
}

/** A streaming UTF-8 decoder, so a character split across writes stays whole. */
const decoder = () => {
    const d = new TextDecoder();
    return (b) => d.decode(b, { stream: true });
};

/**
 * Boots the VM for `ctx.arch` and runs `ctx.program` in it; resolves to the
 * exit code as runLinux documents it. Rejects only if the VM's files cannot
 * be loaded.
 * @param {import('./run-linux.js').RunContext} ctx
 * @returns {Promise<number>}
 */
export async function runSystem(ctx) {
    const { arch, post, mark, options } = ctx;
    const m = MACHINES[arch];
    const dir = `vm/${arch}/`;
    const qemu = `qemu-system-${arch}`;
    post({ type: 'phase', text: `Starting Linux (${arch})` });

    const wants = ['kernel', 'initrd', ...m.firmware, ...(options.strace ? ['strace.cpio'] : [])];
    const glueUrl = new URL(dir + qemu + '.mjs', ctx.base).href;
    // The Wasm module compiles while the kernel downloads; compileStreaming lets
    // the browser cache the compiled code for the next run.
    const wasmModule = ctx.fetchResponse(dir + qemu + '.wasm').then((r) => WebAssembly.compileStreaming(r));
    const [qemuInit, module, ...files] = await Promise.all([
        import(/* @vite-ignore */ glueUrl).then((x) => x.default),
        wasmModule,
        ...wants.map((w) => ctx.fetchBytes(dir + w)),
    ]);
    const blob = Object.fromEntries(wants.map((w, i) => [w, files[i]]));
    // The base initramfs (init), strace's when tracing, then this run's program:
    // the kernel unpacks them in order.
    const initrd = concat([blob.initrd, ...(options.strace ? [blob['strace.cpio']] : []),
        runArchive(ctx.program, ctx.argv, ctx.env, options.strace ? [] : null, ctx.files)]);
    mark('vm-loaded');

    return new Promise((resolve) => {
        const stdin = inputQueue();
        const out = decoder(), err = decoder(), trc = decoder(), con = decoder();
        let ctlText = '';
        let started = false, firstOut = false, finished = false, stopStdin = () => {};
        const finish = (code, why) => {
            if (finished) return;
            finished = true;
            stopStdin();
            if (why) post({ type: 'stderr', text: `\n${vmFailureMessage(started, why)}\n` });
            mark('exit');
            resolve(code);
        };
        // The program is running once init says "exec", or once any of its output
        // arrives: the console ports are separate virtqueues, so a short program's
        // first stdout can reach this thread before the "exec" line does (seen on
        // riscv64). Whichever comes first starts the "Running" phase and stdin.
        const begin = () => {
            if (started) return;
            started = true;
            post({ type: 'phase', text: 'Running' });
            stdin.open();
        };
        // init drains the program's channels before it writes "exit"/"signal", and each
        // channel write is a synchronous call into this thread, so all output is in.
        const onCtl = (b) => {
            ctlText += new TextDecoder().decode(b);
            let nl;
            while ((nl = ctlText.indexOf('\n')) >= 0) {
                const [kind, value] = ctlText.slice(0, nl).split(' ');
                ctlText = ctlText.slice(nl + 1);
                if (kind === 'exec') {
                    // ms is when the line arrived here; guestMs (the guest's uptime when
                    // init ran the program) is the boot time.
                    mark('exec', { guestMs: Math.round(Number(value) * 1000) });
                    begin();
                } else if (kind === 'exit') {
                    finish(Number(value) & 255);
                } else if (kind === 'signal') {
                    post({ type: 'stderr', text: `\n${signalMessage(Number(value))}\n` });
                    finish(128 + Number(value));
                }
            }
        };
        let conTail = '';
        const onConsole = (b) => {
            const text = con(b);
            post({ type: 'kernel', text });
            conTail = (conTail + text).slice(-300);
            // A guest that reboots or panics without init's result (init failed, the
            // kernel died): give the console a moment to finish, then report it.
            if (/reboot: Restarting system|Kernel panic/.test(conTail)) {
                const why = /Kernel panic/.test(conTail) ? 'kernel panic' : 'the guest rebooted';
                setTimeout(() => finish(1, why), 500);
            }
        };
        const Module = {
            arguments: qemuArgs(arch, options.cpus),
            locateFile: (p) => new URL(dir + p, ctx.base).href,
            mainScriptUrlOrBlob: glueUrl,
            instantiateWasm(imports, receive) {
                WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module),
                    (e) => finish(1, `QEMU did not load: ${e?.message ?? e}`));
                return {};
            },
            print: (t) => post({ type: 'kernel', text: `[qemu] ${t}\n` }),
            printErr: (t) => post({ type: 'kernel', text: `[qemu] ${t}\n` }),
            // QEMU is linked with -sEXIT_RUNTIME=1, so an exit() of its own (a bad
            // option, a missing file) arrives here rather than leaving the run hanging.
            onExit: (status) => finish(1, `QEMU exited with status ${status}`),
            onAbort: (reason) => finish(1, `QEMU aborted: ${reason}`),
            preRun: [(mod) => {
                const { FS } = mod;
                FS.mkdir('/pack');
                FS.writeFile('/pack/kernel', blob.kernel);
                FS.writeFile('/pack/initrd', initrd);
                for (const f of m.firmware) FS.writeFile(`/pack/${f}`, blob[f]);
                device(FS, '/dev/yk-in', 0, () => {}, stdin);
                device(FS, '/dev/yk-out', 1, (b) => {
                    begin();
                    if (!firstOut) {
                        firstOut = true;
                        mark('first-stdout');
                    }
                    post({ type: 'stdout', text: out(b) });
                });
                device(FS, '/dev/yk-err', 2, (b) => {
                    begin();
                    post({ type: 'stderr', text: err(b) });
                });
                device(FS, '/dev/yk-trace', 3, (b) => post({ type: 'trace', text: trc(b) }));
                device(FS, '/dev/yk-ctl', 4, onCtl);
                device(FS, '/dev/yk-con', 5, onConsole);
            }],
        };
        stopStdin = pumpStdin(ctx.stdin, post, (bytes) => stdin.push(bytes), () => stdin.eof());
        qemuInit(Module).catch((e) => finish(1, `QEMU failed: ${e?.message ?? e}`));
    });
}
