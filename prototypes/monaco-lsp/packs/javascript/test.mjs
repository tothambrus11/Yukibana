// Headless test of the JavaScript pack, driven the way the app drives it:
// app/static is served over http (brotli siblings served when present, like
// the app's host), a page in Chromium starts
// `new Worker('/packs/javascript/server.js', { type: 'module' })`, and speaks
// LSP to it as plain-object postMessages.
//
// usage: node test.mjs   (after ./build.sh)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(here, '../../app/static');
const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.wasm': 'application/wasm' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/__test.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>pack test</title>');
    return;
  }
  const file = path.join(staticDir, path.normalize(url.pathname));
  if (!file.startsWith(staticDir) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const headers = { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' };
  let body = file;
  if (/\bbr\b/.test(String(req.headers['accept-encoding'])) && fs.existsSync(`${file}.br`)) {
    body = `${file}.br`;
    headers['content-encoding'] = 'br';
  }
  headers['content-length'] = fs.statSync(body).size;
  res.writeHead(200, headers);
  fs.createReadStream(body).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(`${origin}/__test.html`);

// A minimal client in the page: request/notify, every notification recorded.
await page.evaluate(() => {
  const worker = new Worker('/packs/javascript/server.js', { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  const log = [];
  worker.onerror = (e) => log.push({ method: 'worker/error', params: { message: e.message } });
  worker.onmessage = ({ data }) => {
    if ('id' in data && !('method' in data)) {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p.reject(new Error(`${data.error.code}: ${data.error.message}`));
      else p.resolve(data.result);
    } else log.push(data);
  };
  window.lsp = {
    log,
    request(method, params) {
      const id = nextId++;
      worker.postMessage({ jsonrpc: '2.0', id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    lastId: () => nextId - 1,
    worker,
    notify(method, params) {
      worker.postMessage({ jsonrpc: '2.0', method, params });
    },
  };
});

const request = (method, params) => page.evaluate(([m, p]) => window.lsp.request(m, p), [method, params]);
const notify = (method, params) => page.evaluate(([m, p]) => window.lsp.notify(m, p), [method, params]);
const notifications = () => page.evaluate(() => window.lsp.log);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

/** Waits for the latest publishDiagnostics for `uri` to satisfy `ok`. */
async function diagnostics(uri, ok, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    const all = (await notifications()).filter((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri);
    last = all.at(-1)?.params.diagnostics;
    if (last && ok(last)) return last;
    await page.waitForTimeout(50);
  }
  return last;
}

const W = 'file:///workspace/';
const files = {
  'math.js': `// @ts-check
/**
 * Adds two numbers.
 * @param {number} a
 * @param {number} b
 */
export function add(a, b) {
  return a + b;
}

export class Vec {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  /** Euclidean length. */
  length() {
    return Math.hypot(this.x, this.y);
  }
}
`,
  'main.js': `// @ts-check
import { add, Vec } from './math.js';

const v = new Vec(3, 4);
const n = add(v.length(), 1);
console.log(n);
`,
  'loose.js': `const s = 'text';
console.log(Math.max('not checked'), s.toUpperCase());
`,
};
const versions = {};

const t0 = Date.now();
const init = await request('initialize', {
  processId: null,
  rootUri: W,
  workspaceFolders: [{ uri: W, name: 'workspace' }],
  capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
});
const startMs = Date.now() - t0;
check('initialize answers with capabilities', !!init?.capabilities?.completionProvider, `${init?.serverInfo?.name} ${init?.serverInfo?.version}, ${startMs} ms incl. download`);

const loading = (await notifications()).filter((n) => n.method === 'yukibana/loading').map((n) => n.params);
const finals = Object.values(Object.fromEntries(loading.map((l) => [l.label, l])));
check(
  'yukibana/loading reports every download to completion',
  finals.length === 2 && finals.every((l) => l.total > 0 && l.loaded === l.total),
  finals,
);

await notify('initialized', {});
const tOpen = Date.now();
for (const [name, text] of Object.entries(files)) {
  versions[name] = 1;
  await notify('textDocument/didOpen', { textDocument: { uri: W + name, languageId: 'javascript', version: 1, text } });
}

const clean = await diagnostics(W + 'main.js', (d) => d.every((x) => x.severity !== 1));
check('a correct checked project has no errors', clean?.every((x) => x.severity !== 1), `${JSON.stringify(clean)} after ${Date.now() - tOpen} ms (first full check, incl. lib.dom)`);

const change = async (name, text) => {
  files[name] = text;
  await notify('textDocument/didChange', { textDocument: { uri: W + name, version: ++versions[name] }, contentChanges: [{ text }] });
};

// 1. Diagnostic for an introduced error (a type error across files under // @ts-check).
await change('main.js', files['main.js'] + `add('one', 2);\n`);
const bad = await diagnostics(W + 'main.js', (d) => d.some((x) => x.code === 2345));
const err = bad?.find((x) => x.code === 2345);
check('an argument of the wrong type is an error under @ts-check', !!err && err.severity === 1 && err.range.start.line === 6, err ?? bad);

// 2. Completion at a member access, with the member's JSDoc on resolve.
await change('main.js', files['main.js'] + `v.\n`);
const completion = await request('textDocument/completion', {
  textDocument: { uri: W + 'main.js' },
  position: { line: 7, character: 2 },
  context: { triggerKind: 2, triggerCharacter: '.' },
});
const labels = completion?.items?.map((i) => i.label) ?? [];
check('completion after `v.` offers the class members', ['length', 'x', 'y'].every((l) => labels.includes(l)), labels.slice(0, 10));
const lengthItem = completion?.items?.find((i) => i.label === 'length');
const resolved = lengthItem && (await request('completionItem/resolve', lengthItem));
check('completionItem/resolve adds signature and docs', /length\(\): number/.test(resolved?.detail ?? '') && /Euclidean/.test(resolved?.documentation?.value ?? ''), { detail: resolved?.detail, doc: resolved?.documentation?.value });

// 3. Hover on an imported function shows its type and JSDoc from the other file.
const hover = await request('textDocument/hover', { textDocument: { uri: W + 'main.js' }, position: { line: 4, character: 11 } });
check('hover on `add` shows its signature and docs', /add\(a: number, b: number\): number/.test(hover?.contents?.value ?? '') && /Adds two numbers/.test(hover?.contents?.value ?? ''), hover?.contents?.value);

// 4. Go to definition across files.
const def = await request('textDocument/definition', { textDocument: { uri: W + 'main.js' }, position: { line: 4, character: 11 } });
check('definition of `add` is in math.js', def?.length === 1 && def[0].uri === W + 'math.js' && def[0].range.start.line === 6, def);
const defMember = await request('textDocument/definition', { textDocument: { uri: W + 'main.js' }, position: { line: 4, character: 17 } });
check('definition of `v.length` is the method in math.js', defMember?.[0]?.uri === W + 'math.js' && defMember[0].range.start.line === 21, defMember);

// Beyond the four required checks: every other feature the server advertises.
const typeDef = await request('textDocument/typeDefinition', { textDocument: { uri: W + 'main.js' }, position: { line: 4, character: 14 } });
check('type definition of `v` is class Vec in math.js', typeDef?.length === 1 && typeDef[0].uri === W + 'math.js' && typeDef[0].range.start.line === 10, typeDef);

const impl = await request('textDocument/implementation', { textDocument: { uri: W + 'main.js' }, position: { line: 3, character: 14 } });
check('implementation of `Vec` is the class in math.js', impl?.some((l) => l.uri === W + 'math.js' && l.range.start.line === 10), impl);

const highlights = await request('textDocument/documentHighlight', { textDocument: { uri: W + 'main.js' }, position: { line: 3, character: 6 } });
check('document highlight marks every `v` in main.js', highlights?.map((h) => h.range.start.line).join() === '3,4,7', highlights?.map((h) => `${h.range.start.line}:${h.range.start.character}/${h.kind}`));

const wsSymbols = await request('workspace/symbol', { query: 'Vec' });
check('workspace symbols find Vec in math.js', wsSymbols?.some((s) => s.name === 'Vec' && s.location.uri === W + 'math.js'), wsSymbols?.map((s) => `${s.name}@${s.location.uri.slice(W.length)}:${s.location.range.start.line}`));

const prep = await request('textDocument/prepareRename', { textDocument: { uri: W + 'math.js' }, position: { line: 6, character: 17 } });
check('prepare rename gives the range of `add`', prep?.range?.start?.line === 6 && prep.range.start.character === 16 && prep.range.end.character === 19, prep);
let refused;
try {
  await request('textDocument/prepareRename', { textDocument: { uri: W + 'main.js' }, position: { line: 5, character: 2 } });
} catch (e) {
  refused = e.message;
}
check('prepare rename on a built-in (console) is refused', /-32803/.test(refused ?? ''), refused);

// Auto-import: completing a name exported by another file adds the import on resolve.
await notify('textDocument/didOpen', { textDocument: { uri: W + 'auto.js', languageId: 'javascript', version: 1, text: '// @ts-check\nconst r = ad\n' } });
const autoList = await request('textDocument/completion', { textDocument: { uri: W + 'auto.js' }, position: { line: 1, character: 12 }, context: { triggerKind: 1 } });
const autoItem = autoList?.items?.find((i) => i.label === 'add');
const autoResolved = autoItem && (await request('completionItem/resolve', autoItem));
const importEdit = autoResolved?.additionalTextEdits?.map((e) => e.newText).join('');
check('auto-import completion adds `import { add } from ./math.js` on resolve', /import \{ add \} from ['"]\.\/math\.js['"]/.test(importEdit ?? ''), importEdit ?? autoItem ?? 'no `add` item');
await notify('textDocument/didClose', { textDocument: { uri: W + 'auto.js' } });

// Organize imports: an action when there is something to do, none when there is not.
await notify('textDocument/didOpen', { textDocument: { uri: W + 'imports.js', languageId: 'javascript', version: 1, text: `import { Vec, add } from './math.js';\nconsole.log(add(1, 2));\n` } });
await notify('textDocument/didOpen', { textDocument: { uri: W + 'tidy.js', languageId: 'javascript', version: 1, text: `import { add } from './math.js';\nconsole.log(add(1, 2));\n` } });
const whole = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
const organize = await request('textDocument/codeAction', { textDocument: { uri: W + 'imports.js' }, range: whole, context: { diagnostics: [], only: ['source.organizeImports'] } });
const organizedText = organize?.[0]?.edit?.changes?.[W + 'imports.js']?.map((e) => e.newText).join('');
check('organize imports drops the unused import', organize?.length === 1 && organize[0].kind === 'source.organizeImports' && /import \{ add \}/.test(organizedText ?? '') && !/Vec/.test(organizedText ?? ''), organizedText);
const nothing = await request('textDocument/codeAction', { textDocument: { uri: W + 'tidy.js' }, range: whole, context: { diagnostics: [], only: ['source.organizeImports'] } });
check('organize imports offers nothing when imports are already tidy', Array.isArray(nothing) && nothing.length === 0, nothing);
await notify('textDocument/didClose', { textDocument: { uri: W + 'imports.js' } });
await notify('textDocument/didClose', { textDocument: { uri: W + 'tidy.js' } });

// A character past the end of a line means the end of that line (LSP), not the next line.
await notify('textDocument/didOpen', { textDocument: { uri: W + 'end.js', languageId: 'javascript', version: 1, text: 'const zed = 1, w = zed\nzed;\n' } });
const pastEnd = await request('textDocument/hover', { textDocument: { uri: W + 'end.js' }, position: { line: 0, character: 999 } });
check('a position past the end of a line stays on that line', pastEnd?.range?.start?.line === 0 && pastEnd.range.start.character === 19, pastEnd?.range);
await notify('textDocument/didClose', { textDocument: { uri: W + 'end.js' } });

// $/cancelRequest right behind its request cancels it before it runs.
const cancelled = await page.evaluate(() => {
  const p = window.lsp.request('textDocument/hover', { textDocument: { uri: 'file:///workspace/main.js' }, position: { line: 4, character: 11 } });
  window.lsp.notify('$/cancelRequest', { id: window.lsp.lastId() });
  return p.then((r) => `answered: ${JSON.stringify(r)}`, (e) => e.message);
});
check('a request cancelled right away is answered with RequestCancelled', /^-32800:/.test(cancelled), cancelled);

// Other features the app uses.
const refs = await request('textDocument/references', { textDocument: { uri: W + 'math.js' }, position: { line: 6, character: 17 }, context: { includeDeclaration: true } });
check('references to `add` span both files', new Set(refs?.map((r) => r.uri)).size === 2, refs?.map((r) => `${r.uri.slice(W.length)}:${r.range.start.line}`));

const rename = await request('textDocument/rename', { textDocument: { uri: W + 'math.js' }, position: { line: 6, character: 17 }, newName: 'sum' });
check('rename `add` edits both files', Object.keys(rename?.changes ?? {}).length === 2, Object.fromEntries(Object.entries(rename?.changes ?? {}).map(([k, v]) => [k.slice(W.length), v.length])));

const sig = await request('textDocument/signatureHelp', { textDocument: { uri: W + 'main.js' }, position: { line: 6, character: 4 }, context: { triggerKind: 2, triggerCharacter: '(', isRetrigger: false } });
check('signature help inside add(…)', sig?.signatures?.[0]?.label === 'add(a: number, b: number): number' && sig.activeParameter === 0, sig?.signatures?.[0]?.label);

const symbols = await request('textDocument/documentSymbol', { textDocument: { uri: W + 'math.js' } });
check('document symbols list add and Vec with its members', symbols?.map((s) => s.name).join() === 'add,Vec' && symbols[1].children.some((c) => c.name === 'length'), symbols?.map((s) => `${s.name}(${s.children.map((c) => c.name)})`));

const tokens = await request('textDocument/semanticTokens/full', { textDocument: { uri: W + 'main.js' } });
check('semantic tokens are produced', (tokens?.data?.length ?? 0) > 0 && tokens.data.length % 5 === 0, `${(tokens?.data?.length ?? 0) / 5} tokens`);

await change('main.js', files['main.js'].replace('v.\n', 'v.lenght();\n'));
const spelling = await diagnostics(W + 'main.js', (d) => d.some((x) => x.code === 2551));
const typo = spelling?.find((x) => x.code === 2551);
const actions = typo && (await request('textDocument/codeAction', { textDocument: { uri: W + 'main.js' }, range: typo.range, context: { diagnostics: [typo] } }));
const fix = actions?.find((a) => /length/.test(a.title));
check('a quick fix corrects a misspelt member', !!fix?.edit?.changes?.[W + 'main.js']?.some((e) => e.newText === 'length'), actions?.map((a) => a.title));

await notify('textDocument/didOpen', { textDocument: { uri: W + 'ugly.js', languageId: 'javascript', version: 1, text: 'function f( a ){return a}\n' } });
const formatted = await request('textDocument/formatting', { textDocument: { uri: W + 'ugly.js' }, options: { tabSize: 2, insertSpaces: true } });
check('formatting fixes spacing', (formatted?.length ?? 0) > 0, formatted?.map((e) => JSON.stringify(e.newText)).join(' '));
const rangeFormatted = await request('textDocument/rangeFormatting', { textDocument: { uri: W + 'ugly.js' }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 15 } }, options: { tabSize: 2, insertSpaces: true } });
check('range formatting fixes spacing inside the range only', (rangeFormatted?.length ?? 0) > 0 && rangeFormatted.every((e) => e.range.end.line === 0 && e.range.end.character <= 15), rangeFormatted?.map((e) => `${e.range.start.character}-${e.range.end.character}:${JSON.stringify(e.newText)}`).join(' '));
await notify('textDocument/didClose', { textDocument: { uri: W + 'ugly.js' } });

await notify('textDocument/didOpen', { textDocument: { uri: W + 'tsconfig.json', languageId: 'json', version: 1, text: '{ "compilerOptions": { "allowJs": true, "lib": ["es2023", "webworker"] } }' } });
const libError = await diagnostics(W + 'tsconfig.json', (d) => d.length > 0, 5000);
check('a lib the pack does not ship is reported on the config file', libError?.length === 1 && /lib\.webworker\.d\.ts' not found/.test(libError[0].message), libError?.map((x) => x.message));
await notify('textDocument/didClose', { textDocument: { uri: W + 'tsconfig.json' } });

// Plain JS (no @ts-check, no jsconfig): completions and hover, no type errors.
const loose = await diagnostics(W + 'loose.js', () => true, 1500);
check('unchecked JS gets no type errors', !(loose ?? []).some((x) => x.severity === 1), loose ?? 'no diagnostics published');
const looseCompletion = await request('textDocument/completion', { textDocument: { uri: W + 'loose.js' }, position: { line: 1, character: 39 }, context: { triggerKind: 1 } });
check('unchecked JS still completes string members', looseCompletion?.items?.some((i) => i.label === 'toUpperCase'), looseCompletion?.items?.length);

// A jsconfig with checkJs turns checking on for every file; removing it turns it off.
await notify('textDocument/didOpen', { textDocument: { uri: W + 'jsconfig.json', languageId: 'json', version: 1, text: '{ "compilerOptions": { "checkJs": true } }' } });
const checked = await diagnostics(W + 'loose.js', (d) => d.some((x) => x.code === 2345));
check('jsconfig.json with checkJs reports errors in files without @ts-check', checked?.some((x) => x.code === 2345), checked);
await notify('textDocument/didClose', { textDocument: { uri: W + 'jsconfig.json' } });
const unchecked = await diagnostics(W + 'loose.js', (d) => !d.some((x) => x.code === 2345));
check('deleting jsconfig.json turns checking off again', !unchecked?.some((x) => x.code === 2345), unchecked);

// TypeScript files work too, importing from JS.
await notify('textDocument/didOpen', { textDocument: { uri: W + 'util.ts', languageId: 'typescript', version: 1, text: `import { Vec } from './math.js';\nexport const unit: Vec = new Vec(1, 0);\nexport const bad: string = unit.length();\n` } });
const tsDiags = await diagnostics(W + 'util.ts', (d) => d.some((x) => x.code === 2322));
check('a .ts file is type-checked against the JS it imports', tsDiags?.some((x) => x.code === 2322), tsDiags);

// node:test and node:assert, as the runner provides them, have types (src/node/builtins.d.ts).
const testFile = `// @ts-check
import { describe, it, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import legacy, { deepEqual } from 'node:assert';
import { add, Vec } from '../math.js';

describe('Vec', () => {
  /** @type {Vec} */
  let v = new Vec(0, 0);
  beforeEach(() => {
    v = new Vec(3, 4);
  });
  it('has length 5', () => {
    assert.equal(v.length(), 5);
  });
});

test('add', async (t) => {
  await t.test('adds', () => assert.deepEqual(add(1, 2), 3));
  legacy.equal(add(1, 1), 2);
  deepEqual([1], [1]);
  assert.throws(() => add(Number('x'), 1), TypeError);
  await assert.rejects(Promise.reject(new Error('no')), /no/);
  t.assert.ok(true);
});
`;
await notify('textDocument/didOpen', { textDocument: { uri: W + 'tests/math.test.js', languageId: 'javascript', version: 1, text: testFile } });
const nodeTestDiags = await diagnostics(W + 'tests/math.test.js', (d) => d.every((x) => x.severity !== 1));
check('a checked test file importing node:test and node:assert(/strict) has no errors', nodeTestDiags !== undefined && nodeTestDiags.every((x) => x.severity !== 1), nodeTestDiags);
const describeHover = await request('textDocument/hover', { textDocument: { uri: W + 'tests/math.test.js' }, position: { line: 6, character: 2 } });
check('hover on `describe` shows its signature and docs', /describe\(name\?: string, fn\?: SuiteFn\): Promise<void>/.test(describeHover?.contents?.value ?? '') && /Group tests/.test(describeHover?.contents?.value ?? ''), describeHover?.contents?.value);
await notify('textDocument/didChange', { textDocument: { uri: W + 'tests/math.test.js', version: 2 }, contentChanges: [{ text: testFile.replace("import { describe, it, test, beforeEach } from 'node:test';", "import { describe, it, test, beforeEach, mock } from 'node:test';\nassert.nope(1);") }] });
const missing = await diagnostics(W + 'tests/math.test.js', (d) => d.some((x) => x.severity === 1));
check('what the runner lacks is an error: node:test `mock`, an assert function Node does not have', missing?.some((x) => (x.code === 2305 || x.code === 2614) && /no exported member .mock./.test(x.message)) && missing?.some((x) => x.code === 2339 && /nope/.test(x.message)), missing?.map((x) => `${x.code} ${x.message}`));
const wsTestSymbols = await request('workspace/symbol', { query: 'SuiteFunction' });
check('the node:test types stay out of workspace symbols', Array.isArray(wsTestSymbols) && wsTestSymbols.length === 0, wsTestSymbols);

// process and node:readline are typed as the runner provides them.
const cliFile = `import * as readline from 'node:readline/promises';
import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'node:process';
const rl = readline.createInterface({ input, output });
const name: string = await rl.question('Name? ');
for await (const line of createInterface({ input: process.stdin })) process.stdout.write(line);
if (process.argv.length > 2) process.exit(1);
process.exitCode = name.length;
`;
await notify('textDocument/didOpen', { textDocument: { uri: W + 'cli.ts', languageId: 'typescript', version: 1, text: cliFile } });
const cliDiags = await diagnostics(W + 'cli.ts', (d) => d.every((x) => x.severity !== 1));
check('a .ts CLI using process and node:readline(/promises) has no errors', cliDiags !== undefined && cliDiags.every((x) => x.severity !== 1), cliDiags?.map((x) => `${x.code} ${x.message}`));
await notify('textDocument/didChange', { textDocument: { uri: W + 'cli.ts', version: 2 }, contentChanges: [{ text: cliFile + 'process.hrtime();\nrl.history;\n' }] });
const cliMissing = await diagnostics(W + 'cli.ts', (d) => d.filter((x) => x.severity === 1).length >= 2);
check('what process and readline lack here is an error (process.hrtime, rl.history)', cliMissing?.filter((x) => x.code === 2339).length === 2, cliMissing?.map((x) => `${x.code} ${x.message}`));

// Garbage on the wire is logged, not thrown; a second initialize is refused.
await page.evaluate(() => window.lsp.worker.postMessage('not json-rpc'));
let again;
try {
  await request('initialize', { processId: null, rootUri: 'file:///other/', capabilities: {} });
} catch (e) {
  again = e.message;
}
check('a second initialize in the same worker is refused', /-32600:/.test(again ?? ''), again ?? 'it was accepted');
const ignored = (await notifications()).some((n) => n.method === 'window/logMessage' && /not JSON-RPC 2\.0/.test(n.params.message));
check('a message that is not JSON-RPC is logged and ignored', ignored);

const logs = (await notifications()).filter((n) => n.method === 'window/logMessage' || n.method === 'worker/error').map((n) => n.params.message);
console.log('server log:', logs);

await request('shutdown', null);
await notify('exit', null);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
