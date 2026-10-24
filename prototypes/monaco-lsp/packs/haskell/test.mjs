// Headless test of the Haskell pack, run the way the app runs it:
// app/static served over http with COOP/COEP (so the page is
// crossOriginIsolated and the runner can read stdin), the workers started
// as `new Worker('/packs/haskell/server.js', { type: 'module' })` and
// `.../runner.js` in Chromium, one JSON-RPC object per postMessage.
//
// The server: the sample (Main.hs uses Point, distance and norm from
// Geometry.hs; tests/Spec.hs is hspec) has no errors; MicroHs's type errors
// (a mismatch, a missing instance, an unknown name, a parse error, one in an
// imported module) are reported where they are; completion of names (with
// types), after `Map.` and after `import`; hover with types and Haddock;
// definition, references and highlights across files and of locals;
// document symbols; rename and what it refuses; closing a file.
//
// The runner: the sample prints its output; a program reads two lines of
// stdin (a prompt without a newline shows before the read); Data.Map works;
// a compile error, an uncaught exception and exitWith end with the right
// code; Test runs tests/Spec.hs with hspec's coloured report, and a failing
// example fails it.
//
//   node test.mjs            (after ./build.sh; needs playwright-core)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };

// Raw files, no content-encoding negotiation: the worst-case transfer.
let bytesServed = 0;
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION }).end('<!doctype html><link rel=icon href="data:,"><title>haskell pack test</title>');
        return;
    }
    const file = normalize(join(STATIC, path));
    try {
        if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
        const body = await readFile(file);
        bytesServed += body.length;
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'max-age=3600', ...ISOLATION });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const GEOMETRY = `-- | Points and shapes in the plane.
module Geometry
  ( Point (..)
  , norm
  , distance
  , Shape (..)
  , area
  ) where

-- | A point in the plane.
data Point = Point {px :: Double, py :: Double}
  deriving (Eq)

instance Show Point where
  show (Point x y) = "(" ++ show x ++ ", " ++ show y ++ ")"

-- | Distance from the origin.
norm :: Point -> Double
norm (Point x y) = sqrt (x * x + y * y)

-- | Euclidean distance between two points.
distance :: Point -> Point -> Double
distance a b = norm (Point (px a - px b) (py a - py b))

-- | A shape, told apart by its constructor.
data Shape = Circle Double | Square Double
  deriving (Show)

-- | The area of a shape; the cases cover every constructor.
area :: Shape -> Double
area (Circle r) = pi * r * r
area (Square side) = side * side
`;
const MAIN = `module Main (main) where

import Geometry

main :: IO ()
main = do
  let a = Point 0 0
      b = Point 3 4
  putStrLn (show a ++ " to " ++ show b ++ ": " ++ show (distance a b))
  print (norm b)
  mapM_ (print . area) [Circle 1, Square 2]
`;
const SPEC = `module Main (main) where

import Geometry
import Test.Hspec

main :: IO ()
main = hspec $ do
  describe "norm" $
    it "is 5 at (3, 4)" $
      norm (Point 3 4) \`shouldBe\` 5

  describe "distance" $ do
    it "is symmetric" $ do
      let a = Point 1 2
          b = Point (-2) 6
      distance a b \`shouldBe\` distance b a

    it "is 0 from a point to itself" $
      distance (Point 7 (-3)) (Point 7 (-3)) \`shouldBe\` 0

  describe "area" $
    it "of a square of side 3 is 9" $
      area (Square 3) \`shouldBe\` 9
`;
const SAMPLE = { 'Main.hs': MAIN, 'Geometry.hs': GEOMETRY, 'tests/Spec.hs': SPEC };
const README = `# Not Haskell (at all\n`;
const append = (text, more) => text + more;

await stat(join(STATIC, 'packs/haskell/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/haskell/server.js')}: run ./build.sh first`);
    process.exit(2);
});
const browser = await chromium.launch({ executablePath: CHROMIUM });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
};

try {
    const page = await browser.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log(`[page] ${m.text()}`));
    page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
    await page.goto(`${origin}/__test.html`);
    check('the test page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated));

    await serverTests(page);
    await runnerTests(page);
    console.log(`\n${(bytesServed / 1e6).toFixed(2)} MB served raw`);
} finally {
    await browser.close();
    server.close();
}
if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nall checks passed');

async function serverTests(page) {
    // A minimal LSP client in the page, the shape the app's client has.
    await page.evaluate(() => {
        const worker = new Worker('/packs/haskell/server.js', { type: 'module' });
        const pending = new Map();
        const log = [];
        let nextId = 1;
        worker.onerror = (e) => log.push({ method: 'worker/error', params: String(e.message) });
        worker.onmessage = ({ data: msg }) => {
            if (msg.id !== undefined && msg.method) {
                worker.postMessage({ jsonrpc: '2.0', id: msg.id, result: null });
            } else if (msg.id !== undefined) {
                pending.get(msg.id)?.(msg);
                pending.delete(msg.id);
            } else {
                log.push(msg);
            }
        };
        window.lsp = {
            log,
            t0: performance.now(),
            request(method, params) {
                const id = nextId++;
                worker.postMessage({ jsonrpc: '2.0', id, method, params });
                return new Promise((ok) => pending.set(id, ok));
            },
            notify(method, params) {
                worker.postMessage({ jsonrpc: '2.0', method, params });
            },
        };
    });
    const lsp = {
        request: (method, params) => page.evaluate(([m, p]) => window.lsp.request(m, p), [method, params]),
        notify: (method, params) => page.evaluate(([m, p]) => window.lsp.notify(m, p), [method, params]),
        log: () => page.evaluate(() => window.lsp.log),
        elapsed: () => page.evaluate(() => Math.round(performance.now() - window.lsp.t0)),
    };
    const uri = (name) => `file:///workspace/${name}`;
    let version = 1;
    const change = (name, text) => lsp.notify('textDocument/didChange', { textDocument: { uri: uri(name), version: ++version }, contentChanges: [{ text }] });
    /** Waits for the latest publishDiagnostics of a file (after `after` messages) to satisfy `ok`. */
    async function diagnostics(name, ok, after = 0, timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() < deadline) {
            const published = (await lsp.log()).slice(after).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri(name));
            last = published.at(-1)?.params.diagnostics;
            if (last && ok(last)) return last;
            await page.waitForTimeout(100);
        }
        return last;
    }
    /**
     * Waits until the checks after `after` messages are over: one has
     * finished (the server logs each) and no other for 600 ms, longer than
     * the server's debounce, so a check of an earlier edit is not taken for
     * the last.
     */
    async function checked(after) {
        const deadline = Date.now() + 60000;
        let count = 0;
        let since = Date.now();
        while (Date.now() < deadline) {
            const n = (await lsp.log()).slice(after).filter((m) => m.method === 'window/logMessage' && /^checked /.test(m.params.message)).length;
            if (n !== count) {
                count = n;
                since = Date.now();
            } else if (n > 0 && Date.now() - since > 600) return;
            await page.waitForTimeout(50);
        }
    }
    const at = (name, line, character) => ({ textDocument: { uri: uri(name) }, position: { line, character } });
    const show = (d) => JSON.stringify(d?.map((x) => `${x.range.start.line}:${x.range.start.character}-${x.range.end.character} ${x.message}`));
    /** Line and character of the n-th (0-based) occurrence of `word` in `text`. */
    const find = (text, word, n = 0) => {
        let i = -1;
        for (let k = 0; k <= n; k++) i = text.indexOf(word, i + 1);
        const before = text.slice(0, i);
        return [before.split('\n').length - 1, i - before.lastIndexOf('\n') - 1];
    };

    const init = await lsp.request('initialize', {
        processId: null,
        rootUri: 'file:///workspace/',
        workspaceFolders: [{ uri: 'file:///workspace/', name: 'workspace' }],
        capabilities: { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] } } },
    });
    const loading = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    check('initialize answers after the downloads, with progress notifications', !!init.result?.capabilities?.hoverProvider && loading.length > 0,
        `(${await lsp.elapsed()} ms, ${loading.length} progress messages, server ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version})`);
    if (init.error) console.log(init.error);
    await lsp.notify('initialized', {});
    let mark = (await lsp.log()).length;
    for (const [name, text] of Object.entries(SAMPLE)) await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId: 'haskell', version: 1, text } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('README.md'), languageId: 'markdown', version: 1, text: README } });
    const t0 = Date.now();
    await checked(mark);
    const firstCheck = Date.now() - t0;
    for (const name of Object.keys(SAMPLE)) {
        const d = await diagnostics(name, () => true);
        check(`${name} of the sample has no errors`, d?.length === 0, show(d));
    }
    const readme = (await lsp.log()).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('README.md'));
    check('README.md is not checked', readme.length === 0);
    console.log(`      (first check of the three files: ${firstCheck} ms, including reading the packages)`);

    // Errors, one kind at a time.
    const errorCase = async (what, text, ok) => {
        mark = (await lsp.log()).length;
        const t = Date.now();
        await change('Main.hs', text);
        const d = await diagnostics('Main.hs', (x) => x.length > 0, mark);
        check(what, d?.length === 1 && d[0].severity === 1 && ok(d[0]), `${show(d)} (${Date.now() - t} ms)`);
    };
    await errorCase('a type mismatch is reported on its line, in GHC\'s words', append(MAIN, '\nbroken :: Int\nbroken = True\n'),
        (d) => d.range.start.line === 13 && /Couldn't match type ‘Bool’ with ‘Int’/.test(d.message));
    await errorCase('a string where an Int is wanted is a missing IsString instance, explained', append(MAIN, '\nbroken :: Int\nbroken = length "abc" + "no"\n'),
        (d) => d.range.start.line === 13 && /No instance for \(IsString Int\)/.test(d.message) && /string literal/.test(d.message));
    await errorCase('an unknown name is not in scope, underlined', append(MAIN, '\nbroken :: Int\nbroken = lenght [1, 2]\n'),
        (d) => d.range.start.line === 13 && d.range.start.character === 9 && d.range.end.character === 15 && /Variable not in scope: lenght/.test(d.message));
    await errorCase('a parse error says what was unexpected', append(MAIN, '\nbroken = (1 +\n'),
        (d) => d.range.start.line >= 12 && /^Parse error: unexpected/.test(d.message));
    await errorCase('a wrong argument type in a call of a project function', MAIN.replace('print (norm b)', 'print (norm 3 b)'),
        (d) => d.range.start.line === 9);
    await change('Main.hs', MAIN);
    let d = await diagnostics('Main.hs', (x) => x.length === 0);
    check('fixing it clears the error', d?.length === 0, show(d));

    mark = (await lsp.log()).length;
    await change('Geometry.hs', GEOMETRY.replace('sqrt (x * x + y * y)', 'sqrt (x * x + y * "y")'));
    const gd = await diagnostics('Geometry.hs', (x) => x.length > 0, mark);
    const md = await diagnostics('Main.hs', () => true, 0);
    check('an error in Geometry.hs is reported there, once, and not in Main.hs which imports it', gd?.length === 1 && gd[0].range.start.line === 18 && md?.length === 0, `${show(gd)} ${show(md)}`);
    mark = (await lsp.log()).length;
    await change('Geometry.hs', GEOMETRY);
    d = await diagnostics('Geometry.hs', (x) => x.length === 0, mark);
    check('and fixing it clears it', d?.length === 0, show(d));
    await checked(mark);

    // Hover.
    let [l, c] = find(MAIN, 'distance');
    let h = (await lsp.request('textDocument/hover', at('Main.hs', l, c + 2))).result?.contents?.value ?? '';
    check('hover on `distance` shows its type and Haddock comment', /distance :: Point -> Point -> Double/.test(h) && /Euclidean distance between two points/.test(h), JSON.stringify(h));
    [l, c] = find(MAIN, 'a b)');
    h = (await lsp.request('textDocument/hover', at('Main.hs', l, c))).result?.contents?.value ?? '';
    check('hover on the local `a` shows its inferred type', /a :: Point/.test(h), JSON.stringify(h));
    [l, c] = find(MAIN, 'putStrLn');
    h = (await lsp.request('textDocument/hover', at('Main.hs', l, c + 1))).result?.contents?.value ?? '';
    check('hover on `putStrLn` (base) shows its type and module', /putStrLn :: \[Char\] -> IO \(\)/.test(h) && /System\.IO/.test(h), JSON.stringify(h));
    [l, c] = find(MAIN, 'print', 1);
    h = (await lsp.request('textDocument/hover', at('Main.hs', l, c + 1))).result?.contents?.value ?? '';
    check('hover on a polymorphic `print` shows its declared type and the type here', /print :: Show a => a -> IO \(\)/.test(h) && /Here: `Double -> IO \(\)`|Here/.test(h), JSON.stringify(h));
    [l, c] = find(GEOMETRY, 'norm ::');
    h = (await lsp.request('textDocument/hover', at('Geometry.hs', l + 1, 1))).result?.contents?.value ?? '';
    check('hover on a definition (`norm` where it is defined) shows its type', /norm :: Point -> Double/.test(h), JSON.stringify(h));
    [l, c] = find(GEOMETRY, 'Point ->');
    h = (await lsp.request('textDocument/hover', at('Geometry.hs', l, c + 1))).result?.contents?.value ?? '';
    check('hover on the type `Point` in a signature shows its declaration', /data Point = Point \{px :: Double, py :: Double\}/.test(h) && /A point in the plane/.test(h), JSON.stringify(h));

    // Definition, references, highlights.
    [l, c] = find(MAIN, 'distance');
    let r = [(await lsp.request('textDocument/definition', at('Main.hs', l, c + 1))).result].flat()[0];
    let [dl, dc] = find(GEOMETRY, 'distance a b =');
    check('go to definition of `distance` lands on its definition in Geometry.hs', r?.uri === uri('Geometry.hs') && r.range.start.line === dl && r.range.start.character === dc, JSON.stringify(r));
    [l, c] = find(MAIN, 'b)');
    r = [(await lsp.request('textDocument/definition', at('Main.hs', l, c))).result].flat()[0];
    [dl, dc] = find(MAIN, 'b = Point');
    check('go to definition of the local `b` lands on its let binding', r?.uri === uri('Main.hs') && r.range.start.line === dl && r.range.start.character === dc, JSON.stringify(r));
    [l, c] = find(MAIN, 'Circle');
    r = [(await lsp.request('textDocument/definition', at('Main.hs', l, c + 1))).result].flat()[0];
    [dl] = find(GEOMETRY, 'Circle Double');
    check('go to definition of the constructor `Circle` lands in its data declaration', r?.uri === uri('Geometry.hs') && r.range.start.line === dl, JSON.stringify(r));
    [l, c] = find(GEOMETRY, 'norm ::');
    const refs = (await lsp.request('textDocument/references', { ...at('Geometry.hs', l + 1, 1), context: { includeDeclaration: true } })).result ?? [];
    const rl = refs.map((x) => `${x.uri.split('/').pop()}:${x.range.start.line}:${x.range.start.character}`).sort();
    check('references to `norm` are its export, signature and equation, its use in distance, in Main.hs and in Spec.hs', JSON.stringify(rl) === JSON.stringify(['Geometry.hs:17:0', 'Geometry.hs:18:0', 'Geometry.hs:22:15', 'Geometry.hs:3:4', 'Main.hs:9:9', 'Spec.hs:9:6']), JSON.stringify(rl));
    [l, c] = find(GEOMETRY, 'side * side');
    const hl = (await lsp.request('textDocument/documentHighlight', at('Geometry.hs', l, c))).result ?? [];
    check('highlights of the pattern variable `side` are its binding and its two uses', hl.length === 3 && hl.filter((x) => x.kind === 3).length === 1, JSON.stringify(hl));

    // Symbols.
    const symbols = (await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri('Geometry.hs') } })).result ?? [];
    const names = symbols.map((s) => s.name);
    check('document symbols list the types and the functions of Geometry.hs', ['Point', 'norm', 'distance', 'Shape', 'area'].every((n) => names.includes(n)), JSON.stringify(names));

    // Completion.
    const typing = (text, line, character) => change('Main.hs', text).then(() => lsp.request('textDocument/completion', at('Main.hs', line, character)));
    let comp = (await typing(append(MAIN, '  print (dis'), 11, 13)).result?.items ?? [];
    const dist = comp.find((i) => i.label === 'distance');
    check('completion of a name offers the project\'s distance with its type, locals, Prelude and keywords',
        dist?.detail === 'Point -> Point -> Double' && ['a', 'b', 'putStrLn', 'foldr', 'where', 'Maybe'].every((x) => comp.some((i) => i.label === x)),
        `${JSON.stringify(dist)} (${comp.length} items)`);
    const QUALIFIED = MAIN.replace('import Geometry\n', 'import Geometry\nimport qualified Data.Map as Map\n');
    mark = (await lsp.log()).length;
    await change('Main.hs', QUALIFIED);
    await checked(mark);
    comp = (await typing(append(QUALIFIED, '  print (Map.'), 12, 13)).result?.items ?? [];
    check('completion after `Map.` (import qualified Data.Map as Map) offers Data.Map\'s functions', ['insert', 'fromList', 'toList', 'lookup'].every((x) => comp.some((i) => i.label === x)), JSON.stringify(comp.slice(0, 8).map((i) => i.label)));
    comp = (await typing(MAIN.replace('import Geometry\n', 'import Geometry\nimport Data.\n'), 3, 12)).result?.items ?? [];
    check('completion after `import Data.` offers the modules there are', ['Data.Map', 'Data.Map.Strict', 'Data.Char', 'Data.List', 'Data.Set'].every((x) => comp.some((i) => i.label === x)), `${comp.length} modules`);

    // Rename.
    await change('Main.hs', MAIN);
    mark = (await lsp.log()).length;
    await checked(mark);
    [l, c] = find(MAIN, 'distance');
    const prep = (await lsp.request('textDocument/prepareRename', at('Main.hs', l, c + 1))).result;
    check('prepareRename on `distance` offers it', prep?.placeholder === 'distance', JSON.stringify(prep));
    const ren = (await lsp.request('textDocument/rename', { ...at('Main.hs', l, c + 1), newName: 'dist' })).result;
    const edits = Object.entries(ren?.changes ?? {}).map(([u, es]) => `${u.split('/').pop()}:${es.length}`).sort();
    check('rename of `distance` edits its export, signature and equation in Geometry.hs and its uses in Main.hs and Spec.hs', JSON.stringify(edits) === JSON.stringify(['Geometry.hs:3', 'Main.hs:1', 'Spec.hs:3']), JSON.stringify(edits));
    [l, c] = find(MAIN, 'putStrLn');
    const bad = await lsp.request('textDocument/rename', { ...at('Main.hs', l, c + 1), newName: 'say' });
    check('rename of `putStrLn` (base) is refused, saying why', /not in this project/.test(bad.error?.message ?? ''), JSON.stringify(bad.error));
    [l, c] = find(MAIN, 'a = Point');
    const bad2 = await lsp.request('textDocument/rename', { ...at('Main.hs', l, c), newName: 'Upper' });
    check('rename of a variable to a capitalised name is refused', /lowercase/.test(bad2.error?.message ?? ''), JSON.stringify(bad2.error));

    // Closing a file.
    mark = (await lsp.log()).length;
    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri('tests/Spec.hs') } });
    const closed = await diagnostics('tests/Spec.hs', (x) => x.length === 0, mark);
    check('closing a file clears its diagnostics', closed?.length === 0, show(closed));

    const late = await lsp.request('textDocument/hover', { textDocument: { uri: 'file:///elsewhere/x.hs' }, position: { line: 0, character: 0 } });
    check('a request for a file outside the workspace is an error, not a crash', late.error?.code === -32602, JSON.stringify(late));
    const errors = (await lsp.log()).filter((m) => m.method === 'worker/error' || (m.method === 'window/logMessage' && m.params.type === 1));
    check('the server logged no errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
}

async function runnerTests(page) {
    // In the page: start a runner, answer its stdin requests from `inputs`
    // (a string is a line, null is Ctrl-D), collect every message in order.
    await page.evaluate(() => {
        window.runProgram = (files, entry, inputs = [], type = 'run') =>
            new Promise((done) => {
                const t0 = performance.now();
                const sab = new SharedArrayBuffer(8 + 65536);
                const state = new Int32Array(sab, 0, 2);
                const data = new Uint8Array(sab, 8);
                const out = { stdout: '', stderr: '', code: null, events: [], phases: [] };
                const worker = new Worker('/packs/haskell/runner.js', { type: 'module' });
                const timer = setTimeout(() => { worker.terminate(); out.code = 'timeout'; done(out); }, 120000);
                worker.onerror = (e) => { out.stderr += `worker error: ${e.message}`; };
                worker.onmessage = ({ data: msg }) => {
                    if (msg.type === 'stdout' || msg.type === 'stderr') { out[msg.type] += msg.text; out.events.push(`${msg.type}:${msg.text}`); }
                    else if (msg.type === 'phase') out.phases.push(msg.text);
                    else if (msg.type === 'stdin') {
                        out.events.push('stdin?');
                        const line = inputs.shift();
                        setTimeout(() => {
                            if (line === null || line === undefined) Atomics.store(state, 0, 3);
                            else {
                                const bytes = new TextEncoder().encode(line + '\n');
                                data.set(bytes);
                                Atomics.store(state, 1, bytes.length);
                                Atomics.store(state, 0, 2);
                            }
                            Atomics.notify(state, 0);
                        }, 10);
                    } else if (msg.type === 'exit') {
                        clearTimeout(timer);
                        out.code = msg.code;
                        out.ms = Math.round(performance.now() - t0);
                        worker.terminate();
                        done(out);
                    }
                };
                worker.postMessage({ type, files, entry, stdin: sab });
            });
    });
    const run = (files, inputs = [], type = 'run', entry = 'Main.hs') => page.evaluate(([f, i, t, e]) => window.runProgram(f, e, i, t), [files, inputs, type, entry]);

    let r = await run(SAMPLE);
    check('Run prints the sample\'s output and exits with 0', r.code === 0 && r.stdout === '(0.0, 0.0) to (3.0, 4.0): 5.0\n5.0\n3.141592653589793\n4.0\n', `${JSON.stringify(r.stdout)} ${r.stderr} code ${r.code} (${r.ms} ms, cold)`);
    r = await run(SAMPLE);
    console.log(`      (a second run: ${r.ms} ms)`);

    const ECHO = `main :: IO ()
main = do
  putStr "Your name? "
  name <- getLine
  putStrLn ("Hello, " ++ name ++ "!")
  n <- readLn :: IO Int
  print (n * 2)
`;
    r = await run({ 'Main.hs': ECHO }, ['Ada', '21']);
    check('a program reads two lines of stdin; its prompt shows before the read', r.code === 0 && r.stdout === 'Your name? Hello, Ada!\n42\n' && r.events[0] === 'stdout:Your name? ' && r.events[1] === 'stdin?', `${JSON.stringify(r.events)} ${r.stderr}`);
    r = await run({ 'Main.hs': 'main :: IO ()\nmain = getContents >>= \\s -> print (length (lines s))\n' }, ['one', 'two', null]);
    check('getContents reads to the end of input (Ctrl-D)', r.code === 0 && r.stdout === '2\n', `${JSON.stringify(r.stdout)} ${r.stderr}`);

    const MAP = `import qualified Data.Map.Strict as Map
import Data.List (sortOn)
import Data.Char (toUpper)

main :: IO ()
main = do
  let counts = Map.fromListWith (+) [(w, 1 :: Int) | w <- words "a b a c b a"]
  print (sortOn (negate . snd) (Map.toList counts))
  putStrLn (map toUpper "done")
`;
    r = await run({ 'Main.hs': MAP });
    check('Data.Map, Data.List and Data.Char work', r.code === 0 && r.stdout === '[("a",3),("b",2),("c",1)]\nDONE\n', `${JSON.stringify(r.stdout)} ${r.stderr}`);

    r = await run({ ...SAMPLE, 'Main.hs': MAIN.replace('print (norm b)', 'print (norm True)') });
    check('a compile error is printed as GHC does, and the exit code is 1', r.code === 1 && /^\/workspace\/Main\.hs:10:15: error:\n    Couldn't match type ‘Bool’ with ‘Point’/.test(r.stderr) && r.stdout === '', `${JSON.stringify(r.stderr)} code ${r.code}`);
    r = await run({ 'Main.hs': 'main :: IO ()\nmain = do\n  putStrLn "before"\n  print (head ([] :: [Int]))\n' });
    check('an uncaught exception ends the program with its message and code 1, after the output before it', r.code === 1 && r.stdout === 'before\n' && /head/.test(r.stderr), `${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)} code ${r.code}`);
    r = await run({ 'Main.hs': 'import System.Exit\n\nmain :: IO ()\nmain = do\n  putStrLn "bye"\n  exitWith (ExitFailure 3)\n' });
    check('exitWith (ExitFailure 3) ends with code 3 and nothing on stderr', r.code === 3 && r.stdout === 'bye\n' && r.stderr === '', `${JSON.stringify(r)}`);

    r = await run(SAMPLE, [], 'test');
    check('Test runs tests/Spec.hs: hspec\'s report, coloured, "4 examples, 0 failures", code 0',
        r.code === 0 && /4 examples, 0 failures/.test(r.stdout) && /is symmetric \[\x1b\[32m✔/.test(r.stdout), `${JSON.stringify(r.stdout.slice(-300))} ${r.stderr} (${r.ms} ms)`);
    r = await run({ ...SAMPLE, 'tests/Spec.hs': SPEC.replace('`shouldBe` 9', '`shouldBe` 10') }, [], 'test');
    check('a failing example fails Test with code 1, saying what was expected', r.code === 1 && /4 examples, 1 failure/.test(r.stdout) && /expected: 10\.0[\s\S]*but got: 9\.0/.test(r.stdout), `${JSON.stringify(r.stdout.slice(-400))} ${r.stderr}`);
    r = await run({ 'Main.hs': MAIN }, [], 'test');
    check('Test without tests says so', r.code === 1 && /No tests/.test(r.stderr), JSON.stringify(r.stderr));
}
