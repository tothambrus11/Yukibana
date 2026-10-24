// The C/C++ pack's runner (../../CONTRACT.md, "Running a program"): compiles
// every .c/.cpp of the project with clang 21 for the project's target
// (src/targets.js: the --target line of compile_flags.txt, README "Targets").
//
// On the default target, wasm32-wasip1, it links them with wasm-ld into a
// WebAssembly program and runs that program in this worker on the small
// WASI host in wasi.js. On a Linux target (x86_64, aarch64, riscv64) it
// compiles with cc-cross, and runner-linux.js, imported only then, links a
// static ELF with ld.lld and hands it to vm.js (the emulator's bundle,
// QEMU-Wasm; P/vm/README.md). Everything happens here, in the browser:
//
//   cc.wasm              clang + wasm-ld, one Emscripten binary (LLVM's
//                        multi-call driver), built by build-runner.sh
//   cc-cross.wasm        clang + ld.lld for the Linux targets (build-cross.sh)
//   targets/<arch>/      a Linux target's musl bits/ headers and libraries
//                        (build-targets.sh)
//   sysroot.tar.gz       the language server's headers; the runner takes
//                        libc++'s headers and clang's own from it (same URL,
//                        so the browser downloads it once for both workers)
//   wasi-sysroot.tar.gz  wasi-libc's headers, libc++'s __config_site for WASI,
//                        the static libraries (libc++ with exceptions) and
//                        compiler-rt
//   gtest.tar            GoogleTest's libraries, fetched only to build tests
//                        (type 'test') or a program that includes <gtest/...>;
//                        its headers are in sysroot.tar.gz
//   catch2.tar           the same for Catch2 v3 (<catch2/...>)
//   doctest.tar          the same for doctest (<doctest/...>): its
//                        implementation and main, prebuilt
//
// Each tool call gets a fresh instance of the compiler (compiled once; see
// toolchain.js): clang and lld keep global state, and a browser cannot fork.
// Files go from one instance to the next as bytes.

import { createWasi, ProcExit } from './wasi.js';
import { createToolchain, compileArgs, withSourceNames } from './toolchain.js';
import { targetOf, unsupportedMessage, DEFAULT_TARGET } from './targets.js';

// A Linux target's files (targets/<arch>/*.tar) report a total of 0
// (unknown): their sizes would cost the default target's runner.js bytes.
/* global CC_WASM_SIZE, CC_CROSS_WASM_SIZE, WASI_SYSROOT_SIZE, SYSROOT_SIZE, GTEST_SIZE, CATCH2_SIZE, DOCTEST_SIZE */
const SIZES = {
    'cc.wasm': typeof CC_WASM_SIZE === 'number' ? CC_WASM_SIZE : 0,
    'cc-cross.wasm': typeof CC_CROSS_WASM_SIZE === 'number' ? CC_CROSS_WASM_SIZE : 0,
    'wasi-sysroot.tar.gz': typeof WASI_SYSROOT_SIZE === 'number' ? WASI_SYSROOT_SIZE : 0,
    'sysroot.tar.gz': typeof SYSROOT_SIZE === 'number' ? SYSROOT_SIZE : 0,
    'gtest.tar': typeof GTEST_SIZE === 'number' ? GTEST_SIZE : 0,
    'catch2.tar': typeof CATCH2_SIZE === 'number' ? CATCH2_SIZE : 0,
    'doctest.tar': typeof DOCTEST_SIZE === 'number' ? DOCTEST_SIZE : 0,
};

const CXX = /\.(cpp|cc|cxx|c\+\+|C)$/;
const C = /\.c$/;
const OBJ = '.yukibana/obj/';
const WASM = DEFAULT_TARGET;
const LIB = '/wasi/lib/wasm32-wasip1';
/** Where a project keeps its tests (type 'test'); left out of a plain run. */
const TESTS = /^tests\//;

/**
 * The test frameworks, told apart by what a file includes, as a real build
 * would need them: `include` matches a file's `#include` lines (comments
 * left out). Each one's libraries are an archive of their own, fetched the
 * first time a project uses it. `main` is linked when no source defines one;
 * `args` and `env` give the report its colours (the app's terminal renders
 * ANSI; none of the three colours a stream it does not take for a terminal).
 */
const FRAMEWORKS = {
    gtest: {
        name: 'GoogleTest', header: '<gtest/gtest.h>', include: /^[ \t]*#[ \t]*include[ \t]*[<"]gtest\//m,
        archive: 'gtest.tar', libs: ['-lgtest'], main: ['-lgtest_main'],
        // As --gtest_color=yes would; the environment also reaches a test
        // file with its own main, whatever it does with argv.
        args: [], env: { GTEST_COLOR: 'yes' },
    },
    doctest: {
        name: 'doctest', header: '<doctest/doctest.h>', include: /^[ \t]*#[ \t]*include[ \t]*[<"]doctest\//m,
        // doctest is header-only; its implementation and main are one
        // prebuilt object (DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN), linked unless
        // the project implements doctest itself.
        archive: 'doctest.tar', libs: [], main: ['-ldoctest_main'],
        args: ['--force-colors'], env: {},
    },
    catch2: {
        name: 'Catch2', header: '<catch2/catch_test_macros.hpp>', include: /^[ \t]*#[ \t]*include[ \t]*[<"]catch2\//m,
        archive: 'catch2.tar', libs: ['-lCatch2'], main: ['-lCatch2Main'],
        args: ['--colour-mode', 'ansi'], env: {},
    },
};

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Whether a source defines main: `int main(` or `auto main(` outside
 * comments, or doctest's DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN. A heuristic,
 * enough to leave the program's own main out of a test build and to link a
 * framework's main only when there is none. */
const definesMain = (text) => {
    const code = withoutComments(text);
    return /\b(?:int|auto)\s+main\s*\(/.test(code) || /^[ \t]*#[ \t]*define[ \t]+DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN\b/m.test(code);
};

/** Whether a source implements doctest itself (DOCTEST_CONFIG_IMPLEMENT or _WITH_MAIN). */
const implementsDoctest = (text) => /^[ \t]*#[ \t]*define[ \t]+DOCTEST_CONFIG_IMPLEMENT/m.test(withoutComments(text));

/**
 * The test framework the given files use: the one their #includes name, or
 * null for none. Throws, naming a file of each, when they use more than one,
 * which no single test program can link.
 */
function frameworkOf(files, paths) {
    const found = new Map();
    for (const path of paths) {
        const code = withoutComments(files[path] ?? '');
        for (const [id, fw] of Object.entries(FRAMEWORKS)) if (!found.has(id) && fw.include.test(code)) found.set(id, path);
    }
    if (found.size > 1) {
        const which = [...found].map(([id, path]) => `${path} includes ${FRAMEWORKS[id].header.replace(/\/.*>/, '/...>')} (${FRAMEWORKS[id].name})`);
        throw new UserError(`The tests mix test frameworks: ${which.join(', ')}. A test program links one of them; convert or remove the others.\n`);
    }
    return found.size ? [...found.keys()][0] : null;
}

/** An error that is the project's, reported on stderr as it is, exit status 1. */
class UserError extends Error {}

const post = (msg) => self.postMessage(msg);
const phase = (text) => post({ type: 'phase', text });
const stderr = (text) => post({ type: 'stderr', text });
/** When the current request arrived, for the 'mark' timings (runner-linux.js). */
let started = 0;

// ---- the toolchain (toolchain.js)

const toolchain = createToolchain({ base: new URL('./', import.meta.url), post, sizes: SIZES });

// ---- running the program, or its tests

/**
 * type 'run': every .c/.cpp of the project except those under tests/.
 * type 'test': the project's sources without the program's main (the entry
 * file, and any other file that defines main) plus tests/**, linked with
 * the test framework they include (GoogleTest, doctest or Catch2) and,
 * unless a test file has its own main, that framework's main. On the
 * WebAssembly target only: the frameworks' libraries are built for wasm32.
 *
 * The target is the project's (compile_flags.txt, src/targets.js); a target
 * flag that names no supported target is refused before anything is
 * downloaded. Resolves to the exit status.
 */
async function run(request) {
    try {
        return await build(request);
    } catch (error) {
        if (!(error instanceof UserError)) throw error;
        stderr(error.message);
        return 1;
    }
}

async function build({ type, files, entry, stdin, options }) {
    const which = targetOf(files);
    if (which.kind === 'unsupported') throw new UserError(unsupportedMessage(which.triple));
    const target = which.target;
    const linux = target.runtime === 'linux';
    const testing = type === 'test';
    if (linux && testing)
        throw new UserError('Tests run on the WebAssembly target only, for now: the test frameworks are built for wasm32 only.\n');
    const all = Object.keys(files)
        .filter((p) => CXX.test(p) || C.test(p))
        .sort();
    let sources;
    if (testing) {
        const tests = all.filter((p) => TESTS.test(p));
        if (tests.length === 0) {
            stderr('No tests to run: put test files (GoogleTest, doctest or Catch2) in tests/, for example tests/geometry_test.cpp.\n');
            return 1;
        }
        sources = [...all.filter((p) => !TESTS.test(p) && p !== entry && !definesMain(files[p])), ...tests];
    } else {
        sources = all.filter((p) => !TESTS.test(p));
        if (sources.length === 0) {
            stderr('No .c or .cpp file to compile.\n');
            return 1;
        }
    }
    // What the compiled sources include decides the framework, and so do
    // tests/' headers, which only the sources that include them compile.
    const scanned = [...sources, ...(testing ? Object.keys(files).filter((p) => TESTS.test(p) && !sources.includes(p)) : [])];
    // A Linux target links no framework: their libraries are wasm32 only.
    const framework = linux ? null : frameworkOf(files, scanned);
    const ownMain = sources.some((p) => definesMain(files[p]));
    if (testing && !framework && !ownMain)
        throw new UserError('No test framework: the files in tests/ include none of <gtest/gtest.h>, <doctest/doctest.h> or <catch2/...>, and none defines main.\n');
    const fw = framework ? FRAMEWORKS[framework] : null;
    const cxxProgram = sources.some((p) => CXX.test(p));
    phase('Loading the compiler');
    // Every download at once: a Linux target's libraries too, for the link.
    const archives = framework ? [FRAMEWORKS[framework].archive] : [];
    await Promise.all([toolchain.load(target, { link: linux }), ...archives.map(toolchain.archive)]);

    const objects = {};
    for (const [i, source] of sources.entries()) {
        phase(`Compiling ${source} (${i + 1}/${sources.length})${linux ? ` for ${target.triple}` : ''}`);
        // Named after its source, so the linker's "defined in" names the
        // student's file (the prefix is taken out of its messages).
        const object = `${OBJ}${source}.o`;
        // The target's flags, -O2 unless the project gives a -O, exceptions
        // and libc++'s fast hardening for C++, then compile_flags.txt
        // (toolchain.js compileArgs, which the explorer's views use too).
        // On WebAssembly the hardening's trap reads "unreachable", so the
        // crash hint below names the likely cause.
        const { code, out } = await toolchain.tool(
            target,
            'clang',
            [...compileArgs(target, files, source), '-fno-color-diagnostics', '-c', source, '-o', object],
            files,
            [object],
            { archives }
        );
        if (code !== 0 || !out[object]) return code || 1;
        objects[object] = out[object];
    }
    if (linux) {
        // Linking and running for Linux are in runner-linux.js, fetched only
        // for a Linux target, so the default target's runner stays small.
        const { runOnLinux } = await import('./runner-linux.js');
        return runOnLinux({ toolchain, target, objects, cxx: cxxProgram, stdin, options, post, started });
    }

    phase('Linking');
    const lib = LIB;
    // A framework's main is in an archive, and wasi-libc's __main_void only
    // refers weakly to __main_argc_argv (main(argc, argv)), which does not
    // pull an archive member: -u does. doctest's is also its implementation,
    // which a project that implements doctest itself already has.
    const frameworkMain = fw && !ownMain && !(framework === 'doctest' && sources.some((p) => implementsDoctest(files[p])));
    const { code, out } = await toolchain.tool(
        WASM,
        'wasm-ld',
        [
            '-m', 'wasm32', '-L' + lib, lib + '/crt1-command.o',
            ...Object.keys(objects),
            ...(cxxProgram ? [lib + '/yukibana-uncaught.o'] : []),
            ...(frameworkMain ? ['-u', '__main_argc_argv', ...fw.main] : []),
            ...(fw ? fw.libs : []),
            // libc-printscan-long-double: without it, printing a long double
            // (printf("%Lf"), or cout, through libc++'s num_put) aborts with
            // "Support for formatting long double values is currently disabled".
            // libunwind: the two functions of wasm exception handling.
            '-lc++', '-lc++abi', '-lunwind', '-lc-printscan-long-double', '-lc',
            '/usr/lib/clang/21/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a',
            // So the runner can flush the program's stdout before it waits
            // for input, as a terminal's C library would (see below).
            '--export-if-defined=fflush', '--export-if-defined=stdout',
            // The C++ exception tag, to recognise an uncaught exception (see
            // below); yukibana-uncaught.o exports its own function.
            '--export-if-defined=__cpp_exception',
            // wasm-ld's default stack is 64 KiB, below the data, so a local
            // `int a[100000]` would overwrite globals without a word. 8 MiB
            // like a Linux main thread, placed first so an overflow runs off
            // the start of memory and traps. (Call depth is limited sooner,
            // by the browser's own stack: see the crash message below.)
            '-z', 'stack-size=8388608', '--stack-first',
            '-o', '.yukibana/program.wasm',
        ],
        objects,
        ['.yukibana/program.wasm'],
        { rewrite: withSourceNames, archives }
    );
    if (code !== 0 || !out['.yukibana/program.wasm']) return code || 1;

    phase(testing ? 'Running the tests' : 'Running');
    const program = await WebAssembly.compile(out['.yukibana/program.wasm']);
    let instance = null;
    const flushStdout = () => {
        const { fflush, stdout, memory } = instance?.exports ?? {};
        if (typeof fflush !== 'function' || !(stdout instanceof WebAssembly.Global)) return;
        fflush(new DataView(memory.buffer).getUint32(stdout.value, true));
    };
    const wasi = createWasi({
        // The frameworks colour their reports only on a terminal they
        // recognise; the app's terminal renders ANSI colours, so they are
        // told to (FRAMEWORKS). The arguments go to a test program, or to
        // the framework's own main; nothing else is in the environment.
        args: ['main', ...(fw && (testing || frameworkMain) ? fw.args : [])],
        env: fw ? fw.env : {},
        stdin,
        write: (fd, text) => post({ type: fd === 1 ? 'stdout' : 'stderr', text }),
        requestInput: () => post({ type: 'stdin' }),
        // C's stdio does not flush stdout when it reads stdin (C++'s cin does,
        // through tie()), so printf("name? ") would stay invisible while the
        // program waits. Flush it here, as glibc would.
        beforeWait: flushStdout,
    });
    instance = await WebAssembly.instantiate(program, wasi.importsFor(program));
    wasi.setMemory(instance.exports.memory);
    try {
        instance.exports._start();
        return 0;
    } catch (error) {
        if (error instanceof ProcExit) return error.code;
        if (typeof WebAssembly.Exception === 'function' && error instanceof WebAssembly.Exception)
            return uncaught(error);
        const message = String(error?.message ?? error);
        // V8 runs wasm on the worker's native stack (about 1 MB), which holds
        // a few thousand nested calls, far fewer than a native process.
        const hint = error instanceof RangeError && /call stack/i.test(message)
            ? ' (stack overflow: the browser allows only a few thousand nested calls)'
            : /^unreachable/.test(message)
              ? ' (abort(), or a failed check: in C++, for example, an index out of range on a vector, string, array or span)'
              : '';
        stderr(`\nThe program crashed: ${message}${hint}\n`);
        return 134;
    } finally {
        wasi.flush();
    }

    /**
     * A C++ exception nobody caught leaves _start as a WebAssembly.Exception
     * (wasm has no search phase that would call std::terminate first). It is
     * handed back to the program, whose yukibana-uncaught.o rethrows it into
     * a catch that calls std::terminate, and libc++abi prints, as natively,
     * "terminating due to uncaught exception of type std::out_of_range:
     * vector" before abort(). Exit status 134, as for abort().
     */
    function uncaught(error) {
        const { __cpp_exception: tag, __yukibana_uncaught: report } = instance.exports;
        try {
            flushStdout();
            if (!(tag instanceof WebAssembly.Tag) || !error.is(tag) || typeof report !== 'function') throw error;
            report(error.getArg(tag, 0));
        } catch (reported) {
            if (reported instanceof ProcExit) return reported.code;
            // The trap of abort() after libc++abi's message; or not a C++
            // exception at all.
            if (reported === error) stderr('\nThe program crashed: an exception nobody caught\n');
        }
        return 134;
    }
}

self.onmessage = ({ data }) => {
    if (data?.type !== 'run' && data?.type !== 'test') return;
    started = performance.now();
    run(data)
        .catch((error) => {
            stderr(`${error?.message ?? error}\n`);
            return 1;
        })
        .then((code) => post({ type: 'exit', code }));
};
