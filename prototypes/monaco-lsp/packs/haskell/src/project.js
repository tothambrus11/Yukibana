// What the Haskell pack's two workers share (server.js and runner.js): the
// download of yuki.wasm and the packages, the files they put into
// Emscripten's file system, and how a project's modules are found.
//
// yuki.wasm is MicroHs with our entry points (build.sh, src/hs/Yuki.hs). It
// reads its packages from /yuki: base.pkg, containers.pkg and hspec.pkg (our
// Test.Hspec).

const BASE = new URL('./', import.meta.url);

/** The workspace root in Emscripten's file system; the app's file:///workspace/. */
export const ROOT = '/workspace';

let manifest = null;
async function manifestOf() {
    manifest ??= await (await fetch(new URL('manifest.json', BASE))).json();
    return manifest;
}

/**
 * A pack file's bytes, with progress: `report({ label, loaded, total })` as
 * they arrive (total from manifest.json, as the body may come compressed).
 */
export async function fetchBytes(name, report) {
    const sizes = (await manifestOf()).files;
    const total = sizes[name] ?? 0;
    const res = await fetch(new URL(name, BASE));
    if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    report({ label: name, loaded: 0, total });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        report({ label: name, loaded, total: Math.max(total, loaded) });
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

/** The versions build.sh recorded: { microhs, containers }. */
export async function versions() {
    return (await manifestOf()).versions;
}

/**
 * Downloads (in parallel) and starts a fresh yuki.wasm instance with the
 * packages in /yuki. `options` are Emscripten's module options (preRun,
 * print, printErr). The wasm is compiled once per worker and the bytes kept,
 * so a second instance in the same worker costs an instantiation only.
 */
let files = null;
export async function startYuki(report, options = {}) {
    files ??= Promise.all([
        import(new URL('yuki.mjs', BASE).href),
        fetchBytes('yuki.wasm', report).then((b) => WebAssembly.compile(b)),
        fetchBytes('base.pkg', report),
        fetchBytes('containers.pkg', report),
        fetchBytes('hspec.pkg', report),
    ]);
    const [{ default: createYuki }, wasm, base, containers, hspec] = await files;
    const m = await createYuki({
        ...options,
        instantiateWasm: (imports, done) => {
            WebAssembly.instantiate(wasm, imports).then((instance) => done(instance, wasm));
            return {};
        },
    });
    m.FS.mkdirTree('/yuki');
    m.FS.writeFile('/yuki/base.pkg', base);
    m.FS.writeFile('/yuki/containers.pkg', containers);
    m.FS.writeFile('/yuki/hspec.pkg', hspec);
    m.FS.mkdirTree(ROOT);
    return m;
}

/** Writes a project file at its path under ROOT; a path that leaves it is refused. */
export function writeProjectFile(m, rel, text) {
    const parts = rel.split('/').filter((p) => p && p !== '.');
    if (parts.length === 0 || parts.includes('..')) throw new Error(`bad project path: ${rel}`);
    if (parts.length > 1) m.FS.mkdirTree(`${ROOT}/${parts.slice(0, -1).join('/')}`);
    m.FS.writeFile(`${ROOT}/${parts.join('/')}`, text);
}

/**
 * The module a Haskell file declares (`module A.B (...) where`), or null for
 * one without a header, which Haskell takes as Main. Comments and pragmas
 * before the header are skipped.
 */
export function moduleNameOf(text) {
    const s = text.replace(/\{-[\s\S]*?-\}/g, ' ').replace(/--.*$/gm, '');
    const m = /^\s*module\s+([A-Z][\w']*(?:\.[A-Z][\w']*)*)/.exec(s);
    return m ? m[1] : null;
}

/**
 * The directories MicroHs searches for imported modules, as GHC's
 * hs-source-dirs: for a file `src/Data/Shape.hs` that declares
 * `module Data.Shape`, `src`. A file whose path does not end as its module
 * name says (or without a header) counts its own directory. The root comes
 * first, then `tests` and the rest in order of first appearance.
 */
export function sourceRoots(files) {
    const roots = new Set([ROOT]);
    for (const [path, text] of Object.entries(files)) {
        if (!path.endsWith('.hs')) continue;
        const name = moduleNameOf(text);
        const tail = name ? `${name.replaceAll('.', '/')}.hs` : null;
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const root = tail && (path === tail || path.endsWith(`/${tail}`)) ? path.slice(0, path.length - tail.length).replace(/\/$/, '') : dir;
        roots.add(root ? `${ROOT}/${root}` : ROOT);
    }
    return [...roots];
}

/**
 * The test suite's main file: tests/Spec.hs (or test/Spec.hs, hspec's
 * convention), else the first file under tests/ or test/ that defines
 * `main`. Null when there is none.
 */
export function testEntry(files) {
    for (const p of ['tests/Spec.hs', 'test/Spec.hs']) if (p in files) return p;
    const candidates = Object.keys(files).filter((p) => /^tests?\/.*\.hs$/.test(p)).sort();
    return candidates.find((p) => /^main\s*(::|=)/m.test(files[p])) ?? null;
}
