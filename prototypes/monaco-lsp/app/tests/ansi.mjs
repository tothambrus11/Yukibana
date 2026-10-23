// Unit tests of the terminal's ANSI reader (src/lib/ansi.ts): what a program
// printed with escape sequences becomes plain text in styled spans.
//
//   node --test tests/ansi.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnsiStream, PLAIN, applySgr, colorCss, stripAnsi, styleCss } from '../src/lib/ansi.ts';

const feed = (...pieces) => {
	const stream = new AnsiStream();
	return pieces.flatMap((p) => stream.feed(p));
};
/** Neighbouring spans of one style merged, as the terminal merges them. */
const merged = (spans) =>
	spans.reduce((out, s) => {
		const last = out.at(-1);
		if (last && last.css === s.css) last.text += s.text;
		else if (s.text) out.push({ ...s });
		return out;
	}, []);

test('text without escapes is one plain span', () => {
	assert.deepEqual(feed('hello\nworld\n'), [{ text: 'hello\nworld\n', css: '' }]);
});

test("Node's spec reporter line: green mark, grey duration, back to the default", () => {
	assert.deepEqual(feed('  \x1b[32m✔ adds \x1b[90m(0.5ms)\x1b[39m\x1b[39m\n'), [
		{ text: '  ', css: '' },
		{ text: '✔ adds ', css: 'color:var(--ansi-2)' },
		{ text: '(0.5ms)', css: 'color:var(--ansi-8)' },
		{ text: '\n', css: '' },
	]);
});

test('GoogleTest and pytest styles: 0;3Xm, bold red, bright colours, reset', () => {
	assert.deepEqual(feed('\x1b[0;32m[ RUN      ] \x1b[m', 'A.b\n'), [
		{ text: '[ RUN      ] ', css: 'color:var(--ansi-2)' },
		{ text: 'A.b\n', css: '' },
	]);
	assert.deepEqual(feed('\x1b[31m\x1b[1m1 failed\x1b[0m'), [{ text: '1 failed', css: 'color:var(--ansi-1);font-weight:700' }]);
	assert.deepEqual(feed('\x1b[91;104mx'), [{ text: 'x', css: 'color:var(--ansi-9);background-color:var(--ansi-12)' }]);
});

test('a sequence split across two pieces of output, anywhere, is still read', () => {
	const whole = 'a\x1b[1;38;5;208mb\x1b[0mc\x1b]8;;http://x\x1b\\d\x1b]8;;\x07e';
	const expected = merged(feed(whole));
	for (let cut = 0; cut <= whole.length; cut++) {
		assert.deepEqual(merged(feed(whole.slice(0, cut), whole.slice(cut))), expected, `cut at ${cut}`);
	}
	assert.equal(expected.map((s) => s.text).join(''), 'abcde');
});

test('a piece that ends in a lone ESC shows nothing until the sequence completes', () => {
	const stream = new AnsiStream();
	assert.deepEqual(stream.feed('x\x1b'), [{ text: 'x', css: '' }]);
	assert.deepEqual(stream.feed('[31my'), [{ text: 'y', css: 'color:var(--ansi-1)' }]);
});

test('cursor moves, erase-line, titles, charset switches and hyperlinks are removed, their text kept', () => {
	assert.equal(stripAnsi('\x1b[2K\rcollecting\x1b[1A\x1b[?25l\x1b]0;title\x07\x1b(Bok\x1b7\x1b8'), '\rcollectingok');
	assert.equal(stripAnsi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link');
});

test('a malformed or endless sequence cannot swallow the output', () => {
	assert.equal(stripAnsi('a\x1b[12\nb'), 'a\nb');
	assert.equal(stripAnsi('a\x1b\x1b[31mb'), 'ab');
	const stream = new AnsiStream();
	assert.deepEqual(stream.feed('\x1b[' + '1;'.repeat(400)), []);
	// Dropped, and what follows is text again.
	assert.deepEqual(stream.feed('9'.repeat(10) + 'tail'), [{ text: '9999999999tail', css: '' }]);
});

test('the style lasts across pieces until it is reset', () => {
	const stream = new AnsiStream();
	stream.feed('\x1b[33m');
	assert.deepEqual(stream.feed('warn'), [{ text: 'warn', css: 'color:var(--ansi-3)' }]);
	assert.deepEqual(stream.feed('\x1b[39mok'), [{ text: 'ok', css: '' }]);
});

test('SGR attributes switch on and off one by one', () => {
	let s = applySgr(PLAIN, '1;2;3;4;9');
	assert.equal(styleCss(s), 'font-weight:700;opacity:0.65;font-style:italic;text-decoration:underline line-through');
	s = applySgr(s, '22;23;24;29');
	assert.equal(styleCss(s), '');
	assert.equal(styleCss(applySgr(PLAIN, '4:0')), '');
	assert.equal(styleCss(applySgr(PLAIN, '4:3')), 'text-decoration:underline');
	assert.equal(styleCss(applySgr(PLAIN, '31;')), '', 'an empty parameter is 0, a reset');
	assert.equal(styleCss(applySgr(PLAIN, '')), '');
});

test('256 colours and 24-bit colours, in the semicolon and the colon forms', () => {
	assert.equal(styleCss(applySgr(PLAIN, '38;5;9')), 'color:var(--ansi-9)');
	assert.equal(styleCss(applySgr(PLAIN, '38;5;196')), 'color:rgb(255 0 0)');
	assert.equal(styleCss(applySgr(PLAIN, '48;5;232')), 'background-color:rgb(8 8 8)');
	assert.equal(styleCss(applySgr(PLAIN, '38;2;10;20;30;1')), 'color:rgb(10 20 30);font-weight:700');
	assert.equal(styleCss(applySgr(PLAIN, '38:2::10:20:30')), 'color:rgb(10 20 30)');
	assert.equal(styleCss(applySgr(PLAIN, '38:2:10:20:30')), 'color:rgb(10 20 30)');
	assert.equal(styleCss(applySgr(PLAIN, '38:5:2')), 'color:var(--ansi-2)');
	assert.equal(styleCss(applySgr(PLAIN, '38;5;300')), '', 'out of range: ignored');
	assert.equal(colorCss({ index: 16 + 36 * 5 + 6 * 2 + 1 }), 'rgb(255 135 95)');
});

test('inverse swaps the colours, using the terminal defaults where none is set', () => {
	assert.equal(styleCss(applySgr(PLAIN, '7')), 'color:var(--ansi-default-bg);background-color:var(--ansi-default-fg)');
	assert.equal(styleCss(applySgr(PLAIN, '31;7')), 'color:var(--ansi-default-bg);background-color:var(--ansi-1)');
	assert.equal(styleCss(applySgr(PLAIN, '31;7;27')), 'color:var(--ansi-1)');
});

test('private sequences that end in m are not SGR', () => {
	assert.deepEqual(feed('\x1b[>4;2mx'), [{ text: 'x', css: '' }]);
});
