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

/** Every path the server was asked for, so a check can tell what a run fetched. */
const served = [];
const server = createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	served.push(path);
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

// 7b. fast-check, the package this pack ships for property-based tests:
// fetched only by a run that imports it; a passing property, and a failing
// one reported with fast-check's shrunk counterexample.
const fetchedFastCheck = () => served.some((p) => /\/fast-check-[\d.]+\.js$/.test(p));
check('fast-check: not fetched by runs and tests that do not import it', !fetchedFastCheck(), JSON.stringify(served.filter((p) => /fast-check/.test(p))));
const PROPERTIES = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { Point, distance } from '../geometry.js';

const coordinate = fc.double({ min: -1e9, max: 1e9, noNaN: true });
const point = fc.tuple(coordinate, coordinate).map(([x, y]) => new Point(x, y));

test('distance is symmetric', () => {
  fc.assert(fc.property(point, point, (a, b) => distance(a, b) === distance(b, a)));
});

test('norm stays under 100', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 1000 }), (x) => {
      assert.ok(new Point(x, 0).norm() < 100);
    }),
  );
});
`;
const fc1 = await test({ ...SAMPLE, 'tests/properties.test.js': PROPERTIES });
check(
	'fast-check: a passing property passes; a failing one fails with its counterexample shrunk to [100] and, as its cause, the assertion that failed',
	fc1.code === 1 &&
		/✔ distance is symmetric/.test(fc1.stdout) &&
		/✖ norm stays under 100/.test(fc1.stdout) &&
		/Property failed after \d+ tests/.test(fc1.stdout) &&
		/Counterexample: \[100\]/.test(fc1.stdout) &&
		/\[cause\]: AssertionError \[ERR_ASSERTION\]: The expression evaluated to a falsy value:\n\s*\n\s*assert\.ok\(new Point\(x, 0\)\.norm\(\) < 100\)/.test(fc1.stdout) &&
		/Shrunk \d+ time\(s\)/.test(fc1.stdout) &&
		/ℹ pass 5\n/.test(fc1.stdout) &&
		/ℹ fail 1\n/.test(fc1.stdout),
	`code ${fc1.code}\n${block(fc1.stdout.slice(fc1.stdout.indexOf('✖ failing')))}`,
);
check('fast-check: fetched once a test imports it', fetchedFastCheck());
const fc2 = await run({ 'main.ts': "import fc from 'fast-check';\nconst [xs] = fc.sample(fc.array(fc.nat(), { minLength: 3, maxLength: 3 }), { numRuns: 1, seed: 42 });\nconst n: number = xs!.length;\nconsole.log(n, fc.check(fc.property(fc.string(), (s) => s.length >= 0)).failed);\n" }, 'main.ts');
check('fast-check: a TypeScript program can import it too (Run)', fc2.code === 0 && fc2.stdout === '3 false\n', `stdout=${short(fc2.stdout)} stderr=${short(fc2.stderr)}`);
const fc3 = await run({ 'main.js': "import _ from 'lodash';\n" });
check('packages: a bare import of a package the pack does not ship still fails', fc3.code === 1 && /lodash/.test(fc3.stderr), short(fc3.stderr));

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

// p5.js, the package a page may import: an import map in the page maps the
// bare 'p5' to one data: copy of p5-<version>.js, fetched by the preview
// worker the first time a page imports it and reused by its rebuilds.
const fetchedP5 = () => served.filter((p) => /\/p5-[\d.]+\.js$/.test(p)).length;
check('p5: a page that does not import it gets no import map, and p5 is not fetched', fetchedP5() === 0 && !/importmap/.test(built.html ?? ''), JSON.stringify(served.filter((p) => /p5/.test(p))));
const P5_PAGE = {
	'index.html': '<!doctype html>\n<html>\n<head>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<script type="module" src="./main.ts"></script>\n</body>\n</html>\n',
	'style.css': 'html, body { margin: 0; height: 100%; overflow: hidden; }\ncanvas { display: block; }\n',
	'main.ts': `import p5 from 'p5';
import { radius } from './size';

new p5((p: p5) => {
  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.pixelDensity(1);
    p.noStroke();
  };
  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
  p.draw = () => {
    p.clear();
    p.fill(255, 0, 0);
    p.circle(p.mouseX, p.mouseY, radius * 2);
  };
  console.log('p5', p5.VERSION);
});
`,
	'size.ts': "import p5 from 'p5';\nexport const radius: number = 20;\nexport const version: string = p5.VERSION;\n",
};
const twice = await page.evaluate(
	(f) =>
		new Promise((done) => {
			const worker = new Worker('/packs/javascript/runner.js', { type: 'module' });
			const pages = [];
			worker.onmessage = ({ data: m }) => {
				if (m.type !== 'page') return;
				pages.push(m);
				if (pages.length === 2) {
					worker.terminate();
					done(pages);
				} else worker.postMessage({ type: 'preview', id: 2, files: { ...f, 'size.ts': f['size.ts'].replace('20', '25') }, entry: 'index.html' });
			};
			worker.postMessage({ type: 'preview', id: 1, files: f, entry: 'index.html' });
		}),
	P5_PAGE,
);
const p5Page = twice[0];
const maps = (p5Page.html ?? '').match(/<script type="importmap">[^<]*<\/script>/g) ?? [];
const p5Url = /"p5":"(data:text\/javascript;base64,[^"]+)"/.exec(maps[0] ?? '')?.[1] ?? '';
check(
	'p5: two modules that import it get one import map, before the first module script, with p5 as one data: URL',
	p5Page.html !== null && maps.length === 1 && p5Url.length > 1_000_000 && (p5Page.html.split(p5Url).length - 1) === 1 && p5Page.html.indexOf('importmap') < p5Page.html.indexOf('<script type="module"'),
	short(JSON.stringify(p5Page.errors), 200),
);
check('p5: the preview worker fetches it once, and a rebuild reuses it', fetchedP5() === 1 && twice[1].html !== null && twice[1].html.includes(p5Url), fetchedP5());
const sketch = await page.evaluate(async (html) => {
	const frame = document.createElement('iframe');
	frame.sandbox = 'allow-scripts allow-forms allow-modals';
	frame.name = 'p5-sketch';
	frame.style.cssText = 'position: fixed; left: 0; top: 0; width: 400px; height: 300px; border: 0';
	const messages = [];
	addEventListener('message', (e) => e.source === frame.contentWindow && messages.push(e.data));
	frame.srcdoc = html;
	document.body.append(frame);
	for (let i = 0; i < 100 && !messages.some((m) => /^p5 /.test(m.text)); i++) await new Promise((r) => setTimeout(r, 50));
	return messages;
}, p5Page.html ?? '');
check('p5: the sketch runs in a sandboxed srcdoc iframe under COEP, with no error', sketch.some((m) => m.type === 'stdout' && m.text === 'p5 2.3.4\n') && !sketch.some((m) => m.type === 'stderr'), JSON.stringify(sketch).slice(0, 400));
const p5Frame = await (await page.$('iframe[name="p5-sketch"]')).contentFrame();
/** The canvas's size and the red channel at (x, y), read inside the sketch's frame. */
const canvasAt = (x, y) =>
	p5Frame.evaluate(([x, y]) => {
		const canvas = document.querySelector('canvas');
		if (!canvas) return null;
		const red = canvas.getContext('2d').getImageData(x, y, 1, 1).data[0];
		return { width: canvas.width, height: canvas.height, client: [canvas.clientWidth, canvas.clientHeight], red };
	}, [x, y]);
const before = await canvasAt(100, 100);
check('p5: createCanvas(windowWidth, windowHeight) fills the frame', before?.width === 400 && before.height === 300 && before.client.join() === '400,300', JSON.stringify(before));
await page.mouse.move(100, 100);
await page.waitForTimeout(300);
const under = await canvasAt(100, 100);
await page.mouse.move(300, 200);
await page.waitForTimeout(300);
const left = await canvasAt(100, 100);
const moved = await canvasAt(300, 200);
check('p5: the circle follows the mouse: drawn under it, cleared where it was', before?.red === 0 && under?.red === 255 && left?.red === 0 && moved?.red === 255, JSON.stringify({ before: before?.red, under: under?.red, left: left?.red, moved: moved?.red }));
await page.evaluate(() => document.querySelector('iframe[name="p5-sketch"]')?.remove());

// 9. Mutate (`type: 'mutate'`): mutation testing with StrykerJS's instrumenter
// and reporter, every test file run in a fresh worker per mutant.
const mutateRun = async (files, entry = 'main.js', timeoutMs = 120000) => stripped(await page.evaluate(([f, e, t]) => window.runProgram('mutate', f, e, [], t), [files, entry, timeoutMs]));
const fetchedStryker = () => served.some((p) => /\/stryker-[\d.]+\.js$/.test(p));
check('mutate: Stryker is not fetched by runs and tests', !fetchedStryker(), JSON.stringify(served.filter((p) => /stryker/.test(p))));
const m1 = await mutateRun(SAMPLE);
check(
	'mutate: the sample is mutation tested, exit 0: geometry.js mutants killed by its test file, with file:line:column, the code and the mutated code',
	m1.code === 0 && m1.stdout.includes('[Killed] ArithmeticOperator\ngeometry.js:30:21\n-     return Math.hypot(a.x - b.x, a.y - b.y);\n+     return Math.hypot(a.x + b.x, a.y - b.y);\nKilled by: tests/geometry.test.js\n'),
	`code ${m1.code}\n${block(m1.stdout)}\n${block(m1.stderr)}`,
);
check('mutate: main.js, which no test imports, has its mutants reported as NoCoverage', m1.stdout.includes('[NoCoverage] StringLiteral\nmain.js:6:13\n-   console.log(`${a} to ${b}: ${distance(a, b)}`);\n+   console.log(``);\n'), short(m1.stdout, 400));
check(
	"mutate: Stryker's score table, in its colours: total and covered score, killed, timeout, survived, no coverage, errors",
	m1.stdout.includes('File         |  total | covered | # killed | # timeout | # survived | # no cov | # errors |') &&
		m1.stdout.includes('All files    |  77.78 |  100.00 |        7 |         0 |          0 |        2 |        0 |') &&
		m1.raw.stdout.includes('All files    |\x1b[33m  77.78 \x1b[39m|\x1b[32m  100.00 \x1b[39m|') &&
		/Initial test run succeeded\. Ran 1 tests in .* \(net \d+ ms, overhead \d+ ms\)\./.test(m1.stdout),
	block(m1.stdout.slice(m1.stdout.indexOf('Ran '))),
);
check('mutate: Stryker is fetched for Mutate, once', served.filter((p) => /\/stryker-[\d.]+\.js$/.test(p)).length === 1, JSON.stringify(served.filter((p) => /stryker/.test(p))));
check('mutate: progress is shown as phases, as Stryker shows it', m1.phases.includes('Instrumenting') && m1.phases.includes('Mutation testing 9/9 (0 survived, 0 timed out)'), JSON.stringify(m1.phases));

// What the browser's bundle instruments must be what the npm package
// instruments under Node, byte for byte (tools/stryker.mjs replaces Node's
// modules; this is the check that it changed nothing).
const INSTRUMENT = [
	{ name: 'geometry.js', mutate: true, content: SAMPLE['geometry.js'] },
	{ name: 'shapes.ts', mutate: true, content: "export type Shape = { kind: 'circle'; r: number } | { kind: 'square'; side: number };\nexport function area(s: Shape): number {\n  switch (s.kind) {\n    case 'circle': return Math.PI * s.r ** 2;\n    case 'square': return s.side ** 2;\n  }\n}\nexport const names = (xs: string[]) => xs.filter((x) => /^a+b?$/.test(x) && x.length > 1).map((x) => x?.trim() ?? '');\nexport class Box { constructor(readonly w: number) {} get double(): number { return this.w * 2; } }\n" },
];
const INSTRUMENT_OPTIONS = { plugins: null, excludedMutations: [], ignorers: [] };
const LOG = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false };
const { Instrumenter } = await import('@stryker-mutator/instrumenter');
const inNode = JSON.stringify(await new Instrumenter(LOG).instrument(INSTRUMENT, INSTRUMENT_OPTIONS));
const strykerFile = served.find((p) => /\/stryker-[\d.]+\.js$/.test(p));
const inBrowser = await page.evaluate(
	async ([url, files, options]) => {
		// The bundle expects the runner's `process` (Babel reads process.env, path-browserify process.cwd()).
		globalThis.process ??= { env: {}, cwd: () => '/workspace' };
		const { Instrumenter } = await import(url);
		const log = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false };
		return JSON.stringify(await new Instrumenter(log).instrument(files, options));
	},
	[strykerFile, INSTRUMENT, INSTRUMENT_OPTIONS],
);
check("mutate: the bundle's instrumenter gives the npm package's mutants and instrumented code, byte for byte (JavaScript and TypeScript)", inBrowser === inNode, `${JSON.parse(inNode).mutants.length} mutants; ${inBrowser === inNode ? '' : `browser ${short(inBrowser, 300)} node ${short(inNode, 300)}`}`);

const COUNTER = {
	'counter.js': 'export function sumBelow(n) {\n  let sum = 0;\n  for (let i = 0; i < n; i++) sum += i;\n  return sum;\n}\n\nexport function isAdult(age) {\n  return age >= 18;\n}\n',
	'tests/counter.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sumBelow, isAdult } from '../counter.js';\n\ntest('sums below 4', () => assert.equal(sumBelow(4), 6));\ntest('30 is adult, 3 is not', () => {\n  assert.equal(isAdult(30), true);\n  assert.equal(isAdult(3), false);\n});\n",
};
const m2 = await mutateRun(COUNTER, 'counter.js');
check(
	'mutate: a boundary the tests miss survives, listed with the test file that ran',
	m2.code === 0 && m2.stdout.includes('[Survived] EqualityOperator\ncounter.js:8:10\n-     return age >= 18;\n+     return age > 18;\nTests ran:\n    tests/counter.test.js\n'),
	block(m2.stdout),
);
check(
	'mutate: i-- in a for loop never ends; the hit limit stops it and it counts as a Timeout',
	m2.stdout.includes('[Timeout] UpdateOperator\ncounter.js:3:26\n-     for (let i = 0; i < n; i++) sum += i;\n+     for (let i = 0; i < n; i--) sum += i;\n') && / timeout \|[\s\S]*All files[^\n]*\|\s+1 \|\s+1 \|\s+0 \|\s+0 \|\n/.test(m2.stdout),
	block(m2.stdout.slice(m2.stdout.indexOf('Ran '))),
);
const m3 = await mutateRun({ ...COUNTER, 'counter.js': COUNTER['counter.js'].replace('sum += i', 'sum += i + 1') }, 'counter.js');
check('mutate: a failing test stops it before any mutant runs, exit 1, with the failing report', m3.code === 1 && /There were failed tests in the initial test run\./.test(m3.stdout) && /✖ sums below 4/.test(m3.stdout) && !/\[Killed\]/.test(m3.stdout), block(m3.stdout));
const m4 = await mutateRun({ 'main.js': 'console.log(1);\n' });
check('mutate: without test files, exit 1 and the same message as Test', m4.code === 1 && /No test files found/.test(m4.stderr), short(m4.stderr));
const m5 = await mutateRun(TS_SAMPLE, 'main.ts');
check('mutate: TypeScript files are mutated as TypeScript, then stripped as Test strips them', m5.code === 0 && /^ geometry\.ts +\|/m.test(m5.stdout) && /\[Killed\] [A-Za-z]+\ngeometry\.ts:\d+:\d+\n/.test(m5.stdout), block(m5.stdout.slice(m5.stdout.indexOf('Ran '))));

const m6 = await mutateRun({
	'delay.js': 'export function delay(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n',
	'tests/delay.test.js': "import test from 'node:test';\nimport { delay } from '../delay.js';\ntest('waits', async () => {\n  await delay(5);\n});\n",
}, 'delay.js');
check(
	'mutate: a mutant whose promise never settles runs past its timeout (1.5 × net + 5000 ms + overhead); its worker is terminated and it counts as a Timeout',
	m6.code === 0 && m6.stdout.includes('[Timeout] ArrowFunction\ndelay.js:2:22\n-     return new Promise((resolve) => setTimeout(resolve, ms));\n+     return new Promise(() => undefined);\n') && m6.ms > 5000,
	`${m6.ms} ms\n${block(m6.stdout)}`,
);

// Stop terminates the worker the app started; the test workers it started
// end with it. The test file says it is alive on a BroadcastChannel while it
// runs, from inside the test workers, and must fall silent after Stop.
const ALIVE = {
	'tick.js': 'export const tick = (i) => i + 1;\n',
	'tests/tick.test.js': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { tick } from '../tick.js';\nconst channel = new BroadcastChannel('yukibana-alive');\ntest('ticks', async () => {\n  for (let i = 0; i < 20; i++) {\n    channel.postMessage(i);\n    assert.equal(tick(i), i + 1);\n    await new Promise((r) => setTimeout(r, 50));\n  }\n});\n",
};
const heard = await page.evaluate(
	(f) =>
		new Promise((done) => {
			const channel = new BroadcastChannel('yukibana-alive');
			let messages = 0;
			channel.onmessage = () => messages++;
			const w = new Worker('/packs/javascript/runner.js', { type: 'module' });
			w.onmessage = ({ data: m }) => {
				if (m.type !== 'phase' || !/^Mutation testing/.test(m.text)) return;
				// Mutants are running: let them run a little, then Stop.
				setTimeout(() => {
					const whileRunning = messages;
					w.terminate();
					setTimeout(() => {
						const afterStop = messages;
						setTimeout(() => done({ whileRunning, afterStop, later: messages }), 1500);
					}, 100);
				}, 400);
			};
			w.postMessage({ type: 'mutate', files: f, entry: 'tick.js', stdin: null });
		}),
	ALIVE,
);
check('mutate: Stop ends the test workers it started too: they fall silent', heard.whileRunning > 0 && heard.later === heard.afterStop, JSON.stringify(heard));

check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
