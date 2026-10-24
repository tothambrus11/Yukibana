// Writes .gz and .br siblings for every file in a directory (the app's host
// serves them when present) and prints a size table.
// usage: node tools/compress.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/compress.mjs <dir>');
  process.exit(2);
}
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`.padStart(12);
let raw = 0, gz = 0, br = 0;
console.log(`${'file'.padEnd(28)}${'raw'.padStart(12)}${'gzip -9'.padStart(12)}${'brotli 11'.padStart(12)}`);
for (const name of fs.readdirSync(dir).sort()) {
  if (/\.(gz|br)$/.test(name)) continue;
  const file = path.join(dir, name);
  const bytes = fs.readFileSync(file);
  // Brotli 11 on 3.5 MB takes a while; siblings newer than the file are kept.
  const fresh = (sibling) => fs.existsSync(sibling) && fs.statSync(sibling).mtimeMs >= fs.statSync(file).mtimeMs;
  if (!fresh(`${file}.gz`)) fs.writeFileSync(`${file}.gz`, zlib.gzipSync(bytes, { level: 9 }));
  if (!fresh(`${file}.br`)) {
    fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(bytes, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
    }));
  }
  const g = fs.statSync(`${file}.gz`).size;
  const b = fs.statSync(`${file}.br`).size;
  raw += bytes.length; gz += g; br += b;
  console.log(`${name.padEnd(28)}${kb(bytes.length)}${kb(g)}${kb(b)}`);
}
console.log(`${'total'.padEnd(28)}${kb(raw)}${kb(gz)}${kb(br)}`);
