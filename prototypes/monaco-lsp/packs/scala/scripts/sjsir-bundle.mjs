// Writes sjsir.bin: every .sjsir file under the given directories, in the
// class-path bundle format ([u32 BE header length][JSON [[path, offset,
// length], ...]][bytes]). The directories are in class-path order: the first
// one that has a path wins, as on a class path (build.sh passes the runtime
// helper, scala3-library_sjs1, scalajs-library, scalajs-scalalib,
// scalajs-javalib; today none of them overlap).
// Usage: node sjsir-bundle.mjs <out.bin> <dir>...
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const [out, ...dirs] = process.argv.slice(2);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const seen = new Map();
let shadowed = 0;
for (const dir of dirs) {
    for (const f of walk(dir).filter((f) => f.endsWith('.sjsir')).sort()) {
        const path = relative(dir, f).split('\\').join('/');
        if (seen.has(path)) { shadowed++; continue; }
        seen.set(path, readFileSync(f));
    }
}
const paths = [...seen.keys()].sort();
let off = 0;
const header = paths.map((p) => { const e = [p, off, seen.get(p).length]; off += seen.get(p).length; return e; });
const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
const len = Buffer.alloc(4);
len.writeUInt32BE(headerBytes.length);
writeFileSync(out, Buffer.concat([len, headerBytes, ...paths.map((p) => seen.get(p))]));
console.error(`wrote ${paths.length} IR files (${shadowed} shadowed), ${4 + headerBytes.length + off} bytes to ${out}`);
