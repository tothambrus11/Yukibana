// The Swift pack's runner (../../CONTRACT.md, "Running a program"): compiles
// the project with the real Swift compiler and runs it, all in this worker.
//
//   swift-frontend-lsp.wasm  Swift 6.3.3's compiler frontend, built for a
//                            wasm32-wasip1 host by
//                            tothambrus11/swift-toolchain-wasm: the same
//                            module the language server runs sourcekitd
//                            from, so the browser downloads it once; here
//                            only its `swift_frontend_main` is called
//   wasm-ld.wasm             LLVM's linker from the same build
//   swift-sysroot.tar        the stdlib modules and archives, wasi-libc,
//                            compiler-rt: that release's sysroot, trimmed by
//                            build.sh to what a Foundation-free program needs
//
// The pipeline is the driver's, replayed by hand (WASI cannot spawn): one
// whole-module `swift-frontend -frontend -c` over every .swift file, then
// `wasm-ld` with the stdlib archives plus whatever the object's autolink
// entries name, then the program, as a WASI command, in this same worker.
// Standard input blocks on the contract's SharedArrayBuffer, so readLine()
// works interactively.
//
// `{ type: 'test' }` (same fields as 'run') runs the project's XCTest tests
// instead of its program, with the browser's XCTest (xctest/, README "Tests
// with XCTest"): every .swift file except the program's main.swift, plus a
// main.swift generated from the XCTestCase subclasses found (src/xctest.js),
// or the project's own main.swift if that one calls XCTMain. A 'run' leaves
// test files (those importing XCTest) out, as SwiftPM leaves the test target
// out of the executable.
//
// `options.optimization` (either type) is the level the module is compiled
// at, one of toolchain.js's OPTIMIZATION_LEVELS; absent, `-Onone` (README,
// "Optimization").

import {
    Fd, FRONTEND_WASM, LINKER_WASM, OPTIMIZATION_LEVELS, autolinkEntries, compileArgs, linkArgs, linkLibraries, loadMacroPlugins, loadSwiftTesting,
    loadSysroot, loadTool, loadXCTest, mkdirp, readFile, remove, runFrontend, runWasi, textSink, usesMacroPlugins, wasiDefs,
    writeFile, writeProject,
} from './toolchain.js';
import { dropOwnModuleImportWarnings, importsTesting, importsXCTest, isTestFile, planTestRun, projectModuleName } from './xctest.js';

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

/** Where a generated test main.swift is compiled from (outside the project). */
const TEST_MAIN = '/build/xctest/main.swift';

async function run({ files, entry, stdin, options }, testing) {
    const t0 = performance.now();
    // The optimisation level (OPTIMIZATION_LEVELS); anything else is refused
    // before a byte is downloaded, rather than handed to the frontend.
    const optimization = options?.optimization ?? OPTIMIZATION_LEVELS[0];
    if (!OPTIMIZATION_LEVELS.includes(optimization)) {
        post({ type: 'stderr', text: `error: unsupported optimisation level ${JSON.stringify(optimization)}; supported: ${OPTIMIZATION_LEVELS.join(', ')}\n` });
        return 1;
    }
    const ms = () => `${Math.round(performance.now() - t0)} ms`;
    // What to compile: for a run, the program (test files left out); for a
    // test run, the plan of src/xctest.js. Module name: see projectModuleName.
    const swift = Object.entries(files).filter(([p]) => p.endsWith('.swift'));
    const plan = testing ? planTestRun(files) : null;
    // (An entry that imports XCTest or Testing itself, a hand-written test main, keeps them.)
    const keepTests = testing || importsXCTest(files[entry] ?? '') || importsTesting(files[entry] ?? '');
    const compiled = testing ? plan.sources : swift.filter(([p, text]) => keepTests || !isTestFile(p, text)).map(([p]) => p);
    const moduleName = testing ? plan.moduleName : projectModuleName(Object.fromEntries(swift.filter(([p]) => compiled.includes(p))));
    // The texts compiled, with a generated test main, decide the optional
    // downloads: XCTest, swift-testing, and the macro plugins.
    const texts = [...swift.filter(([p]) => compiled.includes(p)).map(([, text]) => text), plan?.main ?? ''];
    const needsXCTest = texts.some(importsXCTest);
    const needsTesting = texts.some(importsTesting);
    const needsPlugins = texts.some(usesMacroPlugins);

    phase('Loading the Swift compiler');
    // All downloads at once; the linker compiles while the frontend runs.
    const linkerPromise = loadTool(LINKER_WASM, onLoading);
    linkerPromise.catch(() => {});
    const [frontend, root] = await Promise.all([
        loadTool(FRONTEND_WASM, onLoading),
        loadSysroot(onLoading).then(async (root) => {
            await Promise.all([
                needsXCTest && loadXCTest(root, onLoading),
                needsTesting && loadSwiftTesting(root, onLoading),
                needsPlugins && loadMacroPlugins(root, onLoading),
            ]);
            return root;
        }),
    ]);

    writeProject(root, WORK, files, entry);
    const sources = compiled.map((p) => `${WORK}/${p.replace(/^\/+/, '')}`);
    sources.sort((a, b) => (a === `${WORK}/${entry}` ? -1 : b === `${WORK}/${entry}` ? 1 : a < b ? -1 : 1));
    mkdirp(root, '/build');
    if (plan?.main) {
        writeFile(root, TEST_MAIN, plan.main);
        sources.push(TEST_MAIN);
        if (plan.classes.length === 0 && !plan.swiftTesting) {
            post({ type: 'stderr', text: 'note: no XCTestCase subclass with test methods, and no file importing Testing, was found\n' });
        }
    }
    if (sources.length === 0) {
        post({ type: 'stderr', text: 'error: the project has no .swift files\n' });
        return 1;
    }

    phase('Compiling');
    // The frontend's diagnostics, posted when it ends (they all come at the
    // end anyway), less the warnings that projectModuleName causes.
    const diagnostics = textSink();
    let code = await runFrontend(frontend, {
        args: compileArgs(sources, '/build/main.o', moduleName, optimization), root,
        stdout: diagnostics, stderr: diagnostics,
    });
    const shown = relative(moduleName === 'main' ? diagnostics.text : dropOwnModuleImportWarnings(diagnostics.text));
    if (shown.trim()) post({ type: 'stderr', text: shown });
    if (code !== 0) return code;
    const errors = textSink((text) => post({ type: 'stderr', text: relative(text) }));

    phase('Linking');
    const object = readFile(root, '/build/main.o');
    const linker = await linkerPromise;
    code = await runWasi(linker, {
        args: [...linkArgs(['/build/main.o'], '/build/main.wasm', 1 << 20, linkLibraries(root, autolinkEntries(object))),
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

    phase(testing ? 'Testing' : 'Running');
    console.debug(`swift runner: compiled and linked in ${ms()}`);
    let exports = null;
    const flush = () => {
        try {
            exports?.fflush?.(0);
        } catch {
            // a program that trapped may not be able to flush; its output is lost
        }
    };
    // XCTest prints failures as `#file:line:`, which is the absolute path the
    // frontend was given; a test run shows it relative, as diagnostics are.
    // (XCTest flushes every line, so a path is never split across writes.)
    const out = textSink((text) => post({ type: 'stdout', text: testing ? relative(text) : text }));
    // swift-testing reports on stderr, with paths as #fileID gives them
    // (module/file), so a test run's stderr is made relative too.
    const err = textSink((text) => post({ type: 'stderr', text: testing ? relative(text) : text }));
    const input = new Stdin(stdin, flush);
    // A test run runs the program once per testing library (planTestRun),
    // as `swift test` does; it fails if any of them fails.
    let status = 0;
    for (const args of testing ? plan.runs : [['main']]) {
        try {
            code = await runWasi(program, {
                args, env: [], root, stdin: input, stdout: out, stderr: err,
                onInstance: (instance) => (exports = instance.exports),
            });
        } catch (e) {
            flush();
            // A Swift runtime error (fatalError, a failed `!`, an overflow) has
            // already printed its message; the trap itself is `unreachable`.
            post({ type: 'stderr', text: `\nProgram crashed: ${e instanceof WebAssembly.RuntimeError ? e.message : e}\n` });
            code = 134;
        }
        if (status === 0) status = code;
    }
    return status;
}

self.onmessage = ({ data }) => {
    if (data?.type !== 'run' && data?.type !== 'test') return;
    run(data, data.type === 'test').then(
        (code) => post({ type: 'exit', code }),
        (e) => {
            post({ type: 'stderr', text: `swift runner: ${e?.message ?? e}\n` });
            post({ type: 'exit', code: 1 });
        },
    );
};
