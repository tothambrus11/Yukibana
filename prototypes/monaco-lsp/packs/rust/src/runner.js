// The Rust pack's runner (../../CONTRACT.md, "Running a program"). There is
// no rustc that compiles to a runnable program inside a browser: rustc's
// code generators (LLVM, Cranelift) and its linker do not run on
// WebAssembly. What does run is Miri, rustc's MIR interpreter, compiled to
// wasm32-wasip1 by bjorn3 and packaged by the rubri project: it parses,
// type checks and borrow checks the program with the real compiler front end
// (so compile errors are rustc's own) and then interprets its MIR, the
// standard library's included, which is why the sysroot's rlibs were built
// with every function's MIR in their metadata.
//
//   miri.wasm    Miri (rustc 1.78.0-dev, 2024), wasm32-wasip1, from rubri
//   sysroot.tar  the x86_64-unknown-linux-gnu sysroot's rlibs, reduced to
//                their metadata (the object code is never used)
//   quickcheck-<version>.tar
//                the crates.io packages the pack ships (quickcheck and its
//                dependencies), compiled to metadata the same way by
//                scripts/build-crates.mjs; downloaded only for a project
//                whose Cargo.toml names one (see `crateArgs`)
//
// The project is laid out as Cargo lays it out: src/main.rs is the binary,
// src/lib.rs (if any) a library the binary and the tests use under the
// package's name (from Cargo.toml), tests/*.rs integration tests. A run
// builds the library to metadata (Miri as rustc, MIRI_BE_RUSTC) and
// interprets the binary; a test (type 'test') interprets the unit tests of
// the library and the binary and each integration test, as `cargo test`
// does, and prints libtest's report.
//
// The one thing this Miri cannot do is unwind: its standard library was
// built for Linux rather than for Miri, so a panic ends in
// `_Unwind_RaiseException`, which Miri does not implement. A run reports
// the panic's message and exits 101, as a panicking Rust program does, and
// leaves out Miri's own complaint. Tests run under harness.rs, which tells
// this file what each test did, so that a panicking test can be reported
// and the remaining tests run in a new instance (see harness.rs).
//
// Each step is a fresh instance of miri.wasm (rustc keeps global state).
// Files live in an in-memory WASI file system (browser_wasi_shim); standard
// input blocks the worker on the contract's SharedArrayBuffer.

import { Directory, Fd, File, PreopenDirectory, WASI, WASIProcExit, wasi as defs } from '@bjorn3/browser_wasi_shim';
import HARNESS from './harness.rs';

/* global MIRI_WASM_SIZE, SYSROOT_SIZE, CRATES_FILE, CRATES_SIZE, CRATES_DIRECT */
/** The crates.io packages' metadata (build.sh), or null in a build without them. */
const CRATES = typeof CRATES_FILE === 'string' ? CRATES_FILE : null;
/** The crates a project may depend on, and the version of each that is here. */
const DIRECT = typeof CRATES_DIRECT === 'object' ? CRATES_DIRECT : {};
const SIZES = {
    'miri.wasm': typeof MIRI_WASM_SIZE === 'number' ? MIRI_WASM_SIZE : 0,
    'sysroot.tar': typeof SYSROOT_SIZE === 'number' ? SYSROOT_SIZE : 0,
    ...(CRATES ? { [CRATES]: typeof CRATES_SIZE === 'number' ? CRATES_SIZE : 0 } : {}),
};

/** The target Miri interprets for: the one the sysroot was built for. */
const TARGET = 'x86_64-unknown-linux-gnu';
/** The edition when Cargo.toml names none; 2021 is the newest this rustc knows. */
const DEFAULT_EDITION = '2021';
const EDITIONS = new Set(['2015', '2018', '2021']);
/** Miri's checks for undefined behaviour cost most of its time; a program
 * here is run, not audited, so they are off (as in rubri). Isolation is off
 * so that the clock and the environment work. */
const MIRI_FLAGS = [
    '-Zmiri-disable-isolation',
    '-Zmiri-ignore-leaks',
    '-Zmiri-permissive-provenance',
    '-Zmiri-disable-alignment-check',
    '-Zmiri-disable-data-race-detector',
    '-Zmiri-disable-stacked-borrows',
    '-Zmiri-disable-validation',
    '-Zmir-emit-retag=false',
];
/** How Miri says that the program tried to unwind (see the header). */
const UNWIND = /^error: unsupported operation: can't call foreign function `_Unwind_RaiseException`/;

const post = (msg) => self.postMessage(msg);
const phase = (text) => post({ type: 'phase', text });
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

// ---- downloads

async function download(name) {
    const response = await fetch(new URL(name, import.meta.url));
    if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
    const total = SIZES[name] ?? 0;
    let loaded = 0;
    post({ type: 'loading', label: name, loaded, total });
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

/** Regular files of a ustar archive, as [path, bytes]. */
function untar(tar) {
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
        if (type === '0') files.push([prefix ? `${prefix}/${name}` : name, tar.subarray(at, at + size)]);
        at += Math.ceil(size / 512) * 512;
    }
    return files;
}

/** A Directory tree from [relative path, bytes] pairs. */
function tree(entries) {
    const root = new Map();
    for (const [path, bytes] of entries) {
        const parts = path.split('/').filter(Boolean);
        let dir = root;
        for (const part of parts.slice(0, -1)) {
            let next = dir.get(part);
            if (!next) dir.set(part, (next = new Map()));
            dir = next;
        }
        dir.set(parts.at(-1), new File(bytes, { readonly: true }));
    }
    const build = (map) => new Directory([...map].map(([name, v]) => [name, v instanceof Map ? build(v) : v]));
    return build(root);
}

let toolchain = null;
function load() {
    toolchain ??= (async () => {
        const [wasm, tar] = await Promise.all([download('miri.wasm'), download('sysroot.tar')]);
        const [module, bytes] = await Promise.all([WebAssembly.compileStreaming(wasm), tar.arrayBuffer()]);
        return { module, sysroot: tree(untar(new Uint8Array(bytes))) };
    })();
    return toolchain;
}

let registry = null;
/** The crates.io packages' metadata, as a directory (lib<crate>.rmeta). */
function loadCrates() {
    registry ??= (async () => tree(untar(new Uint8Array(await (await download(CRATES)).arrayBuffer()))))();
    return registry;
}

// ---- standard streams

/** stdout or stderr of one Miri instance: decoded text, to `onText` as
 * written. */
class Output extends Fd {
    constructor(onText) {
        super();
        this.onText = onText;
        this.decoder = new TextDecoder();
    }
    fd_fdstat_get() {
        const stat = new defs.Fdstat(defs.FILETYPE_CHARACTER_DEVICE, 0);
        stat.fs_rights_base = BigInt(defs.RIGHTS_FD_WRITE);
        return { ret: 0, fdstat: stat };
    }
    fd_filestat_get() {
        return { ret: 0, filestat: new defs.Filestat(0n, defs.FILETYPE_CHARACTER_DEVICE, 0n) };
    }
    fd_write(data) {
        const text = this.decoder.decode(data, { stream: true });
        if (text) this.onText(text);
        return { ret: 0, nwritten: data.byteLength };
    }
    close() {
        const rest = this.decoder.decode();
        if (rest) this.onText(rest);
    }
}

/** Calls `onLine` with each complete line (newline included) of a stream,
 * and with what is left at `end()`. */
function lines(onLine) {
    let buffer = '';
    return {
        text(text) {
            buffer += text;
            for (let at; (at = buffer.indexOf('\n')) >= 0; ) {
                const line = buffer.slice(0, at + 1);
                buffer = buffer.slice(at + 1);
                onLine(line);
            }
        },
        end() {
            if (buffer) onLine(buffer);
            buffer = '';
        },
    };
}

/** stdin on the contract's SharedArrayBuffer; end of file without one.
 * One for the whole run, so input typed ahead survives a restart. */
class Input extends Fd {
    constructor(buffer) {
        super();
        this.state = buffer ? new Int32Array(buffer, 0, 2) : null;
        this.data = buffer ? new Uint8Array(buffer, 8) : null;
        this.pending = new Uint8Array(0);
        this.eof = !buffer;
    }
    fd_fdstat_get() {
        const stat = new defs.Fdstat(defs.FILETYPE_CHARACTER_DEVICE, 0);
        stat.fs_rights_base = BigInt(defs.RIGHTS_FD_READ);
        return { ret: 0, fdstat: stat };
    }
    fd_filestat_get() {
        return { ret: 0, filestat: new defs.Filestat(0n, defs.FILETYPE_CHARACTER_DEVICE, 0n) };
    }
    fd_read(size) {
        if (this.pending.length === 0 && !this.eof) this.wait();
        const n = Math.min(size, this.pending.length);
        const out = this.pending.slice(0, n);
        this.pending = this.pending.subarray(n);
        return { ret: 0, data: out };
    }
    /** Asks the app for a line and blocks until it comes (or end of file).
     * Everything the program wrote has been posted already: Output posts
     * as soon as Miri writes, and Rust's stdout flushes at each newline (a
     * prompt without one needs the program's own flush, as natively). */
    wait() {
        const state = this.state;
        Atomics.store(state, 0, 1);
        post({ type: 'stdin' });
        while (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1);
        const s = Atomics.load(state, 0);
        if (s === 2) this.pending = this.data.slice(0, Math.min(Atomics.load(state, 1), this.data.length));
        else this.eof = true;
        Atomics.store(state, 0, 0);
    }
}

// ---- Miri

/**
 * Runs one instance of Miri with these arguments (argv[0] excluded).
 * Returns its exit code, and `panicked` when the program died unwinding
 * from a panic: Miri's report of that is left out of stderr (everything
 * from its first line on), the panic's own message is not. `stdout`
 * receives the program's output instead of the app when given.
 */
function miri({ module, sysroot }, args, { project, out, deps, stdin, env = [], stdout = null }) {
    let panicked = false;
    let swallow = false;
    const err = lines((line) => {
        if (UNWIND.test(plain(line))) swallow = panicked = true;
        if (!swallow) post({ type: 'stderr', text: line });
    });
    const fds = [
        stdin,
        new Output(stdout ?? ((text) => post({ type: 'stdout', text }))),
        new Output(err.text),
        new PreopenDirectory('/sysroot', []),
        new PreopenDirectory('/project', []),
        new PreopenDirectory('/out', []),
        new PreopenDirectory('/tmp', []),
        new PreopenDirectory('/deps', []),
    ];
    fds[3].dir = sysroot;
    fds[4].dir = project;
    fds[5].dir = out;
    if (deps) fds[7].dir = deps;
    const wasi = new WASI(['miri', ...args], env, fds);
    const imports = { wasi_snapshot_preview1: wasi.wasiImport };
    // Anything else the module imports (rubri's build declares thread
    // spawning, which rustc never uses with one thread) fails if called.
    for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
        if (from === 'wasi_snapshot_preview1' || kind !== 'function') continue;
        imports[from] ??= {};
        imports[from][name] ??= () => {
            throw new Error(`${from}.${name} is not available`);
        };
    }
    const instance = new WebAssembly.Instance(module, imports);
    let code;
    try {
        code = wasi.start(instance);
    } catch (e) {
        if (e instanceof WASIProcExit) code = e.code;
        // rustc leaves through a panic after reporting an error (or after
        // Miri reported the program's), and panics abort in this build:
        // the trap is the exit, the report is already on stderr.
        else if (e instanceof WebAssembly.RuntimeError) code = 1;
        else throw e;
    } finally {
        fds[1].close();
        fds[2].close();
        err.end();
    }
    return { code: panicked ? 101 : code, panicked };
}

// ---- the project, as Cargo sees it

/**
 * `[package] name` and `edition` from Cargo.toml, and the crates it names
 * under `[dependencies]` and `[dev-dependencies]` (`name = "1"`, `name = {
 * version = "1", ... }` or a `[dependencies.name]` table), each with its
 * version requirement (null when none is given). A line-based reading,
 * enough for the keys a package needs; anything else in it is ignored.
 * Crate names have dashes as underscores, as code names them.
 */
function manifest(files) {
    const text = files['Cargo.toml'] ?? '';
    let section = '';
    const values = {};
    const dependencies = new Map();
    const devDependencies = new Map();
    const kinds = { dependencies, 'dev-dependencies': devDependencies };
    let table = null; // [map, crate] while in [dependencies.<crate>]
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header) {
            section = header[1].trim();
            const t = /^((?:dev-)?dependencies)\.(.+)$/.exec(section);
            table = t ? [kinds[t[1]], t[2].trim().replace(/^"|"$/g, '').replace(/-/g, '_')] : null;
            if (table) table[0].set(table[1], null);
            continue;
        }
        const kv = /^([A-Za-z_-]+)\s*=\s*"([^"]*)"$/.exec(line);
        if (kv && section === 'package') values[kv[1]] = kv[2];
        if (kv && table && kv[1] === 'version') table[0].set(table[1], kv[2]);
        const dep = /^([A-Za-z0-9_"-]+)\s*=\s*(.*)$/.exec(line);
        if (dep && kinds[section]) {
            const req = /^"([^"]*)"/.exec(dep[2]) ?? /\bversion\s*=\s*"([^"]*)"/.exec(dep[2]);
            kinds[section].set(dep[1].replace(/"/g, '').replace(/-/g, '_'), req ? req[1] : null);
        }
    }
    const name = (values.name || 'app').replace(/-/g, '_');
    const edition = EDITIONS.has(values.edition) ? values.edition : DEFAULT_EDITION;
    return { name, edition, declared: values.edition, dependencies, devDependencies };
}

/**
 * Whether `version` (x.y.z) meets a Cargo version requirement: comma-
 * separated comparators, each `^` (the default), `~`, `=`, `<`, `<=`, `>`,
 * `>=` or a wildcard (`1.*`, `*`), by Cargo's rules (a caret allows changes
 * that keep the leftmost non-zero part). Pre-release requirements are not
 * understood (false).
 */
function satisfies(version, requirement) {
    const v = version.split('.').map(Number);
    const cmp = (a, b) => {
        for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
        return 0;
    };
    return requirement.split(',').every((raw) => {
        const m = /^\s*(\^|~|=|<=|>=|<|>)?\s*(\*|\d+)(?:\.(\*|\d+))?(?:\.(\*|\d+))?\s*$/.exec(raw);
        if (!m) return false;
        const op = m[1] ?? '^';
        const parts = [m[2], m[3], m[4]].filter((p) => p !== undefined && p !== '*').map(Number);
        const wildcard = [m[2], m[3], m[4]].includes('*');
        const low = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
        // The first version past the range a partial or caret requirement allows.
        const bump = (i) => [...parts.slice(0, i), parts[i] + 1, 0, 0].slice(0, 3);
        if (wildcard || (op === '=' && parts.length < 3)) {
            if (parts.length === 0) return true;
            return cmp(v, low) >= 0 && cmp(v, bump(parts.length - 1)) < 0;
        }
        switch (op) {
            case '=': return cmp(v, low) === 0;
            case '>': return parts.length === 3 ? cmp(v, low) > 0 : cmp(v, bump(parts.length - 1)) >= 0;
            case '>=': return cmp(v, low) >= 0;
            case '<': return cmp(v, low) < 0;
            case '<=': return parts.length === 3 ? cmp(v, low) <= 0 : cmp(v, bump(parts.length - 1)) < 0;
            case '~': return cmp(v, low) >= 0 && cmp(v, bump(Math.min(parts.length - 1, 1))) < 0;
            default: {
                // ^: up to the next change of the leftmost non-zero part
                // given (^0.0 and ^0 are partial: the last part given).
                const lead = parts.findIndex((p) => p !== 0);
                const at = lead === -1 ? parts.length - 1 : lead;
                return cmp(v, low) >= 0 && cmp(v, bump(at)) < 0;
            }
        }
    });
}

/**
 * The rustc arguments that give a crate the crates.io packages Cargo.toml
 * asks for, and loads them (only then): `dependencies` for every crate of
 * the project, `devDependencies` too for test crates, as Cargo does (so a
 * Run, `test` false, loads nothing for dev-dependencies alone). A
 * crate that is not here is left to rustc (an unresolved `use` is E0432,
 * as before), and one whose requirement the version here does not meet
 * gets a warning and the version here. Returns `{ normal, dev, dir }`.
 */
async function crateArgs({ dependencies, devDependencies }, test) {
    const pick = (deps) => [...deps].filter(([name]) => DIRECT[name] !== undefined);
    const normal = pick(dependencies);
    const dev = test ? pick(devDependencies) : [];
    if (!CRATES || normal.length + dev.length === 0) return { normal: [], dev: [], dir: null };
    for (const [name, req] of [...normal, ...dev])
        if (req !== null && !satisfies(DIRECT[name], req))
            post({ type: 'stderr', text: `warning: ${name} ${DIRECT[name]} is the only version here; Cargo.toml asks for "${req}"\n` });
    const args = (deps) => deps.flatMap(([name]) => ['--extern', `${name}=/deps/lib${name}.rmeta`]).concat(deps.length ? ['-L', 'dependency=/deps'] : []);
    return { normal: args(normal), dev: args([...normal, ...dev.filter(([n]) => !dependencies.has(n))]), dir: await loadCrates() };
}

/** A cargo status line ("   Compiling x"), on stderr. */
const status = (verb, rest) => post({ type: 'stderr', text: `\u001b[1;32m${verb.padStart(12)}\u001b[0m ${rest}\n` });
const stem = (path) => path.split('/').pop().replace(/\.rs$/, '').replace(/-/g, '_');

async function main({ type, files, entry, stdin }) {
    const test = type === 'test';
    const cargo = manifest(files);
    const { name, edition, declared } = cargo;
    if (declared && !EDITIONS.has(declared))
        post({ type: 'stderr', text: `warning: edition ${declared} is newer than this rustc (1.78); using ${edition}\n` });
    phase('Loading');
    const [tools, deps] = await Promise.all([load(), crateArgs(cargo, test)]);
    const project = tree(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
    const out = new Directory([]);
    const io = { project, out, deps: deps.dir, stdin: new Input(stdin) };
    // Paths in diagnostics and panics as the project names them (src/main.rs).
    const rustc = ['--sysroot', '/sysroot', '--target', TARGET, '--edition', edition, '--color=always', '--remap-path-prefix=/project/='];
    const common = [...rustc, ...MIRI_FLAGS];
    /** Miri as rustc: a crate to metadata with every function's MIR, as
     * cargo-miri builds dependencies. */
    const library = (crate, path, ext = []) =>
        miri(
            tools,
            ['--crate-type=lib', `--crate-name=${crate}`, '--emit=metadata', '-Zalways-encode-mir', '-o', `/out/lib${crate}.rmeta`, path, ...ext, ...rustc],
            { ...io, env: ['MIRI_BE_RUSTC=target'] },
        ).code;

    const bin = files[entry] !== undefined && entry.endsWith('.rs') ? entry : files['src/main.rs'] !== undefined ? 'src/main.rs' : null;
    const lib = files['src/lib.rs'] !== undefined ? 'src/lib.rs' : null;
    const externs = [];

    if (lib && (bin || test)) {
        phase('Compiling');
        status('Compiling', `${name} (src/lib.rs)`);
        const code = library(name, `/project/${lib}`, deps.normal);
        if (code !== 0) return code;
        externs.push('--extern', `${name}=/out/lib${name}.rmeta`, '-L', '/out');
    }

    if (!test) {
        if (!bin) {
            post({ type: 'stderr', text: `error: nothing to run: a binary crate has src/main.rs\n` });
            return 1;
        }
        phase('Running');
        status('Running', bin);
        return miri(tools, [`--crate-name=${bin === 'src/main.rs' ? name : stem(bin)}`, `/project/${bin}`, ...externs, ...deps.normal, ...common], io).code;
    }

    // Tests: unit tests of the library and the binary, then each file of
    // tests/, as `cargo test` runs them, under harness.rs.
    phase('Compiling');
    project.contents.set('.yukibana', tree([['harness.rs', encoder.encode(HARNESS)]]));
    if (library('yukibana_test', '/project/.yukibana/harness.rs') !== 0) return 1;
    const harness = [
        '-Zcrate-attr=feature(custom_test_frameworks)',
        '-Zcrate-attr=test_runner(::yukibana_test::run)',
        '--extern',
        'yukibana_test=/out/libyukibana_test.rmeta',
        '-L',
        '/out',
    ];
    const targets = [];
    if (lib) targets.push([`unittests ${lib}`, lib, name, deps.dev]);
    if (bin) targets.push([`unittests ${bin}`, bin, name, [...externs, ...deps.dev]]);
    for (const path of Object.keys(files).sort())
        if (/^tests\/[^/]+\.rs$/.test(path)) targets.push([path, path, stem(path), [...externs, ...deps.dev]]);
    if (targets.length === 0) {
        post({ type: 'stderr', text: 'error: no tests: no src/lib.rs, src/main.rs or tests/*.rs\n' });
        return 101;
    }
    phase('Testing');
    let failed = false;
    for (const [label, path, crate, ext] of targets) {
        status('Running', label);
        const code = testTarget((env, stdout) =>
            miri(tools, ['--test', `--crate-name=${crate}`, `/project/${path}`, ...ext, ...harness, ...common], { ...io, env, stdout }),
        );
        if (code !== 0) {
            failed = true;
            if (code !== 101) return code; // did not compile: cargo stops there
        }
    }
    return failed ? 101 : 0;
}

// ---- libtest's report, from harness.rs's control lines

/**
 * Runs one test target to the end, restarting it after each test that
 * panicked, and prints libtest's report of it on stdout. `start(env,
 * stdout)` runs one instance. Returns 0 when every test passed, 101 when
 * one failed, and the instance's code when it did not get to the tests
 * (a compile error).
 */
function testTarget(start) {
    const t0 = performance.now();
    const say = (text) => post({ type: 'stdout', text });
    const unescape = (s) => s.replace(/\\(\\|n|x1e|x1f)/g, (_, c) => ({ '\\': '\\', n: '\n', x1e: '\u001e', x1f: '\u001f' })[c]);
    const done = [];
    const failures = []; // [name, text of its stdout section]
    let passed = 0;
    let ignored = 0;
    let count = null;
    for (;;) {
        let current = null; // [name, expected panic message or undefined]
        let ended = false;
        const finish = (name, ok, section) => {
            done.push(name);
            say(ok ? '\u001b[32mok\u001b[0m\n' : '\u001b[31mFAILED\u001b[0m\n');
            if (ok) passed++;
            else failures.push([name, section]);
            current = null;
        };
        const out = lines((line) => {
            if (!line.startsWith('\u001e')) return say(line);
            const body = line.slice(1).replace(/\n$/, '');
            const space = body.indexOf(' ');
            const kind = body.slice(0, space);
            const fields = body.slice(space + 1).split('\u001f').map(unescape);
            if (kind === 'count') {
                if (count === null) {
                    count = Number(fields[0]);
                    say(`\nrunning ${count} test${count === 1 ? '' : 's'}\n`);
                }
            } else if (kind === 'ignored') {
                done.push(fields[0]);
                ignored++;
                say(`test ${fields[0]} ... \u001b[33mignored${fields[1] ? `, ${fields[1]}` : ''}\u001b[0m\n`);
            } else if (kind === 'start') {
                current = [fields[0], fields.length > 1 ? fields[1] : undefined];
                say(`test ${fields[0]} ... `);
            } else if (kind === 'ok') finish(fields[0], true);
            else if (kind === 'fail') finish(fields[0], false, `${fields[1]}${fields[2]}\n`);
            else if (kind === 'panic') {
                const [name, output, location, message] = fields;
                const report = `${output}thread '${name}' panicked at ${location}:\n${message}\n`;
                const expected = current?.[1];
                if (!current) return;
                if (expected === undefined)
                    finish(name, false, `${report}note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace\n`);
                else if (message.includes(expected)) finish(name, true);
                else
                    finish(name, false,
                        `${report}note: panic did not contain expected string\n      panic message: \`${JSON.stringify(message)}\`,\n expected substring: \`${JSON.stringify(expected)}\`\n`);
            } else if (kind === 'end') ended = true;
        });
        const { code, panicked } = start([`YUKIBANA_DONE=${done.join('\n')}`, 'RUST_TEST_THREADS=1'], out.text);
        out.end();
        if (ended) break;
        if (count === null) return code === 0 ? 1 : code; // never reached the tests
        if (!panicked) {
            // Died some other way (Miri said why, on stderr): the running
            // test failed, and the rest still run.
            if (current) finish(current[0], false, '');
            else break;
        }
    }
    const seconds = ((performance.now() - t0) / 1000).toFixed(2);
    if (failures.length) {
        say('\nfailures:\n\n');
        for (const [name, section] of failures) if (section) say(`---- ${name} stdout ----\n${section}\n`);
        say(`failures:\n${failures.map(([name]) => `    ${name}\n`).join('')}`);
    }
    const result = failures.length ? '\u001b[31mFAILED\u001b[0m' : '\u001b[32mok\u001b[0m';
    say(`\ntest result: ${result}. ${passed} passed; ${failures.length} failed; ${ignored} ignored; 0 measured; 0 filtered out; finished in ${seconds}s\n\n`);
    return failures.length ? 101 : 0;
}

self.onmessage = async ({ data }) => {
    if (data?.type !== 'run' && data?.type !== 'test') return;
    let code;
    try {
        code = await main(data);
    } catch (e) {
        post({ type: 'stderr', text: `${e instanceof Error ? e.message : String(e)}\n` });
        code = 1;
    }
    post({ type: 'exit', code });
};
