// Writes .gz and .br siblings next to each file given (contract: the app's
// host serves them when present). Maximum compression; these are built once.
// Each is written beside its target and renamed over it, so that a hard
// link to the old file (the app's build links the pack's files) keeps the
// old bytes rather than changing under it.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

for (const file of process.argv.slice(2)) {
    const data = readFileSync(file);
    const gz = gzipSync(data, { level: 9 });
    const br = brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
    });
    for (const [ext, bytes] of [['gz', gz], ['br', br]]) {
        writeFileSync(`${file}.${ext}.part`, bytes);
        renameSync(`${file}.${ext}.part`, `${file}.${ext}`);
    }
    console.log(`${file.split('/').pop()}: ${data.length} raw, ${gz.length} gzip, ${br.length} brotli`);
}
