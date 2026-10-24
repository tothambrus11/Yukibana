// Writes .gz and .br siblings next to each file given (contract: the app's
// host serves them when present). Maximum compression; these are built once.
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

for (const file of process.argv.slice(2)) {
    const data = readFileSync(file);
    const gz = gzipSync(data, { level: 9 });
    const br = brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
    });
    writeFileSync(`${file}.gz`, gz);
    writeFileSync(`${file}.br`, br);
    console.log(`${file.split('/').pop()}: ${data.length} raw, ${gz.length} gzip, ${br.length} brotli`);
}
