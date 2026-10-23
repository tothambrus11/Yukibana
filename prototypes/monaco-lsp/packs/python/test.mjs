// Headless test of the Python pack, run the way the app runs it: app/static
// served over http, `new Worker('/packs/python/server.js', { type: 'module' })`
// in Chromium, one JSON-RPC object per postMessage. Checks diagnostics (an
// introduced type error, and an unresolved import that resolves once its file
// is added), completion at a member access, hover (project and stdlib), and
// go-to-definition across files.
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
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.gz': 'application/gzip', '.json': 'application/json' };

// A plain static server, like `python3 -m http.server`: raw files, no
// content-encoding negotiation, so the test sees the worst-case transfer.
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel=icon href="data:,"><title>python pack test</title>');
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

const MODELS = `class Point:
    """A point in the plane."""

    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y

    def norm(self) -> float:
        """Distance from the origin."""
        return (self.x ** 2 + self.y ** 2) ** 0.5
`;
const MAIN = `import math
from models import Point
from helpers import double

p = Point(3, 4)
print(p.norm())
r = math.sqrt(double(p.x))
`;
const MAIN_BROKEN = MAIN + `length: int = "five"\n`;
const PYPROJECT = `[tool.basedpyright]\nreportMissingImports = "warning"\n`;
const README = `# Not Python (at all\n`;
const HELPERS = `def double(v: float) -> float:\n    return v * 2\n`;

await stat(join(STATIC, 'packs/python/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/python/server.js')}: run ./build.sh first`);
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
        const worker = new Worker('/packs/python/server.js', { type: 'module' });
        const pending = new Map();
        const log = [];
        let nextId = 1;
        worker.onerror = (e) => log.push({ method: 'worker/error', params: String(e.message) });
        worker.onmessage = ({ data: msg }) => {
            if (msg.id !== undefined && msg.method) {
                // Server-to-client request: answer as a minimal client would.
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
    /** Waits for the latest publishDiagnostics of a file to satisfy `ok`. */
    async function diagnostics(name, ok, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() < deadline) {
            const published = (await lsp.log()).filter(
                (m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri(name)
            );
            last = published.at(-1)?.params.diagnostics;
            if (last && ok(last)) return last;
            await page.waitForTimeout(100);
        }
        return last;
    }

    const init = await lsp.request('initialize', {
        processId: null,
        rootUri: 'file:///workspace/',
        workspaceFolders: [{ uri: 'file:///workspace/', name: 'workspace' }],
        capabilities: {
            workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: false } },
            textDocument: {
                synchronization: { didSave: false },
                publishDiagnostics: {},
                hover: { contentFormat: ['markdown', 'plaintext'] },
                completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown'] } },
                definition: {},
            },
        },
    });
    const loading = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    const lastLoad = loading.at(-1)?.params;
    check(
        'initialize answers after the stubs download, with progress notifications',
        !!init.result?.capabilities?.hoverProvider && loading.length > 0,
        `(${await lsp.elapsed()} ms, ${loading.length} progress messages, last ${JSON.stringify(lastLoad)}, server ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version})`
    );
    if (init.error) console.log(init.error);

    await lsp.notify('initialized', {});
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('models.py'), languageId: 'python', version: 1, text: MODELS } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('main.py'), languageId: 'python', version: 1, text: MAIN } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('pyproject.toml'), languageId: 'toml', version: 1, text: PYPROJECT } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('README.md'), languageId: 'markdown', version: 1, text: README } });

    let diags = await diagnostics('main.py', (d) => d.some((x) => /helpers/.test(x.message)));
    check(
        'an import of a file the project does not have is reported, as a warning because pyproject.toml says so',
        !!diags?.some((x) => /helpers/.test(x.message) && x.severity === 2),
        `(${await lsp.elapsed()} ms) ${JSON.stringify(diags?.map((d) => d.message))}`
    );

    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('helpers.py'), languageId: 'python', version: 1, text: HELPERS } });
    await lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('helpers.py'), type: 1 }] });
    diags = await diagnostics('main.py', (d) => d.length === 0);
    check('adding that file resolves the import, and the project has no errors', diags?.length === 0, JSON.stringify(diags?.map((d) => d.message)));

    await lsp.notify('textDocument/didChange', {
        textDocument: { uri: uri('main.py'), version: 2 },
        contentChanges: [{ text: MAIN_BROKEN }],
    });
    diags = await diagnostics('main.py', (d) => d.length > 0);
    const typeError = diags?.find((d) => d.severity === 1 && d.range.start.line === 7);
    check('assigning a str to an int is an error on that line', !!typeError, JSON.stringify(typeError?.message));

    // completion after `p.` in `print(p.norm())` (line 5, character 8)
    const completion = await lsp.request('textDocument/completion', {
        textDocument: { uri: uri('main.py') },
        position: { line: 5, character: 8 },
    });
    const items = (completion.result?.items ?? completion.result ?? []).map((i) => i.label);
    check('completion after `p.` offers the members of Point from models.py', ['norm', 'x', 'y'].every((l) => items.includes(l)), JSON.stringify(items.slice(0, 12)));

    const hover = await lsp.request('textDocument/hover', { textDocument: { uri: uri('main.py') }, position: { line: 5, character: 10 } });
    const hoverText = hover.result?.contents?.value ?? JSON.stringify(hover.result);
    check('hover on `norm` shows its signature and docstring', /norm/.test(hoverText) && /float/.test(hoverText) && /Distance from the origin/.test(hoverText), JSON.stringify(hoverText));

    const stdHover = await lsp.request('textDocument/hover', { textDocument: { uri: uri('main.py') }, position: { line: 6, character: 10 } });
    const stdText = stdHover.result?.contents?.value ?? JSON.stringify(stdHover.result);
    check('hover on `math.sqrt` shows the stdlib stub and its documentation', /sqrt/.test(stdText) && /square root/i.test(stdText), JSON.stringify(stdText));

    const definition = await lsp.request('textDocument/definition', { textDocument: { uri: uri('main.py') }, position: { line: 4, character: 5 } });
    const target = [definition.result].flat()[0];
    const targetUri = target?.uri ?? target?.targetUri;
    const targetLine = (target?.range ?? target?.targetSelectionRange)?.start.line;
    check('go to definition of `Point` lands in models.py on its class line', targetUri === uri('models.py') && targetLine === 0, JSON.stringify(definition.result));

    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri('helpers.py') } });
    await lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('helpers.py'), type: 3 }] });
    diags = await diagnostics('main.py', (d) => d.some((x) => /helpers/.test(x.message)));
    check('deleting that file makes its import unresolved again', !!diags?.some((x) => /helpers/.test(x.message)), JSON.stringify(diags?.map((d) => d.message)));

    const readmeDiagnostics = (await lsp.log()).filter(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('README.md') && m.params.diagnostics.length
    );
    check('a non-Python project file is not analysed as Python', readmeDiagnostics.length === 0);

    // A pytest test in tests/: `import pytest` resolves to the stubs shipped
    // with the stdlib ones, `from models import ...` to the project root.
    const TEST = [
        'import pytest',
        '',
        'from models import Point',
        '',
        '',
        '@pytest.mark.parametrize(("x", "y"), [(3, 4), (5, 12)])',
        'def test_norm(x: float, y: float) -> None:',
        '    assert Point(x, y).norm() == pytest.approx((x * x + y * y) ** 0.5)',
        '',
        '',
        'def test_raises() -> None:',
        '    with pytest.raises(ZeroDivisionError) as info:',
        '        _ = 1 / 0',
        '    assert info.type is ZeroDivisionError',
        '',
    ].join('\n');
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('tests/test_models.py'), languageId: 'python', version: 1, text: TEST } });
    diags = await diagnostics('tests/test_models.py', () => true);
    check('a pytest test file in tests/ has no diagnostics at all: pytest and the project module both resolve', diags?.length === 0, JSON.stringify(diags?.map((d) => d.message)));
    const approx = await lsp.request('textDocument/hover', { textDocument: { uri: uri('tests/test_models.py') }, position: { line: 7, character: 42 } });
    const approxText = approx.result?.contents?.value ?? JSON.stringify(approx.result);
    check('hover on `pytest.approx` shows its signature and pytest\'s docstring', /def approx\(/.test(approxText) && /within some tolerance/.test(approxText), JSON.stringify(approxText.slice(0, 160)));
    const raisesInfo = await lsp.request('textDocument/hover', { textDocument: { uri: uri('tests/test_models.py') }, position: { line: 13, character: 12 } });
    check('`with pytest.raises(E) as info` types `info` as ExceptionInfo[E]', /ExceptionInfo\[ZeroDivisionError\]/.test(raisesInfo.result?.contents?.value ?? ''), JSON.stringify(raisesInfo.result?.contents?.value));

    const shutdown = await lsp.request('shutdown', null);
    check('shutdown answers', shutdown.error === undefined);
    const errors = (await lsp.log()).filter((m) => m.method === 'worker/error' || (m.method === 'window/logMessage' && m.params.type === 1));
    check('the worker reported no errors', errors.length === 0, JSON.stringify(errors));
    for (const m of await lsp.log()) {
        if (m.method === 'window/logMessage') console.log(`  [server log] ${m.params.message.split('\n')[0]}`);
    }
} finally {
    await browser.close();
    server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
