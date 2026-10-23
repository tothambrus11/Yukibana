// Headless test of the Swift pack, run the way the app runs it: app/static
// served over http, `new Worker('/packs/swift/server.js', { type: 'module' })`
// in Chromium, one JSON-RPC object per postMessage. The project is three
// Swift files that use each other's declarations. It checks a clean project,
// a diagnostic for an introduced (syntax) error, completion at a member
// access, hover, go-to-definition across files, and the other features the
// pack advertises. The server is swift-syntax based, NOT SourceKit-LSP.
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
     * messages in the log) to satisfy `ok`. */
    async function diagnostics(name, ok, since = 0, timeoutMs = 60000) {
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
    }
    const errors = (diags) => (diags ?? []).filter((d) => d.severity === 1);
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
        !!caps.completionProvider && !!caps.hoverProvider && !!caps.definitionProvider && /swift-syntax/.test(info.name),
        `${info.name} ${info.version ?? ''} after ${await lsp.elapsed()} ms` + (init.error ? ` error: ${init.error.message}` : ''));
    check('yukibana/loading reports swift-ls.wasm',
        loads.some((m) => m.params.label === 'swift-ls.wasm' && m.params.loaded === m.params.total && m.params.total > 0),
        `${loads.length} progress notifications`);
    lsp.notify('initialized', {});
    const files = { 'Shapes.swift': SHAPES, 'Circle.swift': CIRCLE, 'main.swift': MAIN };
    for (const [name, text] of Object.entries(files))
        lsp.notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId: 'swift', version: 1, text } });
    for (const name of Object.keys(files)) {
        const diags = await diagnostics(name, () => true);
        check(`${name} is clean`, diags && diags.length === 0, show(diags));
    }

    // Semantic diagnostics: the real compiler's -typecheck (swift-frontend.wasm,
    // loaded lazily by a nested worker) on a type error the parser cannot see.
    let t = Date.now();
    const TYPED = 'let x: Int = "no"\n';
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Typed.swift'), languageId: 'swift', version: 1, text: TYPED } });
    const typedDiags = await diagnostics('Typed.swift', (d) => errors(d).some((x) => x.source === 'swiftc'), 0, 240000);
    const typeError = errors(typedDiags).find((x) => x.source === 'swiftc');
    check('`let x: Int = "no"` yields a type-error diagnostic from swift-frontend',
        /cannot convert value of type 'String' to specified type 'Int'/.test(typeError?.message ?? '') &&
            typeError.range.start.line === 0 && typeError.range.start.character === 13 && typeError.range.end.character === 17,
        `${show(typedDiags)} ${JSON.stringify(typeError?.range)} after ${Date.now() - t} ms (cold: downloads and compiles swift-frontend.wasm)`);
    const frontendLoads = (await lsp.log()).filter((m) => m.method === 'yukibana/loading' && m.params.label === 'swift-frontend.wasm');
    check('yukibana/loading reports swift-frontend.wasm', frontendLoads.some((m) => m.params.loaded === m.params.total && m.params.total > 0),
        `${frontendLoads.length} progress notifications`);
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
    lsp.notify('textDocument/didClose', { textDocument: { uri: uri('Typed.swift') } });

    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 2 }, contentChanges: [{ text: BROKEN }] });
    const broken = await diagnostics('main.swift', (d) => errors(d).length > 0, since);
    check('an introduced error is a diagnostic', errors(broken).some((d) => /expected '\)' to end function call/.test(d.message)), show(broken));
    // Wait for the type checker's run on the broken text, then look again.
    for (let i = 0; i < 300 && !(await lsp.log()).slice(since).some((m) => m.method === 'window/logMessage' && /-typecheck:/.test(m.params.message)); i++)
        await page.waitForTimeout(100);
    const merged = await diagnostics('main.swift', () => true, since);
    check('the type checker\'s copy of the syntax error is not shown twice',
        errors(merged ?? broken).length === 1, show(merged ?? broken));
    const actions = await lsp.request('textDocument/codeAction', {
        textDocument: { uri: uri('main.swift') }, range: errors(broken)[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: errors(broken) },
    });
    const fix = (actions.result ?? []).find((a) => a.edit);
    check('it comes with a quick fix', !!fix && JSON.stringify(fix.edit).includes(')'), JSON.stringify((actions.result ?? []).map((a) => a.title)));

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 3 }, contentChanges: [{ text: COMPLETE }] });
    t = Date.now();
    const completion = await lsp.request('textDocument/completion', {
        textDocument: { uri: uri('main.swift') },
        position: position(COMPLETE, 'c.centre.\n', 9),
        context: { triggerKind: 2, triggerCharacter: '.' },
    });
    const labels = (completion.result?.items ?? []).map((i) => i.label);
    check('completion after "c.centre." lists Point\'s members (Circle.swift -> Shapes.swift)',
        ['norm', 'moved', 'x', 'y'].every((m) => labels.includes(m)) && !labels.includes('radius'), `${JSON.stringify(labels)} ${Date.now() - t} ms`);

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 4 }, contentChanges: [{ text: MAIN }] });
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
    check('signature help inside origin.moved(by: 2, |1)', /moved\(by dx: Double, _ dy: Double\)/.test(sig.result?.signatures?.[0]?.label ?? '') && sig.result.activeParameter === 1,
        JSON.stringify(sig.result));

    const syms = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri('Shapes.swift') } });
    const names = (syms.result ?? []).map((s) => `${s.name}[${(s.children ?? []).map((c) => c.name).join(',')}]`);
    check('document symbols outline Shapes.swift', names.join(' ') === 'Point[x,y,norm,moved] Shape[area]', names.join(' '));

    const rename = await lsp.request('textDocument/rename', { textDocument: { uri: uri('Shapes.swift') }, position: position(SHAPES, 'func norm', 6), newName: 'length' });
    const renamed = Object.entries(rename.result?.changes ?? {}).map(([u, e]) => `${u.slice(18)}x${e.length}`);
    check('rename norm edits its declaration and its use', renamed.sort().join(' ') === 'Shapes.swiftx1 main.swiftx1', renamed.join(' '));

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 5 }, contentChanges: [{ text: 'let a=Point(x:1,y:2)\n' }] });
    const fmt = await lsp.request('textDocument/formatting', { textDocument: { uri: uri('main.swift') }, options: { tabSize: 4, insertSpaces: true } });
    check('formatting inserts missing whitespace', fmt.result?.[0]?.newText === 'let a = Point(x: 1, y: 2)\n', JSON.stringify(fmt.result?.[0]?.newText));

    const tokens = await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri: uri('Circle.swift') } });
    check('semantic tokens for Circle.swift', (tokens.result?.data?.length ?? 0) > 50 && tokens.result.data.length % 5 === 0, `${(tokens.result?.data?.length ?? 0) / 5} tokens`);

    // An unsaved, ranged edit to Shapes.swift is seen from main.swift.
    const at = position(SHAPES, '    var y: Double', 17);
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('Shapes.swift'), version: 2 },
        contentChanges: [{ range: { start: at, end: at }, text: '\n    var z: Double' }] });
    const typed = MAIN + 'far.\n';
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 6 }, contentChanges: [{ text: typed }] });
    const after = await lsp.request('textDocument/completion', { textDocument: { uri: uri('main.swift') }, position: position(typed, 'far.\n', 4) });
    const afterLabels = (after.result?.items ?? []).map((i) => i.label);
    check('an edit to Shapes.swift reaches completion in main.swift', afterLabels.includes('z'), JSON.stringify(afterLabels));

    // Formatting re-indents consistently, whatever indentation the input had.
    const MESSY = 'struct A {\nvar x = 1\n      func f() {\nreturn\n}\n}\n';
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Fmt.swift'), languageId: 'swift', version: 1, text: MESSY } });
    const fmt2 = await lsp.request('textDocument/formatting', { textDocument: { uri: uri('Fmt.swift') }, options: { tabSize: 4, insertSpaces: true } });
    check('formatting re-indents mixed indentation consistently',
        fmt2.result?.[0]?.newText === 'struct A {\n    var x = 1\n    func f() {\n        return\n    }\n}\n', JSON.stringify(fmt2.result?.[0]?.newText));

    // Rename takes any name the Swift parser reads as one identifier.
    const renameTo = (newName) => lsp.request('textDocument/rename', { textDocument: { uri: uri('Fmt.swift') }, position: { line: 1, character: 4 }, newName });
    const [r1, r2, r3] = [await renameTo('naïve'), await renameTo('`default`'), await renameTo('not a name')];
    check('rename accepts Unicode and backticked identifiers and refuses non-identifiers',
        !!r1.result?.changes && !!r2.result?.changes && r3.error?.code === -32602,
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
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.swift'), version: 7 }, contentChanges: [{ text: MAIN }] });
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
        const said = (diags ?? []).map((d) => d.message).find((m) => /does not analyse|crashed|nesting level/.test(m)) ?? '';
        const kind = /does not analyse/.test(said) ? 'skipped' : /crashed/.test(said) ? 'trapped, recovered' : /nesting level/.test(said) ? 'parser nesting limit' : 'analysed';
        check(`${what}: the server answers (${kind}) and the other files still work`,
            !symbols.error && (kind !== 'analysed' || (diags ?? []).length === 0) && await healthy(), `${Date.now() - t} ms ${said.slice(0, 90)}`);
    }
    const traps = (await lsp.log()).filter((m) => m.method === 'window/logMessage' && /trapped/.test(m.params.message)).length;
    console.log(`(${traps} trap(s) recovered from in the cases above)`);

    const shutdown = await lsp.request('shutdown', null);
    check('shutdown answers', shutdown.result === null, JSON.stringify(shutdown.error ?? ''));
    lsp.notify('exit', null);
    await page.waitForTimeout(300);
    const logs = (await lsp.log()).filter((m) => m.method === 'window/logMessage');
    for (const m of logs) console.log(`[log ${m.params.type}] ${m.params.message.slice(0, 200)}`);
    const workerErrors = (await lsp.log()).filter((m) => m.method === 'worker/error');
    check('the worker raised no errors', workerErrors.length === 0, JSON.stringify(workerErrors));
} finally {
    await browser.close();
    server.close();
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
