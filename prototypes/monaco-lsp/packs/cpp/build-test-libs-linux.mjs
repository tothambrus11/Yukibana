// Compiles GoogleTest's and RapidCheck's libraries for the Linux targets
// with the pack's own cc-cross.wasm, in Node, through the same toolchain.js
// the runner uses (createToolchain, the target's headers from
// sysroot.tar.gz and targets/<arch>/include.tar): every object is made by
// the clang that compiles a student's tests on that target, with Run's
// defaults (-O2, libc++'s fast hardening, exceptions on as on any Linux
// target). build-test-frameworks-linux.sh fetches and checks the sources,
// runs this, and archives and packs what it writes.
//
//   node build-test-libs-linux.mjs <googletest dir> <rapidcheck dir> <out dir> [arch ...]
//
// <out dir>/<arch>/{gtest,gtest_main,rapidcheck}/*.o, one object per
// source. Exits non-zero, with clang's messages, when a source does not
// compile. Needs app/static/packs/cpp/ built (cc-cross.wasm,
// sysroot.tar.gz, targets/<arch>/include.tar).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createToolchain } from './src/toolchain.js';
import { TARGETS } from './src/targets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../app/static/packs/cpp');
const [gtestDir, rcDir, outDir, ...asked] = process.argv.slice(2);
if (!outDir) {
    console.error('usage: node build-test-libs-linux.mjs <googletest dir> <rapidcheck dir> <out dir> [arch ...]');
    process.exit(2);
}
const LINUX = TARGETS.filter((t) => t.runtime === 'linux' && (!asked.length || asked.includes(t.arch)));

/** Every file under `dir`, as project paths under `prefix`. */
function tree(dir, prefix) {
    const files = {};
    const walk = (d) => {
        for (const name of readdirSync(d)) {
            const path = join(d, name);
            if (statSync(path).isDirectory()) walk(path);
            else files[`${prefix}/${relative(dir, path)}`] = readFileSync(path);
        }
    };
    walk(dir);
    return files;
}

// GoogleTest as its CMake build compiles it (googletest/CMakeLists.txt:
// gtest-all.cc and gtest_main.cc, with googletest/ and its include/ on the
// path); its port header finds pthreads, stream redirection and death tests
// on Linux by itself. RapidCheck as its CMakeLists.txt lists its sources,
// C++11, Random.cpp at -O3.
const gtest = { ...tree(join(gtestDir, 'googletest/include'), 'googletest/include'), ...tree(join(gtestDir, 'googletest/src'), 'googletest/src') };
const rc = { ...tree(join(rcDir, 'include'), 'rc/include'), ...tree(join(rcDir, 'src'), 'rc/src') };
const rcSources = readFileSync(join(rcDir, 'CMakeLists.txt'), 'utf8')
    .match(/add_library\(rapidcheck([\s\S]*?)\)/)[1]
    .split(/\s+/)
    .filter((s) => s.endsWith('.cpp'));
if (rcSources.length < 30) throw new Error(`RapidCheck's CMakeLists.txt lists only ${rcSources.length} sources`);

const LIBS = [
    { name: 'gtest', inputs: gtest, flags: ['-Igoogletest/include', '-Igoogletest'], sources: ['googletest/src/gtest-all.cc'] },
    { name: 'gtest_main', inputs: gtest, flags: ['-Igoogletest/include', '-Igoogletest'], sources: ['googletest/src/gtest_main.cc'] },
    { name: 'rapidcheck', inputs: rc, flags: ['-Irc/include', '-std=c++11'], sources: rcSources.map((s) => `rc/${s}`) },
];

const toolchain = createToolchain({
    base: pathToFileURL(OUT + '/'),
    fetch: async (url) => new Response(readFileSync(fileURLToPath(url)), {
        headers: { 'content-type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' },
    }),
    post: (m) => m.type === 'stderr' && process.stderr.write(m.text),
});

const jobs = [];
for (const target of LINUX)
    for (const lib of LIBS)
        for (const source of lib.sources) jobs.push({ target, lib, source });
let failed = 0;
const t0 = Date.now();
// One after the other: each compile is a fresh instance of the compiler
// (toolchain.js), whose callMain runs synchronously on this thread.
for (const { target, lib, source } of jobs) {
    const object = `${lib.name}/${source.replace(/^.*\//, '').replace(/\.(cc|cpp)$/, '.o')}`;
    const optimise = /\/Random\.cpp$/.test(source) ? '-O3' : '-O2';
    const { code, out } = await toolchain.tool(target, 'clang++', [
        `--target=${target.triple}`, '-resource-dir=/usr/lib/clang/21', optimise, '-DNDEBUG',
        '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST', ...lib.flags, '-c', source, '-o', object,
    ], lib.inputs, [object]);
    if (code !== 0 || !out[object]) {
        failed++;
        console.error(`${target.arch}: ${source} did not compile (exit ${code})`);
        continue;
    }
    const path = join(outDir, target.arch, object);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out[object]);
}
console.log(`${jobs.length - failed} of ${jobs.length} objects for ${LINUX.map((t) => t.arch).join(', ')} in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(failed ? 1 : 0);
