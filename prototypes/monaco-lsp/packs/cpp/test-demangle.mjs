// Tests the compiler output views' demangler (src/demangle/; README,
// "Compiler output views"):
//
//   1. demangle.wasm, as shipped in app/static/packs/cpp, on the cases in
//      tests/fixtures/demangle-cases.tsv (one at a time and in one batch, the
//      way explorer.js calls it), and through emit-filter.js's demangleLines;
//   2. the same source built natively with clang, -Wall -Wextra -Wpedantic
//      -Werror and AddressSanitizer + UndefinedBehaviorSanitizer, running
//      src/demangle/test-native.cpp on the same cases;
//   3. clang-tidy on demangle.cpp and test-native.cpp (src/demangle/.clang-tidy),
//      which must print no warning.
//
// The expected names were checked against llvm-cxxfilt. Needs the LLVM
// source tree build.sh caches (for LLVMDemangle) and a host clang
// (CXX, default clang++-18) with clang-tidy (CLANG_TIDY, default clang-tidy).
//
//   node test-demangle.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demangleLines } from './src/emit-filter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../app/static/packs/cpp');
const SRC = join(process.env.PACK_CACHE ?? join(homedir(), '.cache/yukibana-packs'), 'cpp/llvm-project-21.1.8.src');
const CXX = process.env.CXX ?? 'clang++-18';
const TIDY = process.env.CLANG_TIDY ?? 'clang-tidy';
const CASES = join(HERE, 'tests/fixtures/demangle-cases.tsv');

let failed = 0;
const check = (ok, name, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failed++;
};
const cases = readFileSync(CASES, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));

// 1. The wasm build.
const { default: createDemangle } = await import(pathToFileURL(join(OUT, 'demangle.js')).href);
const started = performance.now();
const mod = await createDemangle();
const loadMs = performance.now() - started;
const demangle = (names) => {
    const input = mod.stringToNewUTF8(names.join('\n'));
    const output = mod._yk_demangle_lines(input);
    const text = mod.UTF8ToString(output);
    mod._free(input);
    mod._free(output);
    return text.split('\n');
};
check(true, 'demangle.wasm instantiates', `${loadMs.toFixed(0)} ms`);
for (const [mangled, plain] of cases) {
    const [got] = demangle([mangled]);
    check(got === plain, `wasm: ${mangled}`, got);
}
const t0 = performance.now();
const batch = demangle(cases.map(([m]) => m));
check(JSON.stringify(batch) === JSON.stringify(cases.map(([, p]) => p)), 'wasm: every case in one batch, in order',
    `${cases.length} names in ${(performance.now() - t0).toFixed(1)} ms`);
const asm = '\tcallq\t_Z8distanceRK5PointS1_@PLT\n_ZNK5Point4normEv:  # @_ZNK5Point4normEv\n\tcall\tprintf\n\tbl .L_Znot_a_name';
const shown = demangleLines(asm, demangle);
check(shown === '\tcallq\tdistance(Point const&, Point const&)@PLT\nPoint::norm() const:  # @Point::norm() const\n\tcall\tprintf\n\tbl .L_Znot_a_name',
    'demangleLines: names in assembly demangled, line count kept, .L labels left alone', JSON.stringify(shown));
let calls = 0;
demangleLines('_Znwm _Znwm _ZdlPvm\n_Znwm', (names) => (calls++, names));
check(calls === 1, 'demangleLines: one batched call for every distinct name');

// 2. Native, with sanitizers.
const work = mkdtempSync(join(tmpdir(), 'yk-demangle-'));
try {
    const strict = ['-std=c++17', '-g', '-O1', '-fsanitize=address,undefined', '-fno-sanitize-recover=all', `-I${SRC}/llvm/include`];
    const objects = [];
    for (const f of ['ItaniumDemangle']) {
        execFileSync(CXX, [...strict, '-c', join(SRC, 'llvm/lib/Demangle', `${f}.cpp`), '-o', join(work, `${f}.o`)]);
        objects.push(join(work, `${f}.o`));
    }
    for (const f of ['demangle', 'test-native']) {
        execFileSync(CXX, [...strict, '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-c', join(HERE, 'src/demangle', `${f}.cpp`), '-o', join(work, `${f}.o`)]);
        objects.push(join(work, `${f}.o`));
    }
    execFileSync(CXX, ['-fsanitize=address,undefined', ...objects, '-o', join(work, 'test-native')]);
    check(true, `native build with ${CXX}, -Wall -Wextra -Wpedantic -Werror, ASan + UBSan`);
    let output = '';
    let status = 0;
    try {
        output = execFileSync(join(work, 'test-native'), [CASES], { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1' } });
    } catch (error) {
        output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        status = error.status ?? 1;
    }
    const lines = output.trim().split('\n');
    check(status === 0 && lines.at(-1) === 'all passed', 'native test-native.cpp on the same cases, no sanitizer report',
        `${lines.filter((l) => l.startsWith('PASS')).length} checks; ${lines.at(-1)}`);
    if (status !== 0) console.log(output);
} finally {
    rmSync(work, { recursive: true, force: true });
}

// 3. clang-tidy.
let tidy = '';
let tidyStatus = 0;
try {
    tidy = execFileSync(TIDY, ['--quiet', join(HERE, 'src/demangle/demangle.cpp'), join(HERE, 'src/demangle/test-native.cpp'), '--',
        '-std=c++17', `-I${SRC}/llvm/include`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
    tidy = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    tidyStatus = error.status ?? 1;
}
const warnings = tidy.split('\n').filter((l) => /(warning|error):/.test(l));
check(tidyStatus === 0 && warnings.length === 0, 'clang-tidy is clean (src/demangle/.clang-tidy)', warnings.slice(0, 5).join(' | '));

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
