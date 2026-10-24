// Drives the built app in Chromium the way a person would, once per
// language whose pack is built: selects the language, waits for its server,
// checks the sample has no errors, then types an error, a member access and
// asks for hover and go-to-definition across files.
//
//   npm run build && node tests/e2e.mjs [language ...]
//
// Serves app/build with ../serve.py on a free port. Exits non-zero naming
// every check that failed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
// BUILD_DIR: another build of the app, such as one in a scratch folder.
const build = process.env.BUILD_DIR ?? join(here, '..', 'build');

/**
 * Per language: the file to edit, text appended to make an error, a member
 * access whose completion must offer `member`, a word in the entry file
 * whose definition lives in `definitionFile`, and a word to hover.
 */
const CASES = {
	python: { output: 'Point(x=0, y=0) to Point(x=3, y=4): 5.0', testOutput: '6 passed', file: 'main.py', error: '\nundefined_name_xyz\n', access: '\nPoint(1, 2).', member: 'norm', definition: 'distance', definitionFile: 'geometry.py', hover: 'Point' },
	javascript: { output: '(0, 0) to (3, 4): 5', testOutput: 'ℹ pass 4', mutateOutput: 'All files    |  77.78 |  100.00 |', file: 'main.js', error: '\na.nope();\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'geometry.js', hover: 'Point' },
	// TypeScript and web projects are served by the JavaScript pack (`pack`).
	typescript: { pack: 'javascript', output: '(0, 0) to (3, 4): 5', testOutput: 'ℹ pass 4', mutateOutput: ' geometry.ts |', file: 'main.ts', error: '\nconst wrong: number = "no";\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'geometry.ts', hover: 'Point' },
	web: { pack: 'javascript', file: 'main.ts', error: '\nconst wrong: number = "no";\n', access: '\ncounter.', member: 'increment', definition: 'Counter', definitionFile: 'counter.ts', hover: 'Counter' },
	// One file, and p5.js's declarations, whose definitions are dropped as a lib's are: no definition to go to.
	p5: { pack: 'javascript', file: 'main.ts', error: '\nconst wrong: number = "no";\n', access: '\nnew p5((q) => q.circ', member: 'circle', hover: 'createCanvas' },
	cpp: { output: '5.000000', testOutput: '[  PASSED  ] 3 tests.', file: 'main.cpp', error: '\nint broken = undeclared_xyz;\n', access: '\nvoid f(Point p) { p.', member: 'norm', definition: 'distance', definitionFile: 'geometry', hover: 'Point' },
	swift: { output: 'to', testOutput: 'Executed 2 tests, with 0 failures', file: 'main.swift', error: '\nlet x: Int = "no"\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.swift', hover: 'Point' },
	scala: { output: 'to', file: 'Main.scala', error: '\nval broken: Int = "no"\n', access: '\nval q = Point(1, 2)\nval r = q.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.scala', hover: 'Point' },
	rust: { output: '(0, 0) to (3, 4): 5', testOutput: 'test result: ok. 3 passed', file: 'main.rs', error: '\nfn broken() -> i32 { "no" }\n', access: '\nfn f(p: Point) -> f64 { p.', member: 'norm', definition: 'distance', definitionFile: 'point.rs', hover: 'Point' },
	php: { output: '(0, 0) to (3, 4): 5', testOutput: 'OK (5 tests, 5 assertions)', file: 'main.php', error: '\n$b->nope();\n', access: '\n$b->', member: 'norm', definition: 'distance', definitionFile: 'geometry.php', hover: 'Point' },
	java: { output: 'Point[x=0.0, y=0.0] to Point[x=3.0, y=4.0]: 5.0', testOutput: '3 tests successful', file: 'Main.java', error: '\nclass Broken { int n = "no"; }\n', access: '\nclass Probe { double f(Point p) { return p.', member: 'norm', definition: 'Point', definitionFile: 'Point.java', hover: 'Point' },
	// Syntax only, and no runner (packs/kotlin/README.md): the error is a syntax error.
	kotlin: { file: 'Main.kt', error: '\nfun broken() { val = 1 }\n', access: '\nval q = Point(1.0, 2.0)\nval r = q.', member: 'norm', definition: 'Point', definitionFile: 'Geometry.kt', hover: 'Point' },
	// Haskell has no member access: the completion is of a name Main imports.
	// A constructor to jump from, as the grammar gives names applied in
	// brackets no span of their own.
	haskell: { output: '(0.0, 0.0) to (3.0, 4.0): 5.0', testOutput: '4 examples, 0 failures', file: 'Main.hs', error: '\nbroken :: Int\nbroken = True\n', access: '\nprobe = dis', member: 'distance', definition: 'Circle', definitionFile: 'Geometry.hs', hover: 'Point' },
};

const only = process.argv.slice(2);
const languages = Object.keys(CASES).filter((l) => (only.length ? only.includes(l) : existsSync(join(build, 'packs', CASES[l].pack ?? l, 'server.js'))));
const failures = [];

const port = await new Promise((resolve) => {
	const s = createServer().listen(0, () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
const server = spawn('python3', [join(here, '..', '..', 'serve.py'), build, '--port', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
try {
	for (const language of languages) {
		try {
			await run(language, CASES[language]);
		} catch (e) {
			console.log(`FAIL ${language}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
			failures.push(`${language}: ${e}`);
		}
	}
	if (languages.includes('python') && languages.includes('javascript')) await switching();
	await downloading();
	if (languages.includes('python') && languages.includes('web')) await lazyServices();
	if (languages.includes('python')) await offlineUse();
} finally {
	await browser.close();
	server.kill();
}

if (failures.length) {
	console.error(`\n${failures.length} check(s) failed:\n` + failures.map((f) => `  - ${f}`).join('\n'));
	process.exit(1);
}
console.log(`\nall checks passed for ${languages.join(', ')}`);

async function run(language, c) {
	const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	// Every URL the page and its workers ask for, for the checks of what a use case downloads.
	const requests = [];
	page.context().on('request', (r) => requests.push(r.url()));
	// `?trace` logs every LSP message to the console (cut at 2000 characters)
	// and exposes `monaco`, for the checks that need to see what was asked.
	const lspLog = [];
	page.on('console', (m) => {
		if (m.type() === 'debug' && m.text().startsWith('lsp ')) lspLog.push(m.text());
	});
	const check = (ok, what) => {
		console.log(`${ok ? 'ok  ' : 'FAIL'} ${language}: ${what}`);
		if (!ok) failures.push(`${language}: ${what}`);
	};
	const t0 = Date.now();
	await page.goto(`http://127.0.0.1:${port}/?trace`);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await page.selectOption('header select', language);
	const status = page.locator('footer .state');
	const started = await status
		.filter({ hasNotText: /Starting|Downloading|stopped/ })
		.waitFor({ timeout: 240_000 })
		.then(() => true, () => false);
	const statusText = (await status.textContent())?.trim();
	check(started && !/failed/.test(statusText ?? ''), `server running (${statusText}) after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	if (!started || /failed/.test(statusText ?? '')) {
		console.log((await page.locator('.output .lines').textContent())?.slice(-1500));
		await page.close();
		return;
	}

	const errorCount = page.locator('footer .counts span[title=Errors]');
	await page.waitForTimeout(3000);
	check((await errorCount.textContent())?.trim() === '0', `sample has no errors (has ${(await errorCount.textContent())?.trim()})`);

	const editor = page.locator('.dv-groupview .monaco-editor').first();
	await editor.click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(c.error);
	const sawError = await page.waitForFunction(() => document.querySelector('footer .counts span[title=Errors]')?.textContent?.trim() !== '0', null, { timeout: 30_000 }).then(() => true, () => false);
	check(sawError, 'an introduced error is reported');

	await page.keyboard.type(c.access);
	await page.keyboard.press('Control+Space');
	const suggest = page.locator('.suggest-widget .monaco-list-row');
	const completed = await suggest.filter({ hasText: c.member }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
	const offered = (await suggest.allTextContents()).slice(0, 8).join(' | ');
	check(completed, `completion offers ${c.member} (offered: ${offered.slice(0, 160)})`);
	await page.keyboard.press('Escape');

	// Back to the sample's text for hover and definition.
	await page.keyboard.press('Control+z');
	for (let i = 0; i < 40; i++) await page.keyboard.press('Control+z');
	// A span that is the word, or (Monaco's PHP grammar) the word after the spaces (rendered as U+00A0) and operators before it.
	const word = (w) => page.locator('.dv-groupview .view-line span', { hasText: new RegExp(`^[\\s.=]*${w}$`) }).first();
	await word(c.hover).hover();
	const hovered = await page.locator('.monaco-hover-content').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(hovered, `hover on ${c.hover} shows ${hovered ? JSON.stringify((await page.locator('.monaco-hover-content').first().textContent())?.slice(0, 80)) : 'nothing'}`);
	await page.mouse.move(0, 0);

	if (c.definition) {
		await word(c.definition).click();
		await page.keyboard.press('F12');
		const jumped = await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: c.definitionFile }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
		check(jumped, `go to definition of ${c.definition} opens ${c.definitionFile}`);
	}

	if (c.output && existsSync(join(build, 'packs', c.pack ?? language, 'runner.js'))) {
		await page.locator('header button.run').click();
		const status = page.locator('.terminal .status');
		const ended = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout: 240_000 }).then(() => true, () => false);
		const shown = (await page.locator('.terminal pre').textContent()) ?? '';
		check(ended && /code 0/.test((await status.textContent()) ?? '') && shown.includes(c.output), `Run prints "${c.output}" (${(await status.textContent())?.trim()}: ${JSON.stringify(shown.slice(0, 200))})`);
	}

	if (c.testOutput && existsSync(join(build, 'packs', c.pack ?? language, 'runner.js'))) {
		await page.locator('header button', { hasText: /^Test$/ }).click();
		const status = page.locator('.terminal .status');
		const ended = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout: 240_000 }).then(() => true, () => false);
		const shown = (await page.locator('.terminal pre').textContent()) ?? '';
		check(ended && /code 0/.test((await status.textContent()) ?? '') && shown.includes(c.testOutput), `Test runs the sample's tests: "${c.testOutput}" (${(await status.textContent())?.trim()}: ${JSON.stringify(shown.slice(-160))})`);
		// The test tools print ANSI colours (all but Swift's XCTest, which has
		// none): the terminal shows them as styled spans, and its text, what
		// a copy yields, has no escape sequences left.
		const colours = await page.locator('.terminal pre span[style*="color"]').count();
		check(!shown.includes('\x1b') && (language === 'swift' ? colours === 0 : colours > 0), `the test report's colours are rendered, its text is plain (${colours} coloured spans)`);
	}

	// Mutate (StrykerJS, packs/javascript/README.md "Mutation testing"): the
	// button is there only for languages whose runner mutation-tests, and
	// ends with Stryker's score table.
	const mutateButton = page.locator('header button', { hasText: /^Mutate$/ });
	check((await mutateButton.count()) === (c.mutateOutput ? 1 : 0), `the Mutate button is ${c.mutateOutput ? 'shown' : 'absent'}`);
	if (c.mutateOutput && existsSync(join(build, 'packs', c.pack ?? language, 'runner.js'))) {
		await mutateButton.click();
		const status = page.locator('.terminal .status');
		const ended = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout: 240_000 }).then(() => true, () => false);
		const shown = (await page.locator('.terminal pre').textContent()) ?? '';
		check(ended && /code 0/.test((await status.textContent()) ?? '') && shown.includes(c.mutateOutput) && shown.includes('% Mutation score'), `Mutate mutation-tests the sample: "${c.mutateOutput}" (${(await status.textContent())?.trim()}: ${JSON.stringify(shown.slice(-900))})`);
	}

	if (language === 'javascript') await settings(page, check);
	if (language === 'web') await previewing(page, check);
	if (language === 'web') await webServices(page, check);
	if (language === 'web') check(!requests.some((u) => /\/(p5-|packages-p5-)[\d.]+\.js(on)?$/.test(u)), 'a web project that does not import p5 downloads nothing of p5.js');
	if (language === 'p5') await sketching(page, check, requests);
	if (language === 'python') await peek(page, check);
	if (language === 'cpp') await cppBridge(page, check, lspLog);
	if (language === 'typescript') await renameFromUse(page, check);
	if (language === 'python') await undoRename(page, check, { file: 'main.py', needle: 'distance(a, b)', from: 'distance', name: 'dist3', declarationFile: 'geometry.py', declaration: 'def dist3(', edit: '\n# edited\n' });
	if (language === 'swift' && existsSync(join(build, 'packs', 'swift', 'runner.js'))) await swiftMacros(page, check, requests);
	if (language === 'cpp' && existsSync(join(build, 'packs', 'cpp', 'runner.js'))) await testFrameworks(page, check);
	if (language === 'cpp') {
		if (existsSync(join(build, 'packs', 'cpp', 'cc-cross.wasm')) && existsSync(join(build, 'packs', 'cpp', 'vm.js'))) await cppTargets(page, check, requests);
		else console.log('skip cpp: targets, Linux runs and compiler output views (packs/cpp has no cc-cross.wasm or vm.js)');
	}
	// After cppTargets, which checks that nothing before it fetched the views.
	if (language === 'cpp' && existsSync(join(build, 'packs', 'cpp', 'explorer.js'))) await cppOptimization(page, check);
	if (language === 'cpp' && existsSync(join(build, 'packs', 'cpp', 'sanitizer.js'))) await cppSanitizers(page, check, requests);
	if ((language === 'swift' || language === 'scala') && existsSync(join(build, 'packs', language, 'runner.js'))) await savedOptimization(page, check, language);

	check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
	await page.close();
}

/**
 * Swift macros (packs/swift/README.md "Macros"): main.swift rewritten to use
 * `@Observable` and a `#stringify` it declares is clean, and Run prints what
 * they expand to; the sample's tests rewritten for swift-testing (`@Test`,
 * `#expect`) pass on Test. The macro plugins and swift-testing are fetched
 * then, and not before.
 */
async function swiftMacros(page, check, requests) {
	const fetched = (name) => requests.some((u) => u.endsWith(`/packs/swift/${name}`));
	check(!fetched('SwiftMacroPlugins.wasm') && !fetched('swift-testing.tar'), 'the sample, which uses no macro, fetched neither the macro plugins nor swift-testing');
	await setText(page, 'main.swift', `import Observation

@freestanding(expression)
macro stringify<T>(_ value: T) -> (T, String) = #externalMacro(module: "StringifyMacros", type: "StringifyMacro")

@Observable
final class Counter {
    var count = 0
}

let counter = Counter()
withObservationTracking { _ = counter.count } onChange: { print("observed a change") }
counter.count += 1
let (value, source) = #stringify(counter.count * 2)
print("\\(source) = \\(value)")
`);
	const errorCount = page.locator('footer .counts span[title=Errors]');
	await page.waitForTimeout(3000);
	const clean = await errorCount.filter({ hasText: /^0$/ }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
	check(clean && fetched('SwiftMacroPlugins.wasm'), `a main.swift using @Observable and #stringify has no errors (${(await errorCount.textContent())?.trim()}), the plugins fetched for it`);
	await page.locator('header button.run').click();
	let r = await ended(page, 240_000);
	check(r.done && /code 0/.test(r.status) && r.shown.includes('observed a change') && r.shown.includes('counter.count * 2 = 2'), `Run expands the macros: ${r.status}: ${JSON.stringify(r.shown.slice(-120))}`);
	await setText(page, 'Tests/GeometryTests.swift', `import Testing
@testable import App

@Test func norm() {
    #expect(Point(x: 3, y: 4).norm() == 5)
}

@Test("distance is symmetric") func symmetric() {
    let a = Point(x: 1, y: 2), b = Point(x: -3, y: 5)
    #expect(distance(a, b) == distance(b, a))
}
`);
	await page.locator('header button', { hasText: /^Test$/ }).click();
	r = await ended(page, 240_000);
	check(r.done && /code 0/.test(r.status) && /Test run with 2 tests in 0 suites passed/.test(r.shown) && fetched('swift-testing.tar'),
		`Test runs swift-testing's @Test functions: ${r.status}: ${JSON.stringify(r.shown.slice(-200))}`);
}

/**
 * A C++ project's test framework: the header's choice shows GoogleTest for
 * the sample, rewrites the sample's tests for doctest and then Catch2, and
 * Test passes with each; back to GoogleTest at the end.
 */
async function testFrameworks(page, check) {
	const choice = page.locator('header .framework select');
	check((await choice.inputValue()) === 'gtest', `the test framework choice shows GoogleTest for the sample (${await choice.inputValue()})`);
	for (const [framework, passed] of [['doctest', 'Status: SUCCESS!'], ['catch2', 'All tests passed (4 assertions in 3 test cases)'], ['gtest', '[  PASSED  ] 3 tests.']]) {
		await choice.selectOption(framework);
		const converted = await page.locator('.dv-groupview .view-lines').first().filter({ hasText: framework === 'gtest' ? 'gtest/gtest.h' : `${framework}/` }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
		check(converted && (await choice.inputValue()) === framework, `choosing ${framework} rewrites and shows tests/geometry_test.cpp, and the choice says ${await choice.inputValue()}`);
		await page.locator('header button', { hasText: /^Test$/ }).click();
		const status = page.locator('.terminal .status');
		const ended = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout: 240_000 }).then(() => true, () => false);
		const shown = (await page.locator('.terminal pre').textContent()) ?? '';
		const colours = await page.locator('.terminal pre span[style*="color"]').count();
		check(ended && /code 0/.test((await status.textContent()) ?? '') && shown.includes(passed) && colours > 0, `Test with ${framework} passes: "${passed}", ${colours} coloured spans (${(await status.textContent())?.trim()}: ${JSON.stringify(shown.slice(-160))})`);
		// clangd finds the framework's headers in its sysroot: no errors on the rewritten file.
		const errors = page.locator('footer .counts span[title="Errors"]');
		const clean = await errors.filter({ hasText: /^0$/ }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
		check(clean, `clangd resolves the ${framework} headers: ${(await errors.textContent())?.trim()} errors`);
	}
}

/** The pack files of the C++ pack among `urls`, as paths under packs/cpp/. */
function cppPackFiles(urls) {
	return [...new Set(urls.map((u) => /\/packs\/cpp\/([^?#]*)/.exec(u)?.[1]).filter(Boolean))].sort();
}

/** Waits for the terminal's run to end; returns its status line and text. */
async function ended(page, timeout = 300_000) {
	const status = page.locator('.terminal .status');
	const done = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout }).then(() => true, () => false);
	return { done, status: ((await status.textContent()) ?? '').trim(), shown: (await page.locator('.terminal pre').textContent()) ?? '' };
}

/** Replaces a project file's text through its model, as an edit. */
function setText(page, path, text) {
	return page.evaluate(([path, text]) => globalThis.monaco.editor.getModels().find((m) => m.uri.path === `/workspace/${path}`)?.setValue(text), [path, text]);
}

/** The text a compiler output view shows (`llvm-ir` or `asm`). */
function viewText(page, kind) {
	return page.evaluate((kind) => globalThis.monaco.editor.getModel(globalThis.monaco.Uri.parse(`yukibana-output:/${kind}`))?.getValue() ?? '', kind);
}

/** Waits until `predicate(text of view kind)` holds; returns whether it did, and the text. */
async function viewShows(page, kind, predicate, timeout) {
	const t0 = Date.now();
	let text = '';
	while (Date.now() - t0 < timeout) {
		text = await viewText(page, kind);
		if (predicate(text)) return { ok: true, text, seconds: (Date.now() - t0) / 1000 };
		await page.waitForTimeout(250);
	}
	return { ok: false, text, seconds: (Date.now() - t0) / 1000 };
}


/**
 * The C++ optimisation level (optimization.ts): the picker starts at -O2 with
 * no -O line in compile_flags.txt; choosing -O0 appends one, the assembly
 * view follows (its toolbar names the flag, and unoptimised code is longer),
 * Run still prints the sample's output, and choosing -O2 again removes the
 * line. Ends on the sample, its views closed by Reset project.
 */
async function cppOptimization(page, check) {
	const picker = page.locator('header .optimization select');
	const flags = await modelText(page, 'compile_flags.txt');
	check((await picker.inputValue()) === '-O2' && !/^-O/m.test(flags ?? ''), `the sample is at -O2, the default, with no -O line (${await picker.inputValue()})`);
	await openFile(page, 'geometry.cpp');
	await page.locator('header button.view', { hasText: /^Asm$/ }).click();
	const o2 = await viewShows(page, 'asm', (t) => t.includes('distance'), 240_000);
	const shownFlags = () => page.locator('[data-view="asm"] .yk-view-flags').getAttribute('title').catch(() => '');
	check(o2.ok && / -O2( |$)/.test((await shownFlags()) ?? ''), `the assembly view compiles at -O2 (${await shownFlags()})`);
	const instructions = (t) => t.split('\n').filter((l) => /^\s+\S/.test(l)).length;

	await picker.selectOption('-O0');
	const text = (await modelText(page, 'compile_flags.txt')) ?? '';
	check(text === `${flags}-O0\n` && (await picker.inputValue()) === '-O0', `choosing -O0 appends -O0 to compile_flags.txt (${JSON.stringify(text)})`);
	const o0 = await viewShows(page, 'asm', (t) => t !== o2.text && t.includes('distance'), 60_000);
	check(o0.ok && / -O0( |$)/.test((await shownFlags()) ?? '') && instructions(o0.text) > instructions(o2.text), `the assembly follows: -O0 in its toolbar, ${instructions(o0.text)} instructions against -O2's ${instructions(o2.text)} (${o0.seconds.toFixed(1)} s)`);
	await page.locator('header button.run').click();
	const ran = await ended(page);
	check(ran.done && ran.shown.includes('5.000000') && /Exited with code 0 /.test(ran.status), `Run at -O0 prints the sample's output (${ran.status})`);

	await picker.selectOption('-O2');
	check((await modelText(page, 'compile_flags.txt')) === flags, 'choosing -O2, the default, removes the -O line again');
	await setText(page, 'compile_flags.txt', `${flags}-Og\n`);
	await page.waitForTimeout(300);
	check((await picker.inputValue()) === 'other' && (await picker.locator('option[value="other"]').textContent()) === '-Og', `a hand-written -Og is shown as it is (${await picker.inputValue()})`);
	page.once('dialog', (d) => void d.accept());
	await page.locator('header button', { hasText: 'Reset project' }).click();
	const reset = await page.waitForFunction(() => globalThis.monaco.editor.getModels().find((m) => m.uri.path === '/workspace/compile_flags.txt')?.getValue().startsWith('-std='), null, { timeout: 15_000 }).then(() => true, () => false);
	check(reset && (await picker.inputValue()) === '-O2', `Reset project puts the sample back at -O2 (${await picker.inputValue()})`);
}

/**
 * The C++ sanitizers (cpp-sanitizers.ts, packs/cpp README "Sanitizers"):
 * nothing of them is fetched until one is on; ticking AddressSanitizer
 * appends its -fsanitize= line; a heap buffer overflow in main.cpp is then
 * reported in the terminal (sum inlined into main, so named as -gline-tables-only
 * names it, without parameters, as natively), its frames naming main.cpp's lines as links
 * that open the file there, and the program exits 1. Ends on the sample,
 * by Reset project.
 */
async function cppSanitizers(page, check, requests) {
	const fetched = (name) => requests.some((u) => u.endsWith(`/packs/cpp/${name}`));
	check(!fetched('asan.tar') && !fetched('ubsan.tar') && !fetched('sanitizer.js'), 'nothing of the sanitizers is fetched before one is on');
	const flags = (await modelText(page, 'compile_flags.txt')) ?? '';
	const menu = page.locator('header .sanitizers-menu');
	await menu.locator('button.toggle').click();
	await menu.locator('label', { hasText: 'AddressSanitizer' }).locator('input').check();
	await page.keyboard.press('Escape');
	const text = (await modelText(page, 'compile_flags.txt')) ?? '';
	check(text === `${flags}-fsanitize=address\n` && (await menu.locator('button.toggle').textContent())?.trim() === 'ASan', `ticking AddressSanitizer appends -fsanitize=address to compile_flags.txt (${JSON.stringify(text)})`);

	const program = ['#include <cstdio>', '', 'int sum(const int *a, int n) {', '    int s = 0;', '    for (int i = 0; i <= n; i++) s += a[i];', '    return s;', '}', '', 'int main() {', '    int *a = new int[4]{1, 2, 3, 4};', '    std::printf("%d\\n", sum(a, 4));', '    delete[] a;', '}', ''].join('\n');
	await openFile(page, 'main.cpp');
	await setText(page, 'main.cpp', program);
	await page.locator('header button.run').click();
	const ran = await ended(page);
	check(ran.done && /Exited with code 1 /.test(ran.status) && ran.shown.includes('ERROR: AddressSanitizer: heap-buffer-overflow') && ran.shown.includes('in sum main.cpp:5:39') && ran.shown.includes('in main main.cpp:11:25') && ran.shown.includes('SUMMARY: AddressSanitizer: heap-buffer-overflow main.cpp:5:39 in sum'), `Run reports the overflow at main.cpp:5:39 and exits 1 (${ran.status}): ${ran.shown.split('\n').filter((l) => /#\d|SUMMARY|ERROR/.test(l)).slice(0, 4).join(' | ')}`);
	check(fetched('asan.tar') && fetched('sanitizer.js') && !fetched('ubsan.tar'), 'the run fetched the AddressSanitizer runtime and nothing of UBSan');

	await openFile(page, 'geometry.h');
	const link = page.locator('.terminal button.place', { hasText: 'main.cpp:10:14' }).first();
	const linked = await link.waitFor({ timeout: 5_000 }).then(() => true, () => false);
	if (linked) await link.click();
	const at = await page.waitForFunction(() => globalThis.monaco.editor.getEditors().some((e) => e.getModel()?.uri.path === '/workspace/main.cpp' && e.getPosition()?.lineNumber === 10), null, { timeout: 5_000 }).then(() => true, () => false);
	check(linked && at, 'the allocation frame main.cpp:10:14 is a link that opens main.cpp at line 10');

	page.once('dialog', (d) => void d.accept());
	await page.locator('header button', { hasText: 'Reset project' }).click();
	const reset = await page.waitForFunction(() => !/-fsanitize/.test(globalThis.monaco.editor.getModels().find((m) => m.uri.path === '/workspace/compile_flags.txt')?.getValue() ?? '-fsanitize'), null, { timeout: 15_000 }).then(() => true, () => false);
	check(reset && (await menu.locator('button.toggle').textContent())?.trim() === 'Sanitizers', 'Reset project turns the sanitizers off again');
}

/**
 * The Optimization select of a language whose level is saved with the
 * project (optimization.ts: Swift, Scala): it starts at the default and
 * disables what does not work yet; a level chosen survives a reload and Run
 * still prints the sample's output; Reset project returns to the default.
 */
async function savedOptimization(page, check, language) {
	const picker = page.locator('header .optimization select');
	const { start, choose, disabled } = language === 'swift' ? { start: '-Onone', choose: null, disabled: ['-O', '-Osize'] } : { start: 'off', choose: 'on', disabled: [] };
	check((await picker.inputValue()) === start, `the Optimization select starts at ${start} (${await picker.inputValue()})`);
	const off = await picker.locator('option:disabled').evaluateAll((options) => options.map((o) => o.value));
	check(off.join() === disabled.join(), `levels not available yet are disabled (${off.join(', ') || 'none'})`);
	if (!choose) return;
	await picker.selectOption(choose);
	await page.locator('.dv-tab .dock-tab', { hasText: /^Output$/ }).first().click();
	const said = await page.waitForFunction(() => [...document.querySelectorAll('.output')].some((o) => o.textContent?.includes('Optimization: Optimizer on, for Run.')), null, { timeout: 5_000 }).then(() => true, () => false);
	check(said, 'choosing a level says so in the output panel');
	await page.waitForTimeout(1500);
	await page.reload();
	const kept = await page.locator('header .optimization select').waitFor({ timeout: 60_000 }).then(async () => (await picker.inputValue()) === choose, () => false);
	check(kept, `${choose} is saved with the project and still chosen after a reload (${await picker.inputValue().catch(() => '?')})`);
	await page.locator('header button.run').click();
	const ran = await ended(page);
	check(ran.done && ran.shown.includes(CASES[language].output) && /Exited with code 0 /.test(ran.status), `Run at ${choose} prints the sample's output (${ran.status})`);
	page.once('dialog', (d) => void d.accept());
	await page.locator('header button', { hasText: 'Reset project' }).click();
	const reset = await page.waitForFunction((v) => document.querySelector('header .optimization select')?.value === v, start, { timeout: 15_000 }).then(() => true, () => false);
	check(reset, `Reset project puts the sample back at ${start}`);
}

/**
 * C++ cross-compilation targets (cpp-targets.ts), Linux runs under QEMU and
 * the compiler output views. Runs after the default-target checks of the
 * same page, whose downloads must not include anything of this.
 */
async function cppTargets(page, check, requests) {
	// Four threads, each adding a million to an atomic and, under a mutex, to a plain counter.
	const THREADS = `#include <atomic>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

int main() {
    std::atomic<long> counted{0};
    long locked = 0;
    std::mutex mu;
    std::vector<std::thread> pool;
    for (int t = 0; t < 4; ++t)
        pool.emplace_back([&] {
            for (int i = 0; i < 1000000; ++i) {
                counted.fetch_add(1, std::memory_order_relaxed);
                std::lock_guard<std::mutex> guard(mu);
                ++locked;
            }
        });
    for (auto &t : pool) t.join();
    std::printf("atomic=%ld mutex=%ld\\n", counted.load(), locked);
}
`;
	const forbidden = ['cc-cross', 'targets/', 'vm.js', 'vm/', 'user/', 'explorer.js', 'demangle'];
	const before = cppPackFiles(requests);
	check(!before.some((f) => forbidden.some((x) => f.includes(x))), `editing, Run and Test on WebAssembly fetch nothing of the Linux targets or views (${before.join(', ')})`);

	const picker = page.locator('header .target select');
	const testButton = page.locator('header button.test');
	const errorCount = page.locator('footer .counts span[title=Errors]');
	const warningCount = page.locator('footer .counts span[title=Warnings]');
	const sample = await modelText(page, 'main.cpp');
	const flags = await modelText(page, 'compile_flags.txt');
	const archs = { x86_64: ['x86_64-linux', 'x86_64-linux-musl', '__x86_64__'], aarch64: ['aarch64-linux', 'aarch64-linux-musl', '__aarch64__'], riscv64: ['riscv64-linux', 'riscv64-linux-musl', '__riscv'] };

	for (const [arch, [id, triple, macro]] of Object.entries(archs)) {
		const from = requests.length;
		await picker.selectOption(id);
		const text = (await modelText(page, 'compile_flags.txt')) ?? '';
		check(text === `--target=${triple}\n${flags}`, `choosing ${arch} puts --target=${triple} first in compile_flags.txt (${JSON.stringify(text)})`);
		check(!(await testButton.isDisabled()), `on ${arch}, Test is enabled`);

		// clangd parses for the target: its macro is defined (the #warning proves the file was parsed), the wrong-target #error is not hit.
		await openFile(page, 'main.cpp');
		// As one edit, not typed: Enter after a macro name would accept a completion.
		await page.evaluate((text) => {
			const editor = globalThis.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path === '/workspace/main.cpp');
			editor.pushUndoStop();
			editor.executeEdits('e2e', [{ range: new globalThis.monaco.Range(1, 1, 1, 1), text }]);
			editor.pushUndoStop();
			editor.focus();
		}, `#ifndef ${macro}\n#error wrong target\n#endif\n#ifdef ${macro}\n#warning right target\n#endif\n`);
		const parsed = await warningCount.filter({ hasNotText: /^0$/ }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
		const clean = await errorCount.filter({ hasText: /^0$/ }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
		check(parsed && clean, `clangd parses main.cpp for ${arch}: ${macro} is defined (${(await warningCount.textContent())?.trim()} warnings, ${(await errorCount.textContent())?.trim()} errors)`);
		for (let i = 0; i < 40 && (await modelText(page, 'main.cpp')) !== sample; i++) await page.keyboard.press('Control+z');
		check((await modelText(page, 'main.cpp')) === sample, `undo restores main.cpp on ${arch}`);

		await page.locator('header button.run').click();
		const r = await ended(page);
		check(r.done && /code 0/.test(r.status) && r.shown.includes('5.000000'), `Run on ${arch} (QEMU, system mode) prints 5.000000 (${r.status}: ${JSON.stringify(r.shown.slice(-300))})`);
		if (arch === 'x86_64') {
			// The sample's GoogleTest tests, built for Linux (targets/x86_64/gtest.tar) and run under QEMU.
			await testButton.click();
			const tested = await ended(page, 600_000);
			check(tested.done && /code 0/.test(tested.status) && tested.shown.includes('[  PASSED  ] 3 tests.'), `Test on ${arch} runs the sample's GoogleTest tests under QEMU (${tested.status}: ${JSON.stringify(tested.shown.slice(-200))})`);
		}

		const threads = arch === 'x86_64' ? 4 : 1;
		await page.locator('header .run-options button.toggle').click();
		await page.locator('header .run-options select').selectOption(String(threads));
		await page.keyboard.press('Escape');
		await setText(page, 'main.cpp', THREADS);
		await page.locator('header button.run').click();
		const t = await ended(page, 600_000);
		check(t.done && /code 0/.test(t.status) && t.shown.includes('atomic=4000000 mutex=4000000'), `4 threads on ${arch} with ${threads} CPU(s) count exactly (${t.status}: ${JSON.stringify(t.shown.slice(-200))})`);

		if (arch === 'aarch64') {
			await setText(page, 'main.cpp', 'int main() {\n    volatile int *p = nullptr;\n    return *p;\n}\n');
			await page.locator('header button.run').click();
			const segv = await ended(page);
			check(segv.done && /code 139/.test(segv.status) && segv.shown.includes('signal 11'), `a null dereference on aarch64 exits 139 with signal 11 (${segv.status}: ${JSON.stringify(segv.shown.slice(-200))})`);
		}
		await setText(page, 'main.cpp', sample);
		await page.locator('header .run-options button.toggle').click();
		await page.locator('header .run-options select').selectOption('1');
		await page.keyboard.press('Escape');

		const files = cppPackFiles(requests.slice(from));
		const others = Object.keys(archs).filter((a) => a !== arch);
		const foreign = files.filter((f) => others.some((a) => f.startsWith(`vm/${a}/`) || f.startsWith(`targets/${a}/`) || f.startsWith(`user/${a}/`)));
		check(foreign.length === 0, `${arch} fetches no file of another architecture (${files.join(', ')})`);
	}

	// The views, on x86_64.
	await picker.selectOption('x86_64-linux');
	await openFile(page, 'main.cpp');
	await page.locator('header button.view', { hasText: /^IR$/ }).click();
	const ir = await viewShows(page, 'llvm-ir', (t) => t.includes('target triple = "x86_64-unknown-linux-musl"') && t.includes('define'), 240_000);
	check(ir.ok && !ir.text.includes('!dbg'), `the LLVM IR view shows main.cpp's IR for x86_64, without !dbg (${ir.seconds.toFixed(1)} s; ${JSON.stringify(ir.text.slice(0, 160))})`);
	await page.locator('header button.view', { hasText: /^Asm$/ }).click();
	const asm = await viewShows(page, 'asm', (t) => /^main:/m.test(t) && t.includes('distance(Point const&, Point const&)'), 120_000);
	check(asm.ok, `the assembly view shows main: and calls distance(Point const&, Point const&), demangled (${asm.seconds.toFixed(1)} s; ${JSON.stringify(asm.text.slice(0, 200))})`);
	const tabs = await page.locator('.dv-tab .dock-tab').allTextContents();
	check(tabs.includes('LLVM IR') && tabs.includes('Assembly'), `the views are tabs called LLVM IR and Assembly (${tabs.join(', ')})`);

	await place(page, 'distance(points');
	const mapped = await page.locator('[data-view="asm"] .yk-mapped').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
	check(mapped, `the caret on main.cpp's distance( call lights up its assembly (${await page.locator('[data-view="asm"] .yk-mapped').count()} .yk-mapped)`);

	await setText(page, 'main.cpp', `${sample}\nint extra_function_xyz(int v) { return v * 7; }\n`);
	const updated = await viewShows(page, 'asm', (t) => t.includes('extra_function_xyz'), 10_000);
	check(updated.ok, `an edit of main.cpp updates the assembly within 10 s (${updated.seconds.toFixed(1)} s)`);

	await picker.selectOption('aarch64-linux');
	const a64 = await viewShows(page, 'asm', (t) => /^\s+ret\b/m.test(t) && !t.includes('%rbp'), 120_000);
	const triple = (await page.locator('[data-view="asm"] .yk-view-triple').textContent().catch(() => '')) ?? '';
	check(a64.ok && triple === 'aarch64-linux-musl', `switching to aarch64 shows aarch64 assembly (ret) and its triple in the toolbar (${triple})`);
	await picker.selectOption('wasm32-wasi');
	const wasm = await viewShows(page, 'asm', (t) => t.includes('end_function'), 120_000);
	check(wasm.ok, `switching to WebAssembly shows wasm32 assembly with end_function (${wasm.seconds.toFixed(1)} s)`);
	check(!(await testButton.isDisabled()), 'on WebAssembly, Test is enabled again');
	await setText(page, 'main.cpp', sample);

	// User mode, experimental.
	await picker.selectOption('x86_64-linux');
	await page.locator('header .run-options button.toggle').click();
	await page.locator('header .run-options input[value="user"]').check();
	await page.keyboard.press('Escape');
	await page.locator('header button.run').click();
	const user = await ended(page);
	check(user.done && /code 0/.test(user.status) && user.shown.includes('5.000000'), `Run on x86_64 in QEMU's user mode prints 5.000000 (${user.status})`);
	await page.locator('header .run-options button.toggle').click();
	await page.locator('header .run-options input[value="system"]').check();
	await page.keyboard.press('Escape');

	// Stop ends an endless program in the VM, and the page stays responsive.
	await setText(page, 'main.cpp', 'int main() {\n    volatile unsigned long n = 0;\n    for (;;) ++n;\n}\n');
	await page.locator('header button.run').click();
	await page.locator('.terminal .status', { hasText: 'Running' }).waitFor({ timeout: 300_000 }).catch(() => {});
	await page.waitForTimeout(3000);
	await page.locator('header button.stop').click();
	const stopped = await ended(page, 10_000);
	const t0 = Date.now();
	const alive = await page.evaluate(() => 1 + 1).then((v) => v === 2);
	check(stopped.done && /Stopped/.test(stopped.status) && alive && Date.now() - t0 < 2000, `Stop ends an endless loop on x86_64 Linux and the page answers (${stopped.status})`);
	await setText(page, 'main.cpp', sample);

	// Back to the sample, on WebAssembly.
	page.once('dialog', (d) => void d.accept());
	await page.locator('header button', { hasText: 'Reset project' }).click();
	const reset = await page.waitForFunction(() => globalThis.monaco.editor.getModels().find((m) => m.uri.path === '/workspace/compile_flags.txt')?.getValue().startsWith('-std='), null, { timeout: 15_000 }).then(() => true, () => false);
	check(reset && (await picker.inputValue()) === 'wasm32-wasi', `Reset project restores the sample on WebAssembly (${await picker.inputValue()})`);
}

/** Opens a project file from the explorer and waits for its tab. */
async function openFile(page, name) {
	await page.locator('.explorer .row .name', { hasText: new RegExp(`^${name.replace(/[.]/g, '\\.')}$`) }).click();
	await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: name }).first().waitFor({ timeout: 10_000 });
}

/** Puts the caret of the editor showing `needle` just inside its first occurrence, and focuses it. */
async function place(page, needle) {
	const ok = await page.evaluate((needle) => {
		for (const e of globalThis.monaco.editor.getEditors()) {
			const model = e.getModel();
			const match = model?.findMatches(needle, false, false, true, null, false)[0];
			if (!match) continue;
			e.setPosition({ lineNumber: match.range.startLineNumber, column: match.range.startColumn + 1 });
			e.focus();
			return true;
		}
		return false;
	}, needle);
	if (!ok) throw new Error(`no editor shows ${needle}`);
}

/**
 * Renames what is at `needle` through the UI: F2, the new name, Enter. The
 * name is filled into the rename box rather than typed, because the box
 * takes focus a moment after it appears and keys typed before then go to
 * the editor.
 */
async function rename(page, needle, name) {
	await place(page, needle);
	await page.keyboard.press('F2');
	const input = page.locator('.rename-box .rename-input');
	await input.waitFor({ timeout: 15_000 });
	await input.fill(name);
	await input.press('Enter');
}

/** The text a model holds, by its project path. */
function modelText(page, path) {
	return page.evaluate((path) => globalThis.monaco.editor.getModels().find((m) => m.uri.path === `/workspace/${path}`)?.getValue() ?? null, path);
}

/** Whether some `method` request in the trace was answered with a non-empty result. */
function answered(lspLog, method) {
	const ids = new Set(lspLog.filter((l) => l.startsWith('lsp send') && l.includes(`"method":"${method}"`)).map((l) => /"id":(\d+)/.exec(l)?.[1]));
	// Servers order a response's keys as they like, and a long one is cut,
	// so the first `id` (the response's own) and the result's start are matched.
	return lspLog.some((l) => l.startsWith('lsp receive') && ids.has(/"id":(\d+)/.exec(l)?.[1]) && /"result":(\[[^\]]|\{)/.test(l));
}

/**
 * The capabilities clangd offers beyond the basics reach the editor: folding
 * ranges, smart select (Shift+Alt+Right grows to the whole call), the
 * `#include "geometry.h"` link (and none to `<vector>`, a file the project
 * does not have), and a rename clangd refuses after the new name was typed
 * says why instead of silently doing nothing.
 */
async function cppBridge(page, check, lspLog) {
	await openFile(page, 'main.cpp');
	for (let i = 0; i < 20 && !answered(lspLog, 'textDocument/foldingRange'); i++) await page.waitForTimeout(500);
	check(answered(lspLog, 'textDocument/foldingRange'), 'folding ranges come from clangd');

	await place(page, 'distance(points');
	const selected = [];
	for (let i = 0; i < 4; i++) {
		await page.keyboard.press('Shift+Alt+ArrowRight');
		await page.waitForTimeout(400);
		selected.push(await page.evaluate(() => {
			const e = globalThis.monaco.editor.getEditors().find((e) => e.hasTextFocus());
			return e ? e.getModel().getValueInRange(e.getSelection()) : '';
		}));
	}
	check(answered(lspLog, 'textDocument/selectionRange') && selected.includes('distance(points[0], points[1])'), `smart select grows to the call, from clangd (${JSON.stringify(selected)})`);
	await page.keyboard.press('Escape');

	const links = page.locator('.dv-groupview .view-line .detected-link');
	const linked = await links.filter({ hasText: 'geometry.h' }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
	const texts = await links.allTextContents();
	check(linked && !texts.some((t) => t.includes('vector')), `#include "geometry.h" is a link, <vector> is not (links: ${JSON.stringify(texts)})`);

	const before = await modelText(page, 'main.cpp');
	await rename(page, 'distance(points', 'int');
	const message = page.locator('.monaco-editor-overlaymessage');
	const said = await message.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
	const reason = said ? ((await message.first().textContent()) ?? '').trim() : '';
	check(said && /keyword/i.test(reason) && (await modelText(page, 'main.cpp')) === before, `renaming distance to int is refused with clangd's reason (${JSON.stringify(reason)})`);
	await page.keyboard.press('Escape');
}

/**
 * Renaming a call of an imported function renames the function: its
 * declaration in geometry.ts and every use, not a local alias
 * (`import { distance as dist3 }`).
 */
async function renameFromUse(page, check) {
	await undoRename(page, check, {
		file: 'main.ts',
		needle: 'distance(a, b)',
		from: 'distance',
		name: 'dist3',
		declarationFile: 'geometry.ts',
		declaration: 'function dist3(',
		edit: '\n// edited\n',
		renamed: async (renamed) => {
			const main = (await modelText(page, 'main.ts')) ?? '';
			check(renamed && !/\bas dist3\b/.test(main) && main.includes('dist3(a, b)'), `renaming distance from its call in main.ts renames the function in geometry.ts, without an alias (main.ts: ${JSON.stringify(main.split('\n')[0])})`);
		},
	});
}

/** Every project file's text, by project path. */
function projectTexts(page) {
	return page.evaluate(() => Object.fromEntries(globalThis.monaco.editor.getModels().filter((m) => m.uri.path.startsWith('/workspace/')).map((m) => [m.uri.path.slice('/workspace/'.length), m.getValue()])));
}

/** Waits until every project file's text is `texts`'s; false after `timeout`. */
function textsBecome(page, texts, timeout = 10_000) {
	return page
		.waitForFunction((texts) => Object.entries(texts).every(([path, text]) => globalThis.monaco.editor.getModels().find((m) => m.uri.path === `/workspace/${path}`)?.getValue() === text), texts, { timeout })
		.then(() => true, () => false);
}

/** Focuses the editor showing project file `path`, its caret at `needle` (or at the end). */
async function focusFile(page, path, needle) {
	await openFile(page, path.split('/').pop());
	const ok = await page.evaluate(({ path, needle }) => {
		const editor = globalThis.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path === `/workspace/${path}`);
		const model = editor?.getModel();
		if (!editor || !model) return false;
		const match = needle ? model.findMatches(needle, false, false, true, null, false)[0] : null;
		editor.setPosition(match ? { lineNumber: match.range.startLineNumber, column: match.range.startColumn + 1 } : model.getFullModelRange().getEndPosition());
		editor.focus();
		return true;
	}, { path, needle });
	if (!ok) throw new Error(`no editor shows ${path}`);
}

/**
 * Undo and redo of a rename across files, as in VS Code
 * (src/lib/workspace-edits.ts): Ctrl+Z in the file renamed from asks
 * whether to undo across all files and, told so, restores every file, with
 * the server following (no errors); Ctrl+Y renames them all again without
 * asking. Once another of the files is edited, Ctrl+Z does not offer to
 * undo across files: it undoes this file's part only and says which file
 * changed, the server reports the now broken call, and the edited file
 * keeps both the rename and the edit.
 */
async function undoRename(page, check, { file, needle, from, name, declarationFile, declaration, edit, renamed: afterRename }) {
	const errorCount = page.locator('footer .counts span[title=Errors]');
	const noErrors = () => page.waitForFunction(() => document.querySelector('footer .counts span[title=Errors]')?.textContent?.trim() === '0', null, { timeout: 30_000 }).then(() => true, () => false);
	await openFile(page, file);
	const before = await projectTexts(page);
	await rename(page, needle, name);
	const renamed = await page.waitForFunction(({ path, declaration }) => globalThis.monaco.editor.getModels().find((m) => m.uri.path === `/workspace/${path}`)?.getValue().includes(declaration), { path: declarationFile, declaration }, { timeout: 15_000 }).then(() => true, () => false);
	if (afterRename) await afterRename(renamed);
	if (!renamed) return;
	const after = await projectTexts(page);
	const changed = Object.keys(after).filter((p) => after[p] !== before[p]);
	check(changed.length >= 2 && changed.includes(file) && changed.includes(declarationFile), `renaming ${from} to ${name} edits several files (${changed.join(', ')})`);

	await focusFile(page, file, `${name}(`);
	await page.keyboard.press('Control+z');
	const dialog = page.locator('dialog.app-dialog');
	const asked = await dialog.waitFor({ timeout: 5_000 }).then(() => true, () => false);
	const question = asked ? ((await dialog.locator('.app-dialog-message').textContent()) ?? '') : '';
	const buttons = asked ? await dialog.locator('button').allTextContents() : [];
	check(asked && question === `Would you like to undo 'Renaming ${from} to ${name}' across all files?` && buttons.join('|') === `Undo in ${changed.length} Files|Undo this File|Cancel`, `Ctrl+Z after the rename asks whether to undo it across all files, in the app's dialog (${JSON.stringify(question)}: ${buttons.join(', ')})`);
	if (!asked) return;
	await dialog.locator('button', { hasText: /^Undo in \d+ Files$/ }).click();
	const restored = await textsBecome(page, before);
	check(restored, `Undo in ${changed.length} Files restores every file (${changed.join(', ')})`);
	check(restored && (await noErrors()), `the language server follows the undo in every file: no errors (${(await errorCount.textContent())?.trim()})`);

	await page.keyboard.press('Control+y');
	const redone = await textsBecome(page, after);
	check(redone && (await dialog.count()) === 0, `Ctrl+Y redoes the rename in every file, without asking (${redone ? 'redone' : 'not redone'})`);
	check(redone && (await noErrors()), `the language server follows the redo: no errors (${(await errorCount.textContent())?.trim()})`);

	await focusFile(page, declarationFile);
	await page.keyboard.type(edit);
	await page.waitForTimeout(300);
	await focusFile(page, file, `${name}(`);
	await page.keyboard.press('Control+z');
	const notice = page.locator('.monaco-editor-overlaymessage');
	const told = await notice.first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
	const said = told ? ((await notice.first().textContent()) ?? '').trim() : '';
	const texts = await projectTexts(page);
	check(
		told && said.includes(`Could not undo 'Renaming ${from} to ${name}' across all files because changes were made to ${declarationFile}`) && (await dialog.count()) === 0,
		`after ${declarationFile} was edited, Ctrl+Z in ${file} does not offer to undo across files and says why (${JSON.stringify(said)})`,
	);
	check(
		texts[file] === before[file] && texts[declarationFile] === after[declarationFile] + edit && changed.every((p) => p === file || p === declarationFile || texts[p] === after[p]),
		`only ${file} is undone; ${declarationFile} keeps the rename and the edit, the other files the rename`,
	);
	const broken = await page.waitForFunction(() => document.querySelector('footer .counts span[title=Errors]')?.textContent?.trim() !== '0', null, { timeout: 30_000 }).then(() => true, () => false);
	check(broken, `the language server sees ${file} undone alone: its call of ${from} is an error (${(await errorCount.textContent())?.trim()})`);

	// From the sample again: the rename, then the file it declared renamed
	// in the explorer. Its undo history went with its old name, so Ctrl+Z
	// in the file renamed from undoes that file only and says why.
	page.once('dialog', (d) => void d.accept());
	await page.locator('header button', { hasText: 'Reset project' }).click();
	const reset = await textsBecome(page, { [file]: before[file], [declarationFile]: before[declarationFile] }, 15_000);
	if (!reset) return check(false, 'Reset project restores the sample');
	// Reset restarts the server: rename once it answers again.
	await page.locator('footer .state').filter({ hasNotText: /Starting|Downloading|stopped/ }).waitFor({ timeout: 60_000 });
	await noErrors();
	await page.waitForTimeout(1000);
	await focusFile(page, file);
	const sample = await projectTexts(page);
	await rename(page, needle, name);
	await page.waitForFunction(({ path, declaration }) => globalThis.monaco.editor.getModels().find((m) => m.uri.path === `/workspace/${path}`)?.getValue().includes(declaration), { path: declarationFile, declaration }, { timeout: 15_000 }).catch(() => {});
	const moved = declarationFile.replace(/^geometry/, 'shapes');
	// The row's buttons show on hover.
	await page.locator('.explorer .row', { has: page.locator('.name', { hasText: new RegExp(`^${declarationFile.replace(/[.]/g, '\\.')}$`) }) }).hover();
	await page.locator(`.explorer button[aria-label="Rename ${declarationFile}"]`).click();
	const input = page.locator('.explorer input[aria-label="File name"]');
	await input.fill(moved);
	await input.press('Enter');
	await page.waitForFunction((path) => globalThis.monaco.editor.getModels().some((m) => m.uri.path === `/workspace/${path}`), moved, { timeout: 5_000 }).catch(() => {});
	await focusFile(page, file, `${name}(`);
	await page.keyboard.press('Control+z');
	const gone = await notice.first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
	const why = gone ? ((await notice.first().textContent()) ?? '').trim() : '';
	check(
		gone && why.includes(`These files were deleted or renamed since: ${declarationFile}`) && (await dialog.count()) === 0 && (await modelText(page, file)) === sample[file] && (await modelText(page, moved))?.includes(declaration),
		`after ${declarationFile} was renamed to ${moved}, Ctrl+Z in ${file} undoes the rename there only and says why (${JSON.stringify(why)})`,
	);
}

/** jsconfig.json is highlighted as JSON, completes compiler options from its schema and flags unknown values. */
async function settings(page, check) {
	await page.locator('.explorer .row .name', { hasText: /^jsconfig\.json$/ }).click();
	await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: 'jsconfig.json' }).first().waitFor({ timeout: 10_000 });
	const lines = page.locator('.dv-groupview .monaco-editor .view-lines').first();
	const key = lines.locator('span', { hasText: /^"compilerOptions"$/ }).first();
	const colours = await page.waitForFunction(() => {
		const spans = [...document.querySelectorAll('.dv-groupview .monaco-editor .view-line span span')];
		const of = (t) => spans.find((s) => s.textContent === t);
		const k = of('"compilerOptions"'), v = of('"es2023"');
		return k && v && getComputedStyle(k).color !== getComputedStyle(v).color;
	}, null, { timeout: 10_000 }).then(() => true, () => false);
	check(colours, 'jsconfig.json is highlighted (keys and strings in different colours)');

	await key.click();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('"noUnused');
	await page.keyboard.press('Control+Space');
	const suggest = page.locator('.suggest-widget .monaco-list-row');
	const completed = await suggest.filter({ hasText: 'noUnusedLocals' }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
	check(completed, `jsconfig.json completes noUnusedLocals (offered: ${(await suggest.allTextContents()).slice(0, 5).join(' | ').slice(0, 120)})`);
	await page.keyboard.press('Escape');
	for (let i = 0; i < 10; i++) await page.keyboard.press('Control+z');

	const target = lines.locator('span', { hasText: /^"es2023"$/ }).first();
	await target.dblclick();
	await page.keyboard.type('es1999');
	const flagged = await page.locator('.dv-groupview .monaco-editor .squiggly-warning, .dv-groupview .monaco-editor .squiggly-error').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
	check(flagged, 'jsconfig.json flags an unknown target');
	for (let i = 0; i < 10; i++) await page.keyboard.press('Control+z');
}

/**
 * Run on a web project opens the Preview panel with the page, whose console
 * reaches the terminal; a stylesheet edit is applied in place (the page is
 * not reloaded: a mark set in it survives), any other edit reloads it.
 */
async function previewing(page, check) {
	await page.locator('header button.run').click();
	const frame = page.frameLocator('iframe.preview-frame');
	const shown = await frame.locator('h1', { hasText: 'Hello from TypeScript' }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
	check(shown, 'Run opens the Preview panel showing index.html');
	const terminal = page.locator('.terminal pre');
	const logged = await terminal.filter({ hasText: 'page ready' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
	check(logged, `the page's console.log reaches the terminal (${JSON.stringify((await terminal.textContent())?.slice(0, 200))})`);
	await frame.locator('#increment').click();
	const clicked = await terminal.filter({ hasText: 'clicked 1 times' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
	check(clicked && (await frame.locator('#count').textContent()) === '1', 'the page runs main.ts with its import of counter.ts: a click counts');
	const sandbox = await page.locator('iframe.preview-frame').getAttribute('sandbox');
	check(sandbox === 'allow-scripts allow-forms allow-modals', `the iframe is sandboxed without allow-same-origin (${sandbox})`);

	const inner = () => page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.url() === 'about:srcdoc');
	await inner()?.evaluate(() => (window.yukibanaMark = 'kept'));
	await page.locator('.explorer .row .name', { hasText: /^style\.css$/ }).click();
	await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: 'style.css' }).first().waitFor({ timeout: 10_000 });
	await page.locator('.dv-groupview .monaco-editor').first().click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type('\nh1 { color: rgb(200, 0, 0); }\n');
	const restyled = await frame.locator('h1').evaluate((h) => new Promise((done) => {
		const t0 = Date.now();
		const poll = () => (getComputedStyle(h).color === 'rgb(200, 0, 0)' ? done(true) : Date.now() - t0 > 10_000 ? done(false) : setTimeout(poll, 50));
		poll();
	})).catch(() => false);
	const kept = await inner()?.evaluate(() => window.yukibanaMark).catch(() => undefined);
	check(restyled && kept === 'kept', `a CSS edit restyles the page without reloading it (colour changed: ${restyled}, mark: ${kept})`);

	await page.locator('.explorer .row .name', { hasText: /^main\.ts$/ }).click();
	await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: 'main.ts' }).first().waitFor({ timeout: 10_000 });
	await page.locator('.dv-groupview .monaco-editor').first().click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type("\nbutton.textContent = 'Edited';\n");
	const reloaded = await frame.locator('#increment', { hasText: 'Edited' }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
	const mark = await inner()?.evaluate(() => window.yukibanaMark).catch(() => 'gone');
	check(reloaded && mark === undefined, `a TypeScript edit reloads the page (button says Edited: ${reloaded}, mark after: ${mark})`);

	// Run again with the Preview already in front loads the page once, not
	// twice: re-activating the panel used to take the iframe out of the DOM
	// and put it back (a reload) just before the new page arrived (another),
	// and Chrome sometimes left the frame white.
	await page.evaluate(() => {
		window.yukibanaDetached = 0;
		new MutationObserver((records) => {
			for (const r of records)
				for (const n of r.removedNodes)
					if (n instanceof Element && (n.matches('iframe.preview-frame') || n.querySelector('iframe.preview-frame'))) window.yukibanaDetached++;
		}).observe(document.body, { childList: true, subtree: true });
	});
	const readies = async () => ((await terminal.textContent()) ?? '').split('page ready').length - 1;
	const runs = 3;
	const counts = [];
	for (let i = 0; i < runs; i++) {
		await page.locator('header button.run').click();
		await terminal.filter({ hasText: 'page ready' }).waitFor({ timeout: 15_000 }).catch(() => {});
		await page.waitForTimeout(1_000);
		counts.push(await readies());
	}
	const detached = await page.evaluate(() => window.yukibanaDetached);
	check(detached === 0 && counts.every((c) => c === 1), `each Run loads the preview once, without moving its iframe (iframe detached ${detached} times; "page ready" per run: ${counts.join(', ')})`);
}

/**
 * The p5.js sketch: its types came with it (hover on createCanvas has p5's
 * documentation), and Run shows a canvas that fills the Preview, follows the
 * panel's size (windowResized), and draws the circle under the mouse.
 */
async function sketching(page, check, requests) {
	const fetched = (re) => requests.some((u) => re.test(u));
	check(fetched(/\/packages-p5-[\d.]+\.json$/), 'the editor downloads the declarations of p5.js for a project that imports it');
	await page.locator('.dv-groupview .view-line span', { hasText: /^[\s.]*createCanvas$/ }).first().hover();
	const hover = page.locator('.monaco-hover-content').first();
	const documented = await hover.filter({ hasText: /Creates a canvas element/ }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(documented, `hover on createCanvas shows p5.js's documentation (${JSON.stringify((await hover.textContent().catch(() => ''))?.slice(0, 120))})`);
	await page.mouse.move(0, 0);

	await page.locator('header button.run').click();
	const frameElement = page.locator('iframe.preview-frame');
	const drawn = await page.frameLocator('iframe.preview-frame').locator('canvas').waitFor({ timeout: 60_000 }).then(() => true, () => false);
	check(drawn && fetched(/\/p5-[\d.]+\.js$/), 'Run shows the sketch: p5.js, fetched for it, makes its canvas in the Preview');
	if (!drawn) return;
	const inner = page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.url() === 'about:srcdoc');
	const layout = () =>
		inner.evaluate(() => {
			const canvas = document.querySelector('canvas');
			const root = document.documentElement;
			return { canvas: [canvas?.clientWidth, canvas?.clientHeight], window: [innerWidth, innerHeight], scroll: [root.scrollWidth, root.scrollHeight] };
		});
	const fills = (l) => l.canvas[0] === l.window[0] && l.canvas[1] === l.window[1] && l.scroll[0] <= l.window[0] && l.scroll[1] <= l.window[1];
	await page.waitForTimeout(500);
	const first = await layout();
	const box = await frameElement.boundingBox();
	check(fills(first) && Math.abs(first.window[0] - (box?.width ?? 0)) <= 1 && Math.abs(first.window[1] - (box?.height ?? 0)) <= 1, `the canvas fills the Preview, without scroll bars (${JSON.stringify(first)}, frame ${box?.width}x${box?.height})`);

	/** The colour at (x, y) in CSS pixels of the frame. */
	const pixel = (x, y) =>
		inner.evaluate(([x, y]) => {
			const canvas = document.querySelector('canvas');
			const scale = canvas.width / canvas.clientWidth;
			return [...canvas.getContext('2d').getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
		}, [x, y]);
	const near = (rgb, want) => rgb.every((v, i) => Math.abs(v - want[i]) <= 2);
	const BACKGROUND = [30, 32, 40];
	const CIRCLE = [240, 120, 90];
	const a = { x: 80, y: 80 };
	const b = { x: Math.round(box.width) - 80, y: Math.round(box.height) - 80 };
	const before = await pixel(a.x, a.y);
	await page.mouse.move(box.x + a.x, box.y + a.y, { steps: 4 });
	await page.waitForTimeout(300);
	const underA = await pixel(a.x, a.y);
	await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 4 });
	await page.waitForTimeout(300);
	const underB = await pixel(b.x, b.y);
	const leftA = await pixel(a.x, a.y);
	check(near(before, BACKGROUND) && near(underA, CIRCLE) && near(underB, CIRCLE) && near(leftA, BACKGROUND), `the circle follows the mouse: drawn under it, gone from where it was (at A before ${before}, under A ${underA}, under B ${underB}, at A after ${leftA})`);

	const viewport = page.viewportSize();
	await page.setViewportSize({ width: viewport.width - 200, height: viewport.height - 100 });
	await page.waitForTimeout(800);
	const resized = await layout();
	check(fills(resized) && resized.window[0] < first.window[0], `the canvas follows the Preview's size (windowResized): ${JSON.stringify(resized)}`);
	await page.setViewportSize(viewport);
	const shown = (await page.locator('.terminal pre').textContent()) ?? '';
	check(!/Uncaught|Error/.test(shown), `the sketch logs no error (${JSON.stringify(shown.slice(0, 200))})`);
}

/** In the references peek, arrows preview each reference and Enter goes to it and closes the peek, as in VS Code. */
async function peek(page, check) {
	await page.locator('.explorer .row .name', { hasText: /^main\.py$/ }).click();
	await page.locator('.dv-groupview .view-line span', { hasText: /^Point$/ }).first().click();
	await page.keyboard.press('Shift+F12');
	const widget = page.locator('.reference-zone-widget');
	await widget.waitFor({ timeout: 20_000 });
	// Every file's references are shown at once, and files are named by their project path.
	const allShown = await widget.locator('.monaco-list-row', { hasText: /^\s*class Point:/ }).first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
	check(allShown, "the references peek opens with every file's references shown (geometry.py's too)");
	const labels = (await widget.locator('.peekview-title, .monaco-list-row .label-description').allTextContents()).join(' | ');
	check(!/workspace/.test(labels), `the references peek names files by project path (${labels})`);
	const selected = () => widget.locator('.monaco-list-row.selected').first().textContent();
	const before = await selected();
	await page.keyboard.press('ArrowDown');
	const moved = await page.waitForFunction((b) => document.querySelector('.reference-zone-widget .monaco-list-row.selected')?.textContent !== b, before, { timeout: 5_000 }).then(() => true, () => false);
	const target = (await selected())?.trim();
	check(moved, `Down in the references peek previews the next reference (${target})`);
	await page.keyboard.press('Enter');
	const closed = await widget.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false);
	const line = await page.locator('.dv-groupview .monaco-editor .current-line').count();
	check(closed && line > 0, 'Enter in the references peek goes to the reference and closes the peek');
}

/** Quick switches and a reload must leave one consistent project and server, and keep edits. */
async function switching() {
	const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
	const check = (ok, what) => {
		console.log(`${ok ? 'ok  ' : 'FAIL'} switching: ${what}`);
		if (!ok) failures.push(`switching: ${what}`);
	};
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await page.locator('footer .state', { hasText: 'basedpyright' }).waitFor({ timeout: 60_000 });
	await page.selectOption('header select', 'javascript');
	await page.selectOption('header select', 'python');
	await page.selectOption('header select', 'javascript');
	await page.selectOption('header select', 'python');
	const settled = await page.locator('footer .state', { hasText: 'basedpyright' }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
	const files = (await page.locator('.explorer .row .name').allTextContents()).join(',');
	check(settled && files === 'tests,test_geometry.py,geometry.py,main.py', `after four quick switches python runs on the python files (${files})`);

	const editor = page.locator('.dv-groupview .monaco-editor').first();
	await editor.click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type('\n# kept across reload\n');
	await page.reload();
	await page.locator('footer .state', { hasText: 'basedpyright' }).waitFor({ timeout: 60_000 });
	const text = await page.locator('.dv-groupview .view-lines').first().textContent();
	check(text?.replaceAll('\u00a0', ' ').includes('kept across reload') ?? false, 'an edit made just before a reload is kept');
	await page.close();
}

/**
 * Download saves <language>-project.zip, a zip that Python's zipfile reads
 * without error, holding the project's files in a folder of that name and
 * the build file generated for it. Needs no pack: nothing is compiled.
 */
async function downloading() {
	const page = await browser.newPage({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
	const check = (ok, what) => {
		console.log(`${ok ? 'ok  ' : 'FAIL'} download: ${what}`);
		if (!ok) failures.push(`download: ${what}`);
	};
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await page.selectOption('header select', 'cpp');
	await page.locator('.explorer .row .name', { hasText: 'compile_flags.txt' }).waitFor({ timeout: 30_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), page.click('header button:has-text("Download")')]);
	const dir = mkdtempSync(join(tmpdir(), 'yukibana-download-'));
	const path = join(dir, download.suggestedFilename());
	await download.saveAs(path);
	check(download.suggestedFilename() === 'cpp-project.zip', `the file is called ${download.suggestedFilename()}`);
	const listing = spawnSync('python3', ['-I', '-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint("\\n".join(z.namelist()))', path], { encoding: 'utf8' });
	const names = listing.stdout.trim().split('\n');
	const expected = ['cpp-project/CMakeLists.txt', 'cpp-project/README.md', 'cpp-project/.gitignore', 'cpp-project/main.cpp', 'cpp-project/geometry.h', 'cpp-project/tests/geometry_test.cpp', 'cpp-project/compile_flags.txt'];
	check(listing.status === 0 && expected.every((n) => names.includes(n)), `the zip is valid and holds the project and its CMakeLists.txt (${names.join(', ')}${listing.stderr})`);
	rmSync(dir, { recursive: true, force: true });
	await page.close();
}

/**
 * index.html and style.css have Monaco's HTML and CSS services: tag
 * completion, property completion, an unknown property flagged, colour
 * swatches. Runs after previewing(), on the same page.
 */
async function webServices(page, check) {
	const open = async (name) => {
		await page.locator('.explorer .row .name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }).click();
		await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: name }).first().waitFor({ timeout: 10_000 });
		await page.locator('.dv-groupview .monaco-editor').first().click();
	};
	const suggest = page.locator('.suggest-widget .monaco-list-row');
	const offered = async () => (await suggest.allTextContents()).slice(0, 6).join(' | ').slice(0, 120);

	await open('index.html');
	await page.keyboard.press('Control+Home');
	for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown'); // the <main> line
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('<di');
	await page.keyboard.press('Control+Space');
	const tag = await suggest.filter({ hasText: /^div/ }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(tag, `index.html completes <di to div (offered: ${await offered()})`);
	await page.keyboard.press('Escape');
	for (let i = 0; i < 10; i++) await page.keyboard.press('Control+z');

	await open('style.css');
	const swatches = await page.locator('.dv-groupview .monaco-editor .colorpicker-color-decoration').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(swatches, 'style.css shows colour swatches');
	await page.keyboard.press('Control+End');
	await page.keyboard.type('\np { colr: red; }\na { backgr');
	await page.keyboard.press('Control+Space');
	const property = await suggest.filter({ hasText: /^background/ }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(property, `style.css completes backgr to background (offered: ${await offered()})`);
	await page.keyboard.press('Escape');
	const flagged = await page.locator('.dv-groupview .monaco-editor .squiggly-warning').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(flagged, 'style.css flags the unknown property colr');
	for (let i = 0; i < 10; i++) await page.keyboard.press('Control+z');
}

/**
 * Monaco's HTML and CSS services are downloaded only when a project has
 * such a file: a Python session fetches neither worker; the web project
 * fetches the CSS worker (style.css is checked as the project loads) and
 * the HTML worker once index.html is open.
 */
async function lazyServices() {
	const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
	const page = await context.newPage();
	const check = (ok, what) => {
		console.log(`${ok ? 'ok  ' : 'FAIL'} lazy loading: ${what}`);
		if (!ok) failures.push(`lazy loading: ${what}`);
	};
	const workers = [];
	context.on('request', (r) => {
		const m = /\/workers\/(\w+)\.worker-/.exec(r.url());
		if (m && !workers.includes(m[1])) workers.push(m[1]);
	});
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await page.locator('footer .state', { hasText: 'basedpyright' }).waitFor({ timeout: 60_000 });
	await page.waitForTimeout(2000);
	check(!workers.includes('html') && !workers.includes('css'), `a Python session fetches no HTML or CSS worker (workers: ${workers.join(', ')})`);
	await page.selectOption('header select', 'web');
	await page.locator('.explorer .row .name', { hasText: /^index\.html$/ }).waitFor({ timeout: 30_000 });
	await page.waitForTimeout(2000);
	check(!workers.includes('html'), `the web project fetches no HTML worker before index.html is open (workers: ${workers.join(', ')})`);
	await page.locator('.explorer .row .name', { hasText: /^index\.html$/ }).click();
	for (let i = 0; i < 100 && !workers.includes('html'); i++) await page.waitForTimeout(100);
	check(workers.includes('html') && workers.includes('css'), `opening index.html fetches the HTML worker (workers: ${workers.join(', ')})`);
	await context.close();
}

/**
 * The app is an installable PWA (Chromium's own installability check) and
 * works offline: after Python is made available offline from the Offline
 * dialog, a reload without a network starts the app and the Python server,
 * and Run runs an edit.
 */
async function offlineUse() {
	const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
	const page = await context.newPage();
	const check = (ok, what) => {
		console.log(`${ok ? 'ok  ' : 'FAIL'} offline: ${what}`);
		if (!ok) failures.push(`offline: ${what}`);
	};
	try {
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		const controlled = await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 }).then(() => true, () => false);
		check(controlled, 'the service worker controls the page');
		// Installability is judged in a profile of its own: Chromium never offers
		// to install from an incognito context, which a new context is.
		const profile = mkdtempSync(join(tmpdir(), 'yukibana-profile-'));
		const persistent = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
		try {
			const installPage = persistent.pages()[0] ?? (await persistent.newPage());
			await installPage.goto(`http://127.0.0.1:${port}/`);
			await installPage.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
			const cdp = await persistent.newCDPSession(installPage);
			const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
			check(installabilityErrors.length === 0, `Chromium finds the app installable (${installabilityErrors.map((e) => e.errorId).join(', ') || 'no errors'})`);
			const { errors } = await cdp.send('Page.getAppManifest');
			check(errors.length === 0, `the manifest has no errors (${errors.map((e) => e.message).join('; ') || 'none'})`);
		} finally {
			await persistent.close();
			rmSync(profile, { recursive: true, force: true });
		}

		await page.locator('footer .state', { hasText: 'basedpyright' }).waitFor({ timeout: 60_000 });
		await page.click('header button.offline-button');
		const dialog = page.locator('dialog.offline');
		const total = await dialog.locator('footer').textContent({ timeout: 10_000 });
		check(/Download everything[\s\S]*\d+\.\d MB to download, \d+\.\d MB stored/.test(total ?? ''), `the dialog offers Download everything with its size (${total?.trim().replace(/\s+/g, ' ')})`);
		const row = dialog.locator('tr[data-language="python"]');
		await row.locator('button', { hasText: 'Make available offline' }).click({ timeout: 10_000 }).catch(() => undefined); // already cached by use: no button
		const cached = await row.locator('.ok').waitFor({ timeout: 120_000 }).then(() => true, () => false);
		check(cached, `Python is available offline (${(await row.textContent())?.trim().replace(/\s+/g, ' ')})`);
		await page.keyboard.press('Escape');
		const option = await page.locator('header select option[value="python"]').textContent();
		check(/offline/.test(option ?? ''), `the language list marks Python as offline (${option})`);

		await context.setOffline(true);
		await page.reload();
		const started = await page.locator('footer .state', { hasText: 'basedpyright' }).waitFor({ timeout: 120_000 }).then(() => true, () => false);
		check(started, `offline, the app starts and so does the Python server (${(await page.locator('footer .state').textContent())?.trim()})`);
		await page.locator('.explorer .row .name', { hasText: /^main\.py$/ }).click();
		await page.locator('.dv-groupview .monaco-editor').first().click();
		await page.keyboard.press('Control+End');
		await page.keyboard.type('\nprint("ran offline")\n');
		await page.locator('header button.run').click();
		const status = page.locator('.terminal .status');
		const ended = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout: 240_000 }).then(() => true, () => false);
		const shown = (await page.locator('.terminal pre').textContent()) ?? '';
		check(ended && shown.includes('ran offline'), `offline, Run runs the edited program (${JSON.stringify(shown.slice(-120))})`);
	} finally {
		await context.close();
	}
}
