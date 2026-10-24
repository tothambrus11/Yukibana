// Compiles the crates.io packages of crates/ (quickcheck and what it depends
// on) for the runner's Miri, and packs their sources for rust-analyzer.
//
//   node scripts/build-crates.mjs <toolchain> <cargo target dir> <miri.wasm> <sysroot.tar> <out dir> <name>
//
// writes <out dir>/<name>.tar and <out dir>/<name>-src.tar.
//
// Cargo decides, Miri compiles. `cargo check --target
// x86_64-unknown-linux-gnu` over crates/ (Cargo.lock pins every version and
// checksum) resolves the graph, enables the features, runs the build
// scripts natively, as Cargo runs them on the host, and reports each lib
// crate it compiles, dependencies first; `cargo metadata` gives each crate's
// dependencies under the names its code uses. This script then compiles the
// same crates, in the same order, with the same editions, features and
// build-script cfgs, with miri.wasm as rustc (MIRI_BE_RUSTC=target) into
// metadata with every function's MIR (`-Zalways-encode-mir`), which is all
// Miri reads: the way the runner compiles a project's own library.
//
// The build scripts ran under the host's rustc (the toolchain argument),
// not Miri's 1.78: Cargo has one rustc for both. Of these crates only libc
// has one, and for this target the only thing it derives from the rustc
// version is `cargo::rustc-check-cfg` lines (rustc 1.80 and later), which
// declare cfgs for a lint and are not passed here; its cfgs
// (`linux_time_bits64`) depend on the target alone.
//
// Miri runs under @bjorn3/browser_wasi_shim, the runner's own WASI, with
// its files in memory. Node's built-in node:wasi was tried first and
// crashes Node (a segmentation fault) while compiling libc.
//
// <name>.tar      the crates' .rmeta files (lib<crate>.rmeta), for the
//                 runner's `--extern` and `-L dependency=`
// <name>-src.tar  their sources (<package>-<version>/**.rs, without tests,
//                 benches, examples and build scripts) and crates.json,
//                 which tells rust-analyzer the crate graph: for each crate
//                 its id, name, edition, root file, cfgs and dependencies,
//                 in dependency order, and which crates a project may name
//                 in its Cargo.toml (`direct`)
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Directory, File, OpenFile, PreopenDirectory, WASI, WASIProcExit, ConsoleStdout } from '@bjorn3/browser_wasi_shim';

const TARGET = 'x86_64-unknown-linux-gnu';
const HERE = dirname(fileURLToPath(import.meta.url));
const CRATES = resolve(HERE, '../crates');

const [toolchain, targetDir, miriWasm, sysrootTar, outDir, name] = process.argv.slice(2);
if (!name) {
    console.error('usage: node scripts/build-crates.mjs <toolchain> <cargo target dir> <miri.wasm> <sysroot.tar> <out dir> <name>');
    process.exit(2);
}

// ---- what Cargo would do

const cargo = (args) =>
    execFileSync('cargo', [`+${toolchain}`, ...args], { cwd: CRATES, env: { ...process.env, CARGO_TARGET_DIR: targetDir }, maxBuffer: 1 << 28 }).toString();
const metadata = JSON.parse(cargo(['metadata', '--format-version=1', '--locked', `--filter-platform=${TARGET}`]));
const messages = cargo(['check', '--locked', `--target=${TARGET}`, '--message-format=json'])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const packages = new Map(metadata.packages.map((p) => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const root = metadata.resolve.root;
/** cfgs a build script told Cargo to pass (`cargo:rustc-cfg`), by package id. */
const scriptCfgs = new Map();
/** Variables a build script told Cargo to set (`cargo:rustc-env`), by package id. */
const scriptEnv = new Map();
/** Lib crates in the order Cargo finished them: each after its dependencies. */
const crates = [];
for (const m of messages) {
    if (m.reason === 'build-script-executed') {
        scriptCfgs.set(m.package_id, m.cfgs);
        scriptEnv.set(m.package_id, m.env);
        if (m.linked_libs.length) throw new Error(`${m.package_id}: links ${m.linked_libs.join(', ')}; Miri cannot call native libraries`);
    }
    if (m.reason === 'compiler-artifact' && m.target.kind.includes('lib') && m.package_id !== root) crates.push(m);
}

const pkgOf = (id) => packages.get(id) ?? (() => { throw new Error(`no package ${id}`); })();
const idOf = (pkg) => `${pkg.name}-${pkg.version}`;
const crateName = (m) => m.target.name.replace(/-/g, '_');
/** Normal (not dev, not build) dependencies of a package, as `[extern name, package id]`. */
const depsOf = (id) =>
    nodes.get(id).deps.filter((d) => d.dep_kinds.some((k) => k.kind === null)).map((d) => [d.name, d.pkg]);
const names = new Map();
for (const m of crates) {
    const n = crateName(m);
    if (names.has(n)) throw new Error(`two crates named ${n}: ${names.get(n)} and ${m.package_id}`);
    names.set(n, m.package_id);
}

// ---- the files, in memory

/** The regular files of a ustar archive, as [path, bytes]. */
function untar(tar) {
    const decoder = new TextDecoder();
    const field = (at, length) => {
        const end = tar.indexOf(0, at);
        return decoder.decode(tar.subarray(at, end < 0 || end > at + length ? at + length : end));
    };
    const files = [];
    for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
        const path = field(at, 100);
        const prefix = field(at + 345, 155);
        const size = parseInt(field(at + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(tar[at + 156] || 48);
        at += 512;
        if (type === '0') files.push([prefix ? `${prefix}/${path}` : path, tar.subarray(at, at + size)]);
        at += Math.ceil(size / 512) * 512;
    }
    return files;
}

/** A ustar archive of [path, bytes], in the order given; paths up to 255 bytes. */
function tar(entries) {
    const encoder = new TextEncoder();
    const blocks = [];
    for (const [path, data] of entries) {
        const header = new Uint8Array(512);
        const put = (at, length, text) => header.set(encoder.encode(text).subarray(0, length), at);
        let base = path;
        let prefix = '';
        if (encoder.encode(path).length > 100) {
            const cut = path.lastIndexOf('/', 155);
            if (cut <= 0 || encoder.encode(path.slice(cut + 1)).length > 100) throw new Error(`path too long for ustar: ${path}`);
            prefix = path.slice(0, cut);
            base = path.slice(cut + 1);
        }
        put(0, 100, base);
        put(100, 8, '0000644\0');
        put(108, 8, '0000000\0');
        put(116, 8, '0000000\0');
        put(124, 12, `${data.length.toString(8).padStart(11, '0')}\0`);
        put(136, 12, '00000000000\0');
        put(156, 1, '0');
        put(257, 8, 'ustar\x0000');
        put(345, 155, prefix);
        header.fill(32, 148, 156);
        const sum = header.reduce((a, b) => a + b, 0);
        put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
        blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
    }
    blocks.push(new Uint8Array(1024));
    return Buffer.concat(blocks);
}

/** A directory tree for the WASI shim from [path, bytes]. */
function tree(entries) {
    const top = new Map();
    for (const [path, data] of entries) {
        const parts = path.split('/').filter(Boolean);
        let dir = top;
        for (const part of parts.slice(0, -1)) {
            if (!dir.has(part)) dir.set(part, new Directory(new Map()));
            dir = dir.get(part).contents;
        }
        dir.set(parts.at(-1), new File(data));
    }
    return top;
}

/** The files of a directory, recursively, as [path relative to it, bytes]. */
function walk(dir, base = dir) {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path, base) : [[relative(base, path), readFileSync(path)]];
    });
}

/** The .rs files of a package that its lib can include: not its tests,
 * benches, examples or build script. */
const sources = (pkg) =>
    walk(dirname(pkg.manifest_path)).filter(([path]) => path.endsWith('.rs') && path !== 'build.rs' && !/^(tests|benches|examples)\//.test(path));

// ---- compiling

const module = await WebAssembly.compile(readFileSync(miriWasm));
const sysroot = tree(untar(readFileSync(sysrootTar)));
/** /src: every crate's sources, as <package>-<version>/... */
const srcEntries = crates.flatMap((m) => {
    const pkg = pkgOf(m.package_id);
    return sources(pkg).map(([path, data]) => [`${idOf(pkg)}/${path}`, data]);
});
const src = tree(srcEntries);
const out = new Map();

/** Runs one instance of Miri as rustc; returns its exit code, stderr printed. */
function rustc(args, env) {
    const fds = [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((line) => console.log(line)),
        ConsoleStdout.lineBuffered((line) => console.error(line)),
        new PreopenDirectory('/sysroot', sysroot),
        new PreopenDirectory('/src', src),
        new PreopenDirectory('/out', out),
        new PreopenDirectory('/tmp', new Map()),
    ];
    const wasi = new WASI(['miri', ...args], env, fds, { debug: false });
    const imports = { wasi_snapshot_preview1: wasi.wasiImport };
    // As in the runner: rubri's build declares thread spawning, which rustc
    // never calls with one thread.
    for (const { module: from, name: fn, kind } of WebAssembly.Module.imports(module)) {
        if (from === 'wasi_snapshot_preview1' || kind !== 'function') continue;
        imports[from] ??= {};
        imports[from][fn] ??= () => {
            throw new Error(`${from}.${fn} is not available`);
        };
    }
    try {
        return wasi.start(new WebAssembly.Instance(module, imports));
    } catch (e) {
        if (e instanceof WASIProcExit) return e.code;
        if (e instanceof WebAssembly.RuntimeError) return 1; // rustc's abort after an error it reported
        throw e;
    }
}

const graph = [];
for (const m of crates) {
    const pkg = pkgOf(m.package_id);
    const id = idOf(pkg);
    const name = crateName(m);
    const rootPath = `${id}/${relative(dirname(pkg.manifest_path), m.target.src_path)}`;
    const deps = depsOf(m.package_id).map(([dep, pkgId]) => ({ name: dep, id: idOf(pkgOf(pkgId)) }));
    const cfgs = [...m.features.map((f) => `feature="${f}"`), ...(scriptCfgs.get(m.package_id) ?? [])];
    const [major, minor, patch] = pkg.version.split(/[.+-]/);
    // What Cargo sets for rustc (env! and option_env! read them), and what
    // the build script added.
    const env = [
        'MIRI_BE_RUSTC=target',
        `CARGO_PKG_NAME=${pkg.name}`,
        `CARGO_PKG_VERSION=${pkg.version}`,
        `CARGO_PKG_VERSION_MAJOR=${major}`,
        `CARGO_PKG_VERSION_MINOR=${minor}`,
        `CARGO_PKG_VERSION_PATCH=${patch}`,
        `CARGO_CRATE_NAME=${name}`,
        `CARGO_MANIFEST_DIR=/src/${id}`,
        ...(scriptEnv.get(m.package_id) ?? []).map(([k, v]) => `${k}=${v}`),
    ];
    const args = [
        `--crate-name=${name}`,
        `--edition=${m.target.edition}`,
        '--crate-type=lib',
        '--emit=metadata',
        '-Zalways-encode-mir',
        '-o',
        `/out/lib${name}.rmeta`,
        '--sysroot',
        '/sysroot',
        `--target=${TARGET}`,
        '--cap-lints=allow',
        // Panic locations as Cargo's registry paths end:
        // quickcheck-1.0.3/src/tester.rs:165:28.
        '--remap-path-prefix=/src/=',
        '-L',
        'dependency=/out',
        ...cfgs.flatMap((c) => ['--cfg', c]),
        ...deps.flatMap((d) => ['--extern', `${d.name}=/out/lib${crateName(crates.find((c) => idOf(pkgOf(c.package_id)) === d.id))}.rmeta`]),
        `/src/${rootPath}`,
    ];
    const started = Date.now();
    const code = rustc(args, env);
    if (code !== 0) throw new Error(`${id}: Miri as rustc exited with ${code}`);
    console.log(`${id}: lib${name}.rmeta, ${out.get(`lib${name}.rmeta`).data.length} bytes, ${Date.now() - started} ms`);
    graph.push({ id, name, version: pkg.version, edition: m.target.edition, root: rootPath, cfg: cfgs, deps, license: pkg.license });
}

const direct = depsOf(root).map(([dep]) => dep);
const rmeta = [...out].filter(([, f]) => f instanceof File).map(([n, f]) => [n, f.data]).sort(([a], [b]) => (a < b ? -1 : 1));
writeFileSync(join(outDir, `${name}.tar`), tar(rmeta));
const crateJson = Buffer.from(`${JSON.stringify({ crates: graph, direct }, null, 1)}\n`);
writeFileSync(join(outDir, `${name}-src.tar`), tar([['crates.json', crateJson], ...srcEntries.sort(([a], [b]) => (a < b ? -1 : 1))]));
console.log(`${name}.tar: ${rmeta.map(([n]) => n).join(', ')}; ${name}-src.tar: ${srcEntries.length} files; direct: ${direct.join(', ')}`);
