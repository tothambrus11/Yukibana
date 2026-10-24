// What the Haskell pack's two workers share (server.js and runner.js):
// starting GHC in the worker, and how a project's files and modules are laid
// out for it.
//
// GHC runs as WebAssembly shared libraries (build.sh, ghc/build-rootfs.sh):
// rootfs.tar holds GHC 9.14's library directory (every boot package's
// libHS*.so and interface files, libHSghc.so among them), the Hackage
// packages (QuickCheck, hspec, random, vector, ...) built the same way, the C libraries, and libyuki.so, the pack's
// GHC API program (ghc/Yuki.hs). The archive is unpacked into an in-memory
// file system (browser_wasi_shim), and GHC's own wasm dynamic linker
// (dyld.mjs, from GHC's libdir) links libyuki.so and everything it needs
// from it, as ghc-in-browser does. libyuki.so then answers requests: lines
// of text in, JSON out.

import { ConsoleStdout, Directory, File, Inode, PreopenDirectory } from './wasi.js';
import { DyLDBrowserHost, main } from './dyld.mjs';

const BASE = new URL('./', import.meta.url);

/** The project's root in GHC's file system; the app's file:///workspace/. */
export const ROOT = '/workspace';

let manifest = null;
/** manifest.json, written by build.sh: file sizes, versions, GHC's paths. */
export async function manifestOf() {
    manifest ??= fetch(new URL('manifest.json', BASE)).then((r) => r.json());
    return manifest;
}

/**
 * The packages a project may import, exposed to GHC as cabal's
 * build-depends would: everything else (ghc itself, its private packages)
 * is hidden, so an import names the module a cabal build would find.
 */
export const PACKAGES = ['base', 'containers', 'mtl', 'transformers', 'text', 'bytestring', 'array', 'deepseq', 'directory', 'filepath', 'time', 'stm', 'exceptions', 'random', 'QuickCheck', 'hspec', 'HUnit', 'template-haskell', 'parsec', 'pretty', 'binary', 'vector', 'primitive', 'unordered-containers', 'hashable', 'split', 'async'];

/**
 * Unpacks a tar stream (ustar, with GNU long names and pax paths) into
 * `root` as it arrives: regular files and directories, which is all
 * build-rootfs.sh writes. Reports progress in the archive's own bytes (a
 * fetch body is decoded: a .br transfer still counts raw bytes), against
 * `total`, at most every 100 ms and once at the end.
 */
async function untar(body, root, reportEach, label, total) {
    let last = 0;
    const report = (p) => {
        const now = performance.now();
        if (now - last >= 100 || p.loaded >= total) {
            last = now;
            reportEach(p);
        }
    };
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = new Uint8Array(0);
    let loaded = 0;
    let longName = null;
    const need = async (n) => {
        while (buf.length < n) {
            const { done, value } = await reader.read();
            if (done) return false;
            loaded += value.length;
            report({ label, loaded, total: Math.max(total, loaded) });
            const next = new Uint8Array(buf.length + value.length);
            next.set(buf);
            next.set(value, buf.length);
            buf = next;
        }
        return true;
    };
    // Large files arrive in many chunks: copying the buffer for each would be
    // quadratic, so a file's body is read straight into its own array.
    const take = async (n) => {
        const out = new Uint8Array(n);
        let at = Math.min(n, buf.length);
        out.set(buf.subarray(0, at));
        buf = buf.subarray(at);
        while (at < n) {
            const { done, value } = await reader.read();
            if (done) throw new Error(`${label}: truncated`);
            loaded += value.length;
            report({ label, loaded, total: Math.max(total, loaded) });
            const k = Math.min(n - at, value.length);
            out.set(value.subarray(0, k), at);
            at += k;
            if (k < value.length) buf = value.slice(k);
        }
        return out;
    };
    const str = (h, o, n) => {
        let e = o;
        while (e < o + n && h[e] !== 0) e++;
        return decoder.decode(h.subarray(o, e));
    };
    let files = 0;
    for (;;) {
        if (!(await need(512))) break;
        const h = buf.slice(0, 512);
        buf = buf.subarray(512);
        if (h[0] === 0) break;
        const size = parseInt(str(h, 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        const prefix = str(h, 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
        const padded = Math.ceil(size / 512) * 512;
        const data = await take(padded);
        const body = data.subarray(0, size);
        if (type === 'L') {
            longName = decoder.decode(body).replace(/\0+$/, '');
            continue;
        }
        if (type === 'x') {
            const m = /\d+ path=([^\n]*)\n/.exec(decoder.decode(body));
            longName = m ? m[1] : null;
            continue;
        }
        longName = null;
        const parts = name.split('/').filter((p) => p && p !== '.');
        if (type === '5') dirOf(root, parts);
        else if (type === '0' || type === '7') {
            const dir = dirOf(root, parts.slice(0, -1));
            dir.contents.set(parts.at(-1), new File(body, { readonly: true }));
            files++;
        }
    }
    return files;
}

/** The directory at `parts` under `dir`, made if missing. */
function dirOf(dir, parts) {
    for (const p of parts) {
        let next = dir.contents.get(p);
        if (!(next instanceof Directory)) {
            next = new Directory(new Map());
            next.parent = dir;
            dir.contents.set(p, next);
        }
        dir = next;
    }
    return dir;
}

/**
 * Downloads rootfs.tar and starts GHC: links libyuki.so with dyld.mjs and
 * starts a session, `mode` 'editor' (type checking, .hie files) or
 * 'runner' (GHC's bytecode interpreter). `fds` replaces the program's
 * stdin, stdout and stderr (default: lines to `log`). Answers
 * { request(lines) -> Promise<object>, write(path, text), remove(path),
 *   versions, timings }.
 */
export async function startGhc({ mode, report, log = () => {}, fds = null, flags = [] }) {
    const timings = {};
    const t0 = performance.now();
    const m = await manifestOf();
    const root = new PreopenDirectory('/', new Map());
    const res = await fetch(new URL('rootfs.tar', BASE));
    if (!res.ok || !res.body) throw new Error(`rootfs.tar: HTTP ${res.status}`);
    await untar(res.body, root.dir, report, 'rootfs.tar', m.files['rootfs.tar'] ?? 0);
    timings.unpacked = Math.round(performance.now() - t0);
    dirOf(root.dir, ROOT.split('/').filter(Boolean));
    const host = new DyLDBrowserHost({ rootfs: root, stdout: (s) => log(s), stderr: (s) => log(s) });
    if (fds) host.wasiFds = fds;
    const dyld = await main({
        rpc: host,
        searchDirs: ['/tmp/clib', m.ghc.hsSearchDir],
        mainSoPath: '/tmp/libyuki.so',
        args: ['libyuki.so', '+RTS', '-c', '-RTS'],
        isIserv: false,
    });
    timings.linked = Math.round(performance.now() - t0);
    const base = ['-package-db', m.ghc.storeDb, '-hide-all-packages', ...PACKAGES.flatMap((p) => ['-package', p]), ...flags];
    await dyld.exportFuncs.yukiInit('/tmp/hslib/lib', mode, base.join('\n'));
    timings.ready = Math.round(performance.now() - t0);
    const encoder = new TextEncoder();
    return {
        versions: m.versions,
        timings,
        async request(lines) {
            const answer = JSON.parse(await dyld.exportFuncs.yukiRequest(lines.join('\n')));
            if (answer && answer.failure) throw new Error(answer.failure);
            return answer;
        },
        /** Writes a project file at its path under ROOT; a path that leaves it is refused. */
        write(rel, text) {
            const parts = projectParts(rel);
            const dir = dirOf(root.dir, [...ROOT.split('/').filter(Boolean), ...parts.slice(0, -1)]);
            dir.contents.set(parts.at(-1), new File(encoder.encode(text)));
        },
        remove(rel) {
            const parts = projectParts(rel);
            const dir = dirOf(root.dir, [...ROOT.split('/').filter(Boolean), ...parts.slice(0, -1)]);
            dir.contents.delete(parts.at(-1));
        },
    };
}

function projectParts(rel) {
    const parts = rel.split('/').filter((p) => p && p !== '.');
    if (parts.length === 0 || parts.includes('..')) throw new Error(`bad project path: ${rel}`);
    return parts;
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
 * The directories GHC searches for imported modules (-i), as cabal's
 * hs-source-dirs: for a file `src/Data/Shape.hs` that declares
 * `module Data.Shape`, `src`. A file whose path does not end as its module
 * name says (or without a header) counts its own directory. The root comes
 * first, then the rest in order of first appearance.
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

/**
 * How GHC loads a project for checking: groups of files loaded together.
 * GHC holds one module per name, and a program and its test suite are
 * both `Main`: the first group is the program's Main (`entry`) with every
 * module that is not a Main, each other Main (a test suite) is a group of
 * its own and finds what it imports through the source roots.
 */
export function checkGroups(files, entry = 'Main.hs') {
    const hs = Object.keys(files).filter((p) => p.endsWith('.hs')).sort();
    const isMain = (p) => (moduleNameOf(files[p]) ?? 'Main') === 'Main';
    const first = hs.filter((p) => !isMain(p));
    if (hs.includes(entry) && isMain(entry)) first.unshift(entry);
    const groups = first.length ? [first] : [];
    for (const p of hs) if (isMain(p) && p !== entry) groups.push([p]);
    return groups.map((g) => g.map((p) => `${ROOT}/${p}`));
}

export { ConsoleStdout, Inode };
