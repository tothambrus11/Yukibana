// Headless test of the Kotlin pack's language server, run the way the app
// runs it: app/static served over http, `new Worker('/packs/kotlin/server.js',
// { type: 'module' })` in Chromium, one JSON-RPC object per postMessage. A
// two-file project (Main.kt uses Point and distance from Geometry.kt) and a
// README that must be ignored. The server reads syntax only (README.md):
// checks syntax errors, completion of names and of a project class's
// members, hover with KDoc, definition and references across files,
// symbols, signature help, deleting a file, and malformed and late requests.
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
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };

// A plain static server: raw files, no content-encoding negotiation, so the
// test sees the worst-case transfer.
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel=icon href="data:,"><title>kotlin pack test</title>');
        return;
    }
    const file = normalize(join(STATIC, path));
    try {
        if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;


const GEOMETRY = `import kotlin.math.hypot

/** A point in the plane. */
data class Point(val x: Double, val y: Double) {
    /** Distance from the origin. */
    fun norm(): Double = hypot(x, y)
}

/** Euclidean distance between two points. */
fun distance(a: Point, b: Point): Double = hypot(a.x - b.x, a.y - b.y)
`;
const MAIN = `fun main() {
    val a = Point(0.0, 0.0)
    val b: Point = Point(3.0, 4.0)
    val names = listOf("été", "x").map { it.uppercase() }
    println("$a to $b: \${distance(a, b)} \${names}")
    println(b.norm())
}
`;
// A new line 6, inside main.
const inMain = (line) => MAIN.replace('}\n', `${line}\n}\n`).replace(/\}\n$/, '}\n');
const insert = (line) => { const i = MAIN.lastIndexOf('}'); return MAIN.slice(0, i) + line + '\n' + MAIN.slice(i); };
const MAIN_BROKEN = insert('    val broken = (1 + ');
const MAIN_TYPING_B = insert('    b.');
const MAIN_TYPING_NAME = insert('    dis');
const README = `# Not Kotlin (at all\n`;

await stat(join(STATIC, 'packs/kotlin/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/kotlin/server.js')}: run ./build.sh first`);
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

    // A minimal LSP client in the page, the shape the app's client has.
    await page.evaluate(() => {
        const worker = new Worker('/packs/kotlin/server.js', { type: 'module' });
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
            const published = (await lsp.log()).slice(after).filter(
                (m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri(name)
            );
            last = published.at(-1)?.params.diagnostics;
            if (last && ok(last)) return last;
            await page.waitForTimeout(100);
        }
        return last;
    }
    const at = (name, line, character) => ({ textDocument: { uri: uri(name) }, position: { line, character } });
    const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };

    const init = await lsp.request('initialize', {
        processId: null,
        rootUri: 'file:///workspace/',
        workspaceFolders: [{ uri: 'file:///workspace/', name: 'workspace' }],
        capabilities: { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] } } },
    });
    const loading = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    check('initialize answers after the runtime and grammar download, with progress notifications', !!init.result?.capabilities?.hoverProvider && loading.length > 0,
        `(${await lsp.elapsed()} ms, ${loading.length} progress messages, server ${init.result?.serverInfo?.name})`);
    if (init.error) console.log(init.error);
    await lsp.notify('initialized', {});
    const G = 'src/main/kotlin/Geometry.kt';
    const M = 'src/main/kotlin/Main.kt';
    const short = (u) => u.split('/').pop();
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri(G), languageId: 'kotlin', version: 1, text: GEOMETRY } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri(M), languageId: 'kotlin', version: 1, text: MAIN } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('README.md'), languageId: 'markdown', version: 1, text: README } });

    let diags = await diagnostics(M, () => true);
    check('the sample has no syntax errors', diags?.length === 0, JSON.stringify(diags?.map((d) => d.message)));
    const gd = await diagnostics(G, () => true);
    check('Geometry.kt has none either', gd?.length === 0, JSON.stringify(gd?.map((d) => d.message)));

    let mark = (await lsp.log()).length;
    await change(M, MAIN_BROKEN);
    diags = await diagnostics(M, (d) => d.length > 0, mark);
    check('an unclosed parenthesis is a syntax error at the end of main', diags?.length > 0 && diags.every((d) => d.severity === 1 && d.range.start.line >= 6), JSON.stringify(diags?.map((d) => `${d.range.start.line}:${d.range.start.character} ${d.message}`)));

    await change(M, MAIN_TYPING_B);
    const c1 = await lsp.request('textDocument/completion', at(M, 6, 6));
    const l1 = (c1.result?.items ?? []).map((i) => i.label);
    check('completion after `b.` (declared `b: Point`) offers Point\'s members, then Any\'s, and copy', ['norm', 'x', 'y', 'toString', 'copy'].every((l) => l1.includes(l)), JSON.stringify(l1));
    await change(M, insert('    a.'));
    const c1b = await lsp.request('textDocument/completion', at(M, 6, 6));
    const l1b = (c1b.result?.items ?? []).map((i) => i.label);
    check('completion after `a.` (constructed `Point(...)`) offers Point\'s members too', ['norm', 'x', 'y'].every((l) => l1b.includes(l)), JSON.stringify(l1b));
    await change(M, insert('    names.'));
    const c1c = await lsp.request('textDocument/completion', at(M, 6, 10));
    check('completion after a receiver of a library type offers nothing (the editor then offers the document\'s words)', (c1c.result?.items ?? []).length === 0, JSON.stringify(c1c.result));
    // As the app's e2e types it at the end of the file (Monaco closes the brackets).
    const AFTER = MAIN + '\nfun broken() { val = 1 }\n\nval q = Point(1.0, 2.0)\nval r = q.';
    mark = (await lsp.log()).length;
    await change(M, AFTER);
    const ae = await diagnostics(M, (d) => d.length > 0, mark);
    check('`val = 1` (no name) is a syntax error on its line', ae?.some((d) => d.range.start.line === 8), JSON.stringify(ae?.map((d) => `${d.range.start.line}: ${d.message}`)));
    const ce = await lsp.request('textDocument/completion', at(M, 11, 10));
    check('completion after `q.` on a top-level `val q = Point(...)` typed after a syntax error offers norm', (ce.result?.items ?? []).some((i) => i.label === 'norm'), JSON.stringify(ce.result?.items?.map((i) => i.label)));
    await change(M, MAIN_TYPING_NAME);
    const c2 = await lsp.request('textDocument/completion', at(M, 6, 7));
    const i2 = c2.result?.items ?? [];
    const dist = i2.find((i) => i.label === 'distance');
    check('completion of a name offers the project\'s distance with its signature, locals, keywords and println', !!dist && /fun distance\(a: Point, b: Point\): Double/.test(dist.detail) &&
        ['a', 'b', 'names', 'Point', 'println', 'val', 'when'].every((l) => i2.some((i) => i.label === l)), JSON.stringify(dist));

    await change(M, MAIN);
    const hover = await lsp.request('textDocument/hover', at(M, 5, 15));
    const ht = hover.result?.contents?.value ?? '';
    check('hover on `norm` shows its declaration and KDoc', /fun norm\(\): Double/.test(ht) && /Distance from the origin/.test(ht), JSON.stringify(ht));
    const hover2 = await lsp.request('textDocument/hover', at(M, 1, 14));
    const ht2 = hover2.result?.contents?.value ?? '';
    check('hover on `Point` shows the data class and its KDoc', /data class Point\(val x: Double, val y: Double\)/.test(ht2) && /A point in the plane/.test(ht2), JSON.stringify(ht2));

    const def = await lsp.request('textDocument/definition', at(M, 4, 31));
    const t = [def.result].flat()[0];
    check('go to definition of `distance` (inside a string template) lands in Geometry.kt', t?.uri === uri(G) && t?.range.start.line === 9 && t?.range.start.character === 4, JSON.stringify(def.result));
    const def2 = await lsp.request('textDocument/definition', at(M, 5, 15));
    const t2 = [def2.result].flat()[0];
    check('go to definition of `b.norm` lands on `norm` in Geometry.kt', t2?.uri === uri(G) && t2?.range.start.line === 5, JSON.stringify(def2.result));
    const def3 = await lsp.request('textDocument/definition', at(G, 9, 49));
    const t3 = [def3.result].flat()[0];
    check('go to definition of the parameter `a` in `a.x` lands on the parameter', t3?.uri === uri(G) && t3?.range.start.line === 9 && t3?.range.start.character === 13, JSON.stringify(def3.result));

    const refs = await lsp.request('textDocument/references', { ...at(G, 3, 12), context: { includeDeclaration: true } });
    const rl = (refs.result ?? []).map((r) => `${short(r.uri)}:${r.range.start.line}`).sort();
    check('references to `Point` are its declaration, the parameter types and the uses in Main.kt', ['Geometry.kt:3', 'Geometry.kt:9', 'Main.kt:1', 'Main.kt:2'].every((x) => rl.includes(x)), JSON.stringify(rl));
    const refsX = await lsp.request('textDocument/references', { ...at(G, 3, 21), context: { includeDeclaration: false } });
    const rx = (refsX.result ?? []).map((r) => `${short(r.uri)}:${r.range.start.line}:${r.range.start.character}`).sort();
    check('references to the property `x` are `x` in norm and `a.x`, `b.x` (not other names x)', JSON.stringify(rx) === JSON.stringify(['Geometry.kt:5:31', 'Geometry.kt:9:51', 'Geometry.kt:9:57']), JSON.stringify(rx));

    const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri(G) } });
    const names = (symbols.result ?? []).flatMap((s) => [s.name, ...(s.children ?? []).map((c) => `${s.name}.${c.name}`)]);
    check('document symbols list Point with x, y and norm, and distance', ['Point', 'Point.x', 'Point.y', 'Point.norm', 'distance'].every((n) => names.includes(n)), JSON.stringify(names));

    const sig = await lsp.request('textDocument/signatureHelp', at(M, 4, 37));
    check('signature help inside `distance(a, b)` shows its parameters, the second active', /distance\(a: Point, b: Point\): Double/.test(sig.result?.signatures?.[0]?.label ?? '') && sig.result?.activeParameter === 1, JSON.stringify(sig.result));
    const sig2 = await lsp.request('textDocument/signatureHelp', at(M, 1, 18));
    check('signature help inside `Point(...)` shows the constructor\'s parameters', /Point\(val x: Double, val y: Double\)/.test(sig2.result?.signatures?.[0]?.label ?? ''), JSON.stringify(sig2.result));

    const malformed = await lsp.request('textDocument/completion', {});
    check('a completion request without a document or position is refused as InvalidParams', malformed.error?.code === -32602, JSON.stringify(malformed.error));

    mark = (await lsp.log()).length;
    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri(G) } });
    const gone = await lsp.request('textDocument/definition', at(M, 4, 31));
    check('after Geometry.kt is deleted, `distance` has no definition', (gone.result ?? []).length === 0, JSON.stringify(gone.result));

    const readme = (await lsp.log()).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('README.md'));
    check('a non-Kotlin project file is not parsed', readme.length === 0);
    const shutdown = await lsp.request('shutdown', null);
    check('shutdown answers', shutdown.error === undefined);
    const late = await lsp.request('textDocument/hover', at(M, 1, 14));
    check('a request after shutdown is refused as InvalidRequest', late.error?.code === -32600, JSON.stringify(late.error));
    const errors = (await lsp.log()).filter((m) => m.method === 'worker/error' || (m.method === 'window/logMessage' && m.params.type === 1));
    check('the worker reported no errors', errors.length === 0, JSON.stringify(errors));
} finally {
    await browser.close();
    server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
