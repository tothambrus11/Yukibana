// Regenerates the compiler output fixtures test-emit.mjs reads: for each
// target, the app's sample geometry.cpp and main.cpp compiled with
// `-S` (assembly) and `-S -emit-llvm` (IR), at -O0 and -O2 (main.cpp at -O2
// only: at -O0 every std::vector member is emitted), once with the
// views' flags (`compileArgs(..., { view: true })`: -gline-tables-only
// -fno-discard-value-names) and once without (`plain`; the IR one with
// -fno-discard-value-names alone, so that only -g differs).
//
//   node tests/fixtures/gen.mjs [dir]   dir: where cc.js, cc-cross.js, sysroot.tar.gz,
//                                       ... are (default ../../app/static/packs/cpp)
//
// Output: tests/fixtures/<target id>/<file>.<O0|O2>.<view|plain>.<s|ll>,
// from sample.json (the app's sample); also swap.cpp.O0.view.{s,ll} (a
// library function compiled out of line) and, for x86-64,
// geometry.cpp.O2.view.intel.s (-masm=intel). Run it after a compiler
// changes, and check the diff in.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createToolchain, compileArgs } from '../../src/toolchain.js';
import { TARGETS } from '../../src/targets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] ?? resolve(HERE, '../../../../app/static/packs/cpp'));
const sample = JSON.parse(readFileSync(resolve(HERE, 'sample.json'), 'utf8'));
const tc = createToolchain({
    base: pathToFileURL(dir + '/'),
    fetch: async (url) => new Response(readFileSync(fileURLToPath(url)), { headers: { 'content-type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } }),
});
// Beyond the sample: a function from a library header compiled out of line
// (std::swap<int> at -O0), for hiding library functions.
const EXTRA = { 'swap.cpp': '#include <utility>\n\nint main() {\n    int a = 1, b = 2;\n    std::swap(a, b);\n    return a;\n}\n' };
for (const target of TARGETS) {
    mkdirSync(resolve(HERE, target.id), { recursive: true });
    const flags = `${target.default ? '' : `--target=${target.triple}\n`}${sample['compile_flags.txt']}-O0\n`;
    const files = { ...sample, ...EXTRA, 'compile_flags.txt': flags };
    for (const [ext, emit] of [['s', ['-S']], ['ll', ['-S', '-emit-llvm']]]) {
        const r = await tc.tool(target, 'clang', [...compileArgs(target, files, 'swap.cpp', { view: true }), ...emit, 'swap.cpp', '-o', `out.${ext}`], files, [`out.${ext}`], { quiet: true });
        if (r.code !== 0) throw new Error(`${target.id} swap.cpp: ${r.text}`);
        writeFileSync(resolve(HERE, `${target.id}/swap.cpp.O0.view.${ext}`), r.out[`out.${ext}`]);
    }
    // Intel syntax, as the x86-64 view's toggle compiles it.
    if (target.arch === 'x86_64') {
        const intelFiles = { ...sample, 'compile_flags.txt': `--target=${target.triple}\n${sample['compile_flags.txt']}` };
        const r = await tc.tool(target, 'clang', [...compileArgs(target, intelFiles, 'geometry.cpp', { view: true }), '-S', '-masm=intel', 'geometry.cpp', '-o', 'out.s'], intelFiles, ['out.s'], { quiet: true });
        if (r.code !== 0) throw new Error(r.text);
        writeFileSync(resolve(HERE, `${target.id}/geometry.cpp.O2.view.intel.s`), r.out['out.s']);
    }
    for (const source of ['geometry.cpp', 'main.cpp']) {
        for (const opt of source === 'main.cpp' ? ['-O2'] : ['-O0', '-O2']) {
            const flags = `${target.default ? '' : `--target=${target.triple}\n`}${sample['compile_flags.txt']}${opt}\n`;
            const files = { ...sample, 'compile_flags.txt': flags };
            for (const view of [true, false]) {
                const args = compileArgs(target, files, source, { view });
                for (const [ext, emit] of [['s', ['-S']], ['ll', ['-S', '-emit-llvm', ...(view ? [] : ['-fno-discard-value-names'])]]]) {
                    const out = `out.${ext}`;
                    const r = await tc.tool(target, 'clang', [...args, '-fno-color-diagnostics', ...emit, source, '-o', out], files, [out], { quiet: true });
                    if (r.code !== 0) throw new Error(`${target.id} ${source} ${opt}: ${r.text}`);
                    const name = `${target.id}/${source}.${opt.slice(1)}.${view ? 'view' : 'plain'}.${ext}`;
                    writeFileSync(resolve(HERE, name), r.out[out]);
                    console.log(name, r.out[out].length);
                }
            }
        }
    }
}
