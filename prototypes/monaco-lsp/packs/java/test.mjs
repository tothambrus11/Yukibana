// Headless test of the Java pack's language server, run the way the app
// runs it: app/static served over http, `new Worker('/packs/java/server.js',
// { type: 'module' })` in Chromium, one JSON-RPC object per postMessage. A
// two-file project in a package (Main.java uses Point and Util from
// Point.java) and a README that must be ignored. Checks diagnostics,
// completion (members, the class library, auto-import), hover with Javadoc
// and inferred types, definition and references across files, rename,
// symbols, signature help, enum constants after `case`, the import quick
// fix, type definition, deleting a file, and malformed and late requests.
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
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };

// A plain static server: raw files, no content-encoding negotiation, so the
// test sees the worst-case transfer.
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel=icon href="data:,"><title>java pack test</title>');
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


const POINT = `package demo;

/** A point in the plane. */
public record Point(double x, double y) {
    /** Distance from the origin. */
    public double norm() {
        return Math.hypot(x, y);
    }
}

class Util {
    static double twice(double v) {
        return v * 2;
    }
}
`;
const MAIN = `package demo;

import java.util.List;

public class Main {
    public static void main(String[] args) {
        var p = new Point(3, 4);
        var xs = List.of(1, 2, 3);
        System.out.println(p.norm() + Util.twice(p.x()) + xs.size());
    }
}
`;
// A new line 9, inside main.
const inMain = (line) => MAIN.replace('    }\n}\n', `${line}\n    }\n}\n`);
const MAIN_BROKEN = inMain('        int label = "five";');
const MAIN_TYPING_P = inMain('        p.');
const MAIN_TYPING_XS = inMain('        xs.');
const MAIN_TYPING_CLASS = inMain('        ArrayLi');
const README = `# Not Java (at all\n`;
// Main with more classes after it, one `|` marking the cursor: the text
// without it, and the cursor's line and character.
const withCursor = (extra) => {
    const text = MAIN + extra;
    const i = text.indexOf('|');
    const lines = text.slice(0, i).split('\n');
    return { text: text.slice(0, i) + text.slice(i + 1), line: lines.length - 1, character: lines.at(-1).length };
};
const COLOR = 'enum Color { RED, GREEN, BLUE }\n';
const CASE_CLASSIC = withCursor(COLOR + 'class Paint { int f(Color c) { switch (c) { case | } return 0; } }\n');
const CASE_ARROW = withCursor(COLOR + 'class Paint { int f(Color c) { return switch (c) { case | }; } }\n');
const CASE_LIST = withCursor(COLOR + 'class Paint { int f(Color c) { return switch (c) { case RED -> 1; case BLUE, G| }; } }\n');
const CASE_INT = withCursor(COLOR + 'class Paint { int f(int n) { switch (n) { case | } return 0; } }\n');
const MAIN_MISSING = inMain('        ArrayList<String> names = new ArrayList<>();\n        Shape s = null;\n        int k = nothing;');
const SHAPE = 'package geo;\n\npublic class Shape {\n}\n';

await stat(join(STATIC, 'packs/java/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/java/server.js')}: run ./build.sh first`);
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
        const worker = new Worker('/packs/java/server.js', { type: 'module' });
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
    check('initialize answers after the compiler and class library download, with progress notifications',
        !!init.result?.capabilities?.hoverProvider && loading.length > 0,
        `(${await lsp.elapsed()} ms, ${loading.length} progress messages, server ${init.result?.serverInfo?.name})`);
    if (init.error) console.log(init.error);

    await lsp.notify('initialized', {});
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('src/demo/Point.java'), languageId: 'java', version: 1, text: POINT } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('src/demo/Main.java'), languageId: 'java', version: 1, text: MAIN } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('README.md'), languageId: 'markdown', version: 1, text: README } });
    const M = 'src/demo/Main.java';
    const P = 'src/demo/Point.java';
    const short = (u) => u.split('/').pop();

    let t0 = Date.now();
    let diags = await diagnostics(M, () => true);
    check('the two-file project compiles with no diagnostics', diags?.length === 0, `(${Date.now() - t0} ms) ${JSON.stringify(diags?.map((d) => d.message))}`);
    const pd = await diagnostics(P, () => true);
    check('Point.java has no diagnostics either', pd?.length === 0, JSON.stringify(pd?.map((d) => d.message)));

    let mark = (await lsp.log()).length;
    t0 = Date.now();
    await change(M, MAIN_BROKEN);
    diags = await diagnostics(M, (d) => d.length > 0, mark);
    const typeError = diags?.find((d) => d.severity === 1 && d.range.start.line === 9);
    check('assigning a String to an int is an error on that line, in javac\'s words with simple type names', !!typeError && typeError.message === 'incompatible types: String cannot be converted to int' && typeError.range.start.character === 20,
        `(${Date.now() - t0} ms) ${JSON.stringify(typeError?.message)} at ${JSON.stringify(typeError?.range)}`);

    await change(M, MAIN_TYPING_P);
    const [completion, ct] = await timed(() => lsp.request('textDocument/completion', at(M, 9, 10)));
    const items = completion.result?.items ?? [];
    const labels = items.map((i) => i.label);
    check('completion after `p.` offers the record\'s members (norm, x, y) and Object\'s', ['norm', 'x', 'y', 'equals', 'hashCode'].every((l) => labels.includes(l)), `(${ct} ms, ${items.length} items) ${JSON.stringify(labels.slice(0, 12))}`);
    const key = (i) => (i.sortText ?? i.label).toLowerCase();
    const shown = [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).map((i) => i.label);
    // A record declares equals, hashCode and toString itself; Object's own (clone, wait, ...) come after.
    check('Point\'s own members are listed before those it inherits from Object', ['norm', 'x', 'y', 'equals'].every((l) => ['clone', 'wait', 'notify', 'getClass'].every((o) => shown.indexOf(o) < 0 || shown.indexOf(l) < shown.indexOf(o))), JSON.stringify(shown));
    // As the app's e2e types it at the end of the file (Monaco closes the
    // brackets): after a broken class, a new class, a member access. (A
    // field outside any class would make the file a compact source file,
    // JEP 512, where `Point` is another class: java.base's are imported.)
    const AFTER = MAIN + 'class Broken { int n = "no"; }\nclass Probe { double f(Point p) { return p.}}';
    await change(M, AFTER);
    const ce = await lsp.request('textDocument/completion', at(M, 12, 43));
    const ei = ce.result?.items ?? [];
    const x = ei.find((i) => i.label === 'x');
    check('completion after `p.` in a class typed after a broken one offers norm, and x as a double', ei.some((i) => i.label === 'norm') && /double/.test(x?.detail ?? ''), JSON.stringify(ei.map((i) => `${i.label}:${i.detail}:${i.sortText}`)));
    await change(M, MAIN_TYPING_XS);
    const c2 = await lsp.request('textDocument/completion', at(M, 9, 11));
    const l2 = (c2.result?.items ?? []).map((i) => i.label);
    check('completion after `xs.` offers List methods from the class library', ['size', 'get', 'stream', 'forEach'].every((l) => l2.includes(l)), JSON.stringify(l2.slice(0, 12)));
    await change(M, MAIN_TYPING_CLASS);
    const c3 = await lsp.request('textDocument/completion', at(M, 9, 15));
    const arrayList = (c3.result?.items ?? []).find((i) => i.label === 'ArrayList');
    check('completing `ArrayLi` offers java.util.ArrayList with an edit that imports it', !!arrayList && JSON.stringify(arrayList.additionalTextEdits ?? []).includes('import java.util.ArrayList;'),
        JSON.stringify(arrayList));


    // Enum constants after `case`: the selector's type qualifies them (JLS 14.11.1).
    const caseLabels = async (src) => {
        await change(M, src.text);
        const r = await lsp.request('textDocument/completion', at(M, src.line, src.character));
        return (r.result?.items ?? []).sort((a, b) => (key(a) < key(b) ? -1 : 1)).map((i) => i.label);
    };
    const classic = await caseLabels(CASE_CLASSIC);
    check('after `case` in a switch over an enum, its constants are offered unqualified, in declaration order, and nothing else',
        JSON.stringify(classic) === JSON.stringify(['RED', 'GREEN', 'BLUE']), JSON.stringify(classic.slice(0, 12)));
    const arrow = await caseLabels(CASE_ARROW);
    check('the same in an arrow switch expression', JSON.stringify(arrow) === JSON.stringify(['RED', 'GREEN', 'BLUE']), JSON.stringify(arrow.slice(0, 12)));
    const listed = await caseLabels(CASE_LIST);
    check('after `case BLUE, G` the constants starting with G are offered', listed.includes('GREEN') && !listed.includes('Record'), JSON.stringify(listed.slice(0, 12)));
    const ints = await caseLabels(CASE_INT);
    // (A case label is a constant, so the parameter n is no answer; the class's own f stands for the usual completion.)
    check('after `case` in a switch over an int, enum constants are not offered and the usual completion is', !ints.includes('RED') && ints.includes('f'), JSON.stringify(ints.slice(0, 12)));

    // Quick fixes for `cannot find symbol` on a class: an import, from the class library or another package of the project.
    mark = (await lsp.log()).length;
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('src/geo/Shape.java'), languageId: 'java', version: 1, text: SHAPE } });
    await change(M, MAIN_MISSING);
    diags = await diagnostics(M, (d) => d.filter((x) => /cannot find symbol/.test(x.message)).length >= 4, mark);
    const actionsFor = async (pattern) => {
        const ds = (diags ?? []).filter((d) => pattern.test(d.message));
        const r = await lsp.request('textDocument/codeAction', { textDocument: { uri: uri(M) }, range: ds[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, context: { diagnostics: ds } });
        return r.result ?? [];
    };
    const forList = await actionsFor(/symbol:\s+class ArrayList/);
    const importList = forList.find((a) => a.title === "Import 'java.util.ArrayList'");
    const listEdit = importList?.edit?.changes?.[uri(M)]?.[0];
    check('`cannot find symbol ArrayList` has a preferred quick fix that imports java.util.ArrayList after the last import',
        forList.length === 1 && importList?.kind === 'quickfix' && importList.isPreferred === true && listEdit?.newText === '\nimport java.util.ArrayList;' && listEdit.range.start.line === 2,
        JSON.stringify(forList));
    const forShape = await actionsFor(/symbol:\s+class Shape/);
    check('`cannot find symbol Shape` offers to import the project\'s geo.Shape', forShape.some((a) => a.title === "Import 'geo.Shape'"), JSON.stringify(forShape.map((a) => a.title)));
    const forVariable = await actionsFor(/symbol:\s+variable nothing/);
    check('a missing lower-case variable gets no import quick fix', forVariable.length === 0, JSON.stringify(forVariable));
    const fixed = [importList, forShape[0]].filter(Boolean).flatMap((a) => a.edit.changes[uri(M)]).map((e) => e.newText).join('');
    mark = (await lsp.log()).length;
    await change(M, MAIN_MISSING.replace('import java.util.List;', `import java.util.List;${fixed}`).replace('        int k = nothing;\n', ''));
    diags = await diagnostics(M, () => true, mark);
    check('applying both imports leaves Main.java without errors', diags?.filter((d) => d.severity === 1).length === 0, JSON.stringify(diags?.map((d) => d.message)));
    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri('src/geo/Shape.java') } });

    await change(M, MAIN);
    await diagnostics(M, (d) => d.length === 0, (await lsp.log()).length - 1);
    const typeDef = await lsp.request('textDocument/typeDefinition', at(M, 6, 13));
    const typeTarget = [typeDef.result].flat()[0];
    check('go to type definition of `var p` lands on the record Point in Point.java', typeTarget?.uri === uri(P) && typeTarget?.range.start.line === 3 && typeTarget?.range.start.character === 14, JSON.stringify(typeDef.result));
    const libraryType = await lsp.request('textDocument/typeDefinition', at(M, 7, 13));
    check('go to type definition of `var xs` (a class library List) finds nothing to open', Array.isArray(libraryType.result) && libraryType.result.length === 0, JSON.stringify(libraryType));
    const [hover, ht] = await timed(() => lsp.request('textDocument/hover', at(M, 8, 30)));
    const hoverText = hover.result?.contents?.value ?? JSON.stringify(hover.result);
    check('hover on `norm` shows its declaration and Javadoc', /double (Point\.)?norm\(\)/.test(hoverText) && /Distance from the origin/.test(hoverText), `(${ht} ms) ${JSON.stringify(hoverText)}`);
    const varHover = await lsp.request('textDocument/hover', at(M, 7, 13));
    const varText = varHover.result?.contents?.value ?? JSON.stringify(varHover.result);
    check('hover on `var xs` shows the inferred type List<Integer>', /List<Integer>/.test(varText), JSON.stringify(varText));

    const [definition, dt] = await timed(() => lsp.request('textDocument/definition', at(M, 6, 22)));
    const target = [definition.result].flat()[0];
    check('go to definition of `Point` lands in Point.java on the record\'s name', target?.uri === uri(P) && target?.range.start.line === 3 && target?.range.start.character === 14, `(${dt} ms) ${JSON.stringify(definition.result)}`);
    const def2 = await lsp.request('textDocument/definition', at(M, 8, 45));
    const target2 = [def2.result].flat()[0];
    check('go to definition of `Util.twice` lands on `twice` in Point.java', target2?.uri === uri(P) && target2?.range.start.line === 11, JSON.stringify(def2.result));

    const refs = await lsp.request('textDocument/references', { ...at(P, 5, 19), context: { includeDeclaration: true } });
    const refList = (refs.result ?? []).map((r) => `${short(r.uri)}:${r.range.start.line}`);
    check('references to `norm` are its declaration and its use in Main.java', refList.includes('Point.java:5') && refList.includes('Main.java:8') && refList.length === 2, JSON.stringify(refList));

    const renamed = await lsp.request('textDocument/rename', { ...at(M, 8, 30), newName: 'length' });
    const edits = Object.entries(renamed.result?.changes ?? {}).flatMap(([u, es]) => es.map((e) => `${short(u)}:${e.range.start.line}:${e.range.start.character}-${e.range.end.character}=${e.newText}`)).sort();
    check('renaming `norm` to `length` edits its declaration and its use, and nothing else', JSON.stringify(edits) === JSON.stringify(['Main.java:8:29-33=length', 'Point.java:5:18-22=length']), JSON.stringify(renamed.result ?? renamed.error));
    const library = await lsp.request('textDocument/prepareRename', at(M, 8, 23));
    check('renaming `println` is refused: it is not declared in the project', !!library.error, JSON.stringify(library));
    const badName = await lsp.request('textDocument/rename', { ...at(M, 8, 30), newName: 'class' });
    check('a reserved word is refused as a new name', badName.error?.code === -32602, JSON.stringify(badName.error));

    const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri(P) } });
    const names = (symbols.result ?? []).flatMap((s) => [s.name, ...(s.children ?? []).map((c) => `${s.name}.${c.name}`)]);
    check('document symbols list Point, its norm, Util and its twice', names.includes('Point') && names.includes('Util') && names.some((n) => /^Point\.norm/.test(n)) && names.some((n) => /^Util\.twice/.test(n)), JSON.stringify(names));

    const sig = await lsp.request('textDocument/signatureHelp', at(M, 8, 49));
    check('signature help inside `Util.twice(...)` shows its parameter', /twice\(double v\)/.test(sig.result?.signatures?.[0]?.label ?? ''), JSON.stringify(sig.result?.signatures?.[0]));

    const lineEnd = MAIN.split('\n')[6].length;
    const [past, eol] = [await lsp.request('textDocument/hover', at(M, 6, 500)), await lsp.request('textDocument/hover', at(M, 6, lineEnd))];
    check('a position past the end of a line answers for the end of that line', JSON.stringify(past.result) === JSON.stringify(eol.result), JSON.stringify(past.result));
    const malformed = await lsp.request('textDocument/completion', {});
    check('a completion request without a document or position is refused as InvalidParams', malformed.error?.code === -32602, JSON.stringify(malformed.error));

    // Annotations with element values, and integer division by a constant
    // zero: both once crashed the compiler (README, "What was fixed").
    mark = (await lsp.log()).length;
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('src/demo/Edge.java'), languageId: 'java', version: 1, text: 'package demo;\n\n@SuppressWarnings("unused")\nclass Edge {\n    @Deprecated(since = "1", forRemoval = true)\n    int f() { return 1 / 0; }\n}\n' } });
    diags = await diagnostics('src/demo/Edge.java', () => true, mark);
    check('annotations with values and `1 / 0` compile without diagnostics', diags?.length === 0, JSON.stringify(diags?.map((d) => d.message)));

    mark = (await lsp.log()).length;
    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri(P) } });
    diags = await diagnostics(M, (d) => d.length > 0, mark);
    check('deleting Point.java makes Point and Util unresolved in Main.java', !!diags?.some((x) => /cannot find symbol/.test(x.message)), JSON.stringify(diags?.map((d) => d.message)));

    const readme = (await lsp.log()).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('README.md'));
    check('a non-Java project file is not compiled', readme.length === 0);

    const shutdown = await lsp.request('shutdown', null);
    check('shutdown answers', shutdown.error === undefined);
    const late = await lsp.request('textDocument/hover', at(M, 6, 22));
    check('a request after shutdown is refused as InvalidRequest', late.error?.code === -32600, JSON.stringify(late.error));
    const errors = (await lsp.log()).filter((m) => m.method === 'worker/error' || (m.method === 'window/logMessage' && m.params.type === 1));
    check('the worker reported no errors', errors.length === 0, JSON.stringify(errors));
} finally {
    await browser.close();
    server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
