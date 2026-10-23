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
const build = join(here, '..', 'build');

/**
 * Per language: the file to edit, text appended to make an error, a member
 * access whose completion must offer `member`, a word in the entry file
 * whose definition lives in `definitionFile`, and a word to hover.
 */
const CASES = {
	python: { output: 'Point(x=0, y=0) to Point(x=3, y=4): 5.0', testOutput: '6 passed', file: 'main.py', error: '\nundefined_name_xyz\n', access: '\nPoint(1, 2).', member: 'norm', definition: 'distance', definitionFile: 'geometry.py', hover: 'Point' },
	javascript: { output: '(0, 0) to (3, 4): 5', testOutput: 'ℹ pass 4', file: 'main.js', error: '\na.nope();\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'geometry.js', hover: 'Point' },
	// TypeScript and web projects are served by the JavaScript pack (`pack`).
	typescript: { pack: 'javascript', output: '(0, 0) to (3, 4): 5', testOutput: 'ℹ pass 4', file: 'main.ts', error: '\nconst wrong: number = "no";\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'geometry.ts', hover: 'Point' },
	web: { pack: 'javascript', file: 'main.ts', error: '\nconst wrong: number = "no";\n', access: '\ncounter.', member: 'increment', definition: 'Counter', definitionFile: 'counter.ts', hover: 'Counter' },
	cpp: { output: '5.000000', testOutput: '[  PASSED  ] 3 tests.', file: 'main.cpp', error: '\nint broken = undeclared_xyz;\n', access: '\nvoid f(Point p) { p.', member: 'norm', definition: 'distance', definitionFile: 'geometry', hover: 'Point' },
	swift: { output: 'to', testOutput: 'Executed 2 tests, with 0 failures', file: 'main.swift', error: '\nlet x: Int = "no"\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.swift', hover: 'Point' },
	scala: { output: 'to', file: 'Main.scala', error: '\nval broken: Int = "no"\n', access: '\nval q = Point(1, 2)\nval r = q.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.scala', hover: 'Point' },
	rust: { output: '(0, 0) to (3, 4): 5', testOutput: 'test result: ok. 3 passed', file: 'main.rs', error: '\nfn broken() -> i32 { "no" }\n', access: '\nfn f(p: Point) -> f64 { p.', member: 'norm', definition: 'distance', definitionFile: 'point.rs', hover: 'Point' },
	php: { output: '(0, 0) to (3, 4): 5', testOutput: 'OK (5 tests, 5 assertions)', file: 'main.php', error: '\n$b->nope();\n', access: '\n$b->', member: 'norm', definition: 'distance', definitionFile: 'geometry.php', hover: 'Point' },
	java: { output: 'Point[x=0.0, y=0.0] to Point[x=3.0, y=4.0]: 5.0', testOutput: '3 tests successful', file: 'Main.java', error: '\nclass Broken { int n = "no"; }\n', access: '\nclass Probe { double f(Point p) { return p.', member: 'norm', definition: 'Point', definitionFile: 'Point.java', hover: 'Point' },
	// Syntax only, and no runner (packs/kotlin/README.md): the error is a syntax error.
	kotlin: { file: 'Main.kt', error: '\nfun broken() { val = 1 }\n', access: '\nval q = Point(1.0, 2.0)\nval r = q.', member: 'norm', definition: 'Point', definitionFile: 'Geometry.kt', hover: 'Point' },
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
	const check = (ok, what) => {
		console.log(`${ok ? 'ok  ' : 'FAIL'} ${language}: ${what}`);
		if (!ok) failures.push(`${language}: ${what}`);
	};
	const t0 = Date.now();
	await page.goto(`http://127.0.0.1:${port}/`);
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

	await word(c.definition).click();
	await page.keyboard.press('F12');
	const jumped = await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: c.definitionFile }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(jumped, `go to definition of ${c.definition} opens ${c.definitionFile}`);

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

	if (language === 'javascript') await settings(page, check);
	if (language === 'web') await previewing(page, check);
	if (language === 'web') await webServices(page, check);
	if (language === 'python') await peek(page, check);
	if (language === 'cpp' && existsSync(join(build, 'packs', 'cpp', 'runner.js'))) await testFrameworks(page, check);

	check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
	await page.close();
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
