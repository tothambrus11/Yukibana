// Headless test of the Rust pack's language server, run the way the app runs
// it: app/static served over http (COOP/COEP, as the app's pages are), `new
// Worker('/packs/rust/server.js', { type: 'module' })` in Chromium, one
// JSON-RPC object per postMessage. Two sessions:
//
// 1. The app's sample project (app/src/lib/languages.ts: Cargo.toml,
//    src/main.rs, src/lib.rs, src/point.rs, tests/geometry.rs), files served
//    raw: no diagnostics (the standard library and the crate graph
//    resolve: `use geometry::...` names the library), errors for an
//    unresolved name and a syntax error, completion of a method and of std,
//    hover with the doc comment and std's docs, definition across files,
//    references from the binary and the integration test, document symbols,
//    signature help, document highlight, prepare rename and rename across
//    files, semantic tokens, inlay hints, a quick fix that adds a `use`, a
//    flyimport completion resolved to its `use`, and a new module file.
// 2. The same sample served with Content-Encoding (the .br siblings): the
//    pack loads and reports the same, and a package renamed in Cargo.toml
//    makes `use geometry::...` an error.
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
const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip' };

/** @type {Map<string, string>} path -> Content-Encoding sent, for the report */
const encodings = new Map();
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
/** A static server with the COOP/COEP headers. Plain: raw files, like
 * `python3 -m http.server`. Encoding: the .br or .gz sibling when the
 * browser accepts it, with Content-Encoding, like the app's host. */
async function serve(encoding) {
    const server = createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (path === '/__test.html') {
            res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION }).end('<!doctype html><link rel=icon href="data:,"><title>rust pack test</title>');
            return;
        }
        const file = normalize(join(STATIC, path));
        try {
            if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
            const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...ISOLATION };
            let body;
            const accepts = String(req.headers['accept-encoding'] ?? '');
            for (const [token, ext] of encoding ? [['br', '.br'], ['gzip', '.gz']] : []) {
                if (!accepts.includes(token)) continue;
                body = await readFile(file + ext).catch(() => undefined);
                if (!body) continue;
                headers['content-encoding'] = token;
                encodings.set(path, token);
                break;
            }
            body ??= await readFile(file);
            headers['content-length'] = body.length;
            res.writeHead(200, headers).end(body);
        } catch {
            res.writeHead(404).end();
        }
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const plain = await serve(false);
const encoded = await serve(true);


const languages = await readFile(resolve(HERE, '../../app/src/lib/languages.ts'), 'utf8');
const SAMPLE = sampleOf(languages, 'rust');
const MAIN = SAMPLE['src/main.rs'];
const POINT = SAMPLE['src/point.rs'];

/** The LSP position of the `at`-th character of `needle` in `text`. */
function position(text, needle, at = 0) {
    const offset = text.indexOf(needle);
    if (offset < 0) throw new Error(`no ${needle}`);
    const before = text.slice(0, offset + at);
    const line = before.split('\n').length - 1;
    return { line, character: before.length - before.lastIndexOf('\n') - 1 };
}


await stat(join(STATIC, 'packs/rust/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/rust/server.js')}: run ./build.sh first`);
    process.exit(2);
});

const browser = await chromium.launch({ executablePath: CHROMIUM });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
};
const uri = (name) => `file:///workspace/${name}`;
const errors = (diags) => (diags ?? []).filter((d) => d.severity === 1);
const show = (diags) => JSON.stringify((diags ?? []).map((d) => `${d.range.start.line + 1}: ${d.message}`));

/** A page on `origin` with a worker started as the app starts it, a
 * minimal LSP client in the page of the shape the app's client has, and
 * `initialize` sent. */
async function session(origin) {
    const page = await browser.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log(`[page] ${m.text()}`));
    page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
    await page.goto(`${origin}/__test.html`);
    console.log(`crossOriginIsolated: ${await page.evaluate(() => crossOriginIsolated)}`);
    await page.evaluate(() => {
        const worker = new Worker('/packs/rust/server.js', { type: 'module' });
        const pending = new Map();
        const log = [];
        let nextId = 1;
        worker.onerror = (e) => log.push({ method: 'worker/error', params: String(e.message) });
        worker.onmessage = ({ data: msg }) => {
            if (msg.id !== undefined && msg.method) {
                const result = msg.method === 'workspace/configuration' ? msg.params.items.map(() => null) : null;
                worker.postMessage({ jsonrpc: '2.0', id: msg.id, result });
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
            /** Several notifications in one task, as the app sends a
             * project's didOpens after `initialized`. */
            notifyAll(messages) {
                for (const [method, params] of messages) worker.postMessage({ jsonrpc: '2.0', method, params });
            },
        };
    });
    const lsp = {
        request: (method, params) => page.evaluate(([m, p]) => window.lsp.request(m, p), [method, params]),
        notify: (method, params) => page.evaluate(([m, p]) => window.lsp.notify(m, p), [method, params]),
        notifyAll: (messages) => page.evaluate((ms) => window.lsp.notifyAll(ms), messages),
        log: () => page.evaluate(() => window.lsp.log),
        elapsed: () => page.evaluate(() => Math.round(performance.now() - window.lsp.t0)),
        /** Waits for the latest publishDiagnostics of a file (after `since`
         * messages in the log) to satisfy `ok`. */
        async diagnostics(name, ok, since = 0, timeoutMs = 60000) {
            const deadline = Date.now() + timeoutMs;
            let last;
            while (Date.now() < deadline) {
                const published = (await lsp.log())
                    .slice(since)
                    .filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri(name));
                last = published.at(-1)?.params.diagnostics;
                if (last && ok(last)) return last;
                await page.waitForTimeout(100);
            }
            return last;
        },
        /** The worker's log lines and errors, printed; true when it raised none. */
        async finish(label) {
            const shutdown = await lsp.request('shutdown', null);
            check(`${label}: shutdown answers`, shutdown.result === null, JSON.stringify(shutdown.error ?? ''));
            lsp.notify('exit', null);
            await page.waitForTimeout(500);
            const all = await lsp.log();
            for (const m of all.filter((m) => m.method === 'window/logMessage')) console.log(`[log ${m.params.type}] ${m.params.message}`);
            const workerErrors = all.filter((m) => m.method === 'worker/error');
            check(`${label}: the worker raised no errors`, workerErrors.length === 0, JSON.stringify(workerErrors));
            await page.close();
        },
    };
    const init = await lsp.request('initialize', {
        processId: null,
        rootUri: 'file:///workspace/',
        workspaceFolders: [{ uri: 'file:///workspace/', name: 'workspace' }],
        capabilities: {
            workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: false } },
            textDocument: {
                synchronization: { didSave: false },
                publishDiagnostics: { relatedInformation: true },
                hover: { contentFormat: ['markdown', 'plaintext'] },
                completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown'] } },
                definition: {},
                codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor'] } } },
            },
        },
    });
    return { page, lsp, init };
}

const openAll = (lsp, files) =>
    lsp.notifyAll(Object.entries(files).map(([name, text]) => ['textDocument/didOpen', { textDocument: { uri: uri(name), languageId: name.endsWith('.rs') ? 'rust' : 'plaintext', version: 1, text } }]));
const doc = (name) => ({ textDocument: { uri: uri(name) } });
const at = (name, text, needle, offset = 0) => ({ ...doc(name), position: position(text, needle, offset) });
const RS = Object.keys(SAMPLE).filter((n) => n.endsWith('.rs'));

try {
{
    console.log('-- session 1: the sample project, served raw');
    const { lsp, init } = await session(plain.origin);
    const caps = init.result?.capabilities ?? {};
    check('initialize answers with the capabilities rust-analyzer offers here',
        !!caps.completionProvider && !!caps.hoverProvider && !!caps.definitionProvider && !!caps.renameProvider && !!caps.semanticTokensProvider && !caps.documentFormattingProvider,
        `${init.result?.serverInfo?.name} after ${await lsp.elapsed()} ms${init.error ? ` error: ${init.error.message}` : ''}`);
    const loads = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    check('yukibana/loading reports rust-analyzer.wasm and std-src.tar',
        ['rust-analyzer.wasm', 'std-src.tar'].every((l) => loads.some((m) => m.params.label === l && m.params.loaded === m.params.total && m.params.total > 0)),
        `${loads.length} progress notifications`);
    lsp.notify('initialized', {});
    await openAll(lsp, SAMPLE);
    for (const name of RS) {
        const t = Date.now();
        const diags = await lsp.diagnostics(name, () => true, 0, 120000);
        check(`${name} has no diagnostics (std, the library and the modules resolve)`, diags && diags.length === 0, `${show(diags)} ${Date.now() - t} ms`);
    }

    // Errors.
    let since = (await lsp.log()).length;
    const BROKEN = MAIN.replace('    println!("{}", b.norm());', '    println!("{}", b.norm());\n    let n = no_such_function(a);\n    let = 3;');
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 2 }, contentChanges: [{ text: BROKEN }] });
    const broken = await lsp.diagnostics('src/main.rs', (d) => errors(d).length >= 2, since);
    check('an unresolved function (E0425) and a syntax error are diagnostics with their lines',
        errors(broken).some((d) => d.code === 'E0425' && d.range.start.line === 7) && errors(broken).some((d) => d.code === 'syntax-error' && d.range.start.line === 8),
        show(broken));
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 3 }, contentChanges: [{ text: MAIN }] });
    since = (await lsp.log()).length;
    const fixed = await lsp.diagnostics('src/main.rs', (d) => d.length === 0, since);
    check('the diagnostics clear when the error is undone', fixed && fixed.length === 0, show(fixed));

    // Completion.
    const COMPLETE = MAIN.replace('    println!("{}", b.norm());', '    println!("{}", b.no);\n    let s = String::');
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 4 }, contentChanges: [{ text: COMPLETE }] });
    let t = Date.now();
    const members = await lsp.request('textDocument/completion', { ...at('src/main.rs', COMPLETE, 'b.no);', 4), context: { triggerKind: 1 } });
    // rust-analyzer labels a function with its parentheses: `norm()`, `new(…)`.
    const name = (i) => i.label.replace(/\(.*\)$/, '');
    const memberLabels = (members.result?.items ?? []).map(name);
    check('completion after `b.no` offers Point::norm (from src/point.rs)', memberLabels.includes('norm'), `${memberLabels.slice(0, 8).join(', ')} in ${Date.now() - t} ms`);
    const norm = members.result?.items.find((i) => name(i) === 'norm');
    check('the item has the signature as detail and the doc comment', /fn\(&self\) -> f64/.test(norm?.detail ?? '') && /Distance from the origin/.test(norm?.documentation?.value ?? ''),
        `${norm?.detail} ${JSON.stringify(norm?.documentation?.value)}`);
    t = Date.now();
    const std = await lsp.request('textDocument/completion', { ...at('src/main.rs', COMPLETE, 'String::', 8), context: { triggerKind: 2, triggerCharacter: ':' } });
    const stdLabels = (std.result?.items ?? []).map(name);
    check('completion after `String::` offers std\'s associated functions', ['new', 'from_utf8', 'with_capacity'].every((l) => stdLabels.includes(l)), `${stdLabels.slice(0, 8).join(', ')} in ${Date.now() - t} ms`);
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 5 }, contentChanges: [{ text: MAIN }] });

    // Hover.
    const hover = await lsp.request('textDocument/hover', at('src/main.rs', MAIN, 'b.norm()', 3));
    const hoverText = hover.result?.contents?.value ?? '';
    check('hover on norm shows its signature and doc comment', /pub fn norm\(&self\) -> f64/.test(hoverText) && /Distance from the origin/.test(hoverText), JSON.stringify(hoverText.slice(0, 160)));
    const hoverStd = await lsp.request('textDocument/hover', at('src/point.rs', POINT, 'hypot', 1));
    const stdText = hoverStd.result?.contents?.value ?? '';
    check('hover on f64::hypot shows the standard library\'s documentation', /pub fn hypot\(self, other: f64\) -> f64/.test(stdText) && /hypotenuse/i.test(stdText), JSON.stringify(stdText.slice(0, 160)));
    const hoverPoint = await lsp.request('textDocument/hover', at('src/point.rs', POINT, 'pub struct Point', 11));
    check('hover on the struct shows its size from the x86_64 layout', /size = 16/.test(hoverPoint.result?.contents?.value ?? ''), JSON.stringify((hoverPoint.result?.contents?.value ?? '').slice(0, 200)));

    // Navigation.
    const def = await lsp.request('textDocument/definition', at('src/main.rs', MAIN, 'distance(a, b)', 1));
    const defs = def.result ?? [];
    check('definition of distance (through the library\'s re-export) is in src/point.rs', defs.some((l) => l.uri === uri('src/point.rs') && l.range.start.line === position(POINT, 'pub fn distance').line),
        JSON.stringify(defs));
    const refs = await lsp.request('textDocument/references', { ...at('src/point.rs', POINT, 'pub fn distance', 7), context: { includeDeclaration: true } });
    const refFiles = new Set((refs.result ?? []).map((l) => l.uri.replace('file:///workspace/', '')));
    check('references to distance come from src/point.rs, src/lib.rs, src/main.rs and tests/geometry.rs', ['src/point.rs', 'src/lib.rs', 'src/main.rs', 'tests/geometry.rs'].every((f) => refFiles.has(f)),
        `${(refs.result ?? []).length} in ${[...refFiles].join(', ')}`);
    const symbols = await lsp.request('textDocument/documentSymbol', doc('src/point.rs'));
    const names = (symbols.result ?? []).map((s) => `${s.name}${s.children?.length ? `[${s.children.map((c) => c.name).join(',')}]` : ''}`);
    check('document symbols of src/point.rs: the struct with its fields, the impls, distance, the test module', names.includes('Point[x,y]') && names.includes('distance') && names.some((n) => n.startsWith('tests[')),
        names.join(' '));
    const sig = await lsp.request('textDocument/signatureHelp', at('src/main.rs', MAIN, 'distance(a, b)', 12));
    const s0 = sig.result?.signatures?.[0];
    check('signature help inside distance(a, b) shows the parameters, the second active', /fn distance\(a: Point, b: Point\) -> f64/.test(s0?.label ?? '') && sig.result?.activeParameter === 1,
        `${s0?.label} active=${sig.result?.activeParameter}`);
    const hl = await lsp.request('textDocument/documentHighlight', at('src/main.rs', MAIN, 'let b', 4));
    check('document highlight of b: its definition and three uses', (hl.result ?? []).length === 4, JSON.stringify((hl.result ?? []).map((h) => h.range.start)));

    // Rename.
    const prep = await lsp.request('textDocument/prepareRename', at('src/point.rs', POINT, 'pub fn norm', 7));
    check('prepareRename gives the range of norm', prep.result?.start?.line === position(POINT, 'pub fn norm').line, JSON.stringify(prep.result ?? prep.error));
    const rename = await lsp.request('textDocument/rename', { ...at('src/point.rs', POINT, 'pub fn norm', 7), newName: 'length' });
    const changes = rename.result?.changes ?? {};
    check('rename norm -> length edits src/point.rs (definition, use, test) and src/main.rs',
        (changes[uri('src/point.rs')] ?? []).length === 3 && (changes[uri('src/main.rs')] ?? []).length === 1 && Object.values(changes).flat().every((e) => e.newText === 'length'),
        Object.entries(changes).map(([u, e]) => `${u.split('/').pop()}:${e.length}`).join(' '));

    // Semantic tokens and inlay hints.
    const tokens = await lsp.request('textDocument/semanticTokens/full', doc('src/main.rs'));
    const legend = caps.semanticTokensProvider?.legend?.tokenTypes ?? [];
    const data = tokens.result?.data ?? [];
    const types = new Set();
    for (let i = 3; i < data.length; i += 5) types.add(legend[data[i]]);
    check('semantic tokens of src/main.rs: functions, structs, variables, macros, keywords', ['function', 'struct', 'variable', 'macro', 'keyword'].every((k) => types.has(k)), [...types].join(' '));
    const hints = await lsp.request('textDocument/inlayHint', { ...doc('src/main.rs'), range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } } });
    const hintLabels = (hints.result ?? []).map((h) => `${h.position.line}:${h.label}`);
    check('inlay hints: the type of a and b, the parameter names of Point::new', hintLabels.includes('3:: Point') && hintLabels.some((h) => /^3:x:/.test(h)), hintLabels.join(' '));

    // A quick fix that imports, and a completion that imports.
    const NEEDS_USE = MAIN.replace('    println!("{}", b.norm());', '    println!("{}", b.norm());\n    let mut seen = HashMap::new();\n    seen.insert(1, a);');
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 6 }, contentChanges: [{ text: NEEDS_USE }] });
    since = (await lsp.log()).length;
    const unresolved = await lsp.diagnostics('src/main.rs', (d) => errors(d).length > 0, since);
    const actions = await lsp.request('textDocument/codeAction', {
        ...doc('src/main.rs'),
        range: { start: position(NEEDS_USE, 'HashMap::new'), end: position(NEEDS_USE, 'HashMap::new', 7) },
        context: { diagnostics: unresolved ?? [] },
    });
    const importFix = (actions.result ?? []).find((a) => /Import `std::collections::HashMap`/.test(a.title));
    const importEdit = importFix?.edit?.changes?.[uri('src/main.rs')]?.[0];
    check('code action "Import `std::collections::HashMap`" with its edit', !!importEdit && /use std::collections::HashMap;/.test(importEdit.newText),
        `${(actions.result ?? []).length} actions: ${(actions.result ?? []).slice(0, 5).map((a) => a.title).join(' | ')}`);
    const FLY = MAIN.replace('    println!("{}", b.norm());', '    println!("{}", b.norm());\n    let set = BTreeSe');
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 7 }, contentChanges: [{ text: FLY }] });
    const fly = await lsp.request('textDocument/completion', { ...at('src/main.rs', FLY, 'BTreeSe', 7), context: { triggerKind: 1 } });
    const item = (fly.result?.items ?? []).find((i) => i.label.startsWith('BTreeSet'));
    const resolved = item ? await lsp.request('completionItem/resolve', item) : null;
    const extra = resolved?.result?.additionalTextEdits ?? [];
    check('completion of BTreeSe offers BTreeSet, and resolving it adds `use std::collections::BTreeSet;`', extra.some((e) => /use std::collections::BTreeSet;/.test(e.newText)),
        `${item?.label} ${JSON.stringify(extra)}`);
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 8 }, contentChanges: [{ text: MAIN }] });

    // A new module file, then its deletion.
    const LIB2 = SAMPLE['src/lib.rs'] + '\npub mod shapes;\n';
    const SHAPES = 'use crate::Point;\n\n/// The corners of a unit square.\npub fn unit_square() -> [Point; 4] {\n    [Point::new(0.0, 0.0), Point::new(1.0, 0.0), Point::new(1.0, 1.0), Point::new(0.0, 1.0)]\n}\n';
    const MAIN2 = MAIN.replace('use geometry::{distance, Point};', 'use geometry::{distance, shapes, Point};').replace('    println!("{}", b.norm());', '    println!("{}", b.norm());\n    println!("{}", shapes::unit_square().len());');
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('src/shapes.rs'), languageId: 'rust', version: 1, text: SHAPES } });
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/lib.rs'), version: 2 }, contentChanges: [{ text: LIB2 }] });
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('src/main.rs'), version: 9 }, contentChanges: [{ text: MAIN2 }] });
    since = (await lsp.log()).length;
    const clean = await lsp.diagnostics('src/main.rs', (d) => d.length === 0, since);
    const shapesDef = await lsp.request('textDocument/definition', at('src/main.rs', MAIN2, 'unit_square', 2));
    check('a new file src/shapes.rs declared with `pub mod shapes;` is part of the crate: no diagnostics, definition goes there',
        clean?.length === 0 && (shapesDef.result ?? []).some((l) => l.uri === uri('src/shapes.rs')), `${show(clean)} ${JSON.stringify(shapesDef.result)}`);
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didClose', { textDocument: { uri: uri('src/shapes.rs') } });
    lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('src/shapes.rs'), type: 3 }] });
    const gone = await lsp.diagnostics('src/lib.rs', (d) => errors(d).length > 0, since);
    check('deleting it makes `pub mod shapes;` an unresolved module (E0583)', errors(gone).some((d) => /E0583|unresolved-module/.test(d.code)), show(gone));
    await lsp.finish('session 1');
}
{
    console.log('-- session 2: the sample served with Content-Encoding, and a renamed package');
    const { lsp, init } = await session(encoded.origin);
    check('initialize answers (compressed downloads)', !!init.result?.capabilities?.hoverProvider, `${await lsp.elapsed()} ms; ${[...encodings].map(([p, e]) => `${p.split('/').pop()}:${e}`).join(' ')}`);
    lsp.notify('initialized', {});
    await openAll(lsp, SAMPLE);
    const t = Date.now();
    const diags = await lsp.diagnostics('src/main.rs', () => true, 0, 120000);
    check('src/main.rs has no diagnostics', diags?.length === 0, `${show(diags)} ${Date.now() - t} ms`);
    const since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('Cargo.toml'), version: 2 }, contentChanges: [{ text: SAMPLE['Cargo.toml'].replace('"geometry"', '"plane"') }] });
    const renamed = await lsp.diagnostics('src/main.rs', (d) => errors(d).length > 0, since);
    check('renaming the package in Cargo.toml makes `use geometry::...` unresolved (the crate is now `plane`)', errors(renamed).some((d) => d.code === 'E0432' && d.range.start.line === 0), show(renamed));
    await lsp.finish('session 2');
}
} finally {
    await browser.close();
    plain.server.close();
    encoded.server.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);

/** The `sample` object literal of one language in languages.ts, evaluated:
 * template literals of plain text keyed by file name. */
function sampleOf(source, id) {
    const at = source.indexOf(`id: '${id}'`);
    const start = source.indexOf('sample: {', at) + 'sample: '.length;
    let depth = 0;
    let i = start;
    let inTemplate = false;
    for (; i < source.length; i++) {
        const c = source[i];
        if (inTemplate) {
            if (c === '\\') i++;
            else if (c === '`') inTemplate = false;
        } else if (c === '`') inTemplate = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
    }
    return new Function(`return (${source.slice(start, i + 1)});`)();
}
