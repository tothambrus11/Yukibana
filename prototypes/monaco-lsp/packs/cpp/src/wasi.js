// A small WASI (wasi_snapshot_preview1) host for one compiled program: what a
// C or C++ program built against wasi-libc for wasm32-wasip1 needs to print,
// read standard input, know the time, draw random numbers and exit. There is
// no file system (no preopened directories, so fopen fails with ENOENT-like
// errors from libc), no sockets and no threads. Anything else the program
// imports answers ENOSYS instead of failing to instantiate.
//
// Standard input blocks the worker with Atomics.wait on the SharedArrayBuffer
// of ../../CONTRACT.md ("Standard input"); without one, stdin is at its end.

const SUCCESS = 0;
const EBADF = 8;
const EINVAL = 28;
const ENOSYS = 52;
const ESPIPE = 70;
const FILETYPE_CHARACTER_DEVICE = 2;
const RIGHTS_FD_READ = 2n;
const RIGHTS_FD_WRITE = 64n;

/** Thrown by proc_exit to unwind out of the program. */
export class ProcExit extends Error {
    constructor(code) {
        super(`exit(${code})`);
        this.code = code;
    }
}

/**
 * @param {object} io
 * @param {string[]} io.args              argv, argv[0] included
 * @param {Record<string, string>} [io.env]  the environment, getenv() sees it (empty by default)
 * @param {(fd: 1 | 2, text: string) => void} io.write   decoded output, as it is written
 * @param {SharedArrayBuffer | null} io.stdin             the contract's stdin buffer
 * @param {() => void} io.requestInput    posts { type: 'stdin' }
 * @param {() => void} io.beforeWait      flushes the program's stdout first
 */
export function createWasi({ args, env = {}, write, stdin, requestInput, beforeWait }) {
    /** @type {WebAssembly.Memory | null} */
    let memory = null;
    const view = () => new DataView(memory.buffer);
    const bytes = () => new Uint8Array(memory.buffer);
    const encoder = new TextEncoder();
    const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
    const argBytes = args.map((a) => encoder.encode(a + '\0'));
    const envBytes = Object.entries(env).map(([k, v]) => encoder.encode(`${k}=${v}\0`));

    const state = stdin ? new Int32Array(stdin, 0, 2) : null;
    const data = stdin ? new Uint8Array(stdin, 8) : null;
    /** Input received from the app and not yet read by the program. */
    let pending = new Uint8Array(0);
    let sleeper = null;

    /** Blocks until the app sends a line (true) or end of file (false). */
    function waitForInput() {
        if (!state) return false;
        beforeWait();
        Atomics.store(state, 0, 1);
        requestInput();
        while (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1);
        const s = Atomics.load(state, 0);
        if (s === 2) {
            const length = Math.min(Atomics.load(state, 1), data.length);
            pending = data.slice(0, length);
        }
        Atomics.store(state, 0, 0);
        return s === 2;
    }

    const iovecs = (iovs, count) => {
        const dv = view();
        const list = [];
        for (let i = 0; i < count; i++) list.push([dv.getUint32(iovs + i * 8, true), dv.getUint32(iovs + i * 8 + 4, true)]);
        return list;
    };

    const sizes = (strings, countPtr, sizePtr) => {
        const dv = view();
        dv.setUint32(countPtr, strings.length, true);
        dv.setUint32(sizePtr, strings.reduce((n, s) => n + s.length, 0), true);
        return SUCCESS;
    };
    const fill = (strings, ptrs, buf) => {
        const dv = view();
        const mem = bytes();
        for (const s of strings) {
            dv.setUint32(ptrs, buf, true);
            mem.set(s, buf);
            ptrs += 4;
            buf += s.length;
        }
        return SUCCESS;
    };

    const now = (clock) =>
        clock === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));

    const imports = {
        args_sizes_get: (c, s) => sizes(argBytes, c, s),
        args_get: (p, b) => fill(argBytes, p, b),
        environ_sizes_get: (c, s) => sizes(envBytes, c, s),
        environ_get: (p, b) => fill(envBytes, p, b),

        clock_res_get(clock, out) {
            view().setBigUint64(out, 1000n, true);
            return clock <= 3 ? SUCCESS : EINVAL;
        },
        clock_time_get(clock, _precision, out) {
            if (clock > 3) return EINVAL;
            view().setBigUint64(out, now(clock), true);
            return SUCCESS;
        },

        random_get(buf, len) {
            for (let at = 0; at < len; at += 65536)
                crypto.getRandomValues(new Uint8Array(memory.buffer, buf + at, Math.min(65536, len - at)));
            return SUCCESS;
        },

        fd_write(fd, iovs, count, nwritten) {
            if (fd !== 1 && fd !== 2) return EBADF;
            let total = 0;
            let text = '';
            for (const [ptr, len] of iovecs(iovs, count)) {
                text += decoders[fd].decode(bytes().subarray(ptr, ptr + len), { stream: true });
                total += len;
            }
            if (text) write(fd, text);
            view().setUint32(nwritten, total, true);
            return SUCCESS;
        },

        fd_read(fd, iovs, count, nread) {
            if (fd !== 0) return EBADF;
            if (pending.length === 0) waitForInput();
            let total = 0;
            for (const [ptr, len] of iovecs(iovs, count)) {
                const n = Math.min(len, pending.length);
                bytes().set(pending.subarray(0, n), ptr);
                pending = pending.subarray(n);
                total += n;
                if (pending.length === 0) break;
            }
            view().setUint32(nread, total, true);
            return SUCCESS;
        },

        fd_fdstat_get(fd, out) {
            if (fd > 2) return EBADF;
            // A character device without seek rights: wasi-libc's isatty() is
            // true, so stdout is line buffered as in a terminal.
            const dv = view();
            dv.setUint8(out, FILETYPE_CHARACTER_DEVICE);
            dv.setUint16(out + 2, 0, true);
            dv.setBigUint64(out + 8, fd === 0 ? RIGHTS_FD_READ : RIGHTS_FD_WRITE, true);
            dv.setBigUint64(out + 16, 0n, true);
            return SUCCESS;
        },
        fd_fdstat_set_flags: (fd) => (fd > 2 ? EBADF : SUCCESS),
        fd_prestat_get: () => EBADF, // no preopened directories: no files
        fd_prestat_dir_name: () => EBADF,
        fd_close: (fd) => (fd > 2 ? EBADF : SUCCESS),
        fd_seek: (fd) => (fd > 2 ? EBADF : ESPIPE),
        fd_sync: () => SUCCESS,
        fd_datasync: () => SUCCESS,

        poll_oneoff(inPtr, outPtr, count, neventsPtr) {
            // Clock subscriptions only (sleep, nanosleep, this_thread::sleep_for).
            const dv = view();
            let timeout = 0n;
            for (let i = 0; i < count; i++) {
                const sub = inPtr + i * 48;
                if (dv.getUint8(sub + 8) !== 0) return ENOSYS;
                const clock = dv.getUint32(sub + 16, true);
                let t = dv.getBigUint64(sub + 24, true);
                if (dv.getUint16(sub + 40, true) & 1) t -= now(clock); // absolute
                if (t > timeout) timeout = t;
            }
            const ms = Number(timeout / 1000000n);
            if (ms > 0) {
                if (typeof SharedArrayBuffer === 'function' && crossOriginIsolated) {
                    sleeper ??= new Int32Array(new SharedArrayBuffer(4));
                    Atomics.wait(sleeper, 0, 0, ms);
                } else {
                    const end = performance.now() + ms;
                    while (performance.now() < end);
                }
            }
            for (let i = 0; i < count; i++) {
                const ev = outPtr + i * 32;
                dv.setBigUint64(ev, dv.getBigUint64(inPtr + i * 48, true), true);
                dv.setUint16(ev + 8, 0, true);
                dv.setUint8(ev + 10, 0);
            }
            dv.setUint32(neventsPtr, count, true);
            return SUCCESS;
        },
        sched_yield: () => SUCCESS,
        proc_exit(code) {
            throw new ProcExit(code);
        },
    };

    return {
        /** Import object for a module: what it imports from WASI, the
         * functions above or ENOSYS. */
        importsFor(module) {
            const wasi = {};
            for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
                if (from !== 'wasi_snapshot_preview1' || kind !== 'function') continue;
                wasi[name] = imports[name] ?? (() => ENOSYS);
            }
            return { wasi_snapshot_preview1: wasi };
        },
        setMemory(m) {
            memory = m;
        },
        /** Text a decoder still holds (an incomplete UTF-8 sequence). */
        flush() {
            for (const fd of [1, 2]) {
                const rest = decoders[fd].decode();
                if (rest) write(fd, rest);
            }
        },
    };
}
