// Headless test of the Scala pack, run the way the app runs it: app/static
// served over http, `new Worker('/packs/scala/server.js', { type: 'module' })`
// in Chromium, one JSON-RPC object per postMessage. A two-file project
// (Main.scala uses Point and Util from Geometry.scala) and a README that must
// be ignored. Checks: a clean project has no errors; an introduced type error
// is reported on its line; completion after `p.` (project class) and `xs.`
// (standard library); keywords, enum cases after `case`, and project symbols
// of another package with their import; hover with signature and Scaladoc
// (a class as its declaration); go to definition across files; references
// (a case class's construction included); deleting a file makes its uses
// unresolved; what a
// macro does here (nothing, or an error for a transparent one); malformed
// requests and requests after shutdown are refused, not crashed on.
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
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><link rel=icon href="data:,"><title>scala pack test</title>');
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

const GEOMETRY = `package demo

/** A point in the plane. */
case class Point(x: Double, y: Double):
  /** Distance from the origin. */
  def norm: Double = math.sqrt(x * x + y * y)

object Util:
  def double(v: Double): Double = v * 2
`;
const MAIN = `package demo

@main def run(): Unit =
  val p = Point(3, 4)
  val xs = List(1, 2, 3).map(_ * 2)
  println(p.norm + Util.double(p.x) + xs.sum)
`;
const MAIN_BROKEN = MAIN + `  val label: Int = "five"\n`;
// Incomplete member accesses, as typed, on line 6.
const MAIN_TYPING_P = MAIN + `  p.\n`;
const MAIN_TYPING_XS = MAIN + `  xs.\n`;
const README = `# Not Scala (at all\n`;

await stat(join(STATIC, 'packs/scala/server.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/scala/server.js')}: run ./build.sh first`);
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
        const worker = new Worker('/packs/scala/server.js', { type: 'module' });
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
    check(
        'initialize answers after the compiler and class path download, with progress notifications',
        !!init.result?.capabilities?.hoverProvider && loading.length > 0,
        `(${await lsp.elapsed()} ms, ${loading.length} progress messages, last ${JSON.stringify(loading.at(-1)?.params)}, server ${init.result?.serverInfo?.name})`
    );
    if (init.error) console.log(init.error);

    await lsp.notify('initialized', {});
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Geometry.scala'), languageId: 'scala', version: 1, text: GEOMETRY } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Main.scala'), languageId: 'scala', version: 1, text: MAIN } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('README.md'), languageId: 'markdown', version: 1, text: README } });

    let t0 = Date.now();
    let diags = await diagnostics('Main.scala', () => true);
    check('the two-file project type-checks with no diagnostics', diags?.length === 0, `(${Date.now() - t0} ms) ${JSON.stringify(diags?.map((d) => d.message))}`);
    const geo = await diagnostics('Geometry.scala', () => true);
    check('Geometry.scala has no diagnostics either', geo?.length === 0, JSON.stringify(geo?.map((d) => d.message)));

    let mark = (await lsp.log()).length;
    t0 = Date.now();
    await change('Main.scala', MAIN_BROKEN);
    diags = await diagnostics('Main.scala', (d) => d.length > 0, mark);
    const typeError = diags?.find((d) => d.severity === 1 && d.range.start.line === 6);
    check('assigning a String to an Int is a type error on that line', !!typeError && /Required: Int/.test(typeError.message), `(${Date.now() - t0} ms) ${JSON.stringify(typeError?.message)} at ${JSON.stringify(typeError?.range)}`);

    await change('Main.scala', MAIN_TYPING_P);
    const [completion, ct] = await timed(() => lsp.request('textDocument/completion', at('Main.scala', 6, 4)));
    const items = (completion.result?.items ?? []).map((i) => i.label);
    check('completion after `p.` offers the members of Point from Geometry.scala', ['norm', 'x', 'y', 'copy'].every((l) => items.includes(l)), `(${ct} ms, ${items.length} items) ${JSON.stringify(items.slice(0, 15))}`);
    // The order the editor shows: Monaco, with nothing typed after the dot,
    // compares lower-cased sortText (falling back to the label) as plain
    // strings. Point's own members come first; Any/Product members, then
    // symbolic and plumbing ones (==, ##, ->, _1, asInstanceOf, ...).
    const key = (i) => (i.sortText ?? i.label).toLowerCase();
    const shown = [...(completion.result?.items ?? [])]
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        .map((i) => i.label);
    const rankOf = (l) => shown.indexOf(l);
    check('completion after `p.` lists norm among the first three items, Point\'s members before Any/Product ones and symbolic ones last',
        rankOf('norm') >= 0 && rankOf('norm') < 3 && ['x', 'y', 'copy'].every((l) => rankOf(l) < rankOf('toString') && rankOf(l) < rankOf('canEqual')) &&
        ['==', '##', '->', '_1', 'asInstanceOf', 'isInstanceOf'].every((l) => rankOf(l) > rankOf('productArity')),
        JSON.stringify(shown.slice(0, 12)));
    await change('Main.scala', MAIN_TYPING_XS);
    const [completion2, ct2] = await timed(() => lsp.request('textDocument/completion', at('Main.scala', 6, 5)));
    const items2 = (completion2.result?.items ?? []);
    const map = items2.find((i) => i.label === 'map');
    check('completion after `xs.` offers List methods from the standard library', !!map && items2.some((i) => i.label === 'sum') && items2.some((i) => i.label === 'foldLeft'), `(${ct2} ms, ${items2.length} items) map: ${JSON.stringify(map)}`);

    await change('Main.scala', MAIN);
    const [hover, ht] = await timed(() => lsp.request('textDocument/hover', at('Main.scala', 5, 13)));
    const hoverText = hover.result?.contents?.value ?? JSON.stringify(hover.result);
    check('hover on `norm` shows its declaration and Scaladoc', /def norm: Double/.test(hoverText) && /Distance from the origin/.test(hoverText), `(${ht} ms) ${JSON.stringify(hoverText)}`);
    const stdHover = await lsp.request('textDocument/hover', at('Main.scala', 4, 26));
    const stdText = stdHover.result?.contents?.value ?? JSON.stringify(stdHover.result);
    check('hover on `map` (standard library) shows its signature', /def map\[B\]/.test(stdText), JSON.stringify(stdText));

    // Scala.js cannot tell an Int from a Byte at run time; the compiler was
    // patched so literals keep their type (see README). Inference must say Int.
    const valHover = await lsp.request('textDocument/hover', at('Main.scala', 4, 7));
    const valText = valHover.result?.contents?.value ?? JSON.stringify(valHover.result);
    check('hover on `xs` shows the inferred type List[Int]', /val xs: List\[Int\]/.test(valText), JSON.stringify(valText));

    const [definition, dt] = await timed(() => lsp.request('textDocument/definition', at('Main.scala', 3, 11)));
    const target = [definition.result].flat()[0];
    check('go to definition of `Point` lands in Geometry.scala on its class name', target?.uri === uri('Geometry.scala') && target?.range.start.line === 3 && target?.range.start.character === 11, `(${dt} ms) ${JSON.stringify(definition.result)}`);
    const def2 = await lsp.request('textDocument/definition', at('Main.scala', 5, 24));
    const target2 = [def2.result].flat()[0];
    check('go to definition of `Util.double` lands on `def double` in Geometry.scala', target2?.uri === uri('Geometry.scala') && target2?.range.start.line === 8, JSON.stringify(def2.result));

    const refs = await lsp.request('textDocument/references', { ...at('Geometry.scala', 5, 6), context: { includeDeclaration: true } });
    const refUris = (refs.result ?? []).map((r) => `${r.uri.split('/').pop()}:${r.range.start.line}`);
    check('references to `norm` include its declaration and its use in Main.scala', refUris.includes('Geometry.scala:5') && refUris.includes('Main.scala:5'), JSON.stringify(refUris));

    const prepared = await lsp.request('textDocument/prepareRename', at('Main.scala', 5, 13));
    check('prepareRename on `norm` in Main.scala offers its name', prepared.result?.placeholder === 'norm' && prepared.result?.range.start.character === 12, JSON.stringify(prepared));
    const renamed = await lsp.request('textDocument/rename', { ...at('Main.scala', 5, 13), newName: 'length' });
    const renameEdits = Object.entries(renamed.result?.changes ?? {}).flatMap(([u, es]) => es.map((e) => `${u.split('/').pop()}:${e.range.start.line}:${e.range.start.character}-${e.range.end.character}=${e.newText}`)).sort();
    check('renaming `norm` to `length` edits its declaration and its use, and nothing else',
        JSON.stringify(renameEdits) === JSON.stringify(['Geometry.scala:5:6-10=length', 'Main.scala:5:12-16=length']), JSON.stringify(renameEdits));
    const fromUse = await lsp.request('textDocument/rename', { ...at('Main.scala', 3, 11), newName: 'Vec' });
    const useEdits = Object.entries(fromUse.result?.changes ?? {}).flatMap(([u, es]) => es.map((e) => `${u.split('/').pop()}:${e.range.start.line}:${e.range.start.character}`)).sort();
    check('renaming Point from its construction `Point(3, 4)` renames the class too', JSON.stringify(useEdits) === JSON.stringify(['Geometry.scala:3:11', 'Main.scala:3:10']), JSON.stringify(fromUse.result ?? fromUse.error));
    const renamedPoint = await lsp.request('textDocument/rename', { ...at('Geometry.scala', 3, 12), newName: 'Vec' });
    const pointEdits = Object.entries(renamedPoint.result?.changes ?? {}).flatMap(([u, es]) => es.map((e) => `${u.split('/').pop()}:${e.range.start.line}:${e.range.start.character}`)).sort();
    check('renaming the case class Point also renames its construction in Main.scala', pointEdits.includes('Geometry.scala:3:11') && pointEdits.includes('Main.scala:3:10'), JSON.stringify(renamedPoint.result ?? renamedPoint.error));
    const library = await lsp.request('textDocument/prepareRename', at('Main.scala', 5, 4));
    check('renaming `println` is refused: it is declared in the standard library', /outside the project/.test(library.error?.message ?? ''), JSON.stringify(library));
    const badName = await lsp.request('textDocument/rename', { ...at('Main.scala', 5, 13), newName: 'val' });
    check('a reserved word is refused as a new name', badName.error?.code === -32602, JSON.stringify(badName.error));

    const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: uri('Geometry.scala') } });
    const names = (symbols.result ?? []).flatMap((s) => [s.name, ...(s.children ?? []).map((c) => `${s.name}.${c.name}`)]);
    check('document symbols list Point, Point.norm, Util and Util.double', ['Point', 'Point.norm', 'Util', 'Util.double'].every((n) => names.includes(n)), JSON.stringify(names));

    const sig = await lsp.request('textDocument/signatureHelp', at('Main.scala', 5, 31));
    check('signature help inside `Util.double(...)` shows its parameter', /double\(v: Double\): Double/.test(sig.result?.signatures?.[0]?.label ?? ''), JSON.stringify(sig.result?.signatures?.[0]));

    // Hover on a class is written as its declaration, not the compiler's
    // tree dump (`case case class Point extends Object with Product ... at
    // (demo : demo.type)`, which is what it once showed).
    const classHover = await lsp.request('textDocument/hover', at('Main.scala', 3, 11));
    const classText = classHover.result?.contents?.value ?? JSON.stringify(classHover.result);
    check('hover on `Point` shows `case class Point(x: Double, y: Double)` and its Scaladoc, not a tree dump',
        classText.includes('case class Point(x: Double, y: Double)\n') && /A point in the plane/.test(classText) && !/case case| at\b|extends Object/.test(classText),
        JSON.stringify(classText));
    const objectHover = await lsp.request('textDocument/hover', at('Main.scala', 5, 20));
    check('hover on `Util` shows `object Util`', /```scala\nobject Util\n```/.test(objectHover.result?.contents?.value ?? ''), JSON.stringify(objectHover.result?.contents?.value));

    // A case class's construction in another file goes through its
    // companion's synthetic `apply`; references to the class once missed it.
    for (const [from, pos] of [['Geometry.scala', at('Geometry.scala', 3, 12)], ['Main.scala', at('Main.scala', 3, 11)]]) {
        const pointRefs = await lsp.request('textDocument/references', { ...pos, context: { includeDeclaration: true } });
        const where = (pointRefs.result ?? []).map((r) => `${r.uri.split('/').pop()}:${r.range.start.line}:${r.range.start.character}`).sort();
        check(`references to the case class Point (asked from ${from}) include \`Point(3, 4)\` in Main.scala`,
            JSON.stringify(where) === JSON.stringify(['Geometry.scala:3:11', 'Main.scala:3:10']), JSON.stringify(where));
    }
    const noDecl = await lsp.request('textDocument/references', { ...at('Main.scala', 3, 11), context: { includeDeclaration: false } });
    check('without includeDeclaration, references to Point leave out its declaration', (noDecl.result ?? []).length === 1 && noDecl.result[0].uri === uri('Main.scala'), JSON.stringify(noDecl.result));

    // Keywords: the compiler never offers them. They are filtered by what is
    // typed, ranked after symbols, and never offered after a `.`.
    await change('Main.scala', MAIN + '  def probe3 = whil\n  { val n = 1; i }\n  xs.fi\n');
    const kwWhile = (await lsp.request('textDocument/completion', at('Main.scala', 6, 19))).result?.items ?? [];
    const kwIf = (await lsp.request('textDocument/completion', at('Main.scala', 7, 16))).result?.items ?? [];
    const kwDot = (await lsp.request('textDocument/completion', at('Main.scala', 8, 7))).result?.items ?? [];
    const ifItem = kwIf.find((i) => i.label === 'if');
    check('keyword completion: `whil` offers `while`, `{ val n = 1; i` offers `if` after the symbols, `xs.fi` offers no keyword',
        kwWhile.some((i) => i.label === 'while' && i.kind === 14) && !kwWhile.some((i) => i.label === 'match') &&
        !!ifItem && kwIf.filter((i) => i.kind !== 14).every((i) => key(i) < key(ifItem)) &&
        kwDot.some((i) => i.label === 'filter') && !kwDot.some((i) => i.kind === 14),
        JSON.stringify({ whil: kwWhile.map((i) => i.label), i: kwIf.map((i) => i.label).slice(-6), 'xs.fi': kwDot.filter((i) => i.kind === 14).map((i) => i.label) }));

    // After `case` in a match, the scrutinee's enum cases, qualified.
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Colors.scala'), languageId: 'scala', version: 1, text: 'package demo\n\nenum Color:\n  case Red, Green, Blue\n' } });
    await change('Main.scala', MAIN + '  val c: Color = Color.Green\n  c match\n    case Re\n');
    const cases = (await lsp.request('textDocument/completion', at('Main.scala', 8, 11))).result?.items ?? [];
    const red = cases.find((i) => i.label === 'Color.Red');
    check('after `case Re` in a match on a Color, `Color.Red` is offered (and not Color.Green)',
        red?.insertText === 'Color.Red' && red?.filterText === 'Red' && !cases.some((i) => i.label === 'Color.Green'),
        JSON.stringify(cases.slice(0, 4)));

    // Auto-import: a project definition in another package, with its import.
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('tools/Strings.scala'), languageId: 'scala', version: 1, text: 'package tools\n\nobject Shouter:\n  def shout(s: String): String = s.toUpperCase\n' } });
    await change('Main.scala', MAIN + '  val s = Shou\n');
    const imports = (await lsp.request('textDocument/completion', at('Main.scala', 6, 14))).result?.items ?? [];
    const shouter = imports.find((i) => i.label === 'Shouter');
    const importEdit = shouter?.additionalTextEdits?.[0];
    check('`Shou` offers Shouter from package tools, with `import tools.Shouter` after the package clause',
        importEdit?.newText === '\n\nimport tools.Shouter' && importEdit.range.start.line === 0 && importEdit.range.start.character === 'package demo'.length,
        JSON.stringify(shouter));
    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri('Colors.scala') } });
    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri('tools/Strings.scala') } });
    await change('Main.scala', MAIN);

    // Line 3 is `  val p = Point(3, 4)`. A character far past its end is the
    // end of that line (LSP), not a token on a later line.
    const lineEnd = MAIN.split('\n')[3].length;
    const [past, eol] = [await lsp.request('textDocument/hover', at('Main.scala', 3, 500)), await lsp.request('textDocument/hover', at('Main.scala', 3, lineEnd))];
    check('a position past the end of a line answers for the end of that line', JSON.stringify(past.result) === JSON.stringify(eol.result), JSON.stringify(past.result));

    const malformed = await lsp.request('textDocument/completion', {});
    check('a completion request without a document or position is refused as InvalidParams', malformed.error?.code === -32602, JSON.stringify(malformed.error));

    mark = (await lsp.log()).length;
    await lsp.notify('textDocument/didClose', { textDocument: { uri: uri('Geometry.scala') } });
    await lsp.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('Geometry.scala'), type: 3 }] });
    diags = await diagnostics('Main.scala', (d) => d.length > 0, mark);
    check('deleting Geometry.scala makes Point and Util unresolved in Main.scala', !!diags?.some((x) => /Not found: Point/.test(x.message)), JSON.stringify(diags?.map((d) => d.message)));

    // Macros: the splice runs in the Inlining phase, which the interactive
    // compiler never reaches, so an ordinary inline macro type-checks and is
    // simply not expanded; a transparent one expands during typing and hits
    // the patched Splicer's error.
    const MACROS = `package demo
import scala.quoted.*

object Mac:
  inline def twice(inline x: Int): Int = \${ twiceImpl('x) }
  transparent inline def twiceT(inline x: Int): Int = \${ twiceImpl('x) }
  def twiceImpl(x: Expr[Int])(using Quotes): Expr[Int] = '{ \$x * 2 }
`;
    mark = (await lsp.log()).length;
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('Macros.scala'), languageId: 'scala', version: 1, text: MACROS } });
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri('UseMacro.scala'), languageId: 'scala', version: 1, text: 'package demo\n\nval plain: Int = Mac.twice(3)\n' } });
    diags = await diagnostics('UseMacro.scala', () => true, mark);
    check('a use of an ordinary inline macro type-checks silently (it is never expanded)', diags?.length === 0, JSON.stringify(diags?.map((d) => d.message)));
    // The error carries the splice's position, so it lands on the `${ ... }`
    // in Macros.scala (line 5), not on the use.
    mark = (await lsp.log()).length;
    await change('UseMacro.scala', 'package demo\n\nval expanded: Int = Mac.twiceT(3)\n');
    diags = await diagnostics('Macros.scala', (d) => d.length > 0, mark);
    const unsupported = diags?.find((d) => /not supported by the in-browser Scala compiler/.test(d.message));
    check('a use of a transparent inline macro reports, at its splice, that macros are not supported', unsupported?.range.start.line === 5, JSON.stringify(unsupported));

    const readme = (await lsp.log()).filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri('README.md'));
    check('a non-Scala project file is not compiled', readme.length === 0);

    const shutdown = await lsp.request('shutdown', null);
    check('shutdown answers', shutdown.error === undefined);
    const late = await lsp.request('textDocument/hover', at('Main.scala', 3, 11));
    check('a request after shutdown is refused as InvalidRequest', late.error?.code === -32600, JSON.stringify(late.error));
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
