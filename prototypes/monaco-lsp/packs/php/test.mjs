// Headless test of the PHP pack's language server, run the way the app runs
// it: app/static served over http (no COOP/COEP: the server does not need
// cross-origin isolation), `new Worker('/packs/php/server.js', { type:
// 'module' })` in Chromium, one JSON-RPC object per postMessage. Checks
// diagnostics (Phpactor's own, and a parse error from PHP's parser), that a
// file added later resolves, completion at a member access, hover,
// go-to-definition across files, references, symbols and rename.
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
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };

// Raw files, no content-encoding negotiation: the worst-case transfer.
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel=icon href="data:,"><title>php pack test</title>');
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

const GEOMETRY = `<?php

declare(strict_types=1);

namespace Geometry;

/** A point in the plane. */
final class Point
{
    public function __construct(
        public readonly float $x,
        public readonly float $y,
    ) {
    }

    /** Distance from the origin. */
    public function norm(): float
    {
        return hypot($this->x, $this->y);
    }
}

/** Euclidean distance between two points. */
function distance(Point $a, Point $b): float
{
    return hypot($a->x - $b->x, $a->y - $b->y);
}
`;
const MAIN = `<?php

declare(strict_types=1);

require_once __DIR__ . '/geometry.php';

use Geometry\\Point;
use Geometry\\Shapes\\Circle;

use function Geometry\\distance;

$a = new Point(0, 0);
$b = new Point(3, 4);
echo distance($a, $b) . "\\n";
echo $b->norm() . "\\n";
`;
const CIRCLE = `<?php

namespace Geometry\\Shapes;

final class Circle
{
    public function area(): float
    {
        return 1.0;
    }
}
`;
const TEST = `<?php

namespace Geometry\\Tests;

use Geometry\\Point;
use PHPUnit\\Framework\\TestCase;

final class GeometryTest extends TestCase
{
    public function testNorm(): void
    {
        $this->assertSame(5.0, (new Point(3, 4))->norm());
    }
}
`;
const MAIN_MISSING = MAIN + `$b->nope();\n`;
const MAIN_SYNTAX = MAIN + `echo "unterminated\n`;
const MAIN_CIRCLE = MAIN + `echo (new Circle())->area();\n`;

await stat(join(STATIC, 'packs/php/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/php/server.js')}: run ./build.sh first`);
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
        const worker = new Worker('/packs/php/server.js', { type: 'module' });
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
                log.push({ ...msg, t: Math.round(performance.now()) });
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
    const at = (name, line, character) => ({ textDocument: { uri: uri(name) }, position: { line, character } });
    /**
     * Waits for the latest publishDiagnostics of a file to satisfy `ok` and
     * stay the latest for a second: Phpactor publishes a file's diagnostics
     * in steps (cleared, then each provider's).
     */
    async function diagnostics(name, ok, timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        let last;
        let since = 0;
        let count = 0;
        while (Date.now() < deadline) {
            const published = (await lsp.log()).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri(name));
            if (published.length !== count) {
                count = published.length;
                since = Date.now();
            }
            last = published.at(-1)?.params.diagnostics;
            if (last && ok(last) && Date.now() - since > 1000) return last;
            await page.waitForTimeout(100);
        }
        return last;
    }
    let version = 1;
    const change = (name, text) => lsp.notify('textDocument/didChange', { textDocument: { uri: uri(name), version: ++version }, contentChanges: [{ text }] });

    const init = await lsp.request('initialize', {
        processId: null,
        rootUri: 'file:///workspace/',
        workspaceFolders: [{ uri: 'file:///workspace/', name: 'workspace' }],
        capabilities: {
            general: { positionEncodings: ['utf-16'] },
            workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: false } },
            textDocument: {
                publishDiagnostics: {},
                hover: { contentFormat: ['markdown', 'plaintext'] },
                completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown'] } },
                definition: { linkSupport: true },
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                rename: { prepareSupport: true },
            },
        },
    });
    const loading = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    check(
        'initialize answers after php.wasm and Phpactor download, with progress notifications',
        !!init.result?.capabilities?.hoverProvider && loading.length > 0,
        `(${await lsp.elapsed()} ms, ${loading.length} progress messages, server ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version})`,
    );
    if (init.error) console.log(init.error);

    await lsp.notify('initialized', {});
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('geometry.php'), languageId: 'php', version: 1, text: GEOMETRY } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('main.php'), languageId: 'php', version: 1, text: MAIN_CIRCLE } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('tests/GeometryTest.php'), languageId: 'php', version: 1, text: TEST } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('README.md'), languageId: 'markdown', version: 1, text: '# Not PHP <?php (\n' } });

    let diags = await diagnostics('main.php', (d) => d.some((x) => /Circle/.test(x.message)));
    check('a class the project does not have is reported', !!diags?.some((x) => /Circle/.test(x.message)), `(${await lsp.elapsed()} ms) ${JSON.stringify(diags?.map((d) => d.message))}`);

    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Shapes/Circle.php'), languageId: 'php', version: 1, text: CIRCLE } });
    await lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('Shapes/Circle.php'), type: 1 }] });
    await change('main.php', MAIN_CIRCLE);
    diags = await diagnostics('main.php', (d) => d.length === 0 || !d.some((x) => /Circle/.test(x.message)));
    check('adding that file resolves it, and main.php has no errors', diags !== undefined && !diags.some((d) => d.severity === 1), JSON.stringify(diags?.map((d) => d.message)));

    const testDiags = await diagnostics('tests/GeometryTest.php', () => true, 20000);
    check('the test file, which extends PHPUnit\'s TestCase, has no errors', testDiags !== undefined && !testDiags.some((d) => d.severity === 1), JSON.stringify(testDiags?.map((d) => d.message)));

    await change('main.php', MAIN_MISSING);
    diags = await diagnostics('main.php', (d) => d.some((x) => /nope/.test(x.message)));
    const missing = diags?.find((d) => /nope/.test(d.message));
    check('calling a method Point does not have is an error on that line', missing?.severity === 1 && missing.range.start.line === 15, JSON.stringify(missing));

    await change('main.php', MAIN_SYNTAX);
    diags = await diagnostics('main.php', (d) => d.some((x) => /Parse error/.test(x.message)));
    const parse = diags?.find((d) => /Parse error/.test(d.message));
    check('a syntax error is reported by PHP\'s own parser', !!parse, JSON.stringify(parse?.message));

    await change('main.php', MAIN);
    const completion = await lsp.request('textDocument/completion', at('main.php', 14, 9));
    const items = (completion.result?.items ?? completion.result ?? []).map((i) => i.label);
    check('completion after `$b->` offers the members of Point from geometry.php', ['norm', 'x', 'y'].every((l) => items.includes(l)), JSON.stringify(items.slice(0, 12)));

    const builtin = await lsp.request('textDocument/completion', at('geometry.php', 18, 20));
    const builtinItems = (builtin.result?.items ?? builtin.result ?? []).map((i) => i.label);
    check('completion of a PHP function from the stubs (`hypot`)', builtinItems.includes('hypot'), JSON.stringify(builtinItems.slice(0, 8)));

    const hover = await lsp.request('textDocument/hover', at('main.php', 14, 10));
    const hoverText = hover.result?.contents?.value ?? JSON.stringify(hover.result);
    check('hover on `norm` shows its signature and doc comment', /norm/.test(hoverText) && /float/.test(hoverText) && /Distance from the origin/.test(hoverText), JSON.stringify(hoverText));

    const stdHover = await lsp.request('textDocument/hover', at('geometry.php', 18, 16));
    const stdText = stdHover.result?.contents?.value ?? JSON.stringify(stdHover.result);
    check('hover on PHP\'s `hypot` shows its documentation from phpstorm-stubs', /hypot/.test(stdText) && /float/.test(stdText), JSON.stringify(stdText.slice(0, 160)));

    const definition = await lsp.request('textDocument/definition', at('main.php', 13, 7));
    const target = [definition.result].flat()[0];
    const targetUri = target?.uri ?? target?.targetUri;
    check('definition of `distance` is in geometry.php', targetUri === uri('geometry.php'), JSON.stringify(definition.result));

    const references = await lsp.request('textDocument/references', { ...at('geometry.php', 7, 13), context: { includeDeclaration: true } });
    const files = new Set((references.result ?? []).map((r) => r.uri.replace('file:///workspace/', '')));
    check('references of Point are found in main.php and the test', files.has('main.php') && files.has('tests/GeometryTest.php'), JSON.stringify([...files]));

    const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri('geometry.php') } });
    const names = JSON.stringify(symbols.result ?? null);
    check('document symbols of geometry.php name Point, norm and distance', /Point/.test(names) && /norm/.test(names) && /distance/.test(names), names.slice(0, 200));

    const rename = await lsp.request('textDocument/rename', { ...at('geometry.php', 16, 22), newName: 'length' });
    const edits = rename.result?.changes ?? Object.fromEntries((rename.result?.documentChanges ?? []).map((c) => [c.textDocument.uri, c.edits]));
    const renamed = Object.keys(edits).map((u) => u.replace('file:///workspace/', ''));
    check('rename of norm edits geometry.php, main.php and the test', ['geometry.php', 'main.php', 'tests/GeometryTest.php'].every((f) => renamed.includes(f)), JSON.stringify(rename.result ?? rename.error).slice(0, 300));

    const signature = await lsp.request('textDocument/signatureHelp', at('main.php', 11, 15));
    const label = signature.result?.signatures?.[0]?.label ?? JSON.stringify(signature.result ?? signature.error);
    check('signature help inside `new Point(` shows the constructor\'s parameters', /float \$x/.test(label) && /float \$y/.test(label), JSON.stringify(label));
    // Known limit: Phpactor gives none inside the call of a namespaced function imported with `use function`.
    const fnSignature = await lsp.request('textDocument/signatureHelp', at('main.php', 13, 14));
    console.log(`      (signature help inside \`distance(\`: ${JSON.stringify(fnSignature.result?.signatures?.[0]?.label ?? null)})`);

    const unimported = MAIN.replace('use Geometry\\Shapes\\Circle;\n', '') + `echo (new Circle())->area();\n`;
    await change('main.php', unimported);
    await diagnostics('main.php', (d) => d.some((x) => /Circle/.test(x.message)));
    const line = unimported.split('\n').findIndex((l) => l.includes('new Circle'));
    const actions = await lsp.request('textDocument/codeAction', {
        textDocument: { uri: uri('main.php') },
        range: { start: { line, character: 11 }, end: { line, character: 11 } },
        context: { diagnostics: [] },
    });
    const titles = (actions.result ?? []).map((a) => a.title);
    check('a quick fix imports a class the file uses without `use`', titles.some((t) => /Import/i.test(t) && /Circle/.test(t)), JSON.stringify(titles));
    await change('main.php', MAIN);

    if (process.env.DEBUG) for (const m of await lsp.log()) if (m.method !== 'yukibana/loading') console.log(m.t, m.method, JSON.stringify(m.params).slice(0, 300));
    const shutdown = await Promise.race([lsp.request('shutdown', null), page.waitForTimeout(10000).then(() => ({ error: 'no answer in 10 s' }))]);
    check('shutdown answers', shutdown.error === undefined, JSON.stringify(shutdown));
    const errors = (await lsp.log()).filter((m) => m.method === 'worker/error' || (m.method === 'window/logMessage' && m.params.type === 1));
    check('no worker errors or error log lines', errors.length === 0, JSON.stringify(errors.map((e) => e.params?.message ?? e.params)).slice(0, 600));
} finally {
    await browser.close();
    server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
