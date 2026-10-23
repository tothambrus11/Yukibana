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
	python: { file: 'main.py', error: '\nundefined_name_xyz\n', access: '\nPoint(1, 2).', member: 'norm', definition: 'distance', definitionFile: 'geometry.py', hover: 'Point' },
	javascript: { file: 'main.js', error: '\na.nope();\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'geometry.js', hover: 'Point' },
	cpp: { file: 'main.cpp', error: '\nint broken = undeclared_xyz;\n', access: '\nvoid f(Point p) { p.', member: 'norm', definition: 'distance', definitionFile: 'geometry', hover: 'Point' },
	swift: { file: 'main.swift', error: '\nlet x: Int = "no"\n', access: '\nb.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.swift', hover: 'Point' },
	scala: { file: 'Main.scala', error: '\nval broken: Int = "no"\n', access: '\nval q = Point(1, 2)\nval r = q.', member: 'norm', definition: 'distance', definitionFile: 'Geometry.scala', hover: 'Point' },
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
	for (const language of languages) await run(language, CASES[language]);
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

	check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
	await page.close();
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
