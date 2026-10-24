// SPDX-License-Identifier: MIT
// Runs one static Linux ELF under QEMU-Wasm: the entry of vm.js, which the C/C++
// runner (src/runner.js) imports only for a Linux target. Two emulations:
//
//   system (default)  qemu-system-<arch> boots Linux 6.12 with vm/guest/init.c as
//                     PID 1, which runs the program on virtio consoles (system.js)
//   user              qemu-<arch> (linux-user) translates the program's system
//                     calls onto Emscripten's libc; experimental (user.js)
//
// Both run QEMU with -sPROXY_TO_PTHREAD, so the worker that calls runLinux becomes
// emscripten's main runtime thread: QEMU's own threads are nested workers that
// proxy every file system call here. Nothing in this module blocks; the
// worker's event loop must stay free for those calls (see stdin.js).
//
// The files come from `base` (the pack's /packs/cpp/ URL):
//   vm/<arch>/qemu-system-<arch>.{mjs,wasm}, kernel, initrd, strace.cpio,
//   qboot.rom (x86_64), opensbi-riscv64-generic-fw_dynamic.bin (riscv64)
//   user/<arch>/qemu-<arch>.{mjs,wasm}
// build-vm.sh injects their sizes (VM_SIZES) so progress has a total even when
// the host sends them compressed.

import { runSystem } from './system.js';
import { runUser } from './user.js';

/* global VM_SIZES */
/** Raw byte size of each file under base, by path; injected by build-vm.sh's esbuild --define. */
const SIZES = typeof VM_SIZES === 'object' && VM_SIZES ? VM_SIZES : {};

/** The architectures there is a VM for, in the order the targets table lists them. */
export const ARCHES = ['x86_64', 'aarch64', 'riscv64'];

/**
 * The environment a program starts with when the runner passes none of its
 * own: the same in both emulations, and what vm/guest/init.c uses when
 * /yk/env is missing.
 */
export const DEFAULT_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/', TERM: 'xterm-256color', LANG: 'C.UTF-8' };

/** Signal names by number: identical on x86_64, aarch64 and riscv64 (asm-generic numbering). */
const SIGNALS = [, 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL',
    'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGSTKFLT', 'SIGCHLD', 'SIGCONT', 'SIGSTOP',
    'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO',
    'SIGPWR', 'SIGSYS'];

/**
 * The stderr line for a program killed by signal `n`, as plan §4.2 words it:
 * "Terminated by signal 11 (SIGSEGV)"; real-time signals are named SIGRTMIN+k.
 * @param {number} n
 * @returns {string}
 */
export function signalMessage(n) {
    const name = SIGNALS[n] ?? (n >= 34 && n <= 64 ? `SIGRTMIN+${n - 34}` : null);
    return `Terminated by signal ${n}${name ? ` (${name})` : ''}`;
}

/**
 * The message for a VM that stopped without telling us how the program ended,
 * which the runner's exit code 1 goes with.
 * @param {boolean} started whether the program had started (init's "exec")
 * @param {string} why what the host saw: a QEMU exit status, a reboot, a panic
 * @returns {string}
 */
export function vmFailureMessage(started, why) {
    return `The VM stopped before the program ${started ? 'finished' : 'started'} (${why}); see the kernel log in the Output panel.`;
}

/**
 * The run's shared context, built once by runLinux and handed to the mode:
 * `post`, `mark(name, extra?)` (ms since `t0`), `fetchBytes(path)` and
 * `fetchResponse(path)` with `loading` progress against SIZES, and the
 * resolved `options`.
 * @typedef {{ arch: string, program: Uint8Array, argv: string[], env: string[],
 *   stdin: SharedArrayBuffer | null, options: { emulation: 'system' | 'user', cpus: number, strace: boolean },
 *   post: (msg: object) => void, base: URL, mark: (name: string, extra?: object) => void,
 *   fetchBytes: (path: string) => Promise<Uint8Array>, fetchResponse: (path: string) => Promise<Response> }} RunContext
 */

/**
 * Runs one static Linux ELF under QEMU-Wasm and resolves to its exit code (the
 * runner posts 'exit'; this does not).
 *
 * Posts through `post`: `loading` (per file, `total` = its decoded size),
 * `phase` ("Starting Linux (aarch64)", "Running"), `stdout`, `stderr`,
 * `stdin` (asked continuously while the program runs; CONTRACT.md "Standard
 * input"), `trace` (strace's output when `options.strace`), `kernel` (the
 * guest kernel's console and QEMU's own messages) and `mark` with ms since
 * `t0`: 'vm-loaded', 'exec' (system mode adds `guestMs`, the guest's uptime
 * when init started the program), 'first-stdout', 'exit'. In system mode 'exec'
 * and 'first-stdout' arrive on separate virtqueues and may come in either order;
 * "Running" is posted at whichever is first.
 *
 * Exit codes: the program's status; 128 + n for a program killed by signal n,
 * after "Terminated by signal n (NAME)" on stderr; 1 for a VM that failed,
 * after a pointer to the kernel log on stderr. In user mode a fault the
 * emulator cannot see (a null dereference reads 0) is not a signal at all;
 * vm/README.md lists such gaps.
 *
 * Never blocks the calling worker's thread, and never rejects: an error (a
 * missing file, a bad argument) is reported on stderr and resolves to 1.
 * The VM is not shut down afterwards (QEMU's own shutdown hangs in qemu-wasm):
 * the caller ends it by terminating its worker, which also ends QEMU's nested
 * pthread workers. Call it at most once per worker.
 *
 * @param {object} run
 * @param {'x86_64' | 'aarch64' | 'riscv64'} run.arch the guest architecture
 * @param {Uint8Array} run.program a static ELF for that architecture
 * @param {string[]} [run.args] argv[1..]; argv[0] is "main"
 * @param {Record<string, string>} [run.env] added to (and overriding) DEFAULT_ENV
 * @param {SharedArrayBuffer | null} [run.stdin] the contract's stdin buffer
 * @param {{ emulation?: 'system' | 'user', cpus?: 1 | 2 | 4, strace?: boolean }} [run.options]
 *   defaults: system, 1, false; `cpus` is ignored in user mode (one CPU)
 * @param {(msg: object) => void} run.post sends a runner message to the app
 * @param {string | URL} run.base the URL of /packs/cpp/
 * @param {number} [run.t0] performance.now() when the run message arrived;
 *   marks count from it (default 0, the worker's start)
 * @returns {Promise<number>}
 */
export async function runLinux({ arch, program, args = [], env = {}, stdin = null, options = {}, post, base, t0 = 0 }) {
    const opts = {
        emulation: options?.emulation === 'user' ? 'user' : 'system',
        cpus: [1, 2, 4].includes(options?.cpus) ? options.cpus : 1,
        strace: options?.strace === true,
    };
    const fail = (text) => {
        post({ type: 'stderr', text: text.endsWith('\n') ? text : text + '\n' });
        return 1;
    };
    if (!ARCHES.includes(arch)) return fail(`No VM for architecture ${arch}; supported: ${ARCHES.join(', ')}.`);
    if (!(program instanceof Uint8Array) || program.length < 4 || program[0] !== 0x7f || program[1] !== 0x45 || program[2] !== 0x4c || program[3] !== 0x46)
        return fail('The program is not an ELF executable.');
    const baseUrl = new URL(base, typeof location === 'object' ? location.href : undefined);
    const mark = (name, extra = {}) => post({ type: 'mark', name, ms: Math.round(performance.now() - t0), ...extra });
    const fetchResponse = async (path) => {
        const response = await fetch(new URL(path, baseUrl));
        if (!response.ok || !response.body) throw new Error(`${path}: HTTP ${response.status}`);
        return response;
    };
    const fetchBytes = async (path) => {
        const response = await fetchResponse(path);
        const total = SIZES[path] ?? 0;
        const chunks = [];
        let loaded = 0;
        post({ type: 'loading', label: path, loaded, total });
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            post({ type: 'loading', label: path, loaded, total: Math.max(total, loaded) });
        }
        const out = new Uint8Array(loaded);
        let at = 0;
        for (const c of chunks) {
            out.set(c, at);
            at += c.length;
        }
        return out;
    };
    /** Like fetchBytes, but hands back a Response for streaming compilation while counting a clone. */
    const fetchCounted = async (path) => {
        const response = await fetchResponse(path);
        const total = SIZES[path] ?? 0;
        let loaded = 0;
        post({ type: 'loading', label: path, loaded, total });
        const reader = response.clone().body.getReader();
        (async () => {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                loaded += value.length;
                post({ type: 'loading', label: path, loaded, total: Math.max(total, loaded) });
            }
        })().catch(() => {});
        return response;
    };
    const envList = Object.entries({ ...DEFAULT_ENV, ...env }).map(([k, v]) => `${k}=${v}`);
    for (const e of envList) if (e.includes('\0') || e.startsWith('=')) return fail(`Bad environment entry ${JSON.stringify(e)}.`);
    /** @type {RunContext} */
    const ctx = { arch, program, argv: ['main', ...args.map(String)], env: envList, stdin, options: opts, post, base: baseUrl, mark, fetchBytes, fetchResponse: fetchCounted };
    try {
        return await (opts.emulation === 'user' ? runUser(ctx) : runSystem(ctx));
    } catch (e) {
        return fail(`The VM could not start: ${e?.message ?? e}`);
    }
}
