// Headless test of the JavaScript runner (packs/CONTRACT.md, "Running a
// program"), run the way the app runs it: app/static served over http with
// COOP/COEP so the page is crossOriginIsolated, `new Worker('/packs/javascript/runner.js',
// { type: 'module' })` in Chromium, stdin driven from the page as the app's
// terminal drives it.
//
//   node test-run.mjs        (after ./build.sh; needs playwright-core)
//
// Test mode (`type: 'test'`) is checked against the real thing: the same
// test files run under this Node's own `node --test`, and the two reports
// must agree line for line (durations aside), colours included: the runner
// prints what Node prints on a terminal, and Node is run with FORCE_COLOR.
// The other checks read the output with its escape sequences removed, as
// the app's terminal shows it (`raw` keeps them).

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };

const server = createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (path === '/__test.html') {
		res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION });
		res.end('<!doctype html><link rel=icon href="data:,"><title>javascript runner test</title>');
		return;
	}
	const file = normalize(join(STATIC, path));
	try {
		if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
		const body = await readFile(file);
		res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length, ...ISOLATION });
		res.end(body);
	} catch {
		res.writeHead(404).end();
	}
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${origin}/__test.html`);

// In the page: start a runner, answer its stdin requests from `inputs`
// (a string is a line, null is Ctrl-D), collect every message in order.
await page.evaluate(() => {
	window.runProgram = (type, files, entry, inputs = [], timeoutMs = 30000) =>
		new Promise((done) => {
			const t0 = performance.now();
			const sab = new SharedArrayBuffer(8 + 65536);
			const state = new Int32Array(sab, 0, 2);
			const data = new Uint8Array(sab, 8);
			const out = { stdout: '', stderr: '', code: null, phases: [] };
			const worker = new Worker('/packs/javascript/runner.js', { type: 'module' });
			const finish = () => {
				worker.terminate();
				out.ms = Math.round(performance.now() - t0);
				done(out);
			};
			const timer = setTimeout(() => {
				out.timedOut = true;
				finish();
			}, timeoutMs);
			worker.onerror = (e) => {
				out.workerError = e.message ?? String(e);
				clearTimeout(timer);
				finish();
			};
			worker.onmessage = ({ data: m }) => {
				if (m.type === 'phase') out.phases.push(m.text);
				if (m.type === 'stdout') out.stdout += m.text;
				if (m.type === 'stderr') out.stderr += m.text;
				if (m.type === 'stdin') {
					const line = inputs.shift();
					setTimeout(() => {
						if (line === undefined || line === null) Atomics.store(state, 0, 3);
						else {
							const bytes = new TextEncoder().encode(line);
							data.set(bytes);
							Atomics.store(state, 1, bytes.length);
							Atomics.store(state, 0, 2);
						}
						Atomics.notify(state, 0);
					}, 20);
				}
				if (m.type === 'exit') {
					out.code = m.code;
					clearTimeout(timer);
					finish();
				}
			};
			worker.postMessage({ type, files, entry, stdin: sab });
		});
});

let failures = 0;
const short = (s, n = 160) => JSON.stringify(s.length > n ? `${s.slice(0, n)}...` : s);
const block = (s) => s.trimEnd().replace(/^/gm, '      | ');
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
// CSI sequences (all the reporter prints); the app's own reader is app/src/lib/ansi.ts.
const plain = (text) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');
const stripped = (out) => ({ ...out, raw: { stdout: out.stdout, stderr: out.stderr }, stdout: plain(out.stdout), stderr: plain(out.stderr) });
const run = async (files, entry = 'main.js', inputs = []) => stripped(await page.evaluate(([f, e, i]) => window.runProgram('run', f, e, i), [files, entry, inputs]));
const page_preview = (files, entry = 'index.html') =>
	page.evaluate(
		([f, e]) =>
			new Promise((done) => {
				const worker = new Worker('/packs/javascript/runner.js', { type: 'module' });
				worker.onmessage = ({ data: m }) => {
					if (m.type !== 'page') return;
					worker.terminate();
					done(m);
				};
				worker.postMessage({ type: 'preview', id: 1, files: f, entry: e });
			}),
		[files, entry],
	);
const test = async (files) => stripped(await page.evaluate((f) => window.runProgram('test', f, 'main.js'), files));

// The sample project of app/src/lib/languages.ts, with its test file.
const SAMPLE = {
	'main.js': `// @ts-check
import { Point, distance } from './geometry.js';

const a = new Point(0, 0);
const b = new Point(3, 4);
console.log(\`\${a} to \${b}: \${distance(a, b)}\`);
console.log(a.norm().toFixed(2));
`,
	'geometry.js': `// @ts-check

/** A point in the plane. */
export class Point {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  /** Distance from the origin. */
  norm() {
    return Math.hypot(this.x, this.y);
  }

  toString() {
    return \`(\${this.x}, \${this.y})\`;
  }
}

/**
 * Euclidean distance between two points.
 * @param {Point} a
 * @param {Point} b
 */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
`,
	'tests/geometry.test.js': `// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Point, distance } from '../geometry.js';

describe('Point', () => {
  it('has norm 5 at (3, 4)', () => {
    assert.equal(new Point(3, 4).norm(), 5);
  });

  it('prints as a pair', () => {
    assert.equal(String(new Point(1, 2)), '(1, 2)');
  });
});

describe('distance', () => {
  it('is symmetric', () => {
    const a = new Point(1, 2);
    const b = new Point(-2, 6);
    assert.equal(distance(a, b), distance(b, a));
  });

  it('is 0 from a point to itself', () => {
    const p = new Point(7, -3);
    assert.equal(distance(p, p), 0);
  });
});
`,
};

// 1. Running (type 'run'), as before test mode existed.
const r1 = await run(SAMPLE);
check('run: the sample prints the distance and the norm, exit 0; its test file is not run', r1.code === 0 && r1.stdout === '(0, 0) to (3, 4): 5\n0.00\n' && r1.stderr === '', `stdout=${short(r1.stdout)} stderr=${short(r1.stderr)}`);
const r2 = await run({ 'main.js': 'const a = Number(prompt("First number: "));\nconst b = Number(prompt("Second number: "));\nconsole.log(`${a} + ${b} = ${a + b}`);\n' }, 'main.js', ['2\n', '40\n']);
check('run: prompt() reads two lines through the SharedArrayBuffer', r2.code === 0 && r2.stdout === 'First number: Second number: 2 + 40 = 42\n', `stdout=${short(r2.stdout)}`);

// 2. The sample's tests.
const t1 = await test(SAMPLE);
check(
	'test: the sample tests pass, exit 0, a spec report on stdout',
	t1.code === 0 && /^▶ Point\n  ✔ has norm 5 at \(3, 4\) \([\d.]+ms\)\n/.test(t1.stdout) && /ℹ tests 4\nℹ suites 2\nℹ pass 4\nℹ fail 0\n/.test(t1.stdout) && t1.phases.includes('Testing'),
	`(${t1.ms} ms)\n${block(t1.stdout)}`,
);
const failing = { ...SAMPLE, 'tests/geometry.test.js': SAMPLE['tests/geometry.test.js'].replace('norm(), 5)', 'norm(), 6)') };
const t2 = await test(failing);
check(
	'test: a failing assertion exits 1; the failing-tests list names the test, its line and both values',
	t2.code === 1 &&
		/^  ✖ has norm 5 at \(3, 4\)/m.test(t2.stdout) &&
		/ℹ pass 3\nℹ fail 1\n/.test(t2.stdout) &&
		/test at tests\/geometry\.test\.js:7:3\n✖ has norm 5 at \(3, 4\) \([\d.]+ms\)\n  AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal:\n  \n  5 !== 6\n/.test(t2.stdout) &&
		/at .*tests\/geometry\.test\.js:8:12/.test(t2.stdout) &&
		!/runner\.js/.test(t2.stdout),
	`\n${block(t2.stdout.slice(t2.stdout.indexOf('✖ failing')))}`,
);

// 3. The same report as Node's own `node --test`, for a file that uses most
//    of node:test and node:assert. Node runs it from a temporary directory.
const BEHAVIOUR = {
	'package.json': '{ "type": "module" }\n',
	'counter.js': 'export let n = 0;\nexport const inc = () => ++n;\n',
	'tests/helpers.js': 'export const helper = 1;\nthrow new Error("helpers.js is not a test file and must not run");\n',
	'tests/second.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inc } from '../counter.js';

test('the second file has a fresh counter', () => assert.equal(inc(), 1));
`,
	'tests/behaviour.test.js': await readFile(join(HERE, 'test-fixtures/behaviour.test.js'), 'utf8'),
};
const t3 = await test(BEHAVIOUR);
const dir = await mkdtemp(join(tmpdir(), 'yukibana-node-test-'));
for (const [path, text] of Object.entries(BEHAVIOUR)) {
	await mkdir(dirname(join(dir, path)), { recursive: true });
	await writeFile(join(dir, path), text);
}
const { NO_COLOR, NODE_DISABLE_COLORS, ...env } = process.env;
const node = spawnSync(process.execPath, ['--test', '--test-reporter=spec'], { cwd: dir, encoding: 'utf8', env: { ...env, FORCE_COLOR: '1' } });
await rm(dir, { recursive: true, force: true });
// Durations differ; Node's error details (stacks into node:internal, the
// error's own properties) are not reproduced, so the failing-tests list is
// compared by its `test at` and `✖` lines only. Escapes are compared as
// they are, so each colour must start and end where Node's does.
const comparable = (report) =>
	report
		.replace(/\([\d.]+ms\)/g, '(ms)')
		.replace(/duration_ms [\d.]+/, 'duration_ms')
		.split('\n')
		.filter((line, i, all) => {
			const failing = all.findIndex((l) => plain(l) === '✖ failing tests:');
			return failing < 0 || i <= failing || /^(test at |✖ )/.test(plain(line));
		})
		.join('\n')
		.trim();
const ours = comparable(t3.raw.stdout);
const theirs = comparable(node.stdout);
const diff = ours.split('\n').map((l, i) => (l === theirs.split('\n')[i] ? null : `line ${i + 1}: ours ${JSON.stringify(l)} node ${JSON.stringify(theirs.split('\n')[i])}`)).filter(Boolean);
check(
	`test: the report matches \`node --test\` (Node ${process.version}) on a colour terminal line for line, escapes included: hooks, subtests, skip/todo, timeouts, assertion messages`,
	ours === theirs && /\x1b\[32m✔ /.test(ours) && /\x1b\[31m✖ /.test(ours) && /\x1b\[34mℹ tests/.test(ours) && t3.code === (node.status ?? -1),
	`exit ${t3.code} vs node ${node.status}; ${ours.split('\n').length} lines${diff.length ? `\n${diff.slice(0, 12).join('\n')}` : ''}`,
);
console.log(block(t3.stdout.slice(0, t3.stdout.indexOf('ℹ tests'))));

// 4. Errors around the tests.
const t4 = await test({ ...SAMPLE, 'tests/broken.test.js': "import { nope } from '../missing.js';\n" });
check(
	'test: a test file that cannot be loaded is a failed test named after the file; the others still run',
	t4.code === 1 && /^✖ tests\/broken\.test\.js/m.test(t4.stdout) && /cannot find module 'missing\.js'/.test(t4.stdout) && /ℹ pass 4\nℹ fail 1\n/.test(t4.stdout),
	short(t4.stdout.slice(t4.stdout.indexOf('✖ failing')), 200),
);
const t5 = await test({ 'main.js': 'console.log(1);\n' });
check('test: a project without test files exits 1 and says where it looked', t5.code === 1 && /No test files found/.test(t5.stderr), short(t5.stderr));
const t6 = await test({
	'a.test.js': `import { test } from 'node:test';
test('an uncaught error fails the test that was running', async () => {
  setTimeout(() => { throw new Error('boom'); }, 1);
  await new Promise((r) => setTimeout(r, 50));
});
test('and the next test still runs', () => {});
`,
});
check(
	'test: an uncaught error during a test fails that test, and the run goes on',
	t6.code === 1 && /✖ an uncaught error fails the test that was running/.test(t6.stdout) && /Error: boom/.test(t6.stdout) && /✔ and the next test still runs/.test(t6.stdout),
	short(t6.stdout, 300),
);
const t7 = await test({ 'test/console.js': "import test from 'node:test';\ntest('logs', () => { console.log('from the test'); });\n" });
check('test: files under test/ are test files (Node\'s default patterns); console.log inside a test reaches stdout', t7.code === 0 && /from the test\n✔ logs/.test(t7.stdout), short(t7.stdout));

// 5. `node main.js` runs the tests a program defines; so does Run.
const r3 = await run({ 'main.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nconsole.log('program');\ntest('inside a program', () => assert.ok(true));\n" });
check('run: a program that defines node:test tests runs them, as `node main.js` does', r3.code === 0 && /^program\n✔ inside a program/.test(r3.stdout) && /ℹ pass 1/.test(r3.stdout), short(r3.stdout));

// 6. TypeScript: types stripped as `node main.ts` strips them, positions kept.
const TS_SAMPLE = {
	'main.ts': `import { Point, distance, type Shape } from './geometry.ts';

const a = new Point(0, 0);
const b = new Point(3, 4);
const shapes: Shape[] = [{ kind: 'circle', radius: 1 }];
console.log(\`\${a} to \${b}: \${distance(a, b)}\`);
console.log(shapes.length);
`,
	'geometry.ts': `export type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; side: number };

/** A point in the plane. */
export class Point {
  readonly x: number;
  readonly y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  norm(): number {
    return Math.hypot(this.x, this.y);
  }
  toString(): string {
    return \`(\${this.x}, \${this.y})\`;
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
`,
	'tests/geometry.test.ts': `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Point, distance } from '../geometry.ts';

describe('Point', () => {
  it('has norm 5 at (3, 4)', () => {
    const p: Point = new Point(3, 4);
    assert.equal(p.norm(), 5);
  });
  it('is at distance 0 from itself', () => {
    const p = new Point(7, -3);
    assert.equal(distance(p, p), 0);
  });
});
`,
};
const ts1 = await run(TS_SAMPLE, 'main.ts');
check('typescript: main.ts runs with its types stripped, importing geometry.ts', ts1.code === 0 && ts1.stdout === '(0, 0) to (3, 4): 5\n1\n' && ts1.stderr === '', `(${ts1.ms} ms; ${ts1.phases.join(', ')}) stdout=${short(ts1.stdout)} stderr=${short(ts1.stderr)}`);
const ts2 = await run({ 'main.ts': 'const n: number = 1;\ninterface I { a: string }\nfunction f(x: I): never {\n  throw new Error(x.a);\n}\nf({ a: "at line 4" });\n' }, 'main.ts');
check('typescript: a stack trace points at the .ts line and column (types became whitespace)', ts2.code === 1 && /Error: at line 4\n\s+at f \(main\.ts:4:9\)/.test(ts2.stderr), short(ts2.stderr, 300));
const ts3 = await run({ 'main.ts': 'enum Colour { Red }\nconsole.log(Colour.Red);\n' }, 'main.ts');
check('typescript: an enum is refused with the reason node gives (strip-only mode)', ts3.code === 1 && /^main\.ts:1:1: An enum is not supported when types are only stripped.*ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/.test(ts3.stderr), short(ts3.stderr, 200));
const ts4 = await test(TS_SAMPLE);
check('typescript: Test finds tests/*.test.ts and runs them', ts4.code === 0 && /ℹ tests 2\n/.test(ts4.stdout) && /ℹ pass 2\n/.test(ts4.stdout), short(ts4.stdout, 300));
const ts5 = await test({ ...TS_SAMPLE, 'tests/geometry.test.ts': TS_SAMPLE['tests/geometry.test.ts'].replace('p.norm(), 5)', 'p.norm(), 6)') });
check('typescript: a failing test is located at its .ts line, and assert quotes nothing wrong', ts5.code === 1 && /test at tests\/geometry\.test\.ts:6:3/.test(ts5.stdout) && /at .*tests\/geometry\.test\.ts:8:12/.test(ts5.stdout), short(ts5.stdout.slice(ts5.stdout.indexOf('✖ failing')), 400));

// 7. What a command-line program uses: process and node:readline.
const c1 = await run({ 'main.js': "process.stdout.write('no newline|');\nprocess.stdout.write('then one\\n');\nconsole.log(process.argv.length, process.argv[1]);\nprocess.exitCode = 3;\n" }, 'main.js');
check('cli: process.stdout.write writes without a newline; argv is [node, /workspace/main.js]; exitCode is the status', c1.code === 3 && c1.stdout === 'no newline|then one\n2 /workspace/main.js\n', `code ${c1.code} stdout=${short(c1.stdout)}`);
const c2 = await run({ 'main.js': "console.log('before');\nsetTimeout(() => console.log('never'), 10);\nprocess.exit(4);\nconsole.log('after');\n" }, 'main.js');
check('cli: process.exit(4) ends the run at once with status 4; nothing after it runs', c2.code === 4 && c2.stdout === 'before\n' && c2.stderr === '', `code ${c2.code} stdout=${short(c2.stdout)} stderr=${short(c2.stderr)}`);
const c3 = await run(
	{
		'main.ts': `import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = readline.createInterface({ input, output });
const name = await rl.question('Name? ');
const age = Number(await rl.question('Age? '));
rl.close();
console.log(\`\${name} is \${age}\`);
`,
	},
	'main.ts',
	['Ada\n', '36\n'],
);
check('cli: node:readline/promises question() reads two lines (TypeScript, node:process)', c3.code === 0 && c3.stdout === 'Name? Age? Ada is 36\n', `stdout=${short(c3.stdout)} stderr=${short(c3.stderr)}`);
const c4 = await run(
	{
		'main.js': `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let sum = 0;
for await (const line of rl) sum += Number(line);
console.log('sum', sum);
`,
	},
	'main.js',
	['1\n', '2\n', '39\n', null],
);
check('cli: for await (const line of rl) reads lines until end of input', c4.code === 0 && c4.stdout === 'sum 42\n', `stdout=${short(c4.stdout)} stderr=${short(c4.stderr)}`);
const c5 = await run(
	{
		'main.js': `import readline from 'readline';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = [];
rl.on('line', (line) => lines.push(line.toUpperCase()));
rl.on('close', () => console.log(lines.join(',')));
rl.question('first? ', (a) => console.log('answer', a));
`,
	},
	'main.js',
	['x\n', 'y\n', 'z\n', null],
);
check("cli: question() with a callback, then 'line' events and 'close' at end of input", c5.code === 0 && /^first\? /.test(c5.stdout) && /Y,Z\n$/.test(c5.stdout), `stdout=${short(c5.stdout)} stderr=${short(c5.stderr)}`);

// The environment README.md ("Environment") describes: a module worker's globals, no DOM, no Node beyond what the runner adds.
const environment = await run({
	'main.js': `const has = (name) => typeof globalThis[name] !== 'undefined';
const present = ['fetch', 'WebAssembly', 'crypto', 'TextEncoder', 'TextDecoder', 'structuredClone', 'Intl', 'setTimeout', 'queueMicrotask', 'OffscreenCanvas', 'indexedDB', 'WebSocket', 'URL', 'Blob', 'atob', 'performance', 'SharedArrayBuffer', 'Atomics', 'prompt', 'process'];
const absent = ['document', 'window', 'localStorage', 'alert', 'Buffer', 'require', 'module', '__dirname', 'global'];
console.log('missing', present.filter((n) => !has(n)).join() || 'none');
console.log('present', absent.filter(has).join() || 'none');
console.log(typeof crypto.randomUUID(), typeof crypto.subtle.digest, crossOriginIsolated);
const canvas = new OffscreenCanvas(4, 4);
console.log(canvas.getContext('2d') !== null);
`,
});
check('environment: worker globals (fetch, WebAssembly, crypto, OffscreenCanvas, ...) are there; DOM and Node globals other than process are not', environment.code === 0 && environment.stdout === 'missing none\npresent none\nstring function true\ntrue\n', `stdout=${short(environment.stdout)} stderr=${short(environment.stderr)}`);

// 8. Preview (this pack's `type: 'preview'`): the page as one document.
const built = await page_preview({
	'index.html': '<!doctype html>\n<html>\n<head>\n<link rel="stylesheet" href="style.css">\n</head>\n<body><h1 id="t">x</h1>\n<script type="module" src="./main.ts"></script>\n</body>\n</html>\n',
	'style.css': 'h1 { color: rgb(1, 2, 3); }\n',
	'main.ts': "import { label } from './label';\ndocument.getElementById('t')!.textContent = label(2);\nconsole.log('hello from the page');\n",
	'label.ts': 'export const label = (n: number): string => `count ${n}`;\n',
});
check(
	'preview: index.html becomes one document: style.css inlined, main.ts linked with an extensionless import, the bridge first',
	built.html !== null && built.styles.join() === 'style.css' && /<style data-yukibana-href="style.css">h1 \{ color: rgb\(1, 2, 3\); \}/.test(built.html) && /<script type="module" src="data:text\/javascript;base64,/.test(built.html) && built.html.indexOf('yukibana') < built.html.indexOf('<style'),
	short(JSON.stringify(built.errors), 200),
);
const rendered = await page.evaluate(async (html) => {
	const frame = document.createElement('iframe');
	frame.sandbox = 'allow-scripts allow-forms allow-modals';
	const messages = [];
	addEventListener('message', (e) => e.source === frame.contentWindow && messages.push(e.data));
	frame.srcdoc = html;
	document.body.append(frame);
	await new Promise((r) => setTimeout(r, 1500));
	return messages;
}, built.html ?? '');
check('preview: in a sandboxed srcdoc iframe under COEP the module runs and its console.log reaches the parent', rendered.some((m) => m.yukibana === 'preview' && m.type === 'stdout' && m.text === 'hello from the page\n'), JSON.stringify(rendered).slice(0, 300));
const broken = await page_preview({ 'index.html': '<script type="module" src="main.ts"></script>', 'main.ts': "import './missing.ts';\n" });
check('preview: a missing import is an error and no page', broken.html === null && /cannot find module 'missing\.ts'/.test(broken.errors.join()), JSON.stringify(broken.errors));

check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
