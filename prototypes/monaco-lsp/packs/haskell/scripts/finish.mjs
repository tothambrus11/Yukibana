// Writes manifest.json (versions, and each file's size for download
// progress) and the .gz/.br siblings of every file in the output.
// Usage: node finish.mjs <out dir> <MicroHs version> <containers version>
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const [out, microhs, containers] = process.argv.slice(2);
for (const f of readdirSync(out)) if (f.endsWith('.gz') || f.endsWith('.br')) rmSync(join(out, f));
const names = readdirSync(out).filter((f) => f !== 'manifest.json').sort();
const files = Object.fromEntries(names.map((f) => [f, readFileSync(join(out, f)).length]));
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ versions: { microhs, containers }, files }, null, 2) + '\n');
let raw = 0, br = 0;
for (const f of [...names, 'manifest.json']) {
    const data = readFileSync(join(out, f));
    const gz = gzipSync(data, { level: 9 });
    const b = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    // The packages are compressed already (MicroHs writes them so): a
    // sibling that saves nothing is left out, and the raw file is served.
    if (b.length < data.length * 0.95) {
        writeFileSync(join(out, f + '.gz'), gz);
        writeFileSync(join(out, f + '.br'), b);
    }
    raw += data.length;
    br += Math.min(b.length, data.length);
    console.log(`${f.padEnd(24)} ${String(data.length).padStart(9)} raw ${String(gz.length).padStart(9)} gzip ${String(b.length).padStart(9)} brotli`);
}
console.log(`${'total'.padEnd(24)} ${String(raw).padStart(9)} raw ${''.padStart(9)}      ${String(br).padStart(9)} brotli`);
