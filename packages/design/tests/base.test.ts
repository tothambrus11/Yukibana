import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_PARTS, concatBase } from '../src/base.js';

const text = (p: string): string => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

describe('css/base.css', () => {
    it('is the parts in css/base/ put together, so apps that import the one file get every part', () => {
        expect(text('css/base.css')).toBe(concatBase(BASE_PARTS.map(name => ({ name, css: text(`css/base/${name}.css`) }))));
    });

    it('is built from every file in css/base/, none left out', () => {
        const files = readdirSync(new URL('../css/base/', import.meta.url)).map(f => f.replace(/\.css$/, ''));
        expect(files.toSorted()).toEqual(BASE_PARTS.toSorted());
    });

    it('names each part it came from, and ends every part with one newline', () => {
        const css = concatBase([
            { name: 'a', css: '.a {}\r\n\r\n' },
            { name: 'b', css: '\n.b {}' },
        ]);
        expect(css).toContain('/* ---- css/base/a.css ---- */\n\n.a {}\n\n/* ---- css/base/b.css ---- */\n\n.b {}\n');
        expect(css).not.toContain('\r');
        expect(css.endsWith('.b {}\n')).toBe(true);
    });
});
