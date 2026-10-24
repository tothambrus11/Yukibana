// Writes .gz and .br siblings next to each file given (contract: the app's
// host serves them when present). Maximum compression; these are built once.
// Brotli is tried with its default 4 MB window and with 16 MB (LGWIN 24,
// which browsers decode) and the smaller result kept: the wide window wins
// on the stored stdlib archive, whose repeats are far apart, and loses a
// little on the wasm.
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

for (const file of process.argv.slice(2)) {
    const data = readFileSync(file);
    const gz = gzipSync(data, { level: 9 });
    const brotli = (lgwin) =>
        brotliCompressSync(data, {
            params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
                [constants.BROTLI_PARAM_LGWIN]: lgwin,
                [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
            },
        });
    const a = brotli(22);
    const b = data.length > 4 << 20 ? brotli(24) : a;
    const br = b.length < a.length ? b : a;
    writeFileSync(`${file}.gz`, gz);
    writeFileSync(`${file}.br`, br);
    console.log(`${file.split('/').pop()}: ${data.length} raw, ${gz.length} gzip, ${br.length} brotli`);
}
