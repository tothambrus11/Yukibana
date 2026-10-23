// The Swift pack's runner (../../CONTRACT.md, "Running a program"): compiles
// the project with the real Swift compiler and runs it, all in this worker.
//
//   swift-frontend.wasm  Swift 6.3.3's compiler frontend, built for a
//                        wasm32-wasip1 host by tothambrus11/swift-toolchain-wasm
//   wasm-ld.wasm         LLVM's linker from the same build
//   swift-sysroot.tar    the stdlib modules and archives, wasi-libc,
//                        compiler-rt: that release's sysroot, trimmed by
//                        build.sh to what a Foundation-free program needs
//
// The pipeline is the driver's, replayed by hand (WASI cannot spawn): one
// whole-module `swift-frontend -frontend -c` over every .swift file, then
// `wasm-ld` with the stdlib archives plus whatever the object's autolink
// entries name, then the program, as a WASI command, in this same worker.
// Standard input blocks on the contract's SharedArrayBuffer, so readLine()
// works interactively.

import {
    Fd, FRONTEND_WASM, LINKER_WASM, autolinkEntries, compileArgs, linkArgs, loadSysroot,
    loadTool, mkdirp, readFile, remove, runWasi, textSink, wasiDefs, writeProject,
} from './toolchain.js';

const post = (msg) => self.postMessage(msg);
const phase = (text) => post({ type: 'phase', text });
const onLoading = (label, loaded, total) => post({ type: 'loading', label, loaded, total });

/** Paths in messages are relative to the project, as the editor shows them. */
const WORK = '/workspace';
const relative = (text) => text.replaceAll(`${WORK}/`, '');

/**
 * The program's stdin: the contract's SharedArrayBuffer. A read with nothing
 * buffered flushes the program's stdout (its libc buffers a prompt printed
 * without a newline), asks the app for a line, and blocks in Atomics.wait.
 */
class Stdin extends Fd {
    constructor(sab, flush) {
        super();
        this.state = sab ? new Int32Array(sab, 0, 2) : null;
        this.data = sab ? new Uint8Array(sab, 8) : null;
        this.flush = flush;
        this.pending = new Uint8Array(0);
        this.eof = !sab;
    }
    fd_fdstat_get() {
        const fdstat = new wasiDefs.Fdstat(wasiDefs.FILETYPE_CHARACTER_DEVICE, 0);
        fdstat.fs_rights_base = BigInt(wasiDefs.RIGHTS_FD_READ);
        return { ret: 0, fdstat };
    }
    fd_filestat_get() {
        return { ret: 0, filestat: new wasiDefs.Filestat(0n, wasiDefs.FILETYPE_CHARACTER_DEVICE, 0n) };
    }
    fd_read(size) {
        if (this.pending.length === 0 && !this.eof) this.wait();
        const n = Math.min(size, this.pending.length);
        const out = this.pending.slice(0, n);
        this.pending = this.pending.subarray(n);
        return { ret: 0, data: out };
    }
    wait() {
        this.flush();
        Atomics.store(this.state, 0, 1);
        post({ type: 'stdin' });
        while (Atomics.load(this.state, 0) === 1) Atomics.wait(this.state, 0, 1);
        if (Atomics.load(this.state, 0) === 3) {
            // Ctrl-D: this read and every later one see end of file.
            this.eof = true;
        } else {
            const length = Atomics.load(this.state, 1);
            this.pending = this.data.slice(0, length);
        }
        Atomics.store(this.state, 0, 0);
    }
}

async function run({ files, entry, stdin }) {
    const t0 = performance.now();
    const ms = () => `${Math.round(performance.now() - t0)} ms`;
    phase('Loading the Swift compiler');
    // All three downloads at once; the linker compiles while the frontend runs.
    const linkerPromise = loadTool(LINKER_WASM, onLoading);
    linkerPromise.catch(() => {});
    const [frontend, root] = await Promise.all([loadTool(FRONTEND_WASM, onLoading), loadSysroot(onLoading)]);

    const sources = writeProject(root, WORK, files, entry);
    mkdirp(root, '/build');
    if (sources.length === 0) {
        post({ type: 'stderr', text: 'error: the project has no .swift files\n' });
        return 1;
    }

    phase('Compiling');
    const errors = textSink((text) => post({ type: 'stderr', text: relative(text) }));
    let code = await runWasi(frontend, {
        args: compileArgs(sources, '/build/main.o'), root,
        stdout: errors, stderr: errors,
    });
    if (code !== 0) return code;

    phase('Linking');
    const object = readFile(root, '/build/main.o');
    const linker = await linkerPromise;
    code = await runWasi(linker, {
        args: [...linkArgs(['/build/main.o'], '/build/main.wasm', 1 << 20, autolinkEntries(object)),
            // So the runner can flush the program's stdout before it waits for input.
            '--export-if-defined=fflush'],
        root, stdout: errors, stderr: errors,
    });
    if (code !== 0) return code;
    const program = await WebAssembly.compile(readFile(root, '/build/main.wasm'));
    // The toolchain's files are no longer needed; the program sees an empty /tmp
    // and its own project directory.
    remove(root, '/sysroot');
    remove(root, '/build');

    phase('Running');
    console.debug(`swift runner: compiled and linked in ${ms()}`);
    let exports = null;
    const flush = () => {
        try {
            exports?.fflush?.(0);
        } catch {
            // a program that trapped may not be able to flush; its output is lost
        }
    };
    const out = textSink((text) => post({ type: 'stdout', text }));
    const err = textSink((text) => post({ type: 'stderr', text }));
    try {
        return await runWasi(program, {
            args: ['main'], env: [], root,
            stdin: new Stdin(stdin, flush), stdout: out, stderr: err,
            onInstance: (instance) => (exports = instance.exports),
        });
    } catch (e) {
        flush();
        // A Swift runtime error (fatalError, a failed `!`, an overflow) has
        // already printed its message; the trap itself is `unreachable`.
        post({ type: 'stderr', text: `\nProgram crashed: ${e instanceof WebAssembly.RuntimeError ? e.message : e}\n` });
        return 134;
    }
}

self.onmessage = ({ data }) => {
    if (data?.type !== 'run') return;
    run(data).then(
        (code) => post({ type: 'exit', code }),
        (e) => {
            post({ type: 'stderr', text: `swift runner: ${e?.message ?? e}\n` });
            post({ type: 'exit', code: 1 });
        },
    );
};
