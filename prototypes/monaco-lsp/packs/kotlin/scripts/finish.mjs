// Writes manifest.json and the .gz/.br siblings of every file in the output.
// Usage: node finish.mjs <out dir> <web-tree-sitter version> <kotlin grammar version>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const [out, webTreeSitter, grammar] = process.argv.slice(2);
const file = (f) => ({ file: f, size: readFileSync(join(out, f)).length });
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
    versions: { webTreeSitter, kotlinGrammar: grammar },
    runtime: file('tree-sitter.wasm'),
    grammar: file('tree-sitter-kotlin.wasm'),
}, null, 2) + '\n');
for (const f of readdirSync(out).sort()) {
    if (f.endsWith('.gz') || f.endsWith('.br')) continue;
    const raw = readFileSync(join(out, f));
    const gz = gzipSync(raw, { level: 9 });
    const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    writeFileSync(join(out, f + '.gz'), gz);
    writeFileSync(join(out, f + '.br'), br);
    console.log(`${f.padEnd(24)} ${String(raw.length).padStart(9)} raw ${String(gz.length).padStart(9)} gzip ${String(br.length).padStart(9)} brotli`);
}
