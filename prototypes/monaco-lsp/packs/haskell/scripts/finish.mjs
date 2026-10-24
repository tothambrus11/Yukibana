// Writes manifest.json (versions, GHC's paths, and each file's size for
// download progress) and the .gz/.br siblings of every file in the output.
// rootfs.tar's come with the CI build (brotli at quality 11 takes some ten
// minutes on its 290 MB), and are never made here: without them it is
// served as it is.
// Usage: node finish.mjs <out dir> <versions.json of the GHC build>
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const [out, versionsFile] = process.argv.slice(2);
const v = JSON.parse(readFileSync(versionsFile, 'utf8'));
for (const f of readdirSync(out)) if ((f.endsWith('.gz') || f.endsWith('.br')) && !f.startsWith('rootfs.tar')) rmSync(join(out, f));
const names = readdirSync(out).filter((f) => f !== 'manifest.json' && !f.endsWith('.gz') && !f.endsWith('.br')).sort();
const compress = (data) => ({
    gz: gzipSync(data, { level: 9 }),
    br: brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
});
for (const f of names) {
    if (f === 'rootfs.tar') continue;
    const data = readFileSync(join(out, f));
    const { gz, br } = compress(data);
    if (br.length < data.length * 0.95) {
        writeFileSync(join(out, f + '.gz'), gz);
        writeFileSync(join(out, f + '.br'), br);
    }
}
const size = (f) => (existsSync(join(out, f)) ? statSync(join(out, f)).size : undefined);
const files = {};
for (const f of names) {
    files[f] = size(f);
    for (const s of ['gz', 'br']) if (size(`${f}.${s}`) !== undefined) files[`${f}.${s}`] = size(`${f}.${s}`);
}
const manifest = {
    versions: { ghc: v.ghc, packages: v.packages, ghcWasmMeta: v.ghcWasmMeta },
    ghc: { hsSearchDir: v.hsSearchDir, storeDb: v.storeDb },
    files,
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const m = compress(readFileSync(join(out, 'manifest.json')));
writeFileSync(join(out, 'manifest.json.gz'), m.gz);
writeFileSync(join(out, 'manifest.json.br'), m.br);
let raw = 0, br = 0;
for (const f of names) {
    const b = files[`${f}.br`] ?? files[f];
    raw += files[f];
    br += b;
    console.log(`${f.padEnd(24)} ${String(files[f]).padStart(10)} raw ${String(files[`${f}.gz`] ?? '').padStart(10)} gzip ${String(b).padStart(10)} brotli`);
}
console.log(`${'total'.padEnd(24)} ${String(raw).padStart(10)} raw ${''.padStart(10)}      ${String(br).padStart(10)} brotli`);
