// Node benchmark/trace of the in-browser pipeline (the same src/toolchain.js
// that runner.js and typecheck.js use, under Node's WebAssembly):
//
//   node tools/bench.mjs <dir> [trace-out.txt]
//
// <dir> holds swift-frontend.wasm, wasm-ld.wasm and swift-sysroot-core.tar
// (original or trimmed). Times whole-module vs per-file compilation (twice
// each), -typecheck, linking and running the sample, and with a second
// argument writes every path the tools opened (`open`) or stat'ed (`stat`):
// that list is where tools/trim-sysroot.mjs's rules come from. EXTRA=1 uses a
// program importing WASILibc, Synchronization and RegexBuilder instead.
import { readFileSync, writeFileSync } from 'node:fs';
import * as tc from '../src/toolchain.js';

const dir = process.argv[2];
const traceOut = process.argv[3];
const t = () => performance.now();
const ms = (a) => `${Math.round(t() - a)} ms`;

let t0 = t();
const [frontend, linker] = await Promise.all(['swift-frontend.wasm', 'wasm-ld.wasm'].map((n) => WebAssembly.compile(readFileSync(`${dir}/${n}`))));
console.log('compile both modules', ms(t0));
const tar = new Uint8Array(readFileSync(`${dir}/swift-sysroot-core.tar`));

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
    const code = await tc.runWasi(module, {
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
for (let i = 0; i < 2; i++) {
    let a = t();
    let r = await run(frontend, tc.compileArgs(sources, '/work/main.o'), root);
    console.log(`whole-module -c #${i}`, ms(a), r.code, r.err.slice(0, 2000));
}
for (let i = 0; i < 2; i++) {
    const a = t();
    for (const s of sources) {
        const r = await run(frontend, tc.compileArgsPrimary(sources, s, s.replace('.swift', '.p.o')), root);
        if (r.code) console.log(r.err);
    }
    console.log(`per-file -c x${sources.length} #${i}`, ms(a));
}
for (let i = 0; i < 2; i++) {
    const a = t();
    const r = await run(frontend, tc.typecheckArgs(sources), root);
    console.log(`-typecheck #${i}`, ms(a), r.code, r.err);
}
tc.writeFile(root, '/work/bad.swift', 'let x: Int = "no"\n');
{
    const a = t();
    const r = await run(frontend, tc.typecheckArgs([...sources, '/work/bad.swift']), root);
    console.log(`-typecheck with error`, ms(a), r.code, r.err);
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
