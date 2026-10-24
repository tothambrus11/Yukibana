// Builds the browser's XCTest (xctest/XCTest/*.swift) with the pack's own
// compiler, swift-frontend-lsp.wasm (Swift 6.3.3), under Node, because a binary
// .swiftmodule only loads in the compiler version that wrote it:
//
//   node tools/build-xctest.mjs <dir with swift-frontend-lsp.wasm> <swift-sysroot.tar> <out.tar>
//
// Writes <out.tar> (swift-xctest.tar), which runner.js and server.js
// unpack over the sysroot when a project imports XCTest:
//
//   swift/lib/swift_static/wasi/XCTest.swiftmodule/wasm32-unknown-wasip1.swiftmodule
//   swift/lib/swift_static/wasi/libXCTest.a
//
// The archive is made by llvm-ar (from PATH: build.sh puts the Swift
// toolchain there) because wasm-ld wants an archive symbol index.
//
// One whole-module `-c` with `-emit-module-path`, as the driver does it, and
// `-module-link-name XCTest`, so that `import XCTest` adds `-lXCTest` to the
// object's autolink entries and runner.js links it with no special case.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tc from '../src/toolchain.js';

const [toolDir, sysrootTar, outTar] = process.argv.slice(2);
const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../xctest/XCTest');

const t0 = performance.now();
const frontend = await WebAssembly.compile(readFileSync(join(toolDir, tc.FRONTEND_WASM)));
const root = new tc.Directory(new Map());
tc.untar(root, new Uint8Array(readFileSync(sysrootTar)), tc.SYSROOT);
tc.mkdirp(root, '/tmp');
const sources = readdirSync(SRC).filter((n) => n.endsWith('.swift')).sort().map((n) => {
    tc.writeFile(root, `/xctest/${n}`, readFileSync(join(SRC, n)));
    return `/xctest/${n}`;
});
let log = '';
const sink = tc.textSink((t) => (log += t));
const code = await tc.runFrontend(frontend, {
    args: ['swift-frontend', '-frontend', '-c', ...sources, ...tc.commonFrontendArgs('XCTest'),
        '-parse-as-library', '-module-link-name', 'XCTest', '-O', '-enable-experimental-feature', 'Extern',
        '-emit-module-path', '/out/XCTest.swiftmodule', '-o', '/out/XCTest.o'],
    root: (tc.mkdirp(root, '/out'), root), stdout: sink, stderr: sink,
});
if (log) process.stderr.write(log);
if (code !== 0) process.exit(code);
const tmp = mkdtempSync(join(tmpdir(), 'xctest-'));
writeFileSync(join(tmp, 'XCTest.o'), tc.readFile(root, '/out/XCTest.o'));
execFileSync('llvm-ar', ['rcs', join(tmp, 'libXCTest.a'), join(tmp, 'XCTest.o')]);
const W = 'swift/lib/swift_static/wasi';
const tar = ustar([
    [`${W}/XCTest.swiftmodule/wasm32-unknown-wasip1.swiftmodule`, tc.readFile(root, '/out/XCTest.swiftmodule')],
    [`${W}/libXCTest.a`, readFileSync(join(tmp, 'libXCTest.a'))],
]);
rmSync(tmp, { recursive: true });
writeFileSync(outTar, tar);
console.log(`XCTest built by swift-frontend ${tc.SWIFT_VERSION} in ${Math.round(performance.now() - t0)} ms: ${outTar} ${tar.length} bytes`);

/** A ustar archive of regular files with short (<= 100 byte) names. */
function ustar(files) {
    const blocks = [];
    for (const [name, data] of files) {
        const h = Buffer.alloc(512);
        h.write(name, 0, 100);
        h.write('0000444\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
        h.write('00000000000\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0' + '00', 257);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h, Buffer.from(data), Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}
