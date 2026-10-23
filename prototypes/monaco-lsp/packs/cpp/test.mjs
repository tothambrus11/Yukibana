// Headless test of the C/C++ pack, run the way the app runs it: app/static
// served over http, `new Worker('/packs/cpp/server.js', { type: 'module' })`
// in Chromium, one JSON-RPC object per postMessage. Two sessions, each its
// own worker:
//
// 1. A project of three C++ files and a C file that include each other and
//    the standard library, served raw (no Content-Encoding): the standard
//    headers resolve, a diagnostic for an introduced error, completion at a
//    member access, hover, definition across files, an unsaved header edit
//    seen by its includer, references, rename, signature help, document
//    symbols, formatting, semantic tokens.
// 2. The app's own sample project (app/src/lib/languages.ts, copied here),
//    opened in the app's order with its compile_flags.txt last, served with
//    Content-Encoding (the .br or .gz sibling, as the app's host does): the
//    flags apply from the first parse (C++20, -Wall), compile_flags.txt
//    gets no diagnostics, an edit to it reparses the project, code actions
//    with edits, document highlight, a new and a deleted header with
//    didChangeWatchedFiles, and a ranged edit after a UTF-16 surrogate pair.
//
//   node test.mjs            (after ./build.sh; needs playwright-core)
//
// The page is cross-origin isolated (COOP/COEP), as the app is: clangd's
// threads share memory through a SharedArrayBuffer.

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
            res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION }).end('<!doctype html><link rel=icon href="data:,"><title>cpp pack test</title>');
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

const POINT_H = `#pragma once
#include <vector>

/// A point in the plane.
struct Point {
    double x, y;
    /// Distance from the origin.
    double norm() const;
};

std::vector<Point> square(double side);
`;
const POINT_CPP = `#include "point.h"
#include <cmath>

double Point::norm() const { return std::sqrt(x * x + y * y); }

std::vector<Point> square(double side) {
    return {{0, 0}, {side, 0}, {side, side}, {0, side}};
}
`;
const MAIN_CPP = `#include <cstdio>
#include <string>
#include "point.h"

int main() {
    Point p{3, 4};
    std::string label = "norm";
    std::printf("%s %f\\n", label.c_str(), p.norm());
    return static_cast<int>(square(2).size());
}
`;
const UTIL_C = `#include <stdio.h>
#include <string.h>

int greet(const char *name) { return printf("hello %s (%zu)\\n", name, strlen(name)); }
`;
const BROKEN = MAIN_CPP.replace('    return static_cast', '    int bad = p.nosuch;\n    return static_cast');
const COMPLETE = MAIN_CPP.replace('    return static_cast', '    p.\n    return static_cast');

/** The LSP position of the `at`-th character of `needle` in `text`. */
function position(text, needle, at = 0) {
    const offset = text.indexOf(needle);
    if (offset < 0) throw new Error(`no ${needle}`);
    const before = text.slice(0, offset + at);
    const line = before.split('\n').length - 1;
    return { line, character: before.length - before.lastIndexOf('\n') - 1 };
}

await stat(join(STATIC, 'packs/cpp/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/cpp/server.js')}: run ./build.sh first`);
    process.exit(2);
});
// The app's C++ sample (app/src/lib/languages.ts), in the order the app opens
// it: compile_flags.txt comes last.
const SAMPLE = {
    'main.cpp': `#include <cstdio>
#include <vector>

#include "geometry.h"

int main() {
    std::vector<Point> points{{0, 0}, {3, 4}};
    std::printf("%f\\n", distance(points[0], points[1]));
    std::printf("%f\\n", points[1].norm());
    return 0;
}
`,
    'geometry.h': `#pragma once

/// A point in the plane.
struct Point {
    double x;
    double y;

    /// Distance from the origin.
    double norm() const;
};

/// Euclidean distance between two points.
double distance(const Point &a, const Point &b);
`,
    'geometry.cpp': `#include "geometry.h"

#include <cmath>

double Point::norm() const { return std::hypot(x, y); }

double distance(const Point &a, const Point &b) {
    return std::hypot(a.x - b.x, a.y - b.y);
}
`,
    'compile_flags.txt': `-std=c++20
-Wall
-Wextra
`,
};
// C++20 only (a requires-clause and <concepts>), plus an unused variable
// that only -Wall reports.
const SAMPLE_CXX20 = SAMPLE['main.cpp']
    .replace('#include <vector>\n', '#include <concepts>\n#include <vector>\n\ntemplate <typename T>\n    requires std::integral<T>\nT twice(T v) { return v + v; }\n')
    .replace('    return 0;', '    int unused = twice(21);\n    return 0;');

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
        const worker = new Worker('/packs/cpp/server.js', { type: 'module' });
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

try {
{
    // ---- 1. a C and C++ project, files served raw
    console.log('-- session 1: four files, served raw');
    const { page, lsp, init } = await session(plain.origin);
    const diagnostics = lsp.diagnostics;
    const loads = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    const caps = init.result?.capabilities ?? {};
    check(
        'initialize answers with clangd capabilities',
        !!caps.completionProvider && !!caps.hoverProvider && !!caps.definitionProvider,
        `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version ?? ''} after ${await lsp.elapsed()} ms` +
            (init.error ? ` error: ${init.error.message}` : '')
    );
    check(
        'yukibana/loading reports clangd.wasm and sysroot.tar.gz',
        ['clangd.wasm', 'sysroot.tar.gz'].every((l) =>
            loads.some((m) => m.params.label === l && m.params.loaded === m.params.total && m.params.total > 0)
        ),
        `${loads.length} progress notifications`
    );
    lsp.notify('initialized', {});
    const files = { 'point.h': POINT_H, 'point.cpp': POINT_CPP, 'main.cpp': MAIN_CPP, 'util.c': UTIL_C };
    for (const [name, text] of Object.entries(files))
        lsp.notify('textDocument/didOpen', {
            textDocument: { uri: uri(name), languageId: name.endsWith('.c') ? 'c' : 'cpp', version: 1, text },
        });

    for (const name of ['main.cpp', 'point.cpp', 'util.c']) {
        const t = Date.now();
        const diags = await diagnostics(name, () => true);
        check(`${name} is clean (standard headers and point.h resolve)`, diags && diags.length === 0, `${show(diags)} ${Date.now() - t} ms`);
    }

    let since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 2 }, contentChanges: [{ text: BROKEN }] });
    const broken = await diagnostics('main.cpp', (d) => errors(d).length > 0, since);
    check('an introduced error is a diagnostic', errors(broken).some((d) => /no member named 'nosuch'/i.test(d.message)), show(broken));

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 3 }, contentChanges: [{ text: COMPLETE }] });
    let t = Date.now();
    const completion = await lsp.request('textDocument/completion', {
        textDocument: { uri: uri('main.cpp') },
        position: position(COMPLETE, '    p.\n', 6),
        context: { triggerKind: 2, triggerCharacter: '.' },
    });
    const items = completion.result?.items ?? completion.result ?? [];
    const labels = items.map((i) => (i.filterText ?? i.label).trim());
    check('completion after "p." lists Point\'s members', ['norm', 'x', 'y'].every((m) => labels.includes(m)), `${JSON.stringify(labels.slice(0, 8))} ${Date.now() - t} ms`);

    // Completing an identifier twice in a file: the second completion starts
    // a speculative index query from the first one's, which upstream runs on
    // a new thread; without threads that was abort() (patched to run it
    // deferred on the one thread).
    let version = 4;
    for (const typed of ['sq', 'squ']) {
        const text = MAIN_CPP.replace('    return ', `    ${typed}\n    return `);
        lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: version++ }, contentChanges: [{ text }] });
        const again = await lsp.request('textDocument/completion', {
            textDocument: { uri: uri('main.cpp') },
            position: position(text, `    ${typed}\n`, 4 + typed.length),
            context: { triggerKind: 1 },
        });
        const names = (again.result?.items ?? again.result ?? []).map((i) => (i.filterText ?? i.label).trim());
        check(`completing "${typed}" offers square`, !again.error && names.includes('square'), again.error ? again.error.message.slice(0, 200) : JSON.stringify(names.slice(0, 5)));
    }

    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: version++ }, contentChanges: [{ text: MAIN_CPP }] });
    t = Date.now();
    const hover = await lsp.request('textDocument/hover', {
        textDocument: { uri: uri('main.cpp') },
        position: position(MAIN_CPP, 'p.norm()', 3),
    });
    const hoverText = JSON.stringify(hover.result?.contents ?? '');
    check('hover on p.norm() shows its signature and doc comment', /double norm\(\) const/.test(hoverText) && /Distance from the origin/.test(hoverText), `${hoverText.slice(0, 160)} ${Date.now() - t} ms`);

    const definition = await lsp.request('textDocument/definition', {
        textDocument: { uri: uri('main.cpp') },
        position: position(MAIN_CPP, 'square(2)', 1),
    });
    const targets = [definition.result ?? []].flat().map((l) => `${l.uri ?? l.targetUri}:${(l.range ?? l.targetSelectionRange).start.line + 1}`);
    check('go to definition of square() lands in point.cpp', targets.some((s) => s === `${uri('point.cpp')}:6`), JSON.stringify(targets));

    const declaration = await lsp.request('textDocument/definition', {
        textDocument: { uri: uri('main.cpp') },
        position: position(MAIN_CPP, 'Point p{', 1),
    });
    const declTargets = [declaration.result ?? []].flat().map((l) => `${l.uri ?? l.targetUri}:${(l.range ?? l.targetSelectionRange).start.line + 1}`);
    check('go to definition of Point lands in point.h', declTargets.some((s) => s === `${uri('point.h')}:5`), JSON.stringify(declTargets));

    // An unsaved header edit: main.cpp uses a member only the new point.h has.
    since = (await lsp.log()).length;
    const main2 = MAIN_CPP.replace('p.norm()', 'p.norm() + p.z');
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('point.h'), version: 2 }, contentChanges: [{ range: { start: position(POINT_H, 'x, y;', 4), end: position(POINT_H, 'x, y;', 4) }, text: ', z' }] });
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: version++ }, contentChanges: [{ text: main2 }] });
    const after = await diagnostics('main.cpp', (d) => d.length === 0, since, 20000);
    check('an incremental edit to point.h reaches main.cpp', after && after.length === 0, show(after));

    // The rest of what the app's client uses, on main2 (after the edit).
    const refs = await lsp.request('textDocument/references', {
        textDocument: { uri: uri('main.cpp') },
        position: position(main2, 'square(2)', 1),
        context: { includeDeclaration: true },
    });
    const refFiles = [...new Set((refs.result ?? []).map((l) => l.uri.split('/').pop()))].sort();
    check('references to square() span the files', ['main.cpp', 'point.cpp', 'point.h'].every((f) => refFiles.includes(f)), JSON.stringify(refFiles));
    const rename = await lsp.request('textDocument/rename', {
        textDocument: { uri: uri('main.cpp') },
        position: position(main2, 'Point p{', 1),
        newName: 'Vec2',
    });
    const renamed = Object.keys(rename.result?.changes ?? {}).concat((rename.result?.documentChanges ?? []).map((c) => c.textDocument.uri));
    check('rename of Point edits every file that uses it', ['main.cpp', 'point.cpp', 'point.h'].every((f) => renamed.includes(uri(f))), JSON.stringify(renamed.map((u) => u.split('/').pop())));
    const signature = await lsp.request('textDocument/signatureHelp', {
        textDocument: { uri: uri('main.cpp') },
        position: position(main2, 'square(2)', 7),
    });
    check('signature help inside square(...)', /square\(double side\)/.test(signature.result?.signatures?.[0]?.label ?? ''), signature.result?.signatures?.[0]?.label ?? '');
    const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri('point.h') } });
    check('document symbols of point.h', ['Point', 'square'].every((n) => (symbols.result ?? []).some((s) => s.name === n)), JSON.stringify((symbols.result ?? []).map((s) => s.name)));
    const formatting = await lsp.request('textDocument/formatting', { textDocument: { uri: uri('util.c') }, options: { tabSize: 4, insertSpaces: true } });
    check('formatting (clang-format) returns edits', Array.isArray(formatting.result) && formatting.result.length > 0, `${formatting.result?.length} edits`);
    const tokens = await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri: uri('main.cpp') } });
    check('semantic tokens', (tokens.result?.data?.length ?? 0) > 0, `${tokens.result?.data?.length ?? 0} ints`);

    await lsp.finish('session 1');
}
{
    // ---- 2. the app's sample, as the app opens it, served compressed
    console.log('-- session 2: the app\'s sample project, served with Content-Encoding');
    const { lsp, init } = await session(encoded.origin);
    const diagnostics = lsp.diagnostics;
    const loads = (await lsp.log()).filter((m) => m.method === 'yukibana/loading');
    check(
        'initialize answers when the host sends .br/.gz with Content-Encoding',
        !!init.result?.capabilities?.hoverProvider,
        `encodings: ${JSON.stringify(Object.fromEntries(encodings))}` + (init.error ? ` error: ${init.error.message}` : '')
    );
    const wasmDone = loads.filter((m) => m.params.label === 'clangd.wasm').at(-1)?.params;
    check(
        'progress counts decoded bytes and ends at its total',
        !!wasmDone && wasmDone.total > 0 && wasmDone.loaded === wasmDone.total,
        JSON.stringify(wasmDone)
    );
    const languageOf = (name) => (name.endsWith('.txt') ? 'plaintext' : 'cpp');
    const open = (name, text) => ['textDocument/didOpen', { textDocument: { uri: uri(name), languageId: languageOf(name), version: 1, text } }];
    // initialized and every didOpen in one task, compile_flags.txt last, with
    // main.cpp already using C++20 and with a -Wall warning.
    const sample = { ...SAMPLE, 'main.cpp': SAMPLE_CXX20 };
    let t = Date.now();
    await lsp.notifyAll([['initialized', {}], ...Object.entries(sample).map(([name, text]) => open(name, text))]);
    const asConfigured = (d) => errors(d).length === 0 && d.some((x) => /unused variable 'unused'/i.test(x.message));
    const first = await diagnostics('main.cpp', asConfigured);
    const publishes = (await lsp.log()).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('main.cpp')).length;
    check(
        'compile_flags.txt opened last applies to main.cpp (C++20, -Wall)',
        first && asConfigured(first),
        `${show(first)} ${Date.now() - t} ms, ${publishes === 1 ? 'on the first parse' : `after ${publishes} publishes`}`
    );
    const cleanGeometry = await diagnostics('geometry.cpp', () => true);
    check('geometry.cpp is clean', cleanGeometry?.length === 0, show(cleanGeometry));
    // geometry.h is C++ under flags with -std=c++20 (the driver alone takes a .h for C).
    const cleanHeader = await diagnostics('geometry.h', () => true);
    check('geometry.h is parsed as C++ and is clean', cleanHeader?.length === 0, show(cleanHeader));

    // Edit compile_flags.txt after clangd has parsed: back to C++17, so the
    // requires-clause is an error now.
    let since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('compile_flags.txt'), version: 2 }, contentChanges: [{ text: '-std=c++17\n-Wall\n' }] });
    t = Date.now();
    const cxx17 = await diagnostics('main.cpp', (d) => errors(d).length > 0, since, 30000);
    check('an edit to compile_flags.txt reparses the open files', errors(cxx17).length > 0, `${show(cxx17).slice(0, 160)} ${Date.now() - t} ms`);
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('compile_flags.txt'), version: 3 }, contentChanges: [{ text: SAMPLE['compile_flags.txt'] }] });
    const back = await diagnostics('main.cpp', (d) => errors(d).length === 0, since, 30000);
    check('and the change back to C++20 too', back && errors(back).length === 0, show(back));
    const flagsDiags = (await lsp.log()).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('compile_flags.txt'));
    const invocationErrors = (await lsp.log()).filter((m) => m.method === 'window/logMessage' && /CompilerInvocation/.test(m.params.message));
    check('compile_flags.txt is not compiled as a source file', flagsDiags.length === 0 && invocationErrors.length === 0, JSON.stringify(flagsDiags.concat(invocationErrors)));

    // A quick fix with an edit: a missing semicolon.
    const missingSemi = SAMPLE_CXX20.replace('int unused = twice(21);', 'int unused = twice(21)');
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 2 }, contentChanges: [{ text: missingSemi }] });
    const semi = await diagnostics('main.cpp', (d) => errors(d).length > 0, since);
    const actions = await lsp.request('textDocument/codeAction', {
        textDocument: { uri: uri('main.cpp') },
        range: errors(semi)[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: errors(semi), only: ['quickfix'] },
    });
    const fixes = (actions.result ?? []).filter((a) => a.edit);
    check('a code action fixes the missing semicolon with an edit', fixes.some((a) => JSON.stringify(a.edit).includes('";"')), JSON.stringify(fixes.map((a) => a.title)));

    // Document highlight: every use of `points` in main.cpp.
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 3 }, contentChanges: [{ text: SAMPLE_CXX20 }] });
    const highlight = await lsp.request('textDocument/documentHighlight', {
        textDocument: { uri: uri('main.cpp') },
        position: position(SAMPLE_CXX20, 'points{', 1),
    });
    check('document highlight marks every use of points', (highlight.result ?? []).length === 4, `${(highlight.result ?? []).length} ranges`);

    // A new header, then the same header deleted.
    //
    // SETTLED: clangd answers an edit at once with the preamble (the
    // headers' PCH) it has, patched, while it builds the new one, which
    // here takes seconds. Until then a publish can be stale, even one built
    // with an older compile_flags.txt, so these checks wait for the
    // diagnostics they are about rather than for any change.
    const withExtra = SAMPLE_CXX20.replace('#include "geometry.h"', '#include "geometry.h"\n#include "extra.h"').replace('int unused = twice(21);', 'int unused = twice(kAnswer);');
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('extra.h'), languageId: 'cpp', version: 1, text: '#pragma once\ninline constexpr int kAnswer = 42;\n' } });
    lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('extra.h'), type: 1 }] });
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 4 }, contentChanges: [{ text: withExtra }] });
    const created = await diagnostics('main.cpp', (d) => errors(d).length === 0, since, 20000);
    check('a new header resolves', created && errors(created).length === 0, show(created));
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didClose', { textDocument: { uri: uri('extra.h') } });
    lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('extra.h'), type: 3 }] });
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 5 }, contentChanges: [{ text: withExtra + '\n' }] });
    const deleted = await diagnostics('main.cpp', (d) => errors(d).some((e) => /'extra.h' file not found/.test(e.message)), since, 20000);
    check('a deleted header is not found', errors(deleted).some((d) => /'extra.h' file not found/.test(d.message)), show(deleted));

    // A ranged edit after a surrogate pair: the character offset counts the
    // emoji as two UTF-16 units; counted as one, the insertion would land
    // after the semicolon and not compile. In a header, which both clangd
    // and the worker's mirror apply the edit to.
    const emojiH = SAMPLE['geometry.h'].replace('/// A point in the plane.', '/// A point 🙂 in the plane.\ninline constexpr int kEmoji = 1 /* 🙂 */;');
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('geometry.h'), version: 2 }, contentChanges: [{ text: emojiH }] });
    const usesEmoji = SAMPLE_CXX20.replace('int unused = twice(21);', 'int unused = twice(kEmoji + kSmile);');
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 6 }, contentChanges: [{ text: usesEmoji }] });
    // Wait for the diagnostics that mention kSmile: see SETTLED below.
    const missing = await diagnostics('main.cpp', (d) => errors(d).some((e) => /kSmile/.test(e.message)), since, 20000);
    // Insert ", kSmile = 2" between "1 /* 🙂 */" and ";".
    const at = position(emojiH, '1 /* 🙂 */', '1 /* 🙂 */'.length);
    since = (await lsp.log()).length;
    lsp.notify('textDocument/didChange', {
        textDocument: { uri: uri('geometry.h'), version: 3 },
        contentChanges: [{ range: { start: at, end: at }, rangeLength: 0, text: ', kSmile = 2' }],
    });
    lsp.notify('textDocument/didChange', { textDocument: { uri: uri('main.cpp'), version: 7 }, contentChanges: [{ text: usesEmoji + '\n' }] });
    const fixed = await diagnostics('main.cpp', (d) => errors(d).length === 0, since, 20000);
    check(
        'a ranged edit after a surrogate pair lands where the client meant',
        errors(missing).some((d) => /kSmile/.test(d.message)) && fixed && errors(fixed).length === 0,
        `${show(errors(missing))} then ${show(fixed)} (insert at ${at.line}:${at.character})`
    );
    await lsp.finish('session 2');
}
} finally {
    await browser.close();
    plain.server.close();
    encoded.server.close();
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
