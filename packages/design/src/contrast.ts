/** WCAG 2 contrast between two OKLCH colours, as the browser would show them in sRGB.
 *
 *  A colour outside sRGB is clipped per channel, which is what browsers do today for `oklch()` in an sRGB display; a
 *  token far outside the gamut would show a different hue than its numbers say, and this clipping would hide it, so
 *  `inGamut` lets a test refuse such tokens instead. Translucent colours are composited over the background first. */

import type { Oklch } from './tokens.js';

type Rgb = readonly [number, number, number];

/** Linear-light sRGB, each channel nominally from 0 to 1 but not clipped, by Björn Ottosson's OKLab matrices. */
export function linearSrgb({ l, c, h }: Oklch): Rgb {
    const hr = (h * Math.PI) / 180;
    const a = c * Math.cos(hr);
    const b = c * Math.sin(hr);
    const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
        -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
        -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
    ];
}

/** True if no channel of the colour lies further than `tolerance` outside sRGB's 0 to 1 (in linear light). The default
 *  allows only rounding. */
export function inGamut(color: Oklch, tolerance = 0.002): boolean {
    return linearSrgb(color).every(ch => ch >= -tolerance && ch <= 1 + tolerance);
}

const clip = (x: number): number => Math.min(1, Math.max(0, x));
const encode = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const decode = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** The colour in gamma-encoded sRGB from 0 to 1, clipped, after compositing over `under` when it is translucent. */
function shown(color: Oklch, under: Rgb): Rgb {
    const [r, g, b] = linearSrgb(color);
    const over = (ch: number, base: number): number => encode(clip(ch)) * color.alpha + base * (1 - color.alpha);
    return [over(r, under[0]), over(g, under[1]), over(b, under[2])];
}

const luminance = (rgb: Rgb): number => 0.2126 * decode(rgb[0]) + 0.7152 * decode(rgb[1]) + 0.0722 * decode(rgb[2]);

/** The WCAG 2 contrast ratio, from 1 to 21, of `fg` drawn on `bg`. `bg` must be opaque. */
export function contrast(fg: Oklch, bg: Oklch): number {
    const back = shown(bg, [1, 1, 1]);
    const a = luminance(shown(fg, back));
    const b = luminance(back);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
