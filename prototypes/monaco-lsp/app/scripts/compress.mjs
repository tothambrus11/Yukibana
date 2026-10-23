// Writes .br and .gz siblings for the app's own files in build/, the way
// adapter-static's `precompress` would, but leaves build/packs/ alone: each
// pack's build.sh already compressed its files, and recompressing a 100 MB
// wasm at the highest brotli level on every app build takes many minutes.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = new URL('../build/', import.meta.url).pathname;
const compressible = /\.(html|js|mjs|css|json|svg|webmanifest|txt|xml|wasm)$/;

async function* files(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (path !== join(root, 'packs')) yield* files(path);
		} else if (compressible.test(entry.name)) yield path;
	}
}

let count = 0;
for await (const path of files(root)) {
	const data = await readFile(path);
	await writeFile(`${path}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
	await writeFile(`${path}.gz`, gzipSync(data, { level: 9 }));
	count++;
}
console.log(`compressed ${count} app files (packs are compressed by their own build)`);
