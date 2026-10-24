// Node benchmark/trace of the in-browser pipeline (the same src/toolchain.js
// and src/lite.js that runner.js and server.js use, under
// Node's WebAssembly):
//
//   node tools/bench.mjs <dir> [trace-out.txt]
//
// <dir> holds swift-frontend-lsp.wasm, wasm-ld.wasm and a sysroot tar
// (swift-sysroot.tar or swift-sysroot-core.tar, original or trimmed). Times
// the language server's requests (sourcekitd through sourcekit-lsp-lite:
// open, diagnostics, completion, hover, ...), whole-module compilation
// (twice), linking and running the sample, and with a
// second argument writes every path the tools opened (`open`) or stat'ed
// (`stat`): that list is where tools/trim-sysroot.mjs's rules come from.
// EXTRA=1 uses a program importing WASILibc, Synchronization and
// RegexBuilder instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Lite } from '../src/lite.js';
import * as tc from '../src/toolchain.js';

const dir = process.argv[2];
const traceOut = process.argv[3];
const t = () => performance.now();
const ms = (a) => `${Math.round(t() - a)} ms`;

let t0 = t();
const [frontend, linker] = await Promise.all([tc.FRONTEND_WASM, tc.LINKER_WASM].map((n) => WebAssembly.compile(readFileSync(`${dir}/${n}`))));
console.log('compile both modules', ms(t0));
const tarName = ['swift-sysroot.tar', 'swift-sysroot-core.tar'].find((n) => existsSync(`${dir}/${n}`));
const tar = new Uint8Array(readFileSync(`${dir}/${tarName}`));

const SAMPLE = process.env.EXTRA ? {
    'main.swift': 'import WASILibc\nimport Synchronization\nimport RegexBuilder\nlet m = Mutex(0)\nm.withLock { $0 += 1 }\nlet r = Regex { OneOrMore(.digit) }\nprint(strlen("abc"), m.withLock { $0 }, "a12b".firstMatch(of: r)!.0)\nlet x = Double.pi\nprint(sin(x / 2))\nlet d = differentiableExample()\n',
    'Geometry.swift': 'func differentiableExample() -> Int { [3, 1, 2].sorted().reduce(0, +) }\n',
} : {
    'main.swift': 'let a = Point(x: 0, y: 0)\nlet b = Point(x: 3, y: 4)\nprint("\\(a) to \\(b): \\(distance(a, b))")\nprint(b.norm())\n',
    'Geometry.swift': '/// A point in the plane.\nstruct Point: CustomStringConvertible {\n    var x: Double\n    var y: Double\n\n    /// Distance from the origin.\n    func norm() -> Double {\n        (x * x + y * y).squareRoot()\n    }\n\n    var description: String { "(\\(x), \\(y))" }\n}\n\n/// Euclidean distance between two points.\nfunc distance(_ a: Point, _ b: Point) -> Double {\n    Point(x: a.x - b.x, y: a.y - b.y).norm()\n}\n',
};

const opened = new Set();
function fresh() {
    const root = new tc.Directory(new Map());
    const a = t();
    const n = tc.untar(root, tar, '/sysroot');
    tc.mkdirp(root, '/tmp');
    tc.mkdirp(root, '/work');
    for (const [k, v] of Object.entries(SAMPLE)) tc.writeFile(root, `/work/${k}`, v);
    console.log(`untar ${n} files`, ms(a));
    return root;
}
function rm(root, path) {
    const at = path.lastIndexOf('/');
    let d = root;
    for (const p of path.slice(0, at).split('/')) if (p) d = d.contents.get(p);
    d?.contents.delete(path.slice(at + 1));
}
async function run(module, args, root) {
    const o = args.indexOf('-o');
    if (o > 0) rm(root, args[o + 1]);
    let out = '', err = '';
    const dec = new TextDecoder();
    const code = await (module === frontend ? tc.runFrontend : tc.runWasi)(module, {
        args, root,
        stdout: tc.sink((b) => (out += dec.decode(b))),
        stderr: tc.sink((b) => (err += dec.decode(b))),
    });
    return { code, out, err };
}

// path tracing: wrap the preopen's lookups
if (traceOut) {
    const P = tc.PreopenDirectory.prototype;
    for (const m of ['path_open', 'path_filestat_get']) {
        const orig = P[m];
        P[m] = function (...a) {
            const path = m === 'path_open' ? a[1] : a[1];
            const r = orig.apply(this, a);
            opened.add(`${(r.ret ?? 0) === 0 ? (m === 'path_open' ? 'open ' : 'stat ') : 'ENOENT '}/${path}`);
            return r;
        };
    }
}

const sources = Object.keys(SAMPLE).map((k) => `/work/${k}`).sort((a, b) => (a.endsWith('main.swift') ? -1 : 1));
let root = fresh();

// The language server, as server.js drives it: one instance, a message at a
// time, diagnostics as idle work. Each line is one request's wall time.
{
    const lite = new Lite(frontend, root, (text) => process.stderr.write(text));
    let a = t();
    lite.start();
    console.log('lsp: instantiate', ms(a));
    let id = 0;
    const request = (method, params) => lite.handle({ jsonrpc: '2.0', id: ++id, method, params }).find((m) => m.id === id);
    const uri = 'file:///work/main.swift';
    const timed = (label, method, params) => {
        const b = t();
        const reply = request(method, params);
        const result = reply?.result;
        const n = Array.isArray(result) ? result.length : Array.isArray(result?.items) ? result.items.length
            : Array.isArray(result?.signatures) ? result.signatures.length : result?.changes ? Object.keys(result.changes).length : result ? 1 : 0;
        console.log(`lsp: ${label}`, ms(b), reply?.error ? `error ${reply.error.message}` : `${n} result(s)`);
    };
    a = t();
    request('initialize', { processId: null, rootUri: 'file:///work', capabilities: {}, initializationOptions: { compilerArgs: tc.sourceKitArgs() } });
    lite.handle({ jsonrpc: '2.0', method: 'initialized', params: {} });
    console.log('lsp: initialize', ms(a));
    a = t();
    lite.handle({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'swift', version: 1, text: SAMPLE['main.swift'] } } });
    console.log('lsp: didOpen', ms(a));
    for (let i = 0; i < 2; i++) {
        a = t();
        let published = 0;
        while (lite.hasIdleWork()) published += lite.idle().filter((m) => m.method === 'textDocument/publishDiagnostics').length;
        console.log(`lsp: diagnostics #${i}`, ms(a), `${published} publish(es)`);
        lite.handle({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 + i }, contentChanges: [{ text: SAMPLE['main.swift'] }] } });
    }
    const td = { uri };
    const at = (line, character) => ({ textDocument: td, position: { line, character } });
    for (let i = 0; i < 2; i++) timed(`completion after "b." #${i}`, 'textDocument/completion', at(3, 8));
    timed('hover', 'textDocument/hover', at(1, 4));
    timed('definition', 'textDocument/definition', at(1, 9));
    timed('references', 'textDocument/references', { ...at(1, 9), context: { includeDeclaration: true } });
    timed('documentHighlight', 'textDocument/documentHighlight', at(1, 4));
    timed('rename', 'textDocument/rename', { ...at(1, 4), newName: 'end' });
    timed('signatureHelp', 'textDocument/signatureHelp', at(1, 14));
    timed('documentSymbol', 'textDocument/documentSymbol', { textDocument: td });
    timed('inlayHint', 'textDocument/inlayHint', { textDocument: td, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } } });
    for (const name of root.contents.get('tmp')?.contents.keys() ?? []) if (name.startsWith('sourcekit-lsp-lite-')) rm(root, `/tmp/${name}`);
}
for (let i = 0; i < 2; i++) {
    let a = t();
    let r = await run(frontend, tc.compileArgs(sources, '/work/main.o'), root);
    console.log(`whole-module -c #${i}`, ms(a), r.code, r.err.slice(0, 2000));
}
let a = t();
let r = await run(linker, tc.linkArgs(['/work/main.o'], '/work/program.wasm', undefined, tc.autolinkEntries(tc.readFile(root, '/work/main.o'))), root);
console.log('link', ms(a), r.code, r.err);
const prog = tc.readFile(root, '/work/program.wasm');
console.log('program size', prog?.length);
if (traceOut) writeFileSync(traceOut, [...opened].sort().join('\n') + '\n');
a = t();
const pm = await WebAssembly.compile(prog);
r = await run(pm, ['main'], root);
console.log('run', ms(a), r.code, JSON.stringify(r.out), r.err);
if (traceOut) writeFileSync(traceOut, [...opened].sort().join('\n') + '\n');
