/** Reading W3C design token files (format 2025.10) and compiling them to CSS custom properties.
 *
 *  Pure: functions of parsed JSON and strings, no file system. `scripts/build.ts` does the reading and writing. Only the
 *  token types Yukibana uses are understood; any other `$type`, or a value that does not fit its type, is an error that
 *  names the token's path, because a token silently dropped from the CSS is a colour that quietly falls back to nothing.
 */

/** A colour in OKLCH, the only colour space the tokens use. `l` is lightness from 0 to 1, `c` chroma (0 to about 0.37),
 *  `h` hue in degrees, `alpha` from 0 to 1. */
export type Oklch = { readonly l: number; readonly c: number; readonly h: number; readonly alpha: number };

/** What one token holds, by its `$type`. A dimension's unit is `px` or `rem`; a duration's is `ms` or `s`. */
export type TokenValue =
    | { readonly type: 'color'; readonly color: Oklch }
    | { readonly type: 'dimension'; readonly value: number; readonly unit: 'px' | 'rem' }
    | { readonly type: 'duration'; readonly value: number; readonly unit: 'ms' | 's' }
    | { readonly type: 'fontFamily'; readonly families: readonly string[] }
    | { readonly type: 'fontWeight'; readonly weight: number }
    | { readonly type: 'number'; readonly value: number }
    | { readonly type: 'cubicBezier'; readonly points: readonly [number, number, number, number] };

/** One token: where it sits in the file (`['color', 'code', 'bg']`) and its value. */
export type Token = { readonly path: readonly string[]; readonly value: TokenValue };

/** Thrown for a token file that is not what this module understands. The message names the token. */
export class TokenError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every token in a parsed token file, in the order the file lists them. A group's `$type` applies to the tokens below
 *  it unless one says its own. Keys starting with `$` are the format's own and never tokens or groups. */
export function parseTokens(file: unknown): Token[] {
    const out: Token[] = [];
    walk(file, [], undefined, out);
    return out;
}

function walk(node: unknown, path: string[], inherited: string | undefined, out: Token[]): void {
    const where = path.join('.') || '(root)';
    if (!isObject(node)) throw new TokenError(`${where}: expected a group or a token, found ${JSON.stringify(node)}`);
    const own = node['$type'];
    if (own !== undefined && typeof own !== 'string') throw new TokenError(`${where}: $type must be a string`);
    const type = own ?? inherited;
    if ('$value' in node) {
        if (type === undefined) throw new TokenError(`${where}: no $type on the token or any group above it`);
        out.push({ path, value: valueOf(node['$value'], type, where) });
        return;
    }
    for (const [key, child] of Object.entries(node)) if (!key.startsWith('$')) walk(child, [...path, key], type, out);
}

function valueOf(v: unknown, type: string, where: string): TokenValue {
    const bad = (what: string): never => {
        throw new TokenError(`${where}: ${what}, found ${JSON.stringify(v)}`);
    };
    switch (type) {
        case 'color': {
            if (!isObject(v) || v['colorSpace'] !== 'oklch') return bad('a color must be { colorSpace: "oklch", components: [l, c, h] }');
            const comps = v['components'];
            const [l, c, h, extra] = Array.isArray(comps) ? (comps as unknown[]) : [];
            if (!isNumber(l) || !isNumber(c) || !isNumber(h) || extra !== undefined) return bad('components must be three numbers');
            const alpha = v['alpha'] ?? 1;
            if (!isNumber(alpha) || alpha < 0 || alpha > 1) return bad('alpha must be a number from 0 to 1');
            if (l < 0 || l > 1) return bad('lightness must be from 0 to 1');
            if (c < 0) return bad('chroma cannot be negative');
            return { type, color: { l, c, h, alpha } };
        }
        case 'dimension': {
            if (!isObject(v) || !isNumber(v['value']) || (v['unit'] !== 'px' && v['unit'] !== 'rem')) return bad('a dimension must be { value, unit: "px" | "rem" }');
            return { type, value: v['value'], unit: v['unit'] };
        }
        case 'duration': {
            if (!isObject(v) || !isNumber(v['value']) || (v['unit'] !== 'ms' && v['unit'] !== 's')) return bad('a duration must be { value, unit: "ms" | "s" }');
            return { type, value: v['value'], unit: v['unit'] };
        }
        case 'fontFamily': {
            const list: unknown[] = typeof v === 'string' ? [v] : Array.isArray(v) ? (v as unknown[]) : [];
            const families = list.filter((f): f is string => typeof f === 'string' && f !== '');
            if (families.length === 0 || families.length !== list.length) return bad('a font family must be a name or a list of names');
            return { type, families };
        }
        case 'fontWeight':
            if (!isNumber(v) || v < 1 || v > 1000) return bad('a font weight must be a number from 1 to 1000');
            return { type, weight: v };
        case 'number':
            if (!isNumber(v)) return bad('expected a number');
            return { type, value: v };
        case 'cubicBezier': {
            const [x1, y1, x2, y2, extra] = Array.isArray(v) ? (v as unknown[]) : [];
            if (!isNumber(x1) || !isNumber(y1) || !isNumber(x2) || !isNumber(y2) || extra !== undefined) return bad('a cubic bezier must be four numbers');
            if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return bad('the x coordinates of a cubic bezier must be from 0 to 1');
            return { type, points: [x1, y1, x2, y2] };
        }
        default:
            return bad(`the type ${type} is not one this package compiles`);
    }
}

/** The custom property a token compiles to: `--yk-` and its path joined by `-`, without the leading `color` group, so
 *  `color.code.bg` is `--yk-code-bg` and `radius.md` is `--yk-radius-md`. */
export function propertyName(path: readonly string[]): string {
    const parts = path[0] === 'color' ? path.slice(1) : path;
    return '--yk-' + parts.join('-');
}

const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** A colour as CSS, `oklch(L% C H)` or `oklch(L% C H / A)`, lightness in percent so a reader sees the step. */
export function cssColor({ l, c, h, alpha }: Oklch): string {
    const body = `${trim(l * 100, 2)}% ${trim(c, 4)} ${trim(h, 2)}`;
    return alpha === 1 ? `oklch(${body})` : `oklch(${body} / ${trim(alpha, 3)})`;
}

const quoteFamily = (f: string): string => (/^[a-z-]+$/.test(f) ? f : `'${f.replaceAll("'", "\\'")}'`);

/** A token's value as CSS. Generic family names (`monospace`, `ui-sans-serif`) stay unquoted, as CSS requires. */
export function cssValue(v: TokenValue): string {
    if (v.type === 'color') return cssColor(v.color);
    if (v.type === 'dimension' || v.type === 'duration') return `${trim(v.value, 4)}${v.unit}`;
    if (v.type === 'fontFamily') return v.families.map(quoteFamily).join(', ');
    if (v.type === 'fontWeight') return String(v.weight);
    if (v.type === 'number') return trim(v.value, 4);
    return `cubic-bezier(${v.points.map(p => trim(p, 4)).join(', ')})`;
}

/** The stylesheet for both themes: one `:root` rule in which each colour is `light-dark(light, dark)` and every other
 *  token is its value, then `data-theme` rules that pin a scheme. A page follows the system's scheme unless its root
 *  says `data-theme="light"` or `"dark"`.
 *
 *  `dark` may only override colours that `light` has: a dark token with no light counterpart, or a non-colour in the
 *  dark file, is a `TokenError`, so the two files cannot drift apart. A light colour with no dark override is the same
 *  in both themes. */
export function compileCss(light: readonly Token[], dark: readonly Token[]): string {
    const key = (t: Token): string => t.path.join('.');
    const darkByPath = new Map(dark.map(t => [key(t), t]));
    const lightPaths = new Set(light.map(key));
    for (const t of dark) {
        if (!lightPaths.has(key(t))) throw new TokenError(`${key(t)}: the dark theme overrides a token the base file does not have`);
        if (t.value.type !== 'color') throw new TokenError(`${key(t)}: the dark theme may only override colours`);
    }
    const lines = light.map(t => {
        const d = darkByPath.get(key(t));
        const value = t.value.type === 'color' && d !== undefined ? `light-dark(${cssValue(t.value)}, ${cssValue(d.value)})` : cssValue(t.value);
        return `    ${propertyName(t.path)}: ${value};`;
    });
    return [
        '/* Generated by packages/design/scripts/build.ts from tokens/base.tokens.json and tokens/dark.tokens.json. Do not edit: change the tokens and run `pnpm --filter @yukibana/design build`. */',
        ':root {',
        '    color-scheme: light dark;',
        ...lines,
        '}',
        ":root[data-theme='light'] {",
        '    color-scheme: light;',
        '}',
        ":root[data-theme='dark'] {",
        '    color-scheme: dark;',
        '}',
        '',
    ].join('\n');
}

/** A colour token by its path in the given list, for tests and tools. Throws if it is missing or not a colour. */
export function colorAt(tokens: readonly Token[], path: string): Oklch {
    const t = tokens.find(x => x.path.join('.') === path);
    if (t === undefined || t.value.type !== 'color') throw new TokenError(`${path}: no such colour token`);
    return t.value.color;
}
