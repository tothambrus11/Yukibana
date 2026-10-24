// Headless test of the Swift pack, run the way the app runs it: app/static
// served over http, `new Worker('/packs/swift/server.js', { type: 'module' })`
// in Chromium, one JSON-RPC object per postMessage. The project is three
// Swift files that use each other's declarations. It checks a clean project,
// a diagnostic for an introduced (syntax) error, completion at a member
// access, hover, go-to-definition across files, and the other features the
// pack advertises. The language server is sourcekit-lsp-lite over sourcekitd
// 6.3.3 (swift-frontend-lsp.wasm); formatting and semantic tokens are
// swift-syntax's (swift-ls.wasm).
//
//   node test.mjs            (after ./build.sh; needs playwright-core)
//
// The page is NOT cross-origin isolated: the pack must not need it.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm' };

// A plain static server: raw files, no content-encoding, no COOP/COEP.
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel=icon href="data:,"><title>swift pack test</title>');
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

const SHAPES = `/// A point in the plane.
struct Point {
    var x: Double
    var y: Double

    /// Distance from the origin.
    func norm() -> Double {
        return (x * x + y * y).squareRoot()
    }

    func moved(by dx: Double, _ dy: Double) -> Point {
        return Point(x: x + dx, y: y + dy)
    }
}

protocol Shape {
    /// The area, in square units.
    func area() -> Double
}
`;
const CIRCLE = `/// A circle around a centre.
final class Circle: Shape {
    let centre: Point
    var radius: Double

    init(centre: Point, radius: Double) {
        self.centre = centre
        self.radius = radius
    }

    func area() -> Double {
        return 3.14159 * radius * radius
    }
}
`;
const MAIN = `let origin = Point(x: 3, y: 4)
let far = origin.moved(by: 2, 1)
let c = Circle(centre: far, radius: 2)
print(far.norm(), c.area())
`;
const BROKEN = MAIN.replace('c.area())', 'c.area()');
const COMPLETE = MAIN + 'c.centre.\n';

/** LSP position (UTF-16) of `needle` in `text`, plus `delta` characters. */
function position(text, needle, delta = 0) {
    const i = text.indexOf(needle);
    if (i < 0) throw new Error(`no ${needle}`);
    const before = text.slice(0, i + delta);
    const line = before.split('\n').length - 1;
    return { line, character: before.length - before.lastIndexOf('\n') - 1 };
}

await stat(join(STATIC, 'packs/swift/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/swift/server.js')}: run ./build.sh first`);
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
    console.log(`crossOriginIsolated: ${await page.evaluate(() => crossOriginIsolated)}`);

    // A minimal LSP client in the page, the shape the app's client has.
    await page.evaluate(() => {
        const worker = new Worker('/packs/swift/server.js', { type: 'module' });
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
        };
    });

    const lsp = {
        request: (method, params) => page.evaluate(([m, p]) => window.lsp.request(m, p), [method, params]),
        notify: (method, params) => page.evaluate(([m, p]) => window.lsp.notify(m, p), [method, params]),
        log: () => page.evaluate(() => window.lsp.log),
        elapsed: () => page.evaluate(() => Math.round(performance.now() - window.lsp.t0)),
    };
    const uri = (name) => `file:///workspace/${name}`;
    /** Waits for the latest publishDiagnostics of a file (after `since`
     * messages in the log, and for document `version` if given) to satisfy `ok`. */
    async function diagnostics(name, ok, since = 0, timeoutMs = 60000, version = undefined) {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() < deadline) {
            const published = (await lsp.log())
                .slice(since)
                .filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri(name) &&
                    (version === undefined || m.params.version === version));
            last = published.at(-1)?.params.diagnostics;
            if (last && ok(last)) return last;
            await page.waitForTimeout(100);
        }
        return last;
    }
    const errors = (diags) => (diags ?? []).filter((d) => d.severity === 1);
    /** A completion item's name without its argument labels: `reduce` for `reduce(_:_:)` (its label is the whole signature). */
    const nameOf = (item) => (item.filterText ?? item.label).replace(/\(.*$/, '');
    const show = (diags) => JSON.stringify((diags ?? []).map((d) => `${d.range.start.line + 1}: ${d.message}`));

    const init = await lsp.request('initialize', {
        processId: null,
        rootUri: 'file:///workspace/',
        workspaceFolders: [{ uri: 'file:///workspace/', name: 'workspace' }],
        capabilities: {
            textDocument: {
                hover: { contentFormat: ['markdown', 'plaintext'] },
                completion: { completionItem: { documentationFormat: ['markdown'] } },
            },
        },
    });
    const loads = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    const caps = init.result?.capabilities ?? {};
    const info = init.result?.serverInfo ?? {};
    check('initialize answers, and the server says what it is',
        !!caps.completionProvider && !!caps.hoverProvider && !!caps.definitionProvider && /sourcekit-lsp-lite/.test(info.name),
        `${info.name} ${info.version ?? ''} after ${await lsp.elapsed()} ms` + (init.error ? ` error: ${init.error.message}` : ''));
    check('yukibana/loading reports swift-ls.wasm',
        loads.some((m) => m.params.label === 'swift-ls.wasm' && m.params.loaded === m.params.total && m.params.total > 0),
        `${loads.length} progress notifications`);
    lsp.notify('initialized', {});
    const files = { 'Shapes.swift': SHAPES, 'Circle.swift': CIRCLE, 'main.swift': MAIN };
    for (const [name, text] of Object.entries(files))
        lsp.notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId: 'swift', version: 1, text } });
    // The first diagnostics wait for the compiler's download (cold: it is
    // fetched and compiled here).
    let t = Date.now();
    for (const name of Object.keys(files)) {
        const diags = await diagnostics(name, () => true, 0, 240000);
        check(`${name} is clean`, diags && diags.length === 0, `${show(diags)} after ${Date.now() - t} ms`);
    }

    // Semantic diagnostics: sourcekitd's, on a type error the parser cannot see.
    t = Date.now();
    const TYPED = 'let x: Int = "no"\n';
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Typed.swift'), languageId: 'swift', version: 1, text: TYPED } });
    const typedDiags = await diagnostics('Typed.swift', (d) => errors(d).length > 0, 0, 60000);
    const typeError = errors(typedDiags)[0];
    check('`let x: Int = "no"` yields a type-error diagnostic from sourcekitd',
        /cannot convert value of type 'String' to specified type 'Int'/.test(typeError?.message ?? '') && typeError.source === 'sourcekitd' &&
            typeError.range.start.line === 0 && typeError.range.start.character === 13 && typeError.range.end.character === 17,
        `${show(typedDiags)} ${JSON.stringify(typeError?.range)} after ${Date.now() - t} ms`);
    const frontendLoads = (await lsp.log()).filter((m) => m.method === 'yukibana/loading' && m.params.label === 'swift-frontend-lsp.wasm');
    const finished = frontendLoads.filter((m) => m.params.loaded === m.params.total && m.params.total > 0);
    check('yukibana/loading reports swift-frontend-lsp.wasm, downloaded once', finished.length === 1,
        `${frontendLoads.length} progress notifications, ${finished.length} complete`);
    for (const name of Object.keys(files)) {
        const diags = await diagnostics(name, () => true);
        check(`${name} stays clean after type checking`, diags && diags.length === 0, show(diags));
    }
    let since = (await lsp.log()).length;
    t = Date.now();
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('Typed.swift'), version: 2 }, contentChanges: [{ text: 'let x: Int = 1\nlet y: String = x\n' }] });
    const retyped = await diagnostics('Typed.swift', (d) => errors(d).some((x) => x.range.start.line === 1), since, 60000);
    check('after an edit the type checker runs again (warm)', errors(retyped).length === 1 &&
        /cannot convert value of type 'Int' to specified type 'String'/.test(errors(retyped)[0].message), `${show(retyped)} ${Date.now() - t} ms`);
    // Six edits within the debounce: only the last text is checked. Each text
    // has its own target type, so a result for an intermediate text would show.
    since = (await lsp.log()).length;
    const TYPES = ['Double', 'Float', 'UInt8', 'Int16', 'Int32', 'Int64'];
    TYPES.forEach((type, i) => lsp.notify('textDocument/didChange', {
        textDocument: { uri: uri('Typed.swift'), version: 3 + i }, contentChanges: [{ text: `let v: ${type} = "s"\n` }] }));
    const last = await diagnostics('Typed.swift', (d) => d.some((x) => /type 'Int64'/.test(x.message)), since, 60000);
    const seen = (await lsp.log()).slice(since).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('Typed.swift'))
        .flatMap((m) => m.params.diagnostics.map((x) => /specified type '(\w+)'/.exec(x.message)?.[1])).filter(Boolean);
    check('superseded edits are not checked: diagnostics only for the last text', errors(last).length === 1 &&
        !seen.some((type) => TYPES.slice(0, -1).includes(type)), `${show(last)}; target types seen: ${[...new Set(seen)].join(', ')}`);

    // The compiler's fix-its (only in its serialized diagnostics) are quick fixes.
    since = (await lsp.log()).length;
    const CONFORM = 'protocol A {\n    func a() -> Int\n}\n\nstruct K : A {\n    \n}\n';
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('Typed.swift'), version: 20 }, contentChanges: [{ text: CONFORM }] });
    const conform = await diagnostics('Typed.swift', (d) => errors(d).some((x) => /does not conform/.test(x.message)), since, 60000);
    const conformError = errors(conform).find((x) => /does not conform/.test(x.message));
    const stubs = await lsp.request('textDocument/codeAction', {
        textDocument: { uri: uri('Typed.swift') }, range: conformError?.range ?? { start: { line: 4, character: 7 }, end: { line: 4, character: 7 } },
        context: { diagnostics: conformError ? [conformError] : [] },
    });
    const addStubs = (stubs.result ?? []).find((a) => a.title === 'Add stubs for conformance');
    const stubEdit = addStubs?.edit?.changes?.[uri('Typed.swift')]?.[0];
    check('"add stubs for conformance" from sourcekitd is a quick fix that inserts the missing method',
        !!stubEdit && stubEdit.range.start.line === 4 && stubEdit.range.start.character === 14 && /func a\(\) -> Int \{\n\s+code\n\s+\}/.test(stubEdit.newText),
        JSON.stringify(stubs.result?.map((a) => [a.title, a.edit])));
    // Errors found by the mandatory SIL passes, not by type checking, show while
    // typing: sourcekitd's diagnostics run them.
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('Typed.swift'), version: 21 }, contentChanges: [{ text: 'func f(_ c: Bool) -> Int {\n    if c {\n    } else {\n    }\n}\n' }] });
    const missing = await diagnostics('Typed.swift', (d) => errors(d).some((x) => /missing return/.test(x.message)), since, 60000);
    check('a missing return (a SIL diagnostic) is reported while editing', errors(missing ?? []).some((x) => /missing return in global function expected to return 'Int'/.test(x.message)), show(missing));
    // A test file: `import XCTest` finds the browser's XCTest (swift-xctest.tar,
    // fetched on the first check that needs it), and `@testable import Shapes`
    // names the module as the runner does, without a warning. The one
    // diagnostic is the deliberate type error on line 6.
    since = (await lsp.log()).length;
    t = Date.now();
    const XCTEST_FILE = 'import XCTest\n@testable import Shapes\n\nfinal class ShapesTests: XCTestCase {\n    func testNorm() { XCTAssertEqual(Point(x: 3, y: 4).norm(), 5, accuracy: 1e-9) }\n    func testWrong() { XCTAssertEqual(1, "one") }\n}\n';
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Tests/ShapesTests.swift'), languageId: 'swift', version: 1, text: XCTEST_FILE } });
    const xctDiags = await diagnostics('Tests/ShapesTests.swift', (d) => errors(d).length > 0, since, 60000);
    check('a test file: XCTest is found, `@testable import Shapes` is quiet, the type error in it is reported',
        xctDiags?.length === 1 && xctDiags[0].range.start.line === 5 && xctDiags[0].severity === 1,
        `${show(xctDiags)} after ${Date.now() - t} ms, ${(await lsp.log()).filter((m) => m.method === 'yukibana/loading' && m.params.label === 'swift-xctest.tar').length} swift-xctest.tar progress notifications`);
    lsp.notify('textDocument/didClose', { textDocument: { uri: uri('Tests/ShapesTests.swift') } });
    lsp.notify('textDocument/didClose', { textDocument: { uri: uri('Typed.swift') } });

    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 2 }, contentChanges: [{ text: BROKEN }] });
    const broken = await diagnostics('main.swift', () => true, since, 60000, 2);
    check('an introduced error is a diagnostic, reported once', errors(broken).length === 1 && /expected '\)'/.test(errors(broken)[0].message), show(broken));
    // The compiler's parser has no fix-it for that one (swift-syntax's had);
    // a missing comma between arguments has one.
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 3 }, contentChanges: [{ text: MAIN.replace('far.norm(), c.area()', 'far.norm() c.area()') }] });
    const comma = errors(await diagnostics('main.swift', () => true, since, 60000, 3));
    const actions = await lsp.request('textDocument/codeAction', {
        textDocument: { uri: uri('main.swift') }, range: comma[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: comma },
    });
    const fix = (actions.result ?? []).find((a) => a.edit);
    check('a syntax error with a fix-it comes with a quick fix', /expected ',' separator/.test(comma[0]?.message ?? '') && fix?.isPreferred === true &&
        fix.edit.changes?.[uri('main.swift')]?.[0]?.newText === ',', `${show(comma)} ${JSON.stringify((actions.result ?? []).map((a) => [a.title, a.edit]))}`);

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 4 }, contentChanges: [{ text: COMPLETE }] });
    t = Date.now();
    const completion = await lsp.request('textDocument/completion', {
        textDocument: { uri: uri('main.swift') },
        position: position(COMPLETE, 'c.centre.\n', 9),
        context: { triggerKind: 2, triggerCharacter: '.' },
    });
    const labels = (completion.result?.items ?? []).map(nameOf);
    check('completion after "c.centre." lists Point\'s members (Circle.swift -> Shapes.swift)',
        ['norm', 'moved', 'x', 'y'].every((m) => labels.includes(m)) && !labels.includes('radius'), `${JSON.stringify(labels)} ${Date.now() - t} ms`);

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 5 }, contentChanges: [{ text: MAIN }] });
    t = Date.now();
    const hover = await lsp.request('textDocument/hover', { textDocument: { uri: uri('main.swift') }, position: position(MAIN, 'far.norm()', 5) });
    const hoverText = JSON.stringify(hover.result?.contents ?? '');
    check('hover on far.norm() shows its signature and doc comment',
        /func norm\(\) -> Double/.test(hoverText) && /Distance from the origin/.test(hoverText), `${hoverText.slice(0, 160)} ${Date.now() - t} ms`);

    const where = (r) => [r.result ?? []].flat().map((l) => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`);
    let defs = where(await lsp.request('textDocument/definition', { textDocument: { uri: uri('main.swift') }, position: position(MAIN, 'Point(x', 2) }));
    check('go to definition of Point lands in Shapes.swift', defs.includes(`${uri('Shapes.swift')}:2:8`), JSON.stringify(defs));
    defs = where(await lsp.request('textDocument/definition', { textDocument: { uri: uri('main.swift') }, position: position(MAIN, 'moved(by', 1) }));
    check('go to definition of origin.moved lands on Point.moved', defs.includes(`${uri('Shapes.swift')}:11:10`), JSON.stringify(defs));
    defs = where(await lsp.request('textDocument/definition', { textDocument: { uri: uri('main.swift') }, position: position(MAIN, 'c.area()', 3) }));
    check('go to definition of c.area() lands on Circle.area', defs.includes(`${uri('Circle.swift')}:11:10`), JSON.stringify(defs));
    defs = where(await lsp.request('textDocument/definition', { textDocument: { uri: uri('Circle.swift') }, position: position(CIRCLE, 'radius * radius', 0) }));
    check('go to definition of a property used in a method', defs.includes(`${uri('Circle.swift')}:4:9`), JSON.stringify(defs));

    const refs = where(await lsp.request('textDocument/references', {
        textDocument: { uri: uri('Shapes.swift') }, position: position(SHAPES, 'struct Point', 8), context: { includeDeclaration: true } }));
    check('references to Point span the three files', ['Shapes.swift', 'Circle.swift'].every((f) => refs.some((r) => r.includes(f))) && refs.length >= 5, JSON.stringify(refs));

    const sig = await lsp.request('textDocument/signatureHelp', { textDocument: { uri: uri('main.swift') }, position: position(MAIN, '2, 1)', 3) });
    check('signature help inside origin.moved(by: 2, |1)', /^moved\(by: Double, _ dy: Double\) -> Point$/.test(sig.result?.signatures?.[0]?.label ?? '') && sig.result.activeParameter === 1,
        JSON.stringify(sig.result));

    const syms = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri('Shapes.swift') } });
    const names = (syms.result ?? []).map((s) => `${s.name}[${(s.children ?? []).map((c) => c.name).join(',')}]`);
    check('document symbols outline Shapes.swift', names.join(' ') === 'Point[x,y,norm(),moved(by:_:)] Shape[area()]', names.join(' '));

    const rename = await lsp.request('textDocument/rename', { textDocument: { uri: uri('Shapes.swift') }, position: position(SHAPES, 'func norm', 6), newName: 'length' });
    const renamed = Object.entries(rename.result?.changes ?? {}).map(([u, e]) => `${u.slice(18)}x${e.length}`);
    check('rename norm edits its declaration and its use', renamed.sort().join(' ') === 'Shapes.swiftx1 main.swiftx1', renamed.join(' '));

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 6 }, contentChanges: [{ text: 'let a=Point(x:1,y:2)\n' }] });
    const fmt = await lsp.request('textDocument/formatting', { textDocument: { uri: uri('main.swift') }, options: { tabSize: 4, insertSpaces: true } });
    check('formatting inserts missing whitespace', fmt.result?.[0]?.newText === 'let a = Point(x: 1, y: 2)\n', JSON.stringify(fmt.result?.[0]?.newText));

    const tokens = await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri: uri('Circle.swift') } });
    check('semantic tokens for Circle.swift', (tokens.result?.data?.length ?? 0) > 50 && tokens.result.data.length % 5 === 0, `${(tokens.result?.data?.length ?? 0) / 5} tokens`);

    // ---- sourcekitd on library and project types: the probe the user ran
    // (completion after a dot, hover types, definition, signature help,
    // inlay hints).
    const PROBE = `func makePoints() -> [Point] { [Point(x: 1, y: 2), Point(x: 3, y: 4)] }

let xs = [1, 2, 3]
let ps = makePoints()
let first = ps[0]
let name = "hello"
var dict: [String: Int] = [:]
let total = xs.reduce(0, +)
for p in ps { print(p.norm()) }
`;
    let probeVersion = 100;
    const setMain = (text) => lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: ++probeVersion }, contentChanges: [{ text }] });
    const endOf = (text) => {
        const lines = text.split('\n');
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const latencies = [];
    /** Completion at the end of PROBE + `typed`: [labels, items, ms]. */
    async function completeAfter(typed) {
        const text = PROBE + typed;
        setMain(text);
        const t0 = Date.now();
        const r = await lsp.request('textDocument/completion', { textDocument: { uri: uri('main.swift') }, position: endOf(text), context: { triggerKind: 2, triggerCharacter: '.' } });
        const ms = Date.now() - t0;
        latencies.push(ms);
        const items = r.result?.items ?? [];
        return [items.map(nameOf), items, ms];
    }
    const has = (labels, want, not = []) => want.every((w) => labels.includes(w)) && !not.some((n) => labels.includes(n));
    const POINT = ['x', 'y', 'norm', 'moved'];
    let [got, items, ms] = await completeAfter('xs.');
    check('sourcekitd: completion after `xs.` ([Int]) lists Array\'s members',
        has(got, ['count', 'map', 'filter', 'reduce', 'append', 'sorted', 'contains', 'isEmpty', 'first'], POINT),
        `${got.length} items in ${ms} ms: ${got.slice(0, 12).join(', ')}...`);
    const reduceItem = items.find((i) => i.filterText === 'reduce(::)');
    check('sourcekitd: `reduce` is shown for [Int], with Int filled in and a snippet',
        /^reduce\(initialResult: Result, nextPartialResult: \(Result, Int\) throws -> Result\)/.test(reduceItem?.label ?? '') &&
            reduceItem?.insertTextFormat === 2 && /^reduce\(\$\{1:initialResult: Result\}, \$\{2:/.test(reduceItem?.textEdit?.newText ?? ''),
        JSON.stringify(reduceItem && [reduceItem.label, reduceItem.textEdit?.newText]));
    [got, items, ms] = await completeAfter('ps.');
    check('sourcekitd: completion after `ps.` ([Point]) offers sorted(by:) but not sorted(), since Point is not Comparable',
        has(got, ['count', 'map', 'first', 'sorted'], POINT) && !items.some((i) => i.filterText === 'sorted()'),
        `${got.length} items in ${ms} ms`);
    [got, , ms] = await completeAfter('name.');
    check('sourcekitd: completion after `name.` (String)', has(got, ['count', 'uppercased', 'hasPrefix', 'split', 'contains'], POINT), `${got.length} items in ${ms} ms`);
    [got, , ms] = await completeAfter('dict.');
    check('sourcekitd: completion after `dict.` ([String : Int])', has(got, ['keys', 'values', 'count', 'mapValues', 'updateValue', 'removeValue'], [...POINT, 'append']), `${got.length} items in ${ms} ms`);
    [got, , ms] = await completeAfter('total.');
    check('sourcekitd: completion after `total.` (Int, from reduce) lists Int\'s members, not Point\'s',
        has(got, ['isMultiple', 'description', 'signum'], [...POINT, 'count']), `${got.length} items in ${ms} ms`);
    [got, , ms] = await completeAfter('makePoints().');
    check('sourcekitd: completion after `makePoints().` ([Point])', has(got, ['count', 'map', 'first'], POINT), `${got.length} items in ${ms} ms`);
    [got, , ms] = await completeAfter('ps[0].');
    check('sourcekitd: completion after `ps[0].` (Point)', has(got, POINT, ['count', 'map']), `${JSON.stringify(got)} in ${ms} ms`);
    [got, , ms] = await completeAfter('let doubled = xs.map { $0.');
    check('sourcekitd: completion after `$0.` in a map over [Int] (unclosed closure) lists Int\'s members',
        has(got, ['isMultiple', 'signum'], POINT), `${got.length} items in ${ms} ms`);
    [got, items, ms] = await completeAfter('xs.first.');
    const unwrapped = items.find((i) => nameOf(i) === 'isMultiple');
    check('sourcekitd: after `xs.first.` (Int?) Optional\'s members, and Int\'s as `?.member` edits',
        has(got, ['map', 'flatMap', 'isMultiple']) && /^\?\.isMultiple/.test(unwrapped?.textEdit?.newText ?? ''), `${got.length} items in ${ms} ms, ${JSON.stringify(unwrapped?.textEdit)}`);

    // Implicit member expressions: `.member` with no base, completed from
    // the contextual type the compiler names (the user's case first: an
    // `if` expression as a function's implicit result).
    /** Completion at the `|` in PROBE + `typed`, cursor there, the rest after it: [labels, items, ms]. */
    async function completeAt(typed) {
        const text = PROBE + typed.replace('|', '');
        setMain(text);
        const t0 = Date.now();
        const r = await lsp.request('textDocument/completion', { textDocument: { uri: uri('main.swift') }, position: endOf(PROBE + typed.slice(0, typed.indexOf('|'))) });
        const ms = Date.now() - t0;
        latencies.push(ms);
        const items = r.result?.items ?? [];
        return [items.map(nameOf), items, ms];
    }
    const IMPLICIT = `extension Int {
    static func sad() -> Int { 1 }
}
enum Mood { case happy, grumpy(level: Int)
    static var usual: Mood { .happy }
    static func describe(_ m: Mood) -> String { "" }
}
func feel(_ m: Mood) {}
`;
    const IF_EXPRESSION = (typed) => `${IMPLICIT}func assss() -> Int {
    if true {
        ${typed}
    } else {
        .sad()
    }
}
`;
    [got, , ms] = await completeAt(IF_EXPRESSION('.s|'));
    check('sourcekitd: implicit member `.s` in an if expression returning Int offers `sad`',
        has(got, ['sad'], ['describe', 'isMultiple', 'happy', ...POINT]), `${got.length} items in ${ms} ms: ${[...new Set(got)].join(', ')}`);
    [got, , ms] = await completeAt(IF_EXPRESSION('.|'));
    check('sourcekitd: implicit member `.` there offers Int\'s static members of type Int',
        has(got, ['sad', 'max', 'min', 'zero', 'init', 'random'], ['describe', 'happy', ...POINT]), `${got.length} items in ${ms} ms`);
    [got, , ms] = await completeAt(`${IMPLICIT}let m: Mood = .|
`);
    // sourcekitd also lists Mood's other static members, after the ones of type Mood.
    const MOODS = ['happy', 'grumpy', 'usual'];
    check('sourcekitd: implicit member after `let m: Mood = .` offers the cases and `usual` first, `describe` (a String) after them',
        has(got, MOODS, ['sad']) && (!got.includes('describe') || got.indexOf('describe') > Math.max(...MOODS.map((m) => got.indexOf(m)))),
        `${got.length} items in ${ms} ms: ${got.join(', ')}`);
    [got, , ms] = await completeAt(`${IMPLICIT}func check() { feel(.|) }
`);
    check('sourcekitd: implicit member in an argument `feel(.)` offers Mood\'s cases', has(got, ['happy', 'grumpy', 'usual'], ['sad']), `${got.length} items in ${ms} ms: ${got.join(', ')}`);
    [got, , ms] = await completeAt(`${IMPLICIT}let chained = xs
    .|
`);
    check('sourcekitd: a dot starting a line after an expression continues it (instance members of [Int])', has(got, ['map', 'count'], ['happy']), `${got.length} items in ${ms} ms`);
    check('sourcekitd: the completion item carries the stdlib doc comment', /Returns the result of combining/.test(reduceItem?.documentation?.value ?? ''),
        (reduceItem?.documentation?.value ?? '').slice(0, 60));

    // Hover, definition, signature help and inlay hints.
    setMain(PROBE);
    const hoverAt = async (needle, delta = 0) => {
        const r = await lsp.request('textDocument/hover', { textDocument: { uri: uri('main.swift') }, position: position(PROBE, needle, delta) });
        return r.result?.contents?.value ?? '';
    };
    const hovers = {
        total: await hoverAt('total ='), ps: await hoverAt('ps ='), first: await hoverAt('first ='), dict: await hoverAt('dict:'), p: await hoverAt('p.norm'),
    };
    check('sourcekitd: hover shows the inferred types', /let total: Int/.test(hovers.total) && /let ps: \[Point\]/.test(hovers.ps) &&
        /let first: Point/.test(hovers.first) && /var dict: \[String : Int\]/.test(hovers.dict) && /let p: Point/.test(hovers.p), JSON.stringify(Object.values(hovers)));
    const hoverReduce = await hoverAt('reduce', 1);
    check('sourcekitd: hover on reduce shows the stdlib declaration, Element as Int, and its doc',
        /func reduce<Result>\(_ initialResult: Result, _ nextPartialResult: \(Result, Int\) throws -> Result\)/.test(hoverReduce) &&
            /Returns the result of combining/.test(hoverReduce), hoverReduce.slice(0, 160));
    const hoverPrint = await hoverAt('print(', 1);
    check('sourcekitd: hover on print shows its declaration and doc', /func print\(_ items: Any\.\.\./.test(hoverPrint) && /Writes the textual representation/.test(hoverPrint), hoverPrint.slice(0, 100));
    const sqrt = await lsp.request('textDocument/hover', { textDocument: { uri: uri('Shapes.swift') }, position: position(SHAPES, 'squareRoot', 1) });
    check('sourcekitd: hover on squareRoot (in Shapes.swift) shows FloatingPoint\'s doc', /func squareRoot\(\) -> Double/.test(sqrt.result?.contents?.value ?? '') && /square root/.test(sqrt.result?.contents?.value ?? ''),
        (sqrt.result?.contents?.value ?? '').slice(0, 100));
    const hoverNorm = await hoverAt('norm()', 1);
    check('sourcekitd: hover on p.norm() (declared in another file) shows its declaration and doc', /func norm\(\) -> Double/.test(hoverNorm) && /Distance from the origin/.test(hoverNorm), hoverNorm.slice(0, 100));
    const defAt = async (needle, delta) => where(await lsp.request('textDocument/definition', { textDocument: { uri: uri('main.swift') }, position: position(PROBE, needle, delta) }));
    const defs2 = { makePoints: await defAt('makePoints()\nlet first', 1), norm: await defAt('norm()', 1), ps: await defAt('ps[0]', 0), reduce: await defAt('reduce', 1) };
    check('sourcekitd: definition of makePoints, p.norm and ps lands on their declarations; reduce (stdlib) has no location, not a wrong one',
        defs2.makePoints.join() === `${uri('main.swift')}:1:6` && defs2.norm.join() === `${uri('Shapes.swift')}:7:10` && defs2.ps.join() === `${uri('main.swift')}:4:5` && defs2.reduce.length === 0,
        JSON.stringify(defs2));
    const refsXs = where(await lsp.request('textDocument/references', { textDocument: { uri: uri('main.swift') }, position: position(PROBE, 'xs =', 0), context: { includeDeclaration: true } }));
    check('sourcekitd: references to xs are its declaration and its use in reduce', refsXs.join() === `${uri('main.swift')}:3:5,${uri('main.swift')}:8:13`, JSON.stringify(refsXs));
    const PRINTING = PROBE + 'print(';
    setMain(PRINTING);
    const sigPrint = await lsp.request('textDocument/signatureHelp', { textDocument: { uri: uri('main.swift') }, position: endOf(PRINTING) });
    check('sourcekitd: signature help for print(', /print\(_ items: Any\.\.\., separator: String = " ", terminator: String = "\\n"\)/.test(sigPrint.result?.signatures?.[0]?.label ?? ''),
        JSON.stringify(sigPrint.result?.signatures?.map((s) => s.label)));
    setMain(PROBE);
    const hints = await lsp.request('textDocument/inlayHint', { textDocument: { uri: uri('main.swift') }, range: { start: { line: 0, character: 0 }, end: endOf(PROBE) } });
    const hintText = (hints.result ?? []).map((h) => `${h.position.line + 1}:${h.label}`);
    check('sourcekitd: inlay hints give the inferred types of unannotated declarations', ['3:: [Int]', '4:: [Point]', '8:: Int'].every((h) => hintText.includes(h)) && !hintText.some((h) => h.startsWith('7:')),
        JSON.stringify(hintText));
    // Diagnostics latency, warm: a type error typed into the probe file.
    since = (await lsp.log()).length;
    t = Date.now();
    setMain(PROBE + 'let bad: Int = name\n');
    const badDiags = await diagnostics('main.swift', (d) => d.some((x) => /cannot convert value of type 'String' to specified type 'Int'/.test(x.message)), since, 60000);
    const errorMs = Date.now() - t;
    check('sourcekitd: a type error is reported quickly when warm', errors(badDiags).length === 1, `${errorMs} ms`);
    const sorted = [...latencies].sort((a, b) => a - b);
    console.log(`(latency: completion ${sorted[0]}-${sorted.at(-1)} ms, median ${sorted[sorted.length >> 1]} ms; type error ${errorMs} ms after the edit)`);
    setMain('let a=Point(x:1,y:2)\n');

    // An unsaved, ranged edit to Shapes.swift is seen from main.swift.
    const at = position(SHAPES, '    var y: Double', 17);
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('Shapes.swift'), version: 2 },
        contentChanges: [{ range: { start: at, end: at }, text: '\n    var z: Double = 0' }] });
    const typed = MAIN + 'far.\n';
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 200 }, contentChanges: [{ text: typed }] });
    const after = await lsp.request('textDocument/completion', { textDocument: { uri: uri('main.swift') }, position: position(typed, 'far.\n', 4) });
    const afterLabels = (after.result?.items ?? []).map(nameOf);
    check('an edit to Shapes.swift reaches completion in main.swift', afterLabels.includes('z'), JSON.stringify(afterLabels));

    // Formatting re-indents consistently, whatever indentation the input had.
    const MESSY = 'struct A {\nvar x = 1\n      func f() {\nreturn\n}\n}\n';
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Fmt.swift'), languageId: 'swift', version: 1, text: MESSY } });
    const fmt2 = await lsp.request('textDocument/formatting', { textDocument: { uri: uri('Fmt.swift') }, options: { tabSize: 4, insertSpaces: true } });
    check('formatting re-indents mixed indentation consistently',
        fmt2.result?.[0]?.newText === 'struct A {\n    var x = 1\n    func f() {\n        return\n    }\n}\n', JSON.stringify(fmt2.result?.[0]?.newText));

    // Rename takes any name the Swift lexer reads as one identifier.
    const renameTo = (newName) => lsp.request('textDocument/rename', { textDocument: { uri: uri('Fmt.swift') }, position: { line: 1, character: 4 }, newName });
    const [r1, r2, r3] = [await renameTo('naïve'), await renameTo('`default`'), await renameTo('not a name')];
    check('rename accepts Unicode and backticked identifiers and refuses non-identifiers',
        !!r1.result?.changes && !!r2.result?.changes && r3.error?.code === -32803,
        JSON.stringify([Object.keys(r1.result?.changes ?? {}).length, Object.keys(r2.result?.changes ?? {}).length, r3.error?.message]));

    // CRLF: a multi-line token excludes the \r, and a position past the end
    // of a line stays on that line.
    const CRLF = '/* x\r\n y */\r\nlet abc = 1\r\nlet d = abc\r\n';
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Crlf.swift'), languageId: 'swift', version: 1, text: CRLF } });
    const crlfTokens = (await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri: uri('Crlf.swift') } })).result?.data ?? [];
    const pastEnd = await lsp.request('textDocument/hover', { textDocument: { uri: uri('Crlf.swift') }, position: { line: 2, character: 99 } });
    check('CRLF: a comment token stops before \\r, and a column past a line end stays on that line',
        crlfTokens.slice(0, 5).join() === '0,0,4,4,0' && pastEnd.result === null,
        `${JSON.stringify(crlfTokens.slice(0, 10))} hover past end: ${JSON.stringify(pastEnd.result)}`);

    // Pathological files: the server says it skips them, or recovers from
    // the trap, and the other files keep working either way.
    const healthy = async () => {
        const h = await lsp.request('textDocument/hover', { textDocument: { uri: uri('main.swift') }, position: position(MAIN, 'far.norm()', 5) });
        const d = await lsp.request('textDocument/definition', { textDocument: { uri: uri('main.swift') }, position: position(MAIN, 'Point(x', 2) });
        return /func norm/.test(JSON.stringify(h.result)) && where(d).includes(`${uri('Shapes.swift')}:2:8`);
    };
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 201 }, contentChanges: [{ text: MAIN }] });
    const deepCases = {
        'a 2000-link member chain': 'let c = a' + '.b()'.repeat(2000) + '\n',
        'arrays nested 30 deep (exponential in the parser)': 'let t: ' + '['.repeat(30) + 'Int' + ']'.repeat(30) + ' = []\n',
        'a 2000-branch else-if chain': 'func g(a: Int) {\nif a == 0 { print(0) }\n' +
            Array.from({ length: 2000 }, (_, i) => `else if a == ${i + 1} { print(${i}) }\n`).join('') + '}\n',
        '300 nested closures': 'let f = ' + '{ '.repeat(300) + '1' + ' }'.repeat(300) + '\n',
    };
    let deepVersion = 1;
    for (const [what, text] of Object.entries(deepCases)) {
        since = (await lsp.log()).length;
        t = Date.now();
        const method = deepVersion === 1 ? 'textDocument/didOpen' : 'textDocument/didChange';
        lsp.notify(method, deepVersion === 1
            ? { textDocument: { uri: uri('Deep.swift'), languageId: 'swift', version: deepVersion, text } }
            : { textDocument: { uri: uri('Deep.swift'), version: deepVersion }, contentChanges: [{ text }] });
        deepVersion++;
        const diags = await diagnostics('Deep.swift', () => true, since);
        const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri('Deep.swift') } });
        const said = (diags ?? []).map((d) => d.message).find((m) => /leaves this file out|crashed|nesting level/.test(m)) ?? '';
        const kind = /crashed/.test(said) ? 'crashed, recovered' : /leaves this file out/.test(said) ? 'skipped' : /nesting level/.test(said) ? 'parser nesting limit' : 'analysed';
        check(`${what}: the server answers (${kind}) and the other files still work`,
            !symbols.error && (kind !== 'analysed' || (diags ?? []).length === 0) && await healthy(), `${Date.now() - t} ms ${said.slice(0, 90)}`);
    }
    const traps = (await lsp.log()).filter((m) => m.method === 'window/logMessage' && /sourcekitd crashed/.test(m.params.message)).length;
    console.log(`(${traps} sourcekitd crash(es) recovered from in the cases above)`);

    const shutdown = await lsp.request('shutdown', null);
    check('shutdown answers', shutdown.result === null, JSON.stringify(shutdown.error ?? ''));
    lsp.notify('exit', null);
    await page.waitForTimeout(300);
    const logs = (await lsp.log()).filter((m) => m.method === 'window/logMessage');
    // sourcekitd's own tracing (log level 4, "sourcekitd: ...") is left out: it is long and says nothing about the checks.
    for (const m of logs) if (!(m.params.type === 4 && m.params.message.startsWith('sourcekitd: '))) console.log(`[log ${m.params.type}] ${m.params.message.slice(0, 200)}`);
    const workerErrors = (await lsp.log()).filter((m) => m.method === 'worker/error');
    check('the worker raised no errors', workerErrors.length === 0, JSON.stringify(workerErrors));
} finally {
    await browser.close();
    server.close();
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
