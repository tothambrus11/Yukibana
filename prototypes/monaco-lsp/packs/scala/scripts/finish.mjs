// Writes manifest.json and the .gz/.br siblings of every file in the output.
// Usage: node finish.mjs <out dir> <scala version> <jdk version> <scala.js version> <scalacheck version>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const [out, scalaVersion, jdkVersion, scalajsVersion, scalacheckVersion] = process.argv.slice(2);
const size = (f) => readFileSync(join(out, f)).length;
const count = (f) => {
    const b = readFileSync(join(out, f));
    return JSON.parse(b.subarray(4, 4 + b.readUInt32BE(0)).toString('utf8')).length;
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
    scalaVersion,
    compiler: { file: 'scalac.js', size: size('scalac.js') },
    classpath: { file: 'classpath.bin', size: size('classpath.bin'), entries: count('classpath.bin'), jdk: `Temurin ${jdkVersion} java.base` },
    // What runner.js downloads besides the two files above (see README, "Running").
    runner: {
        scalajsVersion,
        classpath: { file: 'classpath-sjs.bin', size: size('classpath-sjs.bin'), entries: count('classpath-sjs.bin') },
        library: { file: 'sjsir.bin', size: size('sjsir.bin'), entries: count('sjsir.bin') },
        linker: { file: 'sjslinker.js', size: size('sjslinker.js') },
    },
    // ScalaCheck, for a project that names org.scalacheck: its class path
    // bundle (the server and the runner's compiler) and its IR (the linker).
    scalacheck: {
        version: scalacheckVersion,
        classpath: { file: `scalacheck-${scalacheckVersion}-classpath.bin`, size: size(`scalacheck-${scalacheckVersion}-classpath.bin`), entries: count(`scalacheck-${scalacheckVersion}-classpath.bin`) },
        library: { file: `scalacheck-${scalacheckVersion}-sjsir.bin`, size: size(`scalacheck-${scalacheckVersion}-sjsir.bin`), entries: count(`scalacheck-${scalacheckVersion}-sjsir.bin`) },
    },
}, null, 2) + '\n');
for (const f of readdirSync(out).sort()) {
    if (f.endsWith('.gz') || f.endsWith('.br')) continue;
    const raw = readFileSync(join(out, f));
    const gz = gzipSync(raw, { level: 9 });
    const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    writeFileSync(join(out, f + '.gz'), gz);
    writeFileSync(join(out, f + '.br'), br);
    console.log(`${f.padEnd(18)} ${String(raw.length).padStart(9)} raw ${String(gz.length).padStart(9)} gzip ${String(br.length).padStart(9)} brotli`);
}
