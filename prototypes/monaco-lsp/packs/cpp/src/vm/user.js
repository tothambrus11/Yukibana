// SPDX-License-Identifier: MIT
// User emulation (experimental): qemu-<arch> (linux-user) runs the program and
// translates its system calls onto Emscripten's libc; there is no kernel.
// vm/README.md lists what that cannot do (a null dereference reads 0, one CPU,
// no fork, ...), next to the system emulation that can.
//
// The program's descriptors in Emscripten's FS:
//   fd 0  /dev/tty: a terminal for isatty() and ioctl(); read() and readv() go to
//         wasm-host.c's stdin ring instead (below), which this thread fills
//   fd 1  /dev/tty, re-registered here: output in the chunks the program writes
//   fd 2  /dev/tty1, likewise, for stderr (and QEMU's own messages)
// Reads of fd 0 cannot be served on this thread: it would have to block, and it
// serves every proxied file system call. So the guest thread that reads waits on
// a futex in linear memory, and this thread writes the input there.

import { signalMessage, vmFailureMessage } from './run-linux.js';
import { pumpStdin } from './stdin.js';

// Offsets in wasm-host.c's struct wasm_host_stdin (checked there at build time).
const SEQ = 0, HEAD = 4, TAIL = 8, EOF_WRITTEN = 12, EOF_READ = 16, ENABLED = 20, EXIT_SIGNAL = 24, SIZE = 28, EOF_AT = 32, DATA = 96;
const EOFS = 16;

/**
 * The embedder's side of wasm-host.c's stdin ring at address `base` in
 * `memory`: push(bytes) and eof() queue input in order, writing what fits now
 * and the rest when the guest has read enough to make room (polled every 20 ms
 * only while something is waiting).
 * @param {WebAssembly.Memory} memory
 * @param {number} base
 */
export function stdinRing(memory, base) {
    const i32 = (off) => (base + off) >> 2;
    const backlog = []; // Uint8Array chunks and 'eof' marks, in order
    let timer = null;
    const view32 = () => new Int32Array(memory.buffer);
    const drain = () => {
        timer = null;
        const m32 = view32();
        const m8 = new Uint8Array(memory.buffer);
        const size = Atomics.load(m32, i32(SIZE));
        let changed = false;
        while (backlog.length) {
            const head = Atomics.load(m32, i32(HEAD)) >>> 0;
            const tail = Atomics.load(m32, i32(TAIL)) >>> 0;
            const item = backlog[0];
            if (item === 'eof') {
                const ew = Atomics.load(m32, i32(EOF_WRITTEN)) >>> 0;
                const er = Atomics.load(m32, i32(EOF_READ)) >>> 0;
                if (((ew - er) >>> 0) >= EOFS) break;
                Atomics.store(m32, i32(EOF_AT) + (ew % EOFS), head | 0);
                Atomics.store(m32, i32(EOF_WRITTEN), (ew + 1) | 0);
                backlog.shift();
                changed = true;
                continue;
            }
            const free = size - ((head - tail) >>> 0);
            if (free <= 0) break;
            const n = Math.min(free, item.length);
            for (let k = 0; k < n; k++) m8[base + DATA + ((head + k) % size)] = item[k];
            Atomics.store(m32, i32(HEAD), (head + n) | 0);
            changed = true;
            if (n === item.length) backlog.shift();
            else backlog[0] = item.subarray(n);
        }
        if (changed) {
            Atomics.add(m32, i32(SEQ), 1);
            Atomics.notify(m32, i32(SEQ));
        }
        if (backlog.length) timer = setTimeout(drain, 20);
    };
    return {
        /** Makes fd 0 read from the ring (until the guest closes it). */
        enable() {
            Atomics.store(view32(), i32(ENABLED), 1);
        },
        push(bytes) {
            if (bytes.length) backlog.push(bytes);
            if (!timer) drain();
        },
        eof() {
            backlog.push('eof');
            if (!timer) drain();
        },
        /** The host signal that ended the guest (wasm_host_exit_signal), or 0. */
        exitSignal() {
            return Atomics.load(view32(), i32(EXIT_SIGNAL));
        },
        stop() {
            clearTimeout(timer);
            timer = null;
        },
    };
}

/**
 * Terminal output ops for Emscripten's TTY layer that hand the bytes on in
 * the chunks the program wrote them (one post per write call, not per line),
 * keeping its default termios answers so isatty() and tcgetattr() work.
 */
function ttyOps(TTY, onBytes) {
    return {
        ...TTY.default_tty_ops,
        put_char(tty, val) {
            if (val === null) return;
            tty.output.push(val);
            if (tty.output.length === 1) queueMicrotask(() => this.fsync(tty));
        },
        fsync(tty) {
            if (tty.output.length) {
                const bytes = Uint8Array.from(tty.output);
                tty.output = [];
                onBytes(bytes);
            }
        },
    };
}

/** The environment Emscripten gives a program (libc's getEnvStrings), which QEMU passes on. */
const EMSCRIPTEN_ENV = ['USER', 'LOGNAME', 'PATH', 'PWD', 'HOME', 'LANG', '_'];

/**
 * Runs `ctx.program` under qemu-<arch>; resolves to the exit code as runLinux
 * documents it. Rejects only if QEMU's files cannot be loaded.
 * @param {import('./run-linux.js').RunContext} ctx
 * @returns {Promise<number>}
 */
export async function runUser(ctx) {
    const { arch, post, mark, options } = ctx;
    const dir = `user/${arch}/`;
    const qemu = `qemu-${arch}`;
    post({ type: 'phase', text: `Starting QEMU (${arch}, user mode)` });
    const glueUrl = new URL(dir + qemu + '.mjs', ctx.base).href;
    const [qemuInit, module] = await Promise.all([
        import(/* @vite-ignore */ glueUrl).then((x) => x.default),
        ctx.fetchResponse(dir + qemu + '.wasm').then((r) => WebAssembly.compileStreaming(r)),
    ]);
    mark('vm-loaded');

    // The environment: exactly ctx.env, as in system mode.
    const ours = new Set(ctx.env.map((e) => e.slice(0, e.indexOf('='))));
    const envArgs = [...EMSCRIPTEN_ENV.filter((k) => !ours.has(k)).flatMap((k) => ['-U', k]), ...ctx.env.flatMap((e) => ['-E', e])];
    const traceArgs = options.strace ? ['-strace', '-D', '/dev/yk-trace'] : [];

    return new Promise((resolve) => {
        const out = new TextDecoder(), err = new TextDecoder(), trc = new TextDecoder();
        let memory = null, ring = null, finished = false, firstOut = false, stopStdin = () => {};
        const finish = (code, why) => {
            if (finished) return;
            finished = true;
            stopStdin();
            ring?.stop();
            if (why) post({ type: 'stderr', text: `\n${vmFailureMessage(true, why)}\n` });
            mark('exit');
            resolve(code);
        };
        let ttys = [];
        const Module = {
            arguments: [...envArgs, ...traceArgs, '-0', ctx.argv[0], '/yk/prog', ...ctx.argv.slice(1)],
            locateFile: (p) => new URL(dir + p, ctx.base).href,
            mainScriptUrlOrBlob: glueUrl,
            instantiateWasm(imports, receive) {
                // Emscripten passes the shared memory in as an import (its name is minified).
                for (const ns of Object.values(imports))
                    for (const v of Object.values(ns)) if (v instanceof WebAssembly.Memory) memory = v;
                WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module),
                    (e) => finish(1, `QEMU did not load: ${e?.message ?? e}`));
                return {};
            },
            print: (t) => post({ type: 'kernel', text: `[qemu] ${t}\n` }),
            printErr: (t) => post({ type: 'kernel', text: `[qemu] ${t}\n` }),
            preRun: [(mod) => {
                const { FS, TTY } = mod;
                FS.mkdir('/yk');
                FS.writeFile('/yk/prog', ctx.program);
                FS.chmod('/yk/prog', 0o755);
                const stdout = ttyOps(TTY, (b) => {
                    if (!firstOut) {
                        firstOut = true;
                        mark('first-stdout');
                    }
                    post({ type: 'stdout', text: out.decode(b, { stream: true }) });
                });
                const stderr = ttyOps(TTY, (b) => post({ type: 'stderr', text: err.decode(b, { stream: true }) }));
                TTY.register(FS.makedev(5, 0), stdout);
                TTY.register(FS.makedev(6, 0), stderr);
                ttys = [TTY.ttys[FS.makedev(5, 0)], TTY.ttys[FS.makedev(6, 0)]];
                const dev = FS.makedev(64, 3);
                FS.registerDevice(dev, {
                    open() {}, close() {},
                    read() { return 0; },
                    write(stream, buffer, offset, length) {
                        if (length) post({ type: 'trace', text: trc.decode(buffer.slice(offset, offset + length), { stream: true }) });
                        return length;
                    },
                });
                FS.mkdev('/dev/yk-trace', 0o666, dev);
            }],
            onRuntimeInitialized() {
                // Before main() starts on its pthread: fd 0 reads from the ring from the start.
                ring = stdinRing(memory, Module._wasm_host_stdin());
                ring.enable();
                stopStdin = pumpStdin(ctx.stdin, post, (b) => ring.push(b), () => ring.eof());
                mark('exec');
                post({ type: 'phase', text: 'Running' });
            },
            // QEMU exits with the program's status (exit_group), or 128 + n after
            // wasm_host_exit_signal recorded a fatal signal n.
            onExit: (status) => {
                for (const tty of ttys) tty?.ops.fsync(tty);
                const sig = ring?.exitSignal() ?? 0;
                if (sig) post({ type: 'stderr', text: `\n${signalMessage(sig)}\n` });
                finish(status);
            },
            onAbort: (reason) => finish(1, `QEMU aborted: ${reason}`),
        };
        qemuInit(Module).catch((e) => finish(1, `QEMU failed: ${e?.message ?? e}`));
    });
}
