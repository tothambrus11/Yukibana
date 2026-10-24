// Writes manifest.json and the .gz/.br siblings of every file in the output.
// Usage: node finish.mjs <out dir> <teavm version> <teavm-javac commit> <jdk25u revision> <junit version>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const [out, teavm, teavmJavac, jdk, junit] = process.argv.slice(2);
const size = (f) => readFileSync(join(out, f)).length;
const file = (f) => ({ file: f, size: size(f) });
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
    versions: { javac: `OpenJDK 25u (jdk25u ${jdk.slice(0, 12)})`, teavm, teavmJavac: teavmJavac.slice(0, 12), junitJupiter: junit },
    compiler: file('compiler.wasm'),
    runtime: file('teavm-runtime.js'),
    classlibJavac: file('classlib-javac.bin'),
    classlibTeaVM: file('classlib-teavm.bin'),
    junit: file('junit.jar'),
}, null, 2) + '\n');
for (const f of readdirSync(out).sort()) {
    if (f.endsWith('.gz') || f.endsWith('.br')) continue;
    const raw = readFileSync(join(out, f));
    const gz = gzipSync(raw, { level: 9 });
    const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    writeFileSync(join(out, f + '.gz'), gz);
    writeFileSync(join(out, f + '.br'), br);
    console.log(`${f.padEnd(20)} ${String(raw.length).padStart(9)} raw ${String(gz.length).padStart(9)} gzip ${String(br.length).padStart(9)} brotli`);
}
