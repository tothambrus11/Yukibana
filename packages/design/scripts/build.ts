/** Writes css/tokens.css from the token files. `--check` writes nothing and exits non-zero if the committed file is not
 *  what the tokens compile to, which is how CI catches a token edited without a rebuild. */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileCss, parseTokens } from '../src/tokens.ts';

const at = (p: string): string => fileURLToPath(new URL('../' + p, import.meta.url));
const read = (p: string): unknown => JSON.parse(readFileSync(at(p), 'utf8'));

const css = compileCss(parseTokens(read('tokens/base.tokens.json')), parseTokens(read('tokens/dark.tokens.json')));
const out = at('css/tokens.css');
if (process.argv.includes('--check')) {
    let current = '';
    try {
        current = readFileSync(out, 'utf8');
    } catch {}
    if (current !== css) {
        console.error('css/tokens.css is not what the tokens compile to. Run `pnpm --filter @yukibana/design build` and commit the result.');
        process.exit(1);
    }
} else writeFileSync(out, css);
