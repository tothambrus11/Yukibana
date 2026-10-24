/**
 * The editors' text colours, and the colour arithmetic behind them: WCAG
 * contrast, compositing, and raising a colour until it reaches a contrast.
 *
 * Every token colour of the Yukibana themes (theme.svelte.ts) is raised to
 * at least 7:1 against its editor's background (Ambrus, 2026-10-24): the
 * themes as they were, and Monaco's `vs`/`vs-dark` rules underneath them,
 * had comments at 4.3:1 (dark) and 3.8:1 (light), registers at 3.3:1 and
 * line numbers near 2.8:1, and the compiler output views tint rows under the
 * text (link-colours.ts), which only takes contrast away. Raising keeps each
 * colour's hue and saturation and moves only its lightness, away from the
 * background, by the least that reaches the ratio.
 *
 * Imports nothing, so `node` can load this file directly (tests/palette.mjs).
 */

export type Theme = 'light' | 'dark';

/** A colour as `#rrggbb`. */
export type Hex = string;

/** sRGB channels, 0 to 1. */
export type Rgb = readonly [number, number, number];

/** A Monaco theme rule: a token and its colour (`rrggbb`, no `#`, as Monaco takes it), maybe a font style. */
export interface TokenRule {
	token: string;
	foreground?: string;
	fontStyle?: string;
}

/** The contrast every text colour of the themes reaches against its editor's background. */
export const TEXT_CONTRAST = 7;

/** Each theme's editor background and the caret line's. */
export const EDITOR: Record<Theme, { background: Hex; caretLine: Hex; panel: Hex }> = {
	dark: { background: '#121111', caretLine: '#1f1c1c', panel: '#121111' },
	light: { background: '#ffffff', caretLine: '#f4f1f1', panel: '#ffffff' },
};

/** The themes' own token colours, before raising (the rest come from Monaco's `vs` and `vs-dark`). */
export const OWN_RULES: Record<Theme, TokenRule[]> = {
	dark: [
		{ token: 'comment', foreground: '7f7676', fontStyle: 'italic' },
		{ token: 'keyword', foreground: 'e0788f' },
		{ token: 'string', foreground: '9ccf8a' },
		{ token: 'number', foreground: '6fc2c6' },
		{ token: 'type', foreground: '72c2a0' },
	],
	light: [
		{ token: 'comment', foreground: '8a8080', fontStyle: 'italic' },
		{ token: 'keyword', foreground: 'b3264f' },
		{ token: 'string', foreground: '3c7a28' },
		{ token: 'number', foreground: '0d7b80' },
		{ token: 'type', foreground: '018053' },
	],
};

/** The line numbers (and the caret line's), before raising. */
export const LINE_NUMBERS: Record<Theme, { normal: Hex; active: Hex }> = {
	dark: { normal: '#635c5c', active: '#e3dcdc' },
	light: { normal: '#a59c9c', active: '#352b2b' },
};

export function rgbOf(hex: Hex): Rgb {
	const h = hex.replace('#', '');
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

export function hexOf(c: Rgb): Hex {
	return '#' + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
}

/** CSS `hsl(h s% l%)` as sRGB; `s` and `l` in percent. */
export function hsl(h: number, s: number, l: number): Rgb {
	const S = s / 100;
	const L = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = S * Math.min(L, 1 - L);
	return [0, 8, 4].map((n) => L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) as unknown as Rgb;
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l * 100];
	const s = d / (1 - Math.abs(2 * l - 1));
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [(h * 60 + 360) % 360, s * 100, l * 100];
}

/** Colour `c` at opacity `alpha` over `under`, composited as CSS does (in sRGB). */
export function over(c: Rgb, alpha: number, under: Rgb): Rgb {
	return c.map((x, i) => x * alpha + under[i]! * (1 - alpha)) as unknown as Rgb;
}

/** What CSS `filter: brightness(factor)` makes of `c`. */
export function brightened(c: Rgb, factor: number): Rgb {
	return c.map((x) => Math.min(1, x * factor)) as unknown as Rgb;
}

/** WCAG 2 relative luminance. */
export function luminance(c: Rgb): number {
	const [r, g, b] = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as unknown as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => p - q) as [number, number];
	return (y + 0.05) / (x + 0.05);
}

/** Whether a background is dark (text on it is lighter than it). */
export const isDark = (background: Rgb) => luminance(background) < 0.5;

/**
 * `colour` with its lightness moved away from `background` by the least
 * (in steps of half a percent) that reaches `target`; `colour` itself when
 * it already does.
 */
export function raise(colour: Hex, background: Hex, target: number): Hex {
	const c = rgbOf(colour);
	const bg = rgbOf(background);
	if (contrast(c, bg) >= target) return colour.startsWith('#') ? colour.toLowerCase() : '#' + colour.toLowerCase();
	const [h, s, l] = toHsl(c);
	const up = isDark(bg);
	for (let next = l; up ? next <= 100 : next >= 0; next += up ? 0.5 : -0.5) {
		// Judged as written (8 bits a channel), since that is the colour drawn.
		const n = hexOf(hsl(h, s, next));
		if (contrast(rgbOf(n), bg) >= target) return n;
	}
	return up ? '#ffffff' : '#000000';
}

/**
 * The rules a theme is defined with: `base` (Monaco's own theme's rules),
 * then `own` over them, every foreground raised to `target` against
 * `background`. A rule of `base` that `own` names again is left out (the
 * theme's comes later and wins anyway); the default rule (token '') is
 * kept, since it colours every token no rule names.
 */
export function raisedRules(base: readonly TokenRule[], own: readonly TokenRule[], background: Hex, target = TEXT_CONTRAST): TokenRule[] {
	const named = new Set(own.map((r) => r.token));
	return [...base.filter((r) => !named.has(r.token)), ...own].map((r) =>
		r.foreground === undefined ? { ...r } : { ...r, foreground: raise('#' + r.foreground, background, target).slice(1) },
	);
}

/** The colour Monaco gives `token` under `rules`: the longest rule that is a dot-separated prefix of it, else the default rule's. */
export function colourOf(rules: readonly TokenRule[], token: string): Hex | null {
	let best: TokenRule | undefined;
	for (const r of rules) {
		if (r.foreground === undefined) continue;
		const matches = r.token === '' || token === r.token || token.startsWith(r.token + '.');
		if (matches && (!best || r.token.length >= best.token.length)) best = r;
	}
	return best ? '#' + best.foreground!.toLowerCase() : null;
}

/**
 * The tokens the compiler output views and a C or C++ source can show
 * (asm-languages.ts, Monaco's cpp grammar), whose colours the views' tints
 * are checked against (link-colours.ts `judge`).
 */
export const VIEW_TOKENS = ['', 'comment', 'keyword', 'string', 'number', 'number.hex', 'type', 'variable', 'variable.predefined', 'annotation', 'metatag', 'delimiter', 'identifier', 'predefined', 'constant'];

/** The distinct colours of VIEW_TOKENS under `rules`, and the line numbers' (Monaco's colour ids, as the theme sets them). */
export function viewText(rules: readonly TokenRule[], lineNumbers: Record<string, Hex>): Hex[] {
	const colours = VIEW_TOKENS.map((t) => colourOf(rules, t)).filter((c): c is Hex => c !== null);
	return [...new Set([...colours, ...Object.values(lineNumbers).map((c) => c.toLowerCase())])];
}
