import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, inGamut } from '../src/contrast.js';
import { colorAt, compileCss, cssValue, parseTokens, propertyName, TokenError, type Token } from '../src/tokens.js';

const file = (p: string): unknown => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const light = parseTokens(file('tokens/base.tokens.json'));
const dark = parseTokens(file('tokens/dark.tokens.json'));
/** The dark theme as a full set: every light token, with the dark file's colours in place. */
const darkFull: Token[] = light.map(t => dark.find(d => d.path.join('.') === t.path.join('.')) ?? t);

describe('the token files', () => {
    it('compile to the css/tokens.css that is committed, so apps outside this repository can copy it', () => {
        expect(readFileSync(new URL('../css/tokens.css', import.meta.url), 'utf8')).toBe(compileCss(light, dark));
    });

    it('give every colour of the dark theme a light counterpart, and only colours', () => {
        expect(() => compileCss(light, dark)).not.toThrow();
        expect(dark.every(t => t.value.type === 'color')).toBe(true);
    });

    // Several chosen colours (the green accent, the chip tints) sit a hair outside sRGB, at most 0.052 of a channel in
    // linear light. The browser clips that per channel, which shifts nothing a person can see, and the colours were picked
    // by eye as the browser showed them. A colour further out would change hue when clipped, so it is refused.
    it('hold only colours a screen can show without a visible shift when the browser clips them', () => {
        const outside = [...light, ...dark].filter(t => t.value.type === 'color' && !inGamut(t.value.color, 0.06)).map(t => t.path.join('.'));
        expect(outside).toEqual([]);
    });
});

/** Text that must be readable: WCAG AA, 4.5:1. */
const TEXT: [string, string][] = [
    ['ink', 'bg'],
    ['ink', 'surface'],
    ['ink', 'sunken'],
    ['soft', 'bg'],
    ['soft', 'surface'],
    ['soft', 'sunken'],
    ['accent-strong', 'bg'],
    ['accent-strong', 'surface'],
    ['accent-strong', 'accent-bg'],
    // A selected row: its text on the green tint.
    ['ink', 'accent-bg'],
    // A done button's label ("✓ Saved").
    ['ok', 'surface'],
    ['on-accent', 'accent'],
    ['on-accent', 'danger'],
    ['danger', 'surface'],
    ['danger', 'danger-bg'],
    ['warn', 'warn-bg'],
    ['info', 'info-bg'],
    ['on-toast', 'toast'],
    ['code.ink', 'code.bg'],
    ['code.keyword', 'code.bg'],
    ['code.function', 'code.bg'],
    ['code.string', 'code.bg'],
    ['code.number', 'code.bg'],
    ['code.comment', 'code.bg'],
    ['soft', 'code.bar'],
    ...['blue', 'violet', 'pink', 'teal', 'yellow', 'green', 'grey'].map((h): [string, string] => [`chip.${h}.fg`, `chip.${h}.bg`]),
];
/** Things that must be seen but are not text: controls' borders, the focus ring, icons. WCAG 1.4.11, 3:1. */
const UI: [string, string][] = [
    ['line-strong', 'surface'],
    ['line-strong', 'bg'],
    // The search button's border on its own fill, and a checkbox in a hovered row.
    ['line-strong', 'sunken'],
    ['accent', 'surface'],
    ['accent', 'code.bg'],
    ['ink', 'bg'],
    // The focus ring inside a message pill is the pill's text colour.
    ['on-toast', 'toast'],
    ['on-accent', 'danger'],
    ['ok', 'surface'],
    ['ok', 'bg'],
];

describe.each([
    ['light', light],
    ['dark', darkFull],
])('in the %s theme', (_, set) => {
    it.each(TEXT)('%s on %s is readable text (4.5:1)', (fg, bg) => {
        expect(contrast(colorAt(set, `color.${fg}`), colorAt(set, `color.${bg}`))).toBeGreaterThanOrEqual(4.5);
    });
    it.each(UI)('%s on %s is visible as a control or icon (3:1)', (fg, bg) => {
        expect(contrast(colorAt(set, `color.${fg}`), colorAt(set, `color.${bg}`))).toBeGreaterThanOrEqual(3);
    });
});

describe('reading a token file', () => {
    it('takes the type from the nearest group that names one', () => {
        expect(parseTokens({ a: { $type: 'number', b: { c: { $value: 2 } }, d: { $type: 'fontWeight', $value: 700 } } })).toEqual([
            { path: ['a', 'b', 'c'], value: { type: 'number', value: 2 } },
            { path: ['a', 'd'], value: { type: 'fontWeight', weight: 700 } },
        ]);
    });

    it.each([
        ['a token with no type anywhere above it', { a: { $value: 1 } }, 'a: no $type'],
        ['a colour in another colour space', { a: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0] } } }, 'a: a color must be'],
        ['a lightness given in percent', { a: { $type: 'color', $value: { colorSpace: 'oklch', components: [50, 0.1, 160] } } }, 'a: lightness must be from 0 to 1'],
        ['a dimension in em', { a: { $type: 'dimension', $value: { value: 1, unit: 'em' } } }, 'a: a dimension must be'],
        ['a type this package does not compile', { a: { $type: 'shadow', $value: {} } }, 'a: the type shadow'],
        ['a token that is not an object', { a: { b: 3 } }, 'a.b: expected a group or a token'],
    ])('refuses %s, naming the token', (_, input, message) => {
        expect(() => parseTokens(input)).toThrow(TokenError);
        expect(() => parseTokens(input)).toThrow(message);
    });
});

describe('compiling to CSS', () => {
    it.each([
        [['color', 'bg'], '--yk-bg'],
        [['color', 'code', 'bg'], '--yk-code-bg'],
        [['radius', 'md'], '--yk-radius-md'],
        [['font', 'family', 'mono'], '--yk-font-family-mono'],
    ])('names %j %s', (path, name) => {
        expect(propertyName(path)).toBe(name);
    });

    it.each([
        [{ type: 'color', color: { l: 0.5, c: 0.115, h: 162, alpha: 1 } } as const, 'oklch(50% 0.115 162)'],
        [{ type: 'color', color: { l: 0.8, c: 0.03, h: 260, alpha: 0.16 } } as const, 'oklch(80% 0.03 260 / 0.16)'],
        [{ type: 'dimension', value: 8, unit: 'px' } as const, '8px'],
        [{ type: 'duration', value: 120, unit: 'ms' } as const, '120ms'],
        [{ type: 'fontFamily', families: ['JetBrains Mono', 'ui-monospace', 'monospace'] } as const, "'JetBrains Mono', ui-monospace, monospace"],
        [{ type: 'cubicBezier', points: [0.2, 0, 0, 1] } as const, 'cubic-bezier(0.2, 0, 0, 1)'],
    ])('writes %j as %s', (value, css) => {
        expect(cssValue(value)).toBe(css);
    });

    it('pairs each colour with its dark value and leaves other tokens alone', () => {
        const css = compileCss(
            [
                { path: ['color', 'ink'], value: { type: 'color', color: { l: 0.2, c: 0, h: 0, alpha: 1 } } },
                { path: ['radius', 'md'], value: { type: 'dimension', value: 8, unit: 'px' } },
            ],
            [{ path: ['color', 'ink'], value: { type: 'color', color: { l: 0.9, c: 0, h: 0, alpha: 1 } } }],
        );
        expect(css).toContain('    --yk-ink: light-dark(oklch(20% 0 0), oklch(90% 0 0));');
        expect(css).toContain('    --yk-radius-md: 8px;');
    });

    it('refuses a dark theme that overrides a token the light theme lacks', () => {
        expect(() => compileCss([], [{ path: ['color', 'ink'], value: { type: 'color', color: { l: 0.9, c: 0, h: 0, alpha: 1 } } }])).toThrow('does not have');
    });
});

describe('contrast', () => {
    it('is 21 for black on white and 1 for a colour on itself', () => {
        const black = { l: 0, c: 0, h: 0, alpha: 1 };
        const white = { l: 1, c: 0, h: 0, alpha: 1 };
        expect(contrast(black, white)).toBeCloseTo(21, 1);
        expect(contrast(white, white)).toBeCloseTo(1, 5);
    });
});
