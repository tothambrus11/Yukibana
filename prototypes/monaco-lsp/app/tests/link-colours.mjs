// Unit tests of the editors' colours (src/lib/palette.ts) and the linked
// compiler output views' tints (src/lib/link-colours.ts): every text colour
// of both themes reaches 7:1 against its editor, Monaco's own rules
// included, and the views' shade meets Ambrus's criteria in both themes
// for every hue: highlights visible, primary and secondary rows apart, and
// readable text on every row.
//
//   node --test tests/link-colours.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { colourOf, contrast, EDITOR, LINE_NUMBERS, OWN_RULES, raise, raisedRules, rgbOf, TEXT_CONTRAST, viewText } from '../src/lib/palette.ts';
import { CRITERIA, judge, liftFor, linkStyleSheet, partContrast, SHADE } from '../src/lib/link-colours.ts';

/** Monaco's vs and vs-dark rules, read from its source (theme.svelte.ts imports the same objects). */
const themes = readFileSync(new URL('../node_modules/monaco-editor/esm/vs/editor/standalone/common/themes.js', import.meta.url), 'utf8');
const rulesOf = (name) => {
	const body = themes.slice(themes.indexOf(`const ${name} = {`));
	return [...body.slice(0, body.indexOf('colors:')).matchAll(/\{ token: '([^']*)'(?:, foreground: '([0-9a-fA-F]{6})')?/g)].map((m) => ({ token: m[1], ...(m[2] && { foreground: m[2] }) }));
};
const BASE = { dark: rulesOf('vs_dark'), light: rulesOf('vs') };
const RULES = { dark: raisedRules(BASE.dark, OWN_RULES.dark, EDITOR.dark.background), light: raisedRules(BASE.light, OWN_RULES.light, EDITOR.light.background) };
const numbers = (t) => ({ normal: raise(LINE_NUMBERS[t].normal, EDITOR[t].background, TEXT_CONTRAST), active: raise(LINE_NUMBERS[t].active, EDITOR[t].caretLine, TEXT_CONTRAST) });
const TEXT = { dark: viewText(RULES.dark, numbers('dark')), light: viewText(RULES.light, numbers('light')) };

test('Monaco\'s rules were read: both themes have dozens, registers among them', () => {
	for (const t of ['dark', 'light']) {
		assert.ok(BASE[t].length > 30, `${t}: ${BASE[t].length} rules`);
		assert.equal(colourOf(BASE[t], 'variable.predefined'), '#4864aa');
	}
});

test('every token colour of both themes is at least 7:1 against the editor, Monaco\'s own rules too', () => {
	for (const t of ['dark', 'light'])
		for (const r of RULES[t]) if (r.foreground) assert.ok(contrast(rgbOf('#' + r.foreground), rgbOf(EDITOR[t].background)) >= TEXT_CONTRAST, `${t} ${r.token} #${r.foreground}`);
});

test('so are the line numbers, the caret line\'s against the caret line', () => {
	for (const t of ['dark', 'light']) {
		assert.ok(contrast(rgbOf(numbers(t).normal), rgbOf(EDITOR[t].background)) >= TEXT_CONTRAST, t);
		assert.ok(contrast(rgbOf(numbers(t).active), rgbOf(EDITOR[t].caretLine)) >= TEXT_CONTRAST, t);
	}
});

test('a colour that already reaches the contrast is left as it is; one that does not keeps its hue and only gets lighter on dark, darker on light', () => {
	assert.equal(raise('#e3dcdc', '#121111', 7), '#e3dcdc');
	const comment = raise('#7f7676', '#121111', 7);
	assert.ok(contrast(rgbOf(comment), rgbOf('#121111')) >= 7 && contrast(rgbOf(comment), rgbOf('#121111')) < 7.2, comment);
	const light = raise('#8a8080', '#ffffff', 7);
	assert.ok(rgbOf(light)[0] < rgbOf('#8a8080')[0], light);
	// The theme's own colours win over Monaco's for the tokens they name.
	assert.equal(colourOf(RULES.dark, 'keyword'), raise('#e0788f', '#121111', 7));
	assert.equal(colourOf(RULES.dark, 'keyword.flow'), raise('#c586c0', '#121111', 7));
});

test("the views' shade meets every criterion in both themes, for every hue", () => {
	for (const t of ['dark', 'light']) {
		const j = judge(t, SHADE[t], TEXT[t]);
		assert.deepEqual(j.fails, [], `${t}: ${JSON.stringify(j)}`);
		assert.ok(j.restVisible >= CRITERIA.visible && j.focusVisible >= CRITERIA.visibleFocus && j.apart >= CRITERIA.apart, t);
	}
});

test('text on highlighted rows is brightened only as much as it needs, and never past the cap that keeps syntax colours', () => {
	const dark = judge('dark', SHADE.dark, TEXT.dark);
	const light = judge('light', SHADE.light, TEXT.light);
	assert.ok(dark.strongLift >= 1 && dark.strongLift <= CRITERIA.maxLift.dark && dark.focusLift <= dark.strongLift, JSON.stringify(dark));
	assert.ok(light.strongLift <= 1 && light.strongLift >= CRITERIA.maxLift.light && light.focusLift >= light.strongLift, JSON.stringify(light));
	// A thinner tint needs less: none at all on an untinted row.
	assert.equal(liftFor('dark', SHADE.dark, TEXT.dark, 0), 1);
	assert.ok(liftFor('dark', SHADE.dark, TEXT.dark, SHADE.dark.focus) <= liftFor('dark', SHADE.dark, TEXT.dark, SHADE.dark.strong));
});

test('a shade too faint to see, or with primary and secondary rows alike, fails and says why', () => {
	const faint = judge('dark', { ...SHADE.dark, rest: 0.03 }, TEXT.dark);
	assert.ok(faint.fails.includes('the resting tint is too faint'), JSON.stringify(faint.fails));
	const alike = judge('light', { ...SHADE.light, strong: SHADE.light.focus + 0.02 }, TEXT.light);
	assert.ok(alike.fails.includes('primary and secondary rows are too close'), JSON.stringify(alike.fails));
	const dim = judge('dark', { ...SHADE.dark, fadeText: 0.5 }, TEXT.dark);
	assert.ok(dim.fails.includes('unhighlighted code is too faint'), JSON.stringify(dim.fails));
});

test("the source's selected expression, inverted, is readable for every hue", () => {
	for (const t of ['dark', 'light']) assert.ok(partContrast(t, SHADE[t]) >= CRITERIA.text, `${t}: ${partContrast(t, SHADE[t])}`);
});

test('the style sheet sets both themes and a class per hue', () => {
	const css = linkStyleSheet(TEXT);
	assert.match(css, /:root\[data-theme='dark'\] \{[^}]*--yk-lift-strong: 1\.\d+/);
	assert.match(css, /:root\[data-theme='light'\], :root:not\(\[data-theme\]\) \{[^}]*--yk-lift-strong: 0\.\d+/);
	for (let i = 0; i < 8; i++) assert.match(css, new RegExp(`\\.yk-h${i} \\{ --yk-h: \\d+; \\}`));
});
