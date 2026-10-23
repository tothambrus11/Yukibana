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
// must agree line for line (durations aside).

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
const run = (files, entry = 'main.js', inputs = []) => page.evaluate(([f, e, i]) => window.runProgram('run', f, e, i), [files, entry, inputs]);
const test = (files) => page.evaluate((f) => window.runProgram('test', f, 'main.js'), files);

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
const node = spawnSync(process.execPath, ['--test', '--test-reporter=spec'], { cwd: dir, encoding: 'utf8' });
await rm(dir, { recursive: true, force: true });
// Durations differ; Node's error details (stacks into node:internal, the
// error's own properties) are not reproduced, so the failing-tests list is
// compared by its `test at` and `✖` lines only.
const comparable = (report) =>
	report
		.replace(/ \([\d.]+ms\)/g, '')
		.replace(/duration_ms [\d.]+/, 'duration_ms')
		.split('\n')
		.filter((line, i, all) => {
			const failing = all.indexOf('✖ failing tests:');
			return failing < 0 || i <= failing || /^(test at |✖ )/.test(line);
		})
		.join('\n')
		.trim();
const ours = comparable(t3.stdout);
const theirs = comparable(node.stdout);
const diff = ours.split('\n').map((l, i) => (l === theirs.split('\n')[i] ? null : `line ${i + 1}: ours ${JSON.stringify(l)} node ${JSON.stringify(theirs.split('\n')[i])}`)).filter(Boolean);
check(
	`test: the report matches \`node --test\` (Node ${process.version}) line for line: hooks, subtests, skip/todo, timeouts, assertion messages`,
	ours === theirs && t3.code === (node.status ?? -1),
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

check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
