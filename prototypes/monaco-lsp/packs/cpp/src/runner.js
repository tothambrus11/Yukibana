// The C/C++ pack's runner (../../CONTRACT.md, "Running a program"): compiles
// every .c/.cpp of the project with clang 21, links them with wasm-ld into a
// wasm32-wasip1 program, and runs that program in this worker on the small
// WASI host in wasi.js. Everything happens here, in the browser:
//
//   cc.wasm              clang + wasm-ld, one Emscripten binary (LLVM's
//                        multi-call driver), built by build-runner.sh
//   sysroot.tar.gz       the language server's headers; the runner takes
//                        libc++'s headers and clang's own from it (same URL,
//                        so the browser downloads it once for both workers)
//   wasi-sysroot.tar.gz  wasi-libc's headers, libc++'s __config_site for WASI,
//                        the static libraries (libc++ with exceptions) and
//                        compiler-rt
//   gtest.tar            GoogleTest's libraries, fetched only to build tests
//                        (type 'test') or a program that includes <gtest/...>;
//                        its headers are in sysroot.tar.gz
//
// Each tool call gets a fresh instance of cc.wasm (compiled once): clang and
// lld keep global state, and a browser cannot fork. Files go from one
// instance to the next as bytes.

import { createWasi, ProcExit } from './wasi.js';

/* global CC_WASM_SIZE, WASI_SYSROOT_SIZE, SYSROOT_SIZE, GTEST_SIZE */
const SIZES = {
    'cc.wasm': typeof CC_WASM_SIZE === 'number' ? CC_WASM_SIZE : 0,
    'wasi-sysroot.tar.gz': typeof WASI_SYSROOT_SIZE === 'number' ? WASI_SYSROOT_SIZE : 0,
    'sysroot.tar.gz': typeof SYSROOT_SIZE === 'number' ? SYSROOT_SIZE : 0,
    'gtest.tar': typeof GTEST_SIZE === 'number' ? GTEST_SIZE : 0,
};

const TARGET = ['--target=wasm32-wasip1', '--sysroot=/wasi', '-resource-dir=/usr/lib/clang/21'];
// C++ exceptions, as WebAssembly exception handling in its standard form
// (exnref, try_table), the form libc++, libc++abi, libunwind and GoogleTest
// in the sysroot are built with (build-cxx-runtime.sh). Without -mllvm the
// compiler would emit the legacy instructions.
const EXCEPTIONS = ['-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false'];
const CXX = /\.(cpp|cc|cxx|c\+\+|C)$/;
const C = /\.c$/;
const OBJ = '.yukibana/obj/';
const LIB = '/wasi/lib/wasm32-wasip1';
/** Where a project keeps its tests (type 'test'); left out of a plain run. */
const TESTS = /^tests\//;
const INCLUDES_GTEST = /#\s*include\s*[<"]gtest\//;

/** Whether a source defines main: `int main(` or `auto main(` outside
 * comments. A heuristic, enough to leave the program's own main out of a
 * test build and to link GoogleTest's main only when there is none. */
const definesMain = (text) =>
    /\b(?:int|auto)\s+main\s*\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));

const post = (msg) => self.postMessage(msg);
const phase = (text) => post({ type: 'phase', text });
const stderr = (text) => post({ type: 'stderr', text });
const decoder = new TextDecoder();

// ---- downloads

async function download(name) {
    const response = await fetch(new URL(name, import.meta.url));
    if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
    const total = SIZES[name] ?? 0;
    let loaded = 0;
    post({ type: 'loading', label: name, loaded, total });
    // Count bytes on a copy; the original response goes to compileStreaming
    // untouched, so the browser can reuse its cached compiled code next run.
    const counted = response.clone();
    const reader = counted.body.getReader();
    (async () => {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.length;
            post({ type: 'loading', label: name, loaded, total: Math.max(total, loaded) });
        }
    })().catch(() => {});
    return response;
}

/** Entries of a ustar archive, gzipped or already decoded by the host. */
async function untar(response) {
    let tar = new Uint8Array(await response.arrayBuffer());
    if (tar[0] === 0x1f && tar[1] === 0x8b)
        tar = new Uint8Array(await new Response(new Response(tar).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const field = (at, length) => {
        const end = tar.indexOf(0, at);
        return decoder.decode(tar.subarray(at, end < 0 || end > at + length ? at + length : end));
    };
    const files = [];
    for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
        const name = field(at, 100);
        const prefix = field(at + 345, 155);
        const size = parseInt(field(at + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(tar[at + 156] || 48);
        at += 512;
        if (type === '0') files.push(['/' + (prefix ? `${prefix}/${name}` : name), tar.subarray(at, at + size)]);
        at += Math.ceil(size / 512) * 512;
    }
    return files;
}

// ---- the toolchain

let toolchain = null;

/** Starts all downloads at once; resolves when clang can run. */
function load() {
    toolchain ??= (async () => {
        const [{ default: createCC }, wasm, wasiTar, serverTar] = await Promise.all([
            import('./cc.js'),
            download('cc.wasm'),
            download('wasi-sysroot.tar.gz'),
            download('sysroot.tar.gz'),
        ]);
        const [module, wasi, server] = await Promise.all([
            WebAssembly.compileStreaming(wasm),
            untar(wasiTar),
            untar(serverTar),
        ]);
        // From the server's sysroot: libc++'s headers, laid under the WASI
        // sysroot where clang's WASI driver looks for them, and clang's own
        // headers. Not its musl headers: the target is WASI, not Linux.
        // GoogleTest's headers too: they are a few dozen small files.
        const files = [];
        for (const [path, bytes] of server) {
            if (path.startsWith('/usr/include/c++/v1/'))
                files.push(['/wasi/include/wasm32-wasip1/c++/v1/' + path.slice('/usr/include/c++/v1/'.length), bytes]);
            else if (path.startsWith('/usr/include/gtest/')) files.push(['/wasi/include/' + path.slice('/usr/include/'.length), bytes]);
            else if (path.startsWith('/usr/lib/clang/')) files.push([path, bytes]);
        }
        files.push(...wasi); // after: its __config_site replaces the musl one
        return { createCC, module, files };
    })();
    return toolchain;
}

let gtest = null;

/** Adds GoogleTest's libraries to the toolchain's files (once). */
function loadGtest() {
    gtest ??= (async () => {
        const [{ files }, tar] = await Promise.all([load(), download('gtest.tar')]);
        files.push(...(await untar(tar)));
    })();
    return gtest;
}

/**
 * Runs one tool (argv[0] picks it: "clang" or "wasm-ld") in a fresh instance
 * with the sysroot and the given files under /workspace. Resolves to the
 * exit code and the files the tool wrote that `outputs` names.
 */
async function tool(argv0, args, inputs, outputs, rewrite = (text) => text) {
    const { createCC, module, files } = await load();
    let code = null;
    const lines = [];
    // Emscripten waits for done() and has no way to hear that instantiation
    // failed (say, the 64 MB initial memory was refused), so createCC alone
    // would never settle and the run would never post 'exit'. The failure
    // rejects this one instead, and run()'s caller reports it.
    let failed;
    const failure = new Promise((_, reject) => (failed = reject));
    const cc = await Promise.race([
        createCC({
            thisProgram: `/usr/bin/${argv0}`,
            instantiateWasm(imports, done) {
                WebAssembly.instantiate(module, imports).then(
                    (instance) => done(instance, module),
                    (error) => failed(new Error(`${argv0} could not start: ${error?.message ?? error}`))
                );
                return {};
            },
            print: (line) => lines.push(line),
            printErr: (line) => lines.push(line),
            onExit: (status) => (code = status),
            onAbort: (reason) => lines.push(`${argv0} aborted: ${reason}`),
        }),
        failure,
    ]);
    const { FS } = cc;
    const dirs = new Set();
    const put = (path, bytes) => {
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (!dirs.has(dir)) {
            FS.mkdirTree(dir);
            dirs.add(dir);
        }
        FS.writeFile(path, bytes, { canOwn: true });
    };
    for (const [path, bytes] of files) put(path, bytes);
    for (const [path, content] of Object.entries(inputs)) put(`/workspace/${path}`, content);
    // Clang's WASI driver adds the target's libc++ directory only when this
    // generic one exists (wasi-sdk ships it empty too).
    FS.mkdirTree('/wasi/include/c++/v1');
    for (const path of outputs) FS.mkdirTree(`/workspace/${path}`.replace(/\/[^/]*$/, ''));
    FS.chdir('/workspace');
    try {
        const r = cc.callMain(args);
        code ??= r;
    } catch (error) {
        if (error?.name === 'ExitStatus') code = error.status;
        else {
            lines.push(`${argv0} crashed: ${error?.message ?? error}`);
            code = 70;
        }
    }
    const out = {};
    for (const path of outputs) {
        try {
            out[path] = FS.readFile(`/workspace/${path}`);
        } catch {
            // not written: the tool failed and said why
        }
    }
    if (lines.length) stderr(rewrite(lines.join('\n') + '\n'));
    return { code: code ?? 0, out };
}

/** compile_flags.txt, one flag per line, as clangd reads it. A -std= that
 * names the other language is left out, so one file serves C and C++. */
function flagsFor(files, cxx) {
    const lines = (files['compile_flags.txt'] ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.filter((flag) => {
        const std = /^-std=(.*)$/.exec(flag);
        if (!std) return true;
        return /\+\+/.test(std[1]) === cxx;
    });
}

// ---- running the program, or its tests

/**
 * type 'run': every .c/.cpp of the project except those under tests/.
 * type 'test': the project's sources without the program's main (the entry
 * file, and any other file that defines main) plus tests/**, linked with
 * GoogleTest and, unless a test file has its own main, gtest_main.
 */
async function run({ type, files, entry, stdin }) {
    const all = Object.keys(files)
        .filter((p) => CXX.test(p) || C.test(p))
        .sort();
    const testing = type === 'test';
    let sources;
    if (testing) {
        const tests = all.filter((p) => TESTS.test(p));
        if (tests.length === 0) {
            stderr('No tests to run: put GoogleTest files in tests/, for example tests/geometry_test.cpp.\n');
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
    const usesGtest = testing || sources.some((p) => INCLUDES_GTEST.test(files[p]));
    const cxxProgram = sources.some((p) => CXX.test(p));
    phase('Loading the compiler');
    await (usesGtest ? Promise.all([load(), loadGtest()]) : load());

    const objects = {};
    for (const [i, source] of sources.entries()) {
        phase(`Compiling ${source} (${i + 1}/${sources.length})`);
        const cxx = CXX.test(source);
        // Named after its source, so the linker's "defined in" names the
        // student's file (the prefix is taken out of its messages below).
        const object = `${OBJ}${source}.o`;
        const flags = flagsFor(files, cxx);
        const optimise = flags.some((f) => /^-O/.test(f)) ? [] : ['-O2'];
        // A project's -fno-exceptions in compile_flags.txt comes later and wins.
        const exceptions = cxx ? EXCEPTIONS : [];
        // libc++'s "fast" hardening: vector/string/span/array operator[],
        // front(), back() and the like check their bounds and stop the
        // program (a trap, "unreachable") instead of corrupting memory
        // silently, the most common student bug. libc++'s message would need
        // its experimental assertion semantics, so the crash hint names the
        // likely cause instead. Plain arrays and pointers stay unchecked.
        // A project that sets its own mode in compile_flags.txt keeps it.
        const hardening = cxx && !flags.some((f) => f.includes('_LIBCPP_HARDENING_MODE'))
            ? ['-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST']
            : [];
        const { code, out } = await tool(
            'clang',
            [...TARGET, ...optimise, ...exceptions, ...hardening, ...flags, '-fno-color-diagnostics', '-c', source, '-o', object],
            files,
            [object]
        );
        if (code !== 0 || !out[object]) return code || 1;
        objects[object] = out[object];
    }

    phase('Linking');
    const lib = LIB;
    // GoogleTest's main is in an archive, and wasi-libc's __main_void only
    // refers weakly to __main_argc_argv (main(argc, argv)), which does not
    // pull an archive member: -u does.
    const gtestMain = usesGtest && !sources.some((p) => definesMain(files[p]));
    const { code, out } = await tool(
        'wasm-ld',
        [
            '-m', 'wasm32', '-L' + lib, lib + '/crt1-command.o',
            ...Object.keys(objects),
            ...(cxxProgram ? [lib + '/yukibana-uncaught.o'] : []),
            ...(gtestMain ? ['-u', '__main_argc_argv', '-lgtest_main'] : []),
            ...(usesGtest ? ['-lgtest'] : []),
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
        (text) => text.replace(/\.yukibana\/obj\/(\S+?)\.o\b/g, '$1')
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
        args: ['main'],
        // GoogleTest colours its report only on a terminal it recognises;
        // the app's terminal renders ANSI colours, so it is told to, as
        // --gtest_color=yes would (the environment also reaches a test file
        // with its own main, whatever it does with argv). Nothing else is in
        // the environment.
        env: usesGtest ? { GTEST_COLOR: 'yes' } : {},
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
    run(data)
        .catch((error) => {
            stderr(`${error?.message ?? error}\n`);
            return 1;
        })
        .then((code) => post({ type: 'exit', code }));
};
