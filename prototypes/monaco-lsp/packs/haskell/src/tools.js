// The language server's formatter and linter: ormolu and hlint, built for
// WebAssembly as plain WASI commands (ghc/build-tools.sh), each run as its
// command line would be, in a file system of its own. Neither needs GHC:
// both parse with ghc-lib-parser, their own copy of GHC's parser. Each is
// downloaded and compiled the first time it is wanted, then instantiated
// afresh for every run (a WASI command runs once).

import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI } from './wasi.js';

const BASE = new URL('./', import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const compiled = new Map();
/** The compiled module of a tool's wasm, downloaded once. */
function moduleOf(file) {
    if (!compiled.has(file)) {
        const p = WebAssembly.compileStreaming(fetch(new URL(file, BASE)));
        p.catch(() => compiled.delete(file));
        compiled.set(file, p);
    }
    return compiled.get(file);
}

/** A directory tree of the in-memory file system from { 'a/b.hs': text }. */
function treeOf(files) {
    const root = new Map();
    for (const [path, text] of Object.entries(files)) {
        const parts = path.split('/').filter(Boolean);
        let dir = root;
        for (const p of parts.slice(0, -1)) {
            let next = dir.get(p);
            if (!(next instanceof Directory)) {
                next = new Directory(new Map());
                dir.set(p, next);
            }
            dir = next.contents;
        }
        dir.set(parts.at(-1), new File(typeof text === 'string' ? encoder.encode(text) : text, { readonly: true }));
    }
    return root;
}

/**
 * Runs a tool: `args` its command line (args[0] its name), `stdin` its
 * input, `dirs` the directories it sees ({ '/w': { 'Main.hs': text } }).
 * Answers its exit code, stdout and stderr.
 */
export async function runTool(file, args, { stdin = '', dirs = {} } = {}) {
    const module = await moduleOf(file);
    const out = [];
    const err = [];
    const fds = [
        new OpenFile(new File(encoder.encode(stdin), { readonly: true })),
        new ConsoleStdout((b) => out.push(b.slice())),
        new ConsoleStdout((b) => err.push(b.slice())),
        ...Object.entries(dirs).map(([at, files]) => new PreopenDirectory(at, treeOf(files))),
    ];
    const wasi = new WASI(args, [], fds);
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    const code = wasi.start(instance);
    const text = (chunks) => decoder.decode(new Uint8Array(chunks.flatMap((c) => [...c])));
    return { code, stdout: text(out), stderr: text(err) };
}

/**
 * Formats a module with ormolu (its default style, as `ormolu` on a
 * desktop): the formatted text, or an Error with ormolu's message when the
 * module does not parse.
 */
export async function ormolu(path, text) {
    const r = await runTool('ormolu.wasm', ['ormolu', '--stdin-input-file', path], { stdin: text });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `ormolu exited with ${r.code}`);
    return r.stdout;
}

let hlintData = null;
/** hlint's own hints (hlint.yaml and what it includes), from hlint-data.json. */
function hlintDataOf() {
    hlintData ??= fetch(new URL('hlint-data.json', BASE)).then((r) => {
        if (!r.ok) throw new Error(`hlint-data.json: HTTP ${r.status}`);
        return r.json();
    });
    hlintData.catch(() => (hlintData = null));
    return hlintData;
}

/**
 * hlint's ideas for the project's modules ({ path: text }), as `hlint
 * --json` gives them: each with its file (a project path), severity
 * ("Suggestion", "Warning", "Error"), hint, 1-based span, `from`, `to`
 * (null when it suggests removing), and notes. A module hlint cannot parse
 * has an idea of severity "Error" for that, which GHC also reports.
 */
export async function hlint(files) {
    const data = await hlintDataOf();
    const paths = Object.keys(files).filter((p) => p.endsWith('.hs'));
    if (!paths.length) return [];
    const r = await runTool('hlint.wasm', ['hlint', '--datadir=/hlint', '--json', '--no-exit-code', ...paths.map((p) => `/w/${p}`)], {
        dirs: { '/hlint': data, '/w': files },
    });
    const json = r.stdout.trim();
    if (!json.startsWith('[')) throw new Error(r.stderr.trim() || `hlint exited with ${r.code}`);
    return JSON.parse(json).map((idea) => ({ ...idea, file: String(idea.file).replace(/^\/w\//, '') }));
}
