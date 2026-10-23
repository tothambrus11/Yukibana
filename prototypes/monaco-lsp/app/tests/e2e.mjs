// Drives the built app in Chromium the way a person would, once per
// language whose pack is built: selects the language, waits for its server,
// checks the sample has no errors, then types an error, a member access and
// asks for hover and go-to-definition across files.
//
//   npm run build && node tests/e2e.mjs [language ...]
//
// Serves app/build with ../serve.py on a free port. Exits non-zero naming
// every check that failed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
	python: { output: 'Point(x=0, y=0) to Point(x=3, y=4): 5.0', file: 'main.py', error: '\nundefined_name_xyz\n', access: '\nPoint(1, 2).', member: 'norm', definition: 'distance', definitionFile: 'geometry.py', hover: 'Point' },
	javascript: { output: '(0, 0) to (3, 4): 5', file: 'main.js', error: '\na.nope();\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'geometry.js', hover: 'Point' },
	cpp: { output: '5.000000', file: 'main.cpp', error: '\nint broken = undeclared_xyz;\n', access: '\nvoid f(Point p) { p.', member: 'norm', definition: 'distance', definitionFile: 'geometry', hover: 'Point' },
	swift: { output: 'to', file: 'main.swift', error: '\nlet x: Int = "no"\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.swift', hover: 'Point' },
	scala: { output: 'to', file: 'Main.scala', error: '\nval broken: Int = "no"\n', access: '\nval q = Point(1, 2)\nval r = q.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.scala', hover: 'Point' },
};

const only = process.argv.slice(2);
const languages = Object.keys(CASES).filter((l) => (only.length ? only.includes(l) : existsSync(join(build, 'packs', l, 'server.js'))));
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
	const word = (w) => page.locator('.dv-groupview .view-line span', { hasText: new RegExp(`^${w}$`) }).first();
	await word(c.hover).hover();
	const hovered = await page.locator('.monaco-hover-content').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(hovered, `hover on ${c.hover} shows ${hovered ? JSON.stringify((await page.locator('.monaco-hover-content').first().textContent())?.slice(0, 80)) : 'nothing'}`);
	await page.mouse.move(0, 0);

	await word(c.definition).click();
	await page.keyboard.press('F12');
	const jumped = await page.locator('.dv-tab.dv-active-tab .dock-tab', { hasText: c.definitionFile }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
	check(jumped, `go to definition of ${c.definition} opens ${c.definitionFile}`);

	if (c.output && existsSync(join(build, 'packs', language, 'runner.js'))) {
		await page.locator('header button.run').click();
		const status = page.locator('.terminal .status');
		const ended = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout: 240_000 }).then(() => true, () => false);
		const shown = (await page.locator('.terminal pre').textContent()) ?? '';
		check(ended && /code 0/.test((await status.textContent()) ?? '') && shown.includes(c.output), `Run prints "${c.output}" (${(await status.textContent())?.trim()}: ${JSON.stringify(shown.slice(0, 200))})`);
	}

	if (language === 'javascript') await settings(page, check);
	if (language === 'python') await peek(page, check);

	check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
	await page.close();
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

/** In the references peek, arrows preview each reference and Enter goes to it and closes the peek, as in VS Code. */
async function peek(page, check) {
	await page.locator('.explorer .row .name', { hasText: /^main\.py$/ }).click();
	await page.locator('.dv-groupview .view-line span', { hasText: /^Point$/ }).first().click();
	await page.keyboard.press('Shift+F12');
	const widget = page.locator('.reference-zone-widget');
	await widget.waitFor({ timeout: 20_000 });
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
	check(settled && files === 'geometry.py,main.py', `after four quick switches python runs on the python files (${files})`);

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
