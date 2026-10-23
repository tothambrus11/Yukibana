/**
 * ANSI escape sequences in program output, as a terminal reads them: SGR
 * (`ESC [ … m`: colours, bold, dim, italic, underline, inverse, strike,
 * reset) becomes a style; every other escape sequence (cursor moves, erase
 * line, window titles, hyperlinks) is removed without a trace, so it never
 * shows up as `[2K` garbage. Pure: no DOM, testable on its own
 * (tests/ansi.mjs).
 *
 * Streaming-safe: a runner posts its output in pieces cut anywhere, so a
 * sequence may begin at the end of one piece and end in the next.
 * `AnsiStream` keeps the unfinished part and the current style between
 * calls to `feed`, as a terminal keeps its state between reads.
 *
 * Colours are CSS, never fixed RGB for the 16 standard colours: those are
 * `var(--ansi-0)` … `var(--ansi-15)`, defined per theme in app.css, so
 * green on the dark theme and green on the light one are each readable. The
 * 256-colour cube and grey ramp (indices 16–255) and 24-bit colours are what
 * the program asked for, exactly, as in any terminal.
 */

/** A colour as SGR names it: one of the 256 indexed colours, or 24-bit RGB. */
export type Color = { index: number } | { rgb: readonly [number, number, number] };

/** The graphic rendition a terminal keeps between SGR sequences. `null` colour is the default. */
export interface Style {
	readonly fg: Color | null;
	readonly bg: Color | null;
	readonly bold: boolean;
	readonly dim: boolean;
	readonly italic: boolean;
	readonly underline: boolean;
	readonly inverse: boolean;
	readonly hidden: boolean;
	readonly strike: boolean;
}

/** The style after `ESC [ 0 m`: nothing set. */
export const PLAIN: Style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, hidden: false, strike: false };

/** A stretch of text in one style; `css` is the inline style for it, '' for plain. */
export interface Span {
	text: string;
	css: string;
}

const ESC = '\x1b';
/**
 * An escape sequence longer than this without its end is not one a program
 * meant: its text is dropped and reading starts afresh, so a stray ESC cannot
 * swallow the rest of the output.
 */
const MAX_SEQUENCE = 512;

/**
 * Applies the parameters of one SGR sequence (the text between `ESC [` and
 * `m`, e.g. "1;38;5;208" or "38:2::255:0:0") to `style`. Unknown codes are
 * ignored, as terminals ignore them; an empty list is a reset.
 */
export function applySgr(style: Style, params: string): Style {
	const s = { ...style };
	const groups = params.split(';');
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i] ?? '';
		// Colon sub-parameters (ITU T.416): 38:5:n, 38:2::r:g:b or 38:2:r:g:b, 4:3.
		const sub = group.split(':');
		const code = sub[0] === '' ? 0 : Number(sub[0]);
		if (!Number.isInteger(code)) continue;
		if (code === 38 || code === 48 || code === 58) {
			let color: Color | null;
			if (sub.length > 1) {
				color = extended(sub.slice(1).map(Number), true);
			} else {
				// Semicolon form: the colour's parameters are the next groups.
				const rest = groups.slice(i + 1).map((g) => Number(g === '' ? 0 : g));
				const mode = rest[0];
				const used = mode === 5 ? 2 : mode === 2 ? 4 : 1;
				color = extended(rest.slice(0, used), false);
				i += used;
			}
			if (code === 38) s.fg = color ?? s.fg;
			else if (code === 48) s.bg = color ?? s.bg;
			// 58: underline colour, not shown.
			continue;
		}
		if (code === 0) Object.assign(s, PLAIN);
		else if (code === 1) s.bold = true;
		else if (code === 2) s.dim = true;
		else if (code === 3) s.italic = true;
		else if (code === 4) s.underline = sub[1] !== '0';
		else if (code === 7) s.inverse = true;
		else if (code === 8) s.hidden = true;
		else if (code === 9) s.strike = true;
		else if (code === 21) s.underline = true;
		else if (code === 22) s.bold = s.dim = false;
		else if (code === 23) s.italic = false;
		else if (code === 24) s.underline = false;
		else if (code === 27) s.inverse = false;
		else if (code === 28) s.hidden = false;
		else if (code === 29) s.strike = false;
		else if (code >= 30 && code <= 37) s.fg = { index: code - 30 };
		else if (code === 39) s.fg = null;
		else if (code >= 40 && code <= 47) s.bg = { index: code - 40 };
		else if (code === 49) s.bg = null;
		else if (code >= 90 && code <= 97) s.fg = { index: code - 90 + 8 };
		else if (code >= 100 && code <= 107) s.bg = { index: code - 100 + 8 };
	}
	return s;
}

/**
 * The colour of `5;n` or `2;r;g;b` (after 38/48). In the colon form
 * `2::r:g:b` has a colour-space id before r, which is skipped when present.
 * Null when the numbers do not make a colour.
 */
function extended(n: number[], colon: boolean): Color | null {
	const byte = (x: number | undefined) => (x !== undefined && Number.isInteger(x) && x >= 0 && x <= 255 ? x : null);
	if (n[0] === 5) {
		const index = byte(n[1]);
		return index === null ? null : { index };
	}
	if (n[0] === 2) {
		const rgb = colon && n.length >= 5 ? n.slice(2, 5) : n.slice(1, 4);
		const [r, g, b] = rgb.map(byte);
		return r == null || g == null || b == null ? null : { rgb: [r, g, b] };
	}
	return null;
}

/** The six levels of the 256-colour cube (indices 16–231), as xterm defines them. */
const CUBE = [0, 95, 135, 175, 215, 255];

/** A colour as a CSS value: the theme's variable for the 16 standard colours, RGB otherwise. */
export function colorCss(color: Color): string {
	if ('rgb' in color) return `rgb(${color.rgb[0]} ${color.rgb[1]} ${color.rgb[2]})`;
	const i = color.index;
	if (i < 16) return `var(--ansi-${i})`;
	if (i < 232) {
		const c = i - 16;
		return `rgb(${CUBE[Math.floor(c / 36)]} ${CUBE[Math.floor(c / 6) % 6]} ${CUBE[c % 6]})`;
	}
	const grey = 8 + 10 * (i - 232);
	return `rgb(${grey} ${grey} ${grey})`;
}

/**
 * The inline CSS for a style, '' for the plain one, so text without escapes
 * keeps the colour of its stream (stdout, or stderr's red). Equal styles give
 * equal strings: callers merge neighbouring spans by comparing them.
 */
export function styleCss(style: Style): string {
	let fg = style.fg && colorCss(style.fg);
	let bg = style.bg && colorCss(style.bg);
	if (style.inverse) [fg, bg] = [bg ?? 'var(--ansi-default-bg)', fg ?? 'var(--ansi-default-fg)'];
	const parts: string[] = [];
	if (style.hidden) parts.push('color:transparent');
	else if (fg) parts.push(`color:${fg}`);
	if (bg) parts.push(`background-color:${bg}`);
	if (style.bold) parts.push('font-weight:700');
	if (style.dim) parts.push('opacity:0.65');
	if (style.italic) parts.push('font-style:italic');
	const lines = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean);
	if (lines.length) parts.push(`text-decoration:${lines.join(' ')}`);
	return parts.join(';');
}

/** Removes every escape sequence from complete text: what copying a terminal's text yields. */
export function stripAnsi(text: string): string {
	return new AnsiStream()
		.feed(text)
		.map((s) => s.text)
		.join('');
}

/**
 * One output stream read as a terminal reads it. `feed` takes the next piece
 * of output and returns its text split into styled spans (escape sequences
 * removed); an escape sequence cut off at the end of the piece is held back
 * and completed by the next one.
 */
export class AnsiStream {
	#style: Style = PLAIN;
	#css = '';
	/** The start of an escape sequence whose end has not arrived yet. */
	#pending = '';

	/** The style the next text will have. */
	get style(): Style {
		return this.#style;
	}

	feed(piece: string): Span[] {
		const text = this.#pending + piece;
		this.#pending = '';
		const spans: Span[] = [];
		const emit = (t: string) => {
			if (!t) return;
			const last = spans.at(-1);
			if (last && last.css === this.#css) last.text += t;
			else spans.push({ text: t, css: this.#css });
		};
		let at = 0;
		for (;;) {
			const esc = text.indexOf(ESC, at);
			if (esc < 0) {
				emit(text.slice(at));
				break;
			}
			emit(text.slice(at, esc));
			const end = sequenceEnd(text, esc);
			if (end === null) {
				// Unfinished: keep it for the next piece, unless it is too long to be real.
				if (text.length - esc <= MAX_SEQUENCE) this.#pending = text.slice(esc);
				break;
			}
			if (text[esc + 1] === '[' && text[end - 1] === 'm') {
				const params = text.slice(esc + 2, end - 1);
				// Private SGR-like sequences (ESC [ > 4 m, xterm's modifyKeys) are not SGR.
				if (/^[\d;:]*$/.test(params)) {
					this.#style = applySgr(this.#style, params);
					this.#css = styleCss(this.#style);
				}
			}
			at = end;
		}
		return spans;
	}
}

/**
 * Where the escape sequence starting at `text[esc]` (an ESC) ends, exclusive;
 * null when `text` ends before it does.
 *
 *   CSI   ESC [ parameters(0x30–0x3F)* intermediates(0x20–0x2F)* final(0x40–0x7E)
 *   OSC   ESC ] … BEL or ESC \   (also DCS P, SOS X, PM ^, APC _: up to ESC \)
 *   other ESC intermediates(0x20–0x2F)* final(0x30–0x7E), e.g. ESC ( B, ESC 7
 */
function sequenceEnd(text: string, esc: number): number | null {
	const kind = text[esc + 1];
	if (kind === undefined) return null;
	if (kind === '[') {
		for (let i = esc + 2; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c >= 0x40 && c <= 0x7e) return i + 1;
			// Not a CSI byte: the sequence is malformed; it ends before this byte.
			if (c < 0x20 || c > 0x3f) return i;
		}
		return null;
	}
	if (kind === ']' || kind === 'P' || kind === 'X' || kind === '^' || kind === '_') {
		for (let i = esc + 2; i < text.length; i++) {
			if (kind === ']' && text[i] === '\x07') return i + 1;
			if (text[i] === ESC) {
				if (i + 1 >= text.length) return null;
				return text[i + 1] === '\\' ? i + 2 : i;
			}
		}
		return null;
	}
	for (let i = esc + 1; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0x30 && c <= 0x7e) return i + 1;
		if (c < 0x20 || c > 0x2f) return i;
	}
	return null;
}
