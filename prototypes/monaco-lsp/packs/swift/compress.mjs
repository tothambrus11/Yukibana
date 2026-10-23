// Writes .gz and .br siblings next to every .js, .wasm, .tar and .json in a
// directory, and prints the sizes: the app's host serves them when present.
// A sibling newer than its source is kept (brotli -q11 of the 113 MB
// swift-frontend.wasm takes minutes). Brotli uses a 16 MB window (lgwin 24,
// the most browsers decode) because the toolchain files are large.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dir = process.argv[2];
const fresh = (source, sibling) => {
    try {
        return statSync(sibling).mtimeMs >= statSync(source).mtimeMs;
    } catch {
        return false;
    }
};
for (const name of readdirSync(dir).sort()) {
    if (!/\.(js|wasm|tar|json)$/.test(name)) continue;
    const path = join(dir, name);
    const raw = readFileSync(path);
    if (!fresh(path, path + '.gz')) writeFileSync(path + '.gz', gzipSync(raw, { level: 9 }));
    if (!fresh(path, path + '.br')) {
        writeFileSync(path + '.br', brotliCompressSync(raw, {
            params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
                [constants.BROTLI_PARAM_LGWIN]: 24,
                [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
        }));
    }
    console.log(`${name}: ${raw.length} raw, ${statSync(path + '.gz').size} gzip, ${statSync(path + '.br').size} brotli`);
}
