// The C/C++ pack's toolchain, shared by the runner (runner.js) and the
// compiler output views (explorer.js): downloading and unpacking its files,
// running clang or a linker in a fresh instance of the compiler, and the one
// function that builds clang's arguments, so Run and the views compile with
// exactly the same flags (README, "Targets" and "Compiler output views").
//
//   cc.{js,wasm}            clang + wasm-ld, WebAssembly only: the default
//                           target, wasm32-wasip1 (build-runner.sh)
//   cc-cross.{js,wasm}      clang + ld.lld (ELF): x86_64, aarch64 and riscv64
//                           Linux, musl (build-cross.sh)
//   sysroot.tar.gz          the language server's headers: musl's, libc++'s,
//                           clang's own (and the test frameworks')
//   wasi-sysroot.tar.gz     wasi-libc, libc++ with exceptions, compiler-rt
//   targets/<arch>/include.tar   a Linux target's musl bits/ headers
//   targets/<arch>/lib.tar       its libraries and crt files, only to link
//
// Each tool call gets a fresh instance of the compiled module: clang and lld
// keep global state, and a browser cannot fork. Files go from one instance
// to the next as bytes.

const CXX = /\.(cpp|cc|cxx|c\+\+|C)$/;
const WASM_TARGET = ['--target=wasm32-wasip1', '--sysroot=/wasi', '-resource-dir=/usr/lib/clang/21'];
// C++ exceptions, as WebAssembly exception handling in its standard form
// (exnref, try_table), the form libc++, libc++abi, libunwind and GoogleTest
// in the sysroot are built with (build-cxx-runtime.sh). Without -mllvm the
// compiler would emit the legacy instructions.
const EXCEPTIONS = ['-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false'];
const OBJ_PREFIX = /\.yukibana\/obj\/(\S+?)\.o\b/g;
const decoder = new TextDecoder();

/** Whether a path is a C++ source (by its extension, as clang decides). */
export const isCxx = (path) => CXX.test(path);

/**
 * Entries of a ustar archive (gzipped, or already decoded by the host), as
 * `[absolute path, bytes]` for each regular file, in archive order. Paths are
 * the archive's with a leading `/`. Directories and other entry types are
 * left out. Resolves once the whole body is read.
 */
export async function untar(response) {
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

/**
 * compile_flags.txt, one flag per line (trimmed, empty lines left out), as
 * clangd reads it. A `-std=` that names the other language is left out, so
 * one file serves C and C++ (`cxx`: whether the source is C++).
 */
export function flagsFor(files, cxx) {
    const lines = (files['compile_flags.txt'] ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.filter((flag) => {
        const std = /^-std=(.*)$/.exec(flag);
        if (!std) return true;
        return /\+\+/.test(std[1]) === cxx;
    });
}

// Sanitizers that are not UndefinedBehaviorSanitizer's checks (README,
// "Sanitizers"): every other name -fsanitize= takes is one of UBSan's
// checks or groups ("undefined", "integer", "nullability", "bounds", ...),
// whose reports come from UBSan's runtime.
const NOT_UBSAN = new Set(['address', 'leak', 'thread', 'memory', 'hwaddress', 'kernel-address', 'kernel-hwaddress',
    'kernel-memory', 'dataflow', 'safe-stack', 'shadow-call-stack', 'fuzzer', 'fuzzer-no-link', 'scudo', 'kcfi',
    'memtag', 'memtag-stack', 'memtag-heap', 'memtag-globals', 'type', 'realtime', 'numerical', 'cfi']);

/**
 * The sanitizers the project's flags (compile_flags.txt, as flagsFor gives
 * them) turn on, as clang reads -fsanitize= and -fno-sanitize= lists in
 * order (`all` included): `{ address, undefined, minimal, runtime, flags }`.
 * `address`: AddressSanitizer (with LeakSanitizer, as on Linux).
 * `undefined`: some UBSan check is on. `minimal`:
 * -fsanitize-minimal-runtime. `runtime`: the runtime the program links,
 * 'asan' (which holds UBSan's too), 'ubsan', or null when nothing needs one
 * (no sanitizer, or every UBSan check traps: -fsanitize-trap or
 * -fsanitize-trap=undefined/all). `flags`: the project's flags that are
 * about sanitizers, in order, which a link passes on to clang's driver.
 * Approximate where clang is subtle (-fno-sanitize= of one check inside a
 * group leaves the group on; -fsanitize-trap= of some checks traps none):
 * it decides which runtime to fetch, and clang still decides the code.
 */
export function sanitizersOf(flags) {
    const isUbsan = (name) => !NOT_UBSAN.has(name) && !/^cfi/.test(name);
    let on = [];
    let trapped = false;
    let minimal = false;
    const mine = [];
    for (const flag of flags) {
        let m;
        if ((m = /^-f(no-)?sanitize=(.*)$/.exec(flag))) {
            mine.push(flag);
            for (const name of m[2].split(',').filter(Boolean)) {
                if (!m[1]) on.push(name);
                else if (name === 'all') on = [];
                else if (name === 'undefined') on = on.filter((n) => !isUbsan(n));
                else on = on.filter((n) => n !== name);
            }
        } else if ((m = /^-f(no-)?sanitize-trap(?:=(.*))?$/.exec(flag))) {
            mine.push(flag);
            const names = (m[2] ?? 'all').split(',');
            if (names.includes('all') || names.includes('undefined')) trapped = !m[1];
        } else if (/^-f(no-)?sanitize-minimal-runtime$/.test(flag)) {
            mine.push(flag);
            minimal = !flag.startsWith('-fno-');
        } else if (/^-f(no-)?sanitize-|^-(shared|static)-libsan$/.test(flag)) {
            mine.push(flag);
        }
    }
    const address = on.includes('address');
    const undefined_ = on.some(isUbsan);
    const runtime = address ? 'asan' : undefined_ && !trapped ? 'ubsan' : null;
    return { address, undefined: undefined_, minimal, runtime, flags: mine };
}

/**
 * clang's arguments for compiling `source` (a project path) of the project
 * `files` for `target` (a row of src/targets.js), without the action and the
 * file names (`-c source -o object`, `-S`, ...), which the caller adds. The
 * runner and the explorer both call this, so what the views show is what Run
 * compiles; `{ view: true }` adds only `-gline-tables-only` (line tables, for
 * the source mapping) and `-fno-discard-value-names` (readable IR), neither
 * of which changes the generated code (test-emit.mjs checks it).
 *
 * - The default target (`wasm32-wasip1`): exactly the runner's arguments of
 *   before targets existed: `--target=wasm32-wasip1 --sysroot=/wasi
 *   -resource-dir=...`, `-O2` unless the project gives a `-O`, for C++ the
 *   WebAssembly exceptions flags and libc++'s fast hardening (unless the
 *   project sets `_LIBCPP_HARDENING_MODE`), then the project's flags as they
 *   are.
 * - A Linux target: `--target=<triple> -resource-dir=/usr/lib/clang/21`, the
 *   same `-O2` default and hardening, then the project's flags as they are
 *   (their target flag names the same triple: that is how the target was
 *   chosen). Exceptions are on by default there.
 * - With a sanitizer (sanitizersOf), before the project's flags, so that
 *   its own -g or -fomit-frame-pointer wins: `-gline-tables-only`, so that
 *   a report names lines (it does not change the code), and on a Linux
 *   target with AddressSanitizer `-fno-omit-frame-pointer`, which its fast
 *   unwinder needs for the stacks of malloc and free (as clang's
 *   AddressSanitizer documentation asks).
 */
export function compileArgs(target, files, source, { view = false } = {}) {
    const cxx = isCxx(source);
    const flags = flagsFor(files, cxx);
    const optimise = flags.some((f) => /^-O/.test(f)) ? [] : ['-O2'];
    // libc++'s "fast" hardening: vector/string/span/array operator[],
    // front(), back() and the like check their bounds and stop the program
    // (a trap, "unreachable", or SIGILL/SIGTRAP on Linux) instead of
    // corrupting memory silently, the most common student bug. Plain arrays
    // and pointers stay unchecked. A project that sets its own mode in
    // compile_flags.txt keeps it.
    const hardening = cxx && !flags.some((f) => f.includes('_LIBCPP_HARDENING_MODE'))
        ? ['-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST']
        : [];
    const debug = view ? ['-gline-tables-only', '-fno-discard-value-names'] : [];
    const linux = target.runtime === 'linux';
    const sanitize = sanitizersOf(flags);
    const sanitizing = sanitize.address || sanitize.undefined
        ? ['-gline-tables-only', ...(linux && sanitize.address ? ['-fno-omit-frame-pointer'] : [])]
        : [];
    if (!linux) {
        // A project's -fno-exceptions in compile_flags.txt comes later and wins.
        return [...WASM_TARGET, ...optimise, ...(cxx ? EXCEPTIONS : []), ...hardening, ...sanitizing, ...flags, ...debug];
    }
    return [`--target=${target.triple}`, '-resource-dir=/usr/lib/clang/21', ...optimise, ...hardening, ...sanitizing, ...flags, ...debug];
}

/**
 * Splits one command line that clang's `-###` prints (each argument in
 * double quotes, with `\"` and `\\` escaped) into its arguments; an
 * unquoted word counts as one argument.
 */
export function splitCommandLine(line) {
    const args = [];
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    for (let m; (m = re.exec(line)); ) args.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
    return args;
}

/** Link errors name the sources: `.yukibana/obj/main.cpp.o` reads `main.cpp`. */
export const withSourceNames = (text) => text.replace(OBJ_PREFIX, '$1');

/**
 * A toolchain bound to one place its files come from.
 *
 * - `base`: the URL of the directory holding `cc.js`, `sysroot.tar.gz`, ...
 *   (the workers pass `new URL('./', import.meta.url)`; tests a `file:` URL).
 * - `fetch`: fetches a URL to a Response (default: the global fetch). Tests
 *   inject one that reads files; a `.wasm` must come with the
 *   `application/wasm` type, as for any WebAssembly.compileStreaming.
 * - `post`: receives `{ type: 'loading', label, loaded, total }` for every
 *   download, and `{ type: 'stderr', text }` for every tool's output (the
 *   runner protocol's messages, which the explorer also uses).
 * - `sizes`: file name to its size after decoding, for `total` (a host that
 *   sends `.br` gives a compressed Content-Length); 0 when unknown.
 *
 * Downloads start once per file and are shared by every caller (one that
 * failed is tried again by the next caller); `release()` forgets them, the compiled modules included, so their memory can be freed.
 * `post` is the function given, for linkLinux.
 */
export function createToolchain({ base, fetch: fetchImpl = (url) => fetch(url), post = () => {}, sizes = {} }) {
    // Each cache maps a name to the promise of its value, made once.
    const downloads = new Map();
    const unpacked = new Map();
    const compilers = new Map();
    const loaded = new Map();
    // A promise that rejects is forgotten, so the next caller tries again: a
    // worker that lives for a session (explorer.js) must not keep a network
    // blip's "HTTP 503" for the rest of it. Callers already waiting on it
    // still see the rejection.
    const once = (cache, key, make) => {
        if (!cache.has(key)) {
            const promise = make();
            cache.set(key, promise);
            promise.catch(() => {
                if (cache.get(key) === promise) cache.delete(key);
            });
        }
        return cache.get(key);
    };

    /** Fetches a file next to the compiler, reporting progress; one fetch per name. */
    function download(name) {
        return once(downloads, name, async () => {
            const response = await fetchImpl(new URL(name, base));
            if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
            const total = sizes[name] ?? 0;
            let loaded = 0; // bytes after decoding
            post({ type: 'loading', label: name, loaded, total });
            // Count bytes on a copy; the original response goes to
            // compileStreaming untouched, so the browser can reuse its
            // cached compiled code next run.
            const reader = response.clone().body.getReader();
            (async () => {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    loaded += value.length;
                    post({ type: 'loading', label: name, loaded, total: Math.max(total, loaded) });
                }
            })().catch(() => {});
            return response;
        });
    }

    /** An archive's entries (`[path, bytes]`), fetched and unpacked once per name. */
    function archive(name) {
        return once(unpacked, name, () => download(name).then(untar));
    }

    /** A compiler's glue and compiled module, once each. */
    function compiler(id) {
        return once(compilers, id, async () => {
            const [{ default: create }, wasm] = await Promise.all([
                import(new URL(`${id}.js`, base).href),
                download(`${id}.wasm`),
            ]);
            return { create, module: await WebAssembly.compileStreaming(wasm) };
        });
    }

    /**
     * The files a target's compiler sees, as `[path, bytes]`; later entries
     * replace earlier ones of the same path.
     *
     * - `wasm32-wasip1` (cc): libc++'s headers from sysroot.tar.gz laid under
     *   the WASI sysroot where clang's WASI driver looks for them, clang's own
     *   headers, the test frameworks' and RapidCheck's headers, then wasi-sysroot.tar.gz (its
     *   __config_site replaces the musl one). Not the musl headers: the
     *   target is WASI, not Linux.
     * - Linux (cc-cross): sysroot.tar.gz's /usr/include (musl, libc++ in
     *   /usr/include/c++/v1, x86_64's bits/) and clang's headers, then the
     *   target's include.tar (/usr/include/<multiarch>/bits, which clang
     *   searches before /usr/include) and, with `link`, its lib.tar.
     */
    async function filesFor(target, link) {
        if (target.runtime !== 'linux') {
            const [server, wasi] = await Promise.all([archive('sysroot.tar.gz'), archive('wasi-sysroot.tar.gz')]);
            const files = [];
            for (const [path, bytes] of server) {
                if (path.startsWith('/usr/include/c++/v1/'))
                    files.push(['/wasi/include/wasm32-wasip1/c++/v1/' + path.slice('/usr/include/c++/v1/'.length), bytes]);
                else if (/^\/usr\/include\/(gtest\/|catch2\/|doctest\/|rapidcheck\/|rapidcheck\.h$)/.test(path)) files.push(['/wasi/include/' + path.slice('/usr/include/'.length), bytes]);
                else if (path.startsWith('/usr/lib/clang/')) files.push([path, bytes]);
            }
            files.push(...wasi);
            return files;
        }
        const parts = await Promise.all([
            archive('sysroot.tar.gz'),
            archive(`targets/${target.arch}/include.tar`),
            ...(link ? [archive(`targets/${target.arch}/lib.tar`)] : []),
        ]);
        return parts.flat();
    }

    /**
     * Starts every download a target needs at once and resolves when its
     * compiler can run: `{ create, module, files }`. `link`: also the target's
     * libraries (a Linux target's lib.tar; the default target's are in its
     * sysroot anyway). Resolves to the same object for the same arguments.
     */
    function load(target, { link = false } = {}) {
        return once(loaded, `${target.id}${link ? '+link' : ''}`, () =>
            Promise.all([compiler(target.compiler), filesFor(target, link)]).then(([c, files]) => ({ ...c, files })));
    }

    /**
     * Runs one tool of `target`'s compiler (argv[0] picks it: "clang",
     * "clang++", "wasm-ld" or "ld.lld") in a fresh instance, with its files
     * the files of the `archives` named (a test framework's libraries; see
     * `archive`), and `inputs` (project path to text or bytes) under
     * /workspace, the working directory. Resolves to `{ code, out, text }`: the exit code, the
     * files the tool wrote that `outputs` names (missing when it did not),
     * and everything it printed. What it printed also goes to `post` as
     * stderr, through `rewrite`, unless `quiet`. `prepare(FS)`, when given,
     * runs on the instance's file system just before the tool does. Rejects when the instance
     * cannot even start (say, its memory was refused).
     */
    async function tool(target, argv0, args, inputs, outputs, { rewrite = (text) => text, quiet = false, link = false, archives = [], prepare } = {}) {
        const { create, module, files } = await load(target, { link });
        const more = (await Promise.all(archives.map(archive))).flat();
        let code = null;
        const lines = [];
        // Emscripten waits for done() and has no way to hear that
        // instantiation failed (say, the 64 MB initial memory was refused),
        // so create() alone would never settle and the run would never post
        // 'exit'. The failure rejects this one instead.
        let failed;
        const failure = new Promise((_, reject) => (failed = reject));
        const cc = await Promise.race([
            create({
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
        for (const [path, bytes] of more) put(path, bytes);
        for (const [path, content] of Object.entries(inputs)) put(`/workspace/${path}`, content);
        // Clang's WASI driver adds the target's libc++ directory only when
        // this generic one exists (wasi-sdk ships it empty too).
        if (target.runtime !== 'linux') FS.mkdirTree('/wasi/include/c++/v1');
        prepare?.(FS);
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
        const text = lines.length ? rewrite(lines.join('\n') + '\n') : '';
        if (text && !quiet) post({ type: 'stderr', text });
        return { code: code ?? 0, out, text };
    }

    /** Forgets every download and compiled module, so that their memory can be freed. */
    function release() {
        downloads.clear();
        unpacked.clear();
        compilers.clear();
        loaded.clear();
    }

    return { download, archive, load, tool, release, post };
}

/**
 * Links `objects` (path to bytes; `.yukibana/obj/<source>.o`) into a static
 * ELF program for a Linux `target` with `toolchain` (from createToolchain),
 * the way clang itself would: `clang -### --target=<triple> -static
 * <objects> -o a.out` prints the ld.lld command line clang's Linux driver
 * builds (crt files, -lc++, compiler-rt, libunwind, libc, from the target's
 * lib.tar), and ld.lld runs with exactly those arguments (a browser cannot
 * spawn it from clang). `cxx`: link as clang++ (libc++). `libs`: `-l`
 * flags after the objects (a test framework's, RapidCheck's), whose
 * libraries are in the `archives` named (toolchain `archive` names, laid
 * into the linker's file system with lib.tar's). Resolves to
 * `{ code, program }`; on failure the messages (with source names for
 * objects) went to the toolchain's `post` as stderr and `program` is null.
 * `sanitize` (sanitizersOf): its flags go to the driver, which adds the
 * runtimes (from the archive targets/<arch>/asan.tar or ubsan.tar, among
 * `archives`); with AddressSanitizer the program is dynamically linked
 * against musl (libc.so, in asan.tar), as AddressSanitizer refuses a
 * static program ("_DYNAMIC" undefined: AsanDoesNotSupportStaticLinkage),
 * and needs /lib/ld-musl-<arch>.so.1 to run.
 * A separate function, not a toolchain method, so that the default target's
 * runner.js does not carry it (runner-linux.js does).
 */
export async function linkLinux(toolchain, objects, target, { cxx = true, libs = [], archives = [], sanitize = null } = {}) {
    const names = Object.keys(objects);
    const plan = await toolchain.tool(target, cxx ? 'clang++' : 'clang',
        // -no-canonical-prefixes: the driver's InstalledDir, where it finds
        // ld.lld, is then argv[0]'s directory, /usr/bin; canonicalised, it
        // would come from the executable's own path, which a wasm module
        // does not have.
        [`--target=${target.triple}`, '-resource-dir=/usr/lib/clang/21', '-no-canonical-prefixes',
            ...(sanitize?.address ? [] : ['-static']), ...(sanitize?.flags ?? []), ...names, ...libs, '-o', 'a.out', '-###'],
        objects, [], {
            quiet: true,
            link: true,
            archives,
            // An installation's /usr/bin, as executables the driver can
            // find: it looks for ld.lld (CLANG_DEFAULT_LINKER=lld) in its
            // InstalledDir, and prints a linker it cannot find as plain "ld".
            prepare(FS) {
                FS.mkdirTree('/usr/bin');
                for (const name of ['clang', 'clang++', 'ld.lld']) {
                    FS.writeFile(`/usr/bin/${name}`, '');
                    FS.chmod(`/usr/bin/${name}`, 0o755);
                }
            },
        });
    const line = plan.text.split('\n').find((l) => /^\s*"[^"]*ld\.lld"/.test(l));
    if (plan.code !== 0 || !line) {
        const text = withSourceNames(plan.text) || 'clang printed no ld.lld command line\n';
        toolchain.post({ type: 'stderr', text });
        return { code: plan.code || 1, program: null };
    }
    const { code, out } = await toolchain.tool(target, 'ld.lld', splitCommandLine(line).slice(1), objects, ['a.out'],
        { rewrite: withSourceNames, link: true, archives });
    const program = code === 0 ? out['a.out'] ?? null : null;
    return { code: program ? 0 : code || 1, program };
}
