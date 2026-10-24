// The Swift toolchain that runs in the browser, from Ambrus Tóth's
// swift-toolchain-wasm, driven over an in-memory file system with no driver
// in between:
//
//   swift-frontend-lsp.wasm  Swift 6.3.3's compiler frontend and sourcekitd
//                            (with sourcekit-lsp-lite) in one wasm32-wasip1
//                            reactor module: `swift_frontend_main` compiles,
//                            the `lsp_*` exports are the language server
//   wasm-ld.wasm             LLVM's wasm linker, a WASI command
//
// Shared by server.js (the language server, src/lite.js) and runner.js
// (compile, link, run). Both fetch the same URLs, so the browser and the
// app's service worker hold one copy.
//
// Where this came from: the argument vectors, the tar reader and the
// "every WASI tool runs over one shared file system" design are ported from
// tothambrus11/yukibana-swift packages/runtime/src/ (pipeline.ts, tar.ts,
// run.ts, vfs.ts, wasm-backend.ts), which captured the vectors from a real
// `swiftc -target wasm32-unknown-wasip1 -v`. The WASI implementation is the
// same library that runtime uses, @bjorn3/browser_wasi_shim 0.4.2, bundled
// in by esbuild.

import { ConsoleStdout, Directory, Fd, File, OpenFile, PreopenDirectory, WASI, WASIProcExit, wasi as wasiDefs } from '@bjorn3/browser_wasi_shim';
import { SwiftPluginHost } from './vendor/swift-plugin-host.mjs';

export { ConsoleStdout, Directory, Fd, File, OpenFile, PreopenDirectory, WASI, WASIProcExit, wasiDefs };

export const SWIFT_VERSION = '6.3.3';

export const SYSROOT = '/sysroot';
const WASI_SYSROOT = `${SYSROOT}/wasi-sysroot`;
const RESOURCES = `${SYSROOT}/swift/lib/swift_static`;
export const MODULE_CACHE = '/tmp/module-cache';

/**
 * What the driver would pass to `swift-frontend -frontend` for
 * wasm32-unknown-wasip1. `moduleName` is `main` unless a test file imports
 * the project under another name (see xctest.js, projectModuleName).
 */
export function commonFrontendArgs(moduleName = 'main') {
    return [
        '-target', 'wasm32-unknown-wasip1',
        // wasm has no Objective-C runtime; the driver always passes this for wasi.
        '-disable-objc-interop',
        '-sdk', WASI_SYSROOT,
        '-resource-dir', RESOURCES,
        '-use-static-resource-dir',
        '-no-color-diagnostics',
        '-Xcc', '-fno-color-diagnostics',
        // Clang builds the SwiftShims module implicitly and caches it here; the
        // cache lives as long as the worker, so only the first compile pays.
        '-module-cache-path', MODULE_CACHE,
        ...macroPluginArgs(),
        '-module-name', moduleName,
    ];
}

// ---------------------------------------------------------------- macros

/**
 * The macro plugins, one WASI module from swift-toolchain-wasm (its Stage
 * 37): the example `StringifyMacros`, Observation's `ObservationMacros` and
 * swift-testing's `TestingMacros`, sharing one copy of swift-syntax. Every
 * compile and sourcekitd are told (macroPluginArgs) that they are an
 * in-process plugin library at MACRO_PLUGIN_PATH; the file is there only
 * when loadMacroPlugins() has put it there, for code that uses one of their
 * macros (usesMacroPlugins). Without it a macro use is a diagnostic, "could
 * not be found ...; No such file or directory", like a missing plugin on a
 * native host.
 */
export const MACRO_PLUGINS_WASM = 'SwiftMacroPlugins.wasm';
export const MACRO_PLUGIN_PATH = `${SYSROOT}/plugins/${MACRO_PLUGINS_WASM}`;
export const MACRO_MODULES = ['StringifyMacros', 'ObservationMacros', 'TestingMacros'];

/** `-load-resolved-plugin <library>#<no executable>#<modules>`: the plugins above, in-process. */
export function macroPluginArgs() {
    return ['-load-resolved-plugin', `${MACRO_PLUGIN_PATH}##${MACRO_MODULES.join(',')}`];
}

/**
 * Whether Swift source can expand a macro the plugins provide: only through
 * `import Observation`, `import Testing` (also `@testable`, `@_exported` or
 * `import struct Testing.Test`), or a macro the project declares itself with
 * `#externalMacro(module: "<one of MACRO_MODULES>", ...)`. Projects that do
 * none of these never download the plugins. A false positive (the words in
 * a comment) costs a download, nothing else.
 */
export function usesMacroPlugins(text) {
    return /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func|actor)\s+)?(?:Observation|Testing)\b/.test(text) ||
        new RegExp(`#externalMacro\\s*\\(\\s*module\\s*:\\s*"(?:${MACRO_MODULES.join('|')})"`).test(text);
}

/**
 * Compiled plugin modules by the bytes they were compiled from (a file's
 * data in a sysroot), so that every compile and every sourcekitd instance
 * of a worker shares one.
 */
const compiledPlugins = new WeakMap();

/**
 * The embedder side of the compiler's `swift_plugin_host` imports
 * (swift-toolchain-wasm's swift-plugin-host.mjs, vendored in src/vendor/ and
 * checked against the release by build.sh). Every instance of
 * swift-frontend-lsp.wasm needs one: the module imports
 * `swift_plugin_host.handle_message` and `take_response` whether or not
 * the code uses a macro. Pass `host.imports` next to the WASI imports and
 * `host.attach(memory)` once instantiated.
 *
 * A plugin is the wasm module at the path the compiler names, in `root`,
 * as in swift-toolchain-wasm's run-frontend.mjs. The compiler asks for it
 * synchronously, from inside a compile; a worker may compile a module
 * synchronously, and loadMacroPlugins() compiles it ahead anyway, so this
 * normally finds it done. `onStderr(text)` receives what a plugin prints.
 */
export function pluginHost(root, onStderr = () => {}) {
    return new SwiftPluginHost({
        loadPlugin(libraryPath) {
            const bytes = readFile(root, libraryPath);
            if (!bytes) throw new Error('no such file');
            let module = compiledPlugins.get(bytes);
            if (!module) compiledPlugins.set(bytes, (module = new WebAssembly.Module(bytes)));
            return module;
        },
        onStderr: (name, text) => onStderr(`[${name}] ${text}`),
    });
}

/**
 * Fetches SwiftMacroPlugins.wasm into `root` at MACRO_PLUGIN_PATH, compiled
 * for pluginHost(). About 2.2 MB brotli (13 MB decoded), for projects that
 * use a macro.
 */
export async function loadMacroPlugins(root, onLoading) {
    const response = await fetchArtifact(MACRO_PLUGINS_WASM, onLoading);
    const bytes = new Uint8Array(await response.arrayBuffer());
    compiledPlugins.set(bytes, await WebAssembly.compile(bytes));
    writeFile(root, MACRO_PLUGIN_PATH, bytes).readonly = true;
}

/**
 * The compiler arguments sourcekit-lsp-lite passes sourcekitd (its
 * initializationOptions.compilerArgs): driver-style arguments, as SwiftPM's
 * build settings would give SourceKit-LSP. The files and `-module-name` are
 * the server's own (every .swift file under the root, the module named by a
 * `@testable import`, as projectModuleName does for the runner).
 */
export function sourceKitArgs() {
    return [
        '-target', 'wasm32-unknown-wasip1',
        '-sdk', WASI_SYSROOT,
        '-resource-dir', RESOURCES,
        '-module-cache-path', MODULE_CACHE,
        ...macroPluginArgs(),
    ];
}

/**
 * `swift-frontend -frontend -c`: one invocation for the whole module (no
 * -primary-file), writing one object. Measured against one invocation per
 * file in build-time notes (README): with two files it is the faster choice,
 * because each per-file invocation re-loads the 16 MB stdlib module.
 * `entry` (main.swift) is the file whose top-level code becomes main.
 */
export function compileArgs(sources, output, moduleName = 'main') {
    return ['swift-frontend', '-frontend', '-c', ...sources, ...commonFrontendArgs(moduleName), '-empty-abi-descriptor', '-o', output];
}

/**
 * The libraries every program links, in link order: yukibana-swift's
 * pipeline.ts STDLIB_LIBRARIES, its stand-in for swift-autolink-extract.
 * Libraries a program's own imports need (Synchronization, RegexBuilder,
 * WASILibc, Observation, Testing, ...) are added from the objects' autolink
 * entries and theirs, see linkLibraries().
 */
const STDLIB_LIBRARIES = [
    '-lswiftSwiftOnoneSupport', '-lswiftCore', '-lswift_Concurrency', '-lswift_StringProcessing',
    '-lswift_RegexParser', '-ldl', '-lc++', '-lc++abi', '-lm',
    '-lwasi-emulated-mman', '-lwasi-emulated-signal', '-lwasi-emulated-process-clocks',
];

/** `wasm-ld`, exactly what clang drives for this target (yukibana-swift pipeline.ts linkArgs). */
export function linkArgs(objects, output, stackSize = 1 << 20, autolink = []) {
    return [
        'wasm-ld', '-m', 'wasm32',
        `-L${RESOURCES}/wasi`,
        `-L${WASI_SYSROOT}/lib/wasm32-wasip1`,
        `${WASI_SYSROOT}/lib/wasm32-wasip1/crt1-command.o`,
        `${RESOURCES}/wasi/wasm32/swiftrt.o`,
        ...objects,
        ...autolink.filter((l) => !STDLIB_LIBRARIES.includes(l)),
        ...STDLIB_LIBRARIES,
        '--error-limit=0',
        '--threads=1',
        '--global-base=4096',
        '--table-base=4096',
        // yukibana-swift uses 128 KiB; 1 MiB lets ordinary recursion run.
        '-z', `stack-size=${stackSize}`,
        '-lc',
        `${RESOURCES}/clang/lib/wasip1/libclang_rt.builtins-wasm32.a`,
        '-o', output,
    ];
}

/**
 * What swift-autolink-extract does, for wasm objects: the NUL-separated
 * linker flags in the `.swift1_autolink_entries` custom section (for example
 * `-lswiftSynchronization` after `import Synchronization`). Only `-l` flags
 * are kept.
 */
export function autolinkEntries(object) {
    const out = [];
    if (!object || object[0] !== 0 || object[1] !== 0x61) return out;
    let p = 8;
    const leb = () => {
        let v = 0, shift = 0, b;
        do {
            b = object[p++];
            v |= (b & 0x7f) << shift;
            shift += 7;
        } while (b & 0x80);
        return v >>> 0;
    };
    while (p < object.length) {
        const id = object[p++];
        const size = leb();
        const end = p + size;
        if (id === 0) {
            const n = leb();
            const name = new TextDecoder().decode(object.subarray(p, p + n));
            if (name === '.swift1_autolink_entries') {
                for (const flag of new TextDecoder().decode(object.subarray(p + n, end)).split('\0')) {
                    if (/^-l[\w.+-]+$/.test(flag) && !out.includes(flag)) out.push(flag);
                }
            }
        }
        p = end;
    }
    return out;
}

/** autolinkEntries() of every wasm object in an `ar` archive, in member order, each flag once. */
export function archiveAutolinkEntries(archive) {
    const out = [];
    const magic = '!<arch>\n';
    if (!archive || new TextDecoder().decode(archive.subarray(0, 8)) !== magic) return out;
    for (let p = 8; p + 60 <= archive.length;) {
        const size = parseInt(new TextDecoder().decode(archive.subarray(p + 48, p + 58)).trim(), 10);
        const data = archive.subarray(p + 60, p + 60 + size);
        for (const flag of autolinkEntries(data)) if (!out.includes(flag)) out.push(flag);
        p += 60 + size + (size & 1);
    }
    return out;
}

/**
 * The libraries to link for objects whose autolink entries are `flags`: those
 * flags and, transitively, the autolink entries of the archives they name,
 * as swiftc's driver gathers them natively (swift-toolchain-wasm's Stage 57
 * does the same with swift-autolink-extract). Only libraries this sysroot
 * has are kept. That matters for swift-testing: libTesting.a autolinks
 * Foundation, FoundationInternationalization, CoreFoundation and ICU, for
 * its Foundation overlay, but none of their symbols is reached without
 * `import Foundation`, which the sysroot does not offer; it links and runs
 * against FoundationEssentials alone. A library that is really needed and
 * missing still fails the link, with the symbols it would have provided.
 */
export function linkLibraries(root, flags) {
    const has = (flag) => [`${RESOURCES}/wasi`, `${WASI_SYSROOT}/lib/wasm32-wasip1`]
        .map((dir) => readFile(root, `${dir}/lib${flag.slice(2)}.a`)).find(Boolean);
    const out = [];
    const queue = [...flags];
    while (queue.length) {
        const flag = queue.shift();
        if (out.includes(flag)) continue;
        const archive = has(flag);
        if (!archive) continue;
        out.push(flag);
        queue.push(...archiveAutolinkEntries(archive));
    }
    return out;
}

// ---------------------------------------------------------------- file system

/** Returns the directory at `path` under `root`, creating it and its parents. */
export function mkdirp(root, path) {
    let dir = root;
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        let next = dir.contents.get(part);
        if (!next) {
            next = new Directory(new Map());
            dir.contents.set(part, next);
            next.parent = dir;
        }
        if (!(next instanceof Directory)) throw new Error(`${path}: ${part} is a file`);
        dir = next;
    }
    return dir;
}

export function writeFile(root, path, data) {
    const at = path.lastIndexOf('/');
    const dir = mkdirp(root, path.slice(0, at));
    // File's constructor copies a Uint8Array; set the view afterwards instead.
    const file = new File(new ArrayBuffer(0));
    file.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    dir.contents.set(path.slice(at + 1), file);
    file.parent = dir;
    return file;
}

export function readFile(root, path) {
    let node = root;
    for (const part of path.split('/')) if (part) node = node?.contents?.get(part);
    return node instanceof File ? node.data : null;
}

/**
 * Unpacks an uncompressed tar (ustar/pax/GNU long names; regular files,
 * directories, symlinks materialised as copies) under `prefix`. Ported from
 * yukibana-swift tar.ts; file contents are views into `archive`, not copies,
 * because the sysroot is read-only for every tool that sees it.
 */
export function untar(root, archive, prefix) {
    const decoder = new TextDecoder();
    const str = (o, n) => {
        let e = o;
        while (e < o + n && archive[e] !== 0) e++;
        return decoder.decode(archive.subarray(o, e));
    };
    const links = [];
    let offset = 0;
    let longName = null;
    let paxPath = null;
    let files = 0;
    while (offset + 512 <= archive.length) {
        if (archive[offset] === 0) break;
        const size = parseInt(str(offset + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(archive[offset + 156] || 48);
        const ustarPrefix = str(offset + 345, 155);
        let name = longName ?? paxPath ?? (ustarPrefix ? `${ustarPrefix}/${str(offset, 100)}` : str(offset, 100));
        const data = offset + 512;
        if (type === 'L') longName = decoder.decode(archive.subarray(data, data + size)).replace(/\0+$/, '');
        else if (type === 'x') {
            const m = /\d+ path=([^\n]*)\n/.exec(decoder.decode(archive.subarray(data, data + size)));
            paxPath = m ? m[1] : null;
        } else if (type === 'g') {
            // global pax header: nothing we use
        } else {
            longName = paxPath = null;
            const path = `${prefix}/${name.replace(/^\.?\//, '')}`.replace(/\/+$/, '');
            if (type === '5') mkdirp(root, path);
            else if (type === '0' || type === '7') {
                const file = writeFile(root, path, archive.subarray(data, data + size));
                file.readonly = true;
                files++;
            } else if (type === '1' || type === '2') links.push([path, str(offset + 157, 100)]);
        }
        offset = data + Math.ceil(size / 512) * 512;
    }
    for (const [path, target] of links) {
        const base = path.slice(0, path.lastIndexOf('/'));
        const bytes = readFile(root, target.startsWith('/') ? `${prefix}${target}` : `${base}/${target}`);
        if (bytes) writeFile(root, path, bytes).readonly = true;
    }
    return files;
}

/**
 * The file system's root as a WASI preopen, for every tool.
 * browser_wasi_shim 0.4.2 answers `path_readlink` with ENOTSUP, and
 * realpath() passes that on as a failure: the compiler resolves a macro
 * plugin's path with it, and reported every macro as "could not be found
 * ...; Not supported". There are no symbolic links here, so readlink
 * answers as POSIX does for anything else: EINVAL for a path that exists,
 * the lookup's error otherwise.
 */
class RootDirectory extends PreopenDirectory {
    path_readlink(path) {
        const { ret } = this.path_filestat_get(0, path);
        return { ret: ret === wasiDefs.ERRNO_SUCCESS ? wasiDefs.ERRNO_INVAL : ret, data: null };
    }
}

/** `root` mounted at `/`, as every tool here sees it. */
export function preopenRoot(root) {
    return new RootDirectory('/', root.contents);
}

// ---------------------------------------------------------------- running

/**
 * An fd whose writes go to `write(bytes)` as they happen (stdout/stderr).
 */
export function sink(write) {
    return new ConsoleStdout((chunk) => write(chunk.slice()));
}

/**
 * An fd that collects a tool's output as text in `.text`; `forward` sees
 * each decoded chunk as it is written.
 */
export function textSink(forward) {
    const decoder = new TextDecoder();
    const fd = new ConsoleStdout((bytes) => {
        const text = decoder.decode(bytes, { stream: true });
        fd.text += text;
        if (text) forward?.(text);
    });
    fd.text = '';
    return fd;
}

/**
 * Runs one wasm32-wasip1 command module to completion against `root`
 * (mounted at `/`), returning its exit code. Ported from yukibana-swift
 * run.ts. `stdin` is an fd object (OpenFile of empty bytes by default).
 */
export async function runWasi(module, { args, root, stdout, stderr, stdin, env = ['TMPDIR=/tmp', 'HOME=/tmp'], onInstance }) {
    const fds = [
        stdin ?? new OpenFile(new File(new Uint8Array())),
        stdout,
        stderr,
        preopenRoot(root),
    ];
    const wasi = new WASI(args, env, fds, { debug: false });
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    onInstance?.(instance);
    try {
        return wasi.start(instance);
    } catch (e) {
        if (e instanceof WASIProcExit) return e.code;
        throw e;
    }
}

/**
 * Runs `swift-frontend` (the arguments as its command line, `args[0]` the
 * program name) in a fresh instance of swift-frontend-lsp.wasm, against
 * `root` mounted at `/`, and returns its exit status. One compile per
 * instance: the frontend leaves LLVM shut down when it returns
 * (swift-toolchain-wasm docs/status.md, "One module for the compiler and the
 * server"), so the compiled module is instantiated again each time, which
 * is cheap next to compiling it. Macro plugins are found in `root`
 * (pluginHost); what they print goes to `stderr`.
 */
export async function runFrontend(module, { args, root, stdout, stderr, env = ['TMPDIR=/tmp', 'HOME=/tmp'] }) {
    const fds = [new OpenFile(new File(new Uint8Array())), stdout, stderr, preopenRoot(root)];
    const wasi = new WASI(args, env, fds, { debug: false });
    const encoder = new TextEncoder();
    const host = pluginHost(root, (text) => stderr.fd_write(encoder.encode(text)));
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport, ...host.imports });
    host.attach(instance.exports.memory);
    wasi.initialize(instance);
    const x = instance.exports;
    const pointers = args.map((arg) => {
        const bytes = encoder.encode(`${arg}\0`);
        const p = x.lsp_alloc(bytes.length);
        new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
        return p;
    });
    const argv = x.lsp_alloc(4 * pointers.length); // malloc's alignment suits a u32 array
    new Uint32Array(x.memory.buffer, argv, pointers.length).set(pointers);
    try {
        return x.swift_frontend_main(args.length, argv);
    } catch (e) {
        if (e instanceof WASIProcExit) return e.code;
        throw e;
    }
}

/** `file:line:col: severity: message`, as the frontend prints diagnostics. */
export function parseDiagnostics(text) {
    const out = [];
    for (const m of text.matchAll(/^(.*?):(\d+):(\d+): (error|warning|note|remark): (.*)$/gm)) {
        out.push({ file: m[1], line: +m[2], column: +m[3], severity: m[4], message: m[5] });
    }
    return out;
}

// ---------------------------------------------------------------- downloads

/* global __SWIFT_TOOLCHAIN_SIZES__ */
/** Decoded sizes of the artifacts, injected by build.sh for progress totals. */
const SIZES = typeof __SWIFT_TOOLCHAIN_SIZES__ === 'object' ? __SWIFT_TOOLCHAIN_SIZES__ : {};

/**
 * Fetches one artifact next to this script, reporting progress through
 * `onLoading(label, loaded, total)` (decoded bytes, so the host's .br/.gz
 * siblings do not confuse the bar). Returns the untouched Response, so that
 * WebAssembly.compileStreaming can take it and the browser can cache the
 * compiled code; the bytes are counted on a clone.
 */
export async function fetchArtifact(name, onLoading) {
    const response = await fetch(new URL(name, import.meta.url));
    if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
    const total = SIZES[name] ?? 0;
    onLoading?.(name, 0, total);
    const reader = response.clone().body.getReader();
    (async () => {
        let loaded = 0, last = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.length;
            // The end is reported once, below, even when the last chunk
            // ends a megabyte step.
            if (loaded - last >= 1 << 20 && (total === 0 || loaded < total)) {
                last = loaded;
                onLoading?.(name, loaded, Math.max(total, loaded));
            }
        }
        onLoading?.(name, loaded, Math.max(total, loaded));
    })().catch(() => {});
    return response;
}

/** Fetches and compiles a tool (streaming: compilation overlaps the download). */
export async function loadTool(name, onLoading) {
    return WebAssembly.compileStreaming(await fetchArtifact(name, onLoading));
}

/** Fetches the sysroot tar and unpacks it under /sysroot of a new root directory. */
export async function loadSysroot(onLoading) {
    const response = await fetchArtifact(SYSROOT_TAR, onLoading);
    const tar = new Uint8Array(await response.arrayBuffer());
    const root = new Directory(new Map());
    untar(root, tar, SYSROOT);
    mkdirp(root, '/tmp');
    return root;
}

export const FRONTEND_WASM = 'swift-frontend-lsp.wasm';
export const LINKER_WASM = 'wasm-ld.wasm';
export const SYSROOT_TAR = 'swift-sysroot.tar';
export const XCTEST_TAR = 'swift-xctest.tar';
export const TESTING_TAR = 'swift-testing.tar';

/**
 * Adds the browser's XCTest (xctest/, built by tools/build-xctest.mjs) to a
 * sysroot from loadSysroot: its .swiftmodule and libXCTest.a, where the
 * frontend and the linker look for the stdlib's. A separate download
 * (about 230 kB, 60 kB over the wire) so that the 44 MB sysroot stays cached when it
 * changes, and fetched only by projects that import XCTest.
 */
export async function loadXCTest(root, onLoading) {
    const response = await fetchArtifact(XCTEST_TAR, onLoading);
    untar(root, new Uint8Array(await response.arrayBuffer()), SYSROOT);
}

/**
 * Adds swift-testing to a sysroot from loadSysroot, for projects that
 * import Testing (build.sh, "swift-testing.tar"): its module (the SDK's
 * .swiftinterface, which the compiler builds into the module cache on
 * first use), libTesting.a and the libraries it links, among them
 * FoundationEssentials and _FoundationCollections, but not Foundation or
 * ICU (see linkLibraries). Not part of the sysroot so that projects
 * without swift-testing do not download it.
 */
export async function loadSwiftTesting(root, onLoading) {
    const response = await fetchArtifact(TESTING_TAR, onLoading);
    untar(root, new Uint8Array(await response.arrayBuffer()), SYSROOT);
}

/** Removes `path` (a file or a whole directory) if it exists. */
export function remove(root, path) {
    const at = path.lastIndexOf('/');
    let dir = root;
    for (const part of path.slice(0, at).split('/')) if (part) dir = dir?.contents?.get(part);
    dir?.contents?.delete(path.slice(at + 1));
}

/**
 * Writes the project's files under `dir` (replacing what was there) and
 * returns the absolute paths of its .swift files, `entry` first.
 */
export function writeProject(root, dir, files, entry) {
    remove(root, dir);
    mkdirp(root, dir);
    const sources = [];
    for (const [path, text] of Object.entries(files)) {
        const clean = path.replace(/^\/+/, '');
        writeFile(root, `${dir}/${clean}`, text);
        if (clean.endsWith('.swift')) sources.push(`${dir}/${clean}`);
    }
    sources.sort((a, b) => (a === `${dir}/${entry}` ? -1 : b === `${dir}/${entry}` ? 1 : a < b ? -1 : 1));
    return sources;
}
