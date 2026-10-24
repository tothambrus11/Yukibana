// Headless test of the C/C++ runner (../CONTRACT.md, "Running a program"),
// run the way the app runs it: app/static served over http WITH
// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy, so the page is
// crossOriginIsolated; `new Worker('/packs/cpp/runner.js', { type: 'module' })`
// in Chromium; one { type: 'run' } message; stdin through the
// SharedArrayBuffer protocol, driven from the page as the app's terminal does.
//
//   node test-run.mjs        (after ./build.sh; needs playwright-core)
//
// Cases: the app's sample project (languages.ts), a prompt without newline
// and two lines of stdin (C++ and C), a compile error, and a program that
// never ends, which the page stops by terminating the worker. The sample runs
// twice: cold (empty browser cache) and warm (cached downloads and compiled
// wasm), with timings. C++ exceptions, caught and uncaught, and the
// sample's tests ({ type: 'test' }) in GoogleTest, doctest and Catch2,
// passing and failing, and tests that mix two frameworks. The default
// target fetches exactly the files it fetched before the Linux targets
// existed; a target flag that names no target, a Test on a Linux target and
// a Linux run without the emulator (vm.js) are refused with their messages.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
// The app's sample tests per framework (imports only types, so Node loads it).
import { chooseTestFramework } from '../../app/src/lib/cpp-tests.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.html': 'text/html' };
const ISOLATION = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
};

// Static files with the isolation headers, serving the .br sibling when the
// browser accepts brotli, as the app's host does; cacheable, so the second
// run measures a warm cache.
let bytesSent = 0;
/** The paths requested, in order; and paths the server answers 404 for. */
const requested = [];
const hidden = new Set();
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requested.push(path);
    if (hidden.has(path)) return res.writeHead(404).end();
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION });
        res.end('<!doctype html><link rel=icon href="data:,"><title>cpp runner test</title>');
        return;
    }
    const file = normalize(join(STATIC, path));
    try {
        if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
        const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600', ...ISOLATION };
        let body;
        if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '') && !file.endsWith('.gz')) {
            try {
                body = await readFile(file + '.br');
                headers['content-encoding'] = 'br';
            } catch {}
        }
        body ??= await readFile(file);
        headers['content-length'] = body.length;
        bytesSent += body.length;
        res.writeHead(200, headers).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

// The sample project of app/src/lib/languages.ts, read from there so the test
// runs exactly what a new project contains.
const languages = await readFile(resolve(HERE, '../../app/src/lib/languages.ts'), 'utf8');
const SAMPLE = sampleOf(languages, 'cpp');

const STDIN_CPP = {
    'main.cpp': `#include <iostream>

int main() {
    long a, b;
    std::cout << "first number: ";
    std::cin >> a;
    std::cout << "second number: ";
    std::cin >> b;
    std::cout << "sum: " << a + b << "\\n";
}
`,
};
const STDIN_C = {
    'main.c': `#include <stdio.h>

int main(void) {
    long a, b;
    printf("first number: ");
    if (scanf("%ld", &a) != 1) return 2;
    printf("second number: ");
    if (scanf("%ld", &b) != 1) return 2;
    printf("sum: %ld\\n", a + b);
    return 0;
}
`,
};
const BROKEN = {
    'main.cpp': `#include <cstdio>

int main() {
    std::printf("%d\\n", undeclared + 1)
}
`,
};
const RECURSION = {
    'main.cpp': `#include <cstdio>

volatile int sink;
int down(int n) { int a[4] = {n, n, n, n}; sink = a[n % 4]; return n == 0 ? 0 : 1 + down(n - 1) + a[0] * 0; }

int main() {
    int big[1000000];  // 4 MB of locals: needs more than wasm-ld's 64 KiB default stack
    for (int i = 0; i < 1000000; i++) big[i] = i;
    std::printf("big %d\\n", big[999999]);
    for (int n = 1000; n <= 1024000; n *= 2) std::printf("depth %d\\n", down(n));
}
`,
};
const FOREVER = {
    'main.cpp': `#include <cstdio>

int main() {
    std::puts("looping");
    for (volatile unsigned long i = 0;; i++) {}
}
`,
};

const LONG_DOUBLE_CPP = {
    'main.cpp': `#include <iostream>

int main() {
    long double x = 1.0L / 3;
    std::cout << x << "\\n";
}
`,
};
const LONG_DOUBLE_C = {
    'main.c': `#include <stdio.h>

int main(void) {
    long double x = 1.0L / 3;
    printf("%.6Lf\\n", x);
    return 0;
}
`,
};
// Out of bounds through a vector: libc++'s hardening stops the program.
const VECTOR_OOB = {
    'main.cpp': `#include <cstdio>
#include <vector>

int main() {
    std::vector<int> v(4);
    volatile int i = 50;
    std::puts("before");
    v[i] = 7;
    std::printf("not reached %d\\n", v[i]);
}
`,
};
// C++ exceptions: thrown and caught, from the program and from libc++, with
// destructors run during unwinding.
const EXCEPTIONS = {
    'main.cpp': `#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

struct Mine : std::runtime_error {
    using std::runtime_error::runtime_error;
};
struct Guard {
    ~Guard() { std::cout << "destructor ran\\n"; }
};

int main() {
    try {
        throw Mine("custom");
    } catch (const std::exception &e) {
        std::cout << "caught " << e.what() << "\\n";
    }
    try {
        std::stoi("abc");
    } catch (const std::invalid_argument &) {
        std::cout << "stoi: invalid_argument\\n";
    }
    try {
        std::vector<int> v(2);
        v.at(5) = 1;
    } catch (const std::out_of_range &) {
        std::cout << "at: out_of_range\\n";
    }
    try {
        Guard g;
        throw 42;
    } catch (int x) {
        std::cout << "int " << x << "\\n";
    }
}
`,
};
const UNCAUGHT = {
    'main.cpp': `#include <iostream>
#include <stdexcept>

int main() {
    std::cout << "before\\n";
    throw std::logic_error("boom");
}
`,
};
// A failing test next to the sample's passing ones.
const FAILING_TEST = {
    'tests/broken_test.cpp': `#include <gtest/gtest.h>

#include "geometry.h"

TEST(Broken, NormIsWrong) {
    Point p{3, 4};
    EXPECT_DOUBLE_EQ(p.norm(), 6.0);
}

TEST(Broken, ThrowsSomethingElse) {
    EXPECT_THROW(throw std::runtime_error("x"), std::logic_error);
}
`,
};

// Two definitions of main: the linker must name the student's files.
const DUPLICATE_MAIN = {
    'main.cpp': `int main() { return 0; }
`,
    'lib/other.cpp': `int main() { return 1; }
`,
};

// A persistent profile, so the browser has a disk cache as a real one does
// (an ephemeral context's memory cache does not keep a 42 MB file); the app
// itself also keeps packs in its service worker's cache.
const profile = await mkdtemp(join(tmpdir(), 'cpp-runner-test-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM });
let failed = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('console', (m) => process.env.VERBOSE && console.log('[page]', m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/__test.html`);
    check('the page is crossOriginIsolated', await page.evaluate(() => crossOriginIsolated));

    // In the page: start the runner, answer stdin requests from `inputs` (one
    // line each, then end of file), optionally terminate it after the program
    // printed `stopAfter`. Resolves with what came back and when.
    await page.evaluate(() => {
        window.runProject = (files, { inputs = [], stopAfter = null, entry = 'main.cpp', failInstantiate = false, type = 'run' } = {}) =>
            new Promise((done) => {
                const t0 = performance.now();
                const result = { stdout: '', stderr: '', code: null, phases: [], loading: {}, stdinRequests: 0, stdoutBeforeInput: [], terminated: false };
                const sab = new SharedArrayBuffer(8 + 65536);
                const state = new Int32Array(sab, 0, 2);
                const data = new Uint8Array(sab, 8);
                // failInstantiate: the runner in a worker whose
                // WebAssembly.instantiate rejects for the compiler (as when a
                // device refuses its memory), to show the run still ends.
                const worker = failInstantiate
                    ? new Worker(
                          URL.createObjectURL(
                              new Blob(
                                  [
                                      `const real = WebAssembly.instantiate;
                                       WebAssembly.instantiate = (m, imports) => m instanceof WebAssembly.Module && WebAssembly.Module.imports(m).some((i) => i.module !== 'wasi_snapshot_preview1')
                                           ? Promise.reject(new RangeError('WebAssembly.Memory(): could not allocate memory'))
                                           : real(m, imports);
                                       const queue = [];
                                       self.onmessage = (e) => queue.push(e);
                                       await import('${location.origin}/packs/cpp/runner.js');
                                       for (const e of queue) self.onmessage(e);`,
                                  ],
                                  { type: 'text/javascript' }
                              )
                          ),
                          { type: 'module' }
                      )
                    : new Worker('/packs/cpp/runner.js', { type: 'module' });
                const finish = () => {
                    result.ms = Math.round(performance.now() - t0);
                    done(result);
                };
                worker.onerror = (e) => {
                    result.stderr += `worker error: ${e.message}\n`;
                    finish();
                };
                worker.onmessage = ({ data: m }) => {
                    const at = Math.round(performance.now() - t0);
                    if (m.type === 'stdout') result.stdout += m.text;
                    else if (m.type === 'stderr') result.stderr += m.text;
                    else if (m.type === 'phase') result.phases.push([m.text, at]);
                    else if (m.type === 'loading') result.loading[m.label] = [m.loaded, m.total];
                    else if (m.type === 'stdin') {
                        // What the terminal shows when the program asks.
                        result.stdinRequests++;
                        result.stdoutBeforeInput.push(result.stdout);
                        const line = inputs.shift();
                        if (Atomics.load(state, 0) !== 1) result.stderr += 'stdin requested with state != 1\n';
                        if (line === undefined) Atomics.store(state, 0, 3);
                        else {
                            const bytes = new TextEncoder().encode(line + '\n');
                            data.set(bytes);
                            Atomics.store(state, 1, bytes.length);
                            Atomics.store(state, 0, 2);
                        }
                        Atomics.notify(state, 0);
                    } else if (m.type === 'exit') {
                        result.code = m.code;
                        worker.terminate();
                        finish();
                    }
                    if (stopAfter && m.type === 'stdout' && result.stdout.includes(stopAfter)) {
                        // Let it spin a moment, then Stop as the app does.
                        setTimeout(() => {
                            worker.terminate();
                            result.terminated = true;
                            finish();
                        }, 1000);
                    }
                };
                worker.postMessage({ type, files, entry, stdin: sab });
            });
    });

    const run = (files, opts) => page.evaluate(([f, o]) => window.runProject(f, o), [files, opts ?? {}]);
    const timeline = (r) => r.phases.map(([t, ms]) => `${t}@${ms}`).join(', ');

    // 1. The sample, cold then warm.
    bytesSent = 0;
    requested.length = 0;
    const cold = await run(SAMPLE);
    const coldBytes = bytesSent;
    // What the default target fetched before targets existed, and nothing
    // more: no cc-cross, targets/, runner-linux.js, vm.js, explorer.js or demangle.
    const urls = [...new Set(requested)].sort();
    const before = ['/packs/cpp/cc.js', '/packs/cpp/cc.wasm', '/packs/cpp/runner.js', '/packs/cpp/sysroot.tar.gz', '/packs/cpp/wasi-sysroot.tar.gz'];
    check('the default target fetches exactly the files it always did', JSON.stringify(urls) === JSON.stringify(before), urls.join(' '));
    check(
        'sample project (cold): prints the distance and the norm, exits 0',
        cold.code === 0 && cold.stdout === '5.000000\n5.000000\n',
        `${JSON.stringify(cold.stdout)} code=${cold.code} in ${cold.ms} ms, ${(coldBytes / 1e6).toFixed(1)} MB transferred; ${timeline(cold)}`
    );
    if (cold.stderr) console.log(cold.stderr);
    bytesSent = 0;
    const warm = await run(SAMPLE);
    check(
        'sample project (warm): same output from the browser cache',
        warm.code === 0 && warm.stdout === '5.000000\n5.000000\n',
        `code=${warm.code} in ${warm.ms} ms, ${bytesSent} bytes transferred; ${timeline(warm)}`
    );
    const loads = Object.entries(cold.loading).map(([k, [l, t]]) => `${k} ${l}/${t}`);
    check('loading messages for each download', loads.length === 3 && Object.values(cold.loading).every(([l, t]) => l === t && l > 0), loads.join(', '));

    // 2. stdin, C++ and C: the prompt must be visible before the program waits.
    for (const [name, files] of [['C++ (cin)', STDIN_CPP], ['C (scanf)', STDIN_C]]) {
        const r = await run(files, { inputs: ['19', '23'], entry: Object.keys(files)[0] });
        check(
            `${name}: prompt without newline, two lines of stdin, their sum`,
            r.code === 0 &&
                r.stdout === 'first number: second number: sum: 42\n' &&
                r.stdinRequests === 2 &&
                r.stdoutBeforeInput[0] === 'first number: ' &&
                r.stdoutBeforeInput[1] === 'first number: second number: ',
            `${JSON.stringify(r.stdout)} requests=${r.stdinRequests} seen-before-input=${JSON.stringify(r.stdoutBeforeInput)} code=${r.code} ${r.ms} ms`
        );
        if (r.stderr) console.log(r.stderr);
    }
    const eof = await run(STDIN_C, { inputs: [], entry: 'main.c' });
    check('end of file on stdin (Ctrl-D) ends scanf', eof.code === 2 && eof.stdout === 'first number: ', `code=${eof.code} ${JSON.stringify(eof.stdout)}`);

    // 3. A compile error: on stderr, non-zero exit, nothing run.
    const broken = await run(BROKEN);
    check(
        'compile error: clang diagnostics on stderr, non-zero exit',
        broken.code !== 0 && /main\.cpp:4:\d+: error: use of undeclared identifier 'undeclared'/.test(broken.stderr) && broken.stdout === '' && !broken.phases.some(([t]) => t === 'Running'),
        `code=${broken.code}\n${broken.stderr.trimEnd()}`
    );

    // 5. A 4 MB local array fits the 8 MiB stack; call depth is limited by
    //    the browser's stack, and running out of it is a crash on stderr.
    const deep = await run(RECURSION);
    const depth = Math.max(0, ...[...deep.stdout.matchAll(/depth (\d+)/g)].map((m) => Number(m[1])));
    check(
        '4 MB of locals work; deep recursion ends in a stack-overflow message, exit 134',
        deep.stdout.startsWith('big 999999\ndepth 1000\n') && deep.code === 134 && /stack overflow/.test(deep.stderr),
        `deepest completed: ${depth} calls; ${JSON.stringify(deep.stderr.trim())}`
    );

    // Long double formatting (wasi-libc keeps it in a separate library).
    for (const [name, files] of [['C++ (cout)', LONG_DOUBLE_CPP], ['C (printf %Lf)', LONG_DOUBLE_C]]) {
        const r = await run(files, { entry: Object.keys(files)[0] });
        check(`long double prints: ${name}`, r.code === 0 && r.stdout === '0.333333\n', `${JSON.stringify(r.stdout)} code=${r.code} ${JSON.stringify(r.stderr.trim())}`);
    }

    // A vector index out of bounds stops the program (libc++ hardening)
    // instead of writing past the buffer and going on.
    const oob = await run(VECTOR_OOB);
    check(
        'vector index out of bounds: the program is stopped, exit 134, nothing after it runs',
        oob.code === 134 && oob.stdout === 'before\n' && /The program crashed: unreachable .*index out of range/.test(oob.stderr),
        `code=${oob.code} ${JSON.stringify(oob.stderr.trim())}`
    );

    // C++ exceptions (WebAssembly exception handling).
    const caught = await run(EXCEPTIONS);
    check(
        'C++ exceptions: thrown and caught (own type, std::stoi, vector::at), destructors run while unwinding',
        caught.code === 0 && caught.stdout === 'caught custom\nstoi: invalid_argument\nat: out_of_range\ndestructor ran\nint 42\n',
        `${JSON.stringify(caught.stdout)} code=${caught.code} ${JSON.stringify(caught.stderr.trim())}`
    );
    const thrown = await run(UNCAUGHT);
    check(
        'uncaught C++ exception: terminate message with type and what(), exit 134',
        thrown.code === 134 && thrown.stdout === 'before\n' &&
            /terminating due to uncaught exception of type std::logic_error: boom/.test(thrown.stderr),
        `code=${thrown.code} ${JSON.stringify(thrown.stderr.trim())}`
    );

    // The sample's tests (tests/geometry_test.cpp, GoogleTest), and a
    // failing one beside them.
    // GoogleTest prints in colour (GTEST_COLOR=yes): the checks read the
    // report with the escapes removed, as the app's terminal shows it
    // (app/src/lib/ansi.ts); `raw` keeps them.
    const plain = (text) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');
    const testRun = async (files) => {
        const r = await run(files, { type: 'test' });
        return { ...r, raw: r.stdout, stdout: plain(r.stdout) };
    };
    bytesSent = 0;
    const tests = await testRun(SAMPLE);
    check(
        "sample's GoogleTest tests: all pass, exit 0, main.cpp left out",
        tests.code === 0 && /\[  PASSED  \] 3 tests\./.test(tests.stdout) && !tests.phases.some(([t]) => t.includes('main.cpp')),
        `code=${tests.code} in ${tests.ms} ms, ${(bytesSent / 1e3).toFixed(0)} kB transferred (gtest.tar ${JSON.stringify(tests.loading['gtest.tar'])}); ${timeline(tests)}`
    );
    console.log(tests.stdout.trimEnd().replace(/^/gm, '    | '));
    if (tests.stderr) console.log(tests.stderr);
    check(
        "GoogleTest's report is in its terminal colours: green [ RUN ]/[ OK ]/[ PASSED ], nothing else escaped",
        /\x1b\[0;32m\[ RUN      \] \x1b\[m/.test(tests.raw) && /\x1b\[0;32m\[  PASSED  \] \x1b\[m3 tests\./.test(tests.raw) && !/\x1b\[[0-9;]*[A-Za-ln-z]/.test(tests.raw),
        JSON.stringify(tests.raw.slice(0, 120))
    );
    const failing = await testRun({ ...SAMPLE, ...FAILING_TEST });
    check(
        'a failing test: reported on stdout with file and line, exit non-zero',
        failing.code !== 0 && failing.code !== null &&
            /tests\/broken_test\.cpp:7: Failure/.test(failing.stdout) &&
            /\[  FAILED  \] Broken\.NormIsWrong/.test(failing.stdout) &&
            /\[  FAILED  \] Broken\.ThrowsSomethingElse/.test(failing.stdout) &&
            /\[  PASSED  \] 3 tests\./.test(failing.stdout),
        `code=${failing.code} in ${failing.ms} ms`
    );
    check('a failing test is in red', /\x1b\[0;31m\[  FAILED  \] \x1b\[mBroken\.NormIsWrong/.test(failing.raw), JSON.stringify(failing.raw.slice(-200)));
    console.log(failing.stdout.trimEnd().replace(/^/gm, '    | '));

    // The same tests in doctest and in Catch2, as the app's framework choice
    // writes them (app/src/lib/cpp-tests.ts), and a failing test in each.
    // Each run fetches its own framework's archive, and no other.
    for (const fw of ['doctest', 'catch2']) {
        const files = { ...SAMPLE, ...chooseTestFramework(SAMPLE, fw, SAMPLE).write };
        const passed = fw === 'doctest' ? /\[doctest\] test cases: 3 \| 3 passed \| 0 failed/ : /All tests passed \(4 assertions in 3 test cases\)/;
        const coloured = fw === 'doctest' ? /\x1b\[0;32mSUCCESS!/ : /\x1b\[[0-9;]*m/;
        const ok = await testRun(files);
        const archives = Object.keys(ok.loading).filter((k) => k.endsWith('.tar'));
        check(
            `${fw}: the sample's tests pass, exit 0, only ${fw}.tar fetched`,
            ok.code === 0 && passed.test(ok.stdout) && archives.join() === `${fw}.tar`,
            `code=${ok.code} in ${ok.ms} ms (${fw}.tar ${JSON.stringify(ok.loading[`${fw}.tar`])}; archives: ${archives}); ${timeline(ok)}`
        );
        console.log(ok.stdout.trimEnd().replace(/^/gm, '    | '));
        if (ok.stderr) console.log(ok.stderr);
        check(`${fw}: the report is in colour (${fw === 'doctest' ? '--force-colors' : '--colour-mode ansi'})`, coloured.test(ok.raw), JSON.stringify(ok.raw.slice(0, 120)));
        const broken = fw === 'doctest'
            ? `#include <doctest/doctest.h>

#include <stdexcept>

#include "geometry.h"

TEST_CASE("norm is wrong") {
    Point p{3, 4};
    CHECK(p.norm() == doctest::Approx(6.0));
}

TEST_CASE("throws something else") {
    CHECK_THROWS_AS(throw std::runtime_error("x"), std::logic_error);
}
`
            : `#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <stdexcept>

#include "geometry.h"

TEST_CASE("norm is wrong") {
    Point p{3, 4};
    REQUIRE_THAT(p.norm(), Catch::Matchers::WithinULP(6.0, 4));
}

TEST_CASE("throws something else") {
    REQUIRE_THROWS_AS(throw std::runtime_error("x"), std::logic_error);
}
`;
        const bad = await testRun({ ...files, 'tests/broken_test.cpp': broken });
        const where = fw === 'doctest'
            ? /tests\/broken_test\.cpp:9: ERROR: CHECK\( p\.norm\(\) == doctest::Approx\(6\.0\) \) is NOT correct!/
            : /tests\/broken_test\.cpp:10: FAILED:/;
        const counts = fw === 'doctest' ? /test cases: 5 \| 3 passed \| 2 failed/ : /test cases: 5 \| 3 passed \| 2 failed/;
        check(
            `${fw}: failing tests are reported with file and line, exit non-zero`,
            bad.code !== 0 && bad.code !== null && where.test(bad.stdout) && counts.test(bad.stdout) && /std::runtime_error|runtime_error|x/.test(bad.stdout),
            `code=${bad.code} in ${bad.ms} ms`
        );
        console.log(bad.stdout.trimEnd().replace(/^/gm, '    | '));
        if (bad.stderr) console.log(bad.stderr);
    }
    // doctest implemented by the test itself (its own main): the prebuilt
    // implementation is not linked, so nothing is defined twice.
    const ownDoctest = await testRun({
        ...SAMPLE,
        'tests/geometry_test.cpp': '#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN\n' + chooseTestFramework(SAMPLE, 'doctest', SAMPLE).write['tests/geometry_test.cpp'],
    });
    check('doctest with DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN in a test: links once, passes', ownDoctest.code === 0 && /3 passed/.test(ownDoctest.stdout), `code=${ownDoctest.code} ${JSON.stringify(ownDoctest.stderr.slice(0, 300))}`);
    // Tests that mix frameworks cannot be one program: said before compiling.
    const mixed = await testRun({ ...SAMPLE, 'tests/other_test.cpp': '#include <catch2/catch_test_macros.hpp>\nTEST_CASE("x") { REQUIRE(true); }\n' });
    check(
        'tests that mix GoogleTest and Catch2: a message naming both files, exit 1, nothing compiled',
        mixed.code === 1 && /mix test frameworks: tests\/geometry_test\.cpp includes <gtest\/\.\.\.> \(GoogleTest\), tests\/other_test\.cpp includes <catch2\/\.\.\.> \(Catch2\)/.test(mixed.stderr) && !mixed.phases.some(([t]) => t.startsWith('Compiling')),
        JSON.stringify(mixed.stderr.trim())
    );

    const none = await testRun({ 'main.cpp': 'int main() {}\n' });
    check('test mode without tests/: says so, exit 1', none.code === 1 && /No tests to run/.test(none.stderr), JSON.stringify(none.stderr.trim()));

    // A link error names the sources, not internal object files.
    const dup = await run(DUPLICATE_MAIN);
    check(
        'duplicate main: the link error names main.cpp and lib/other.cpp, non-zero exit',
        dup.code !== 0 && /duplicate symbol: main\n>>> defined in (main\.cpp|lib\/other\.cpp)\n>>> defined in (main\.cpp|lib\/other\.cpp)/.test(dup.stderr) && !dup.stderr.includes('.yukibana'),
        `code=${dup.code}\n${dup.stderr.trimEnd()}`
    );

    // The compiler cannot start (instantiation refused): stderr and an exit,
    // not a run stuck at "Compiling".
    const refused = await run(SAMPLE, { failInstantiate: true });
    check(
        'compiler cannot be instantiated: error on stderr and an exit message',
        refused.code === 1 && /could not start: .*could not allocate memory/.test(refused.stderr),
        `code=${refused.code} ${JSON.stringify(refused.stderr.trim())} ${refused.ms} ms`
    );

    // Targets (README, "Targets"): refusals that need no compiler.
    const armv7 = await run({ ...SAMPLE, 'compile_flags.txt': '--target=armv7-linux-musleabihf\n-std=c++20\n' });
    check(
        'an unsupported --target: the message lists the supported triples, exit 1, nothing downloaded',
        armv7.code === 1 && /^Unsupported target "armv7-linux-musleabihf" in compile_flags.txt; supported: wasm32-wasip1, x86_64-linux-musl, aarch64-linux-musl, riscv64-linux-musl \(or no --target\)\.\n$/.test(armv7.stderr) && Object.keys(armv7.loading).length === 0,
        JSON.stringify(armv7.stderr)
    );
    const linuxTests = await testRun({ ...SAMPLE, 'compile_flags.txt': '-target\naarch64-linux-musl\n' });
    check(
        'Test on a Linux target: refused, naming why (the frameworks are wasm32), exit 1',
        linuxTests.code === 1 && /^Tests run on the WebAssembly target only, for now: the test frameworks are built for wasm32 only\.\n$/.test(linuxTests.stderr),
        JSON.stringify(linuxTests.stderr)
    );
    // A Linux run with the emulator missing (vm.js answered 404): compiled
    // and linked, then the message. Needs cc-cross and targets/x86_64.
    let haveCross = true;
    try {
        await stat(join(STATIC, 'packs/cpp/cc-cross.wasm'));
    } catch {
        haveCross = false;
    }
    if (haveCross) {
        hidden.add('/packs/cpp/vm.js');
        requested.length = 0;
        const novm = await run({ ...SAMPLE, 'compile_flags.txt': `--target=x86_64-linux-musl\n${SAMPLE['compile_flags.txt']}` });
        hidden.clear();
        const fetched = [...new Set(requested)].filter((u) => u.startsWith('/packs/')).sort();
        check(
            'Linux target without vm.js: compiled for x86_64-linux-musl, linked, then "not installed", exit 1',
            novm.code === 1 && novm.stderr === 'Running on x86-64 Linux is not installed (packs/cpp/vm.js)\n' &&
                novm.phases.some(([t]) => t === 'Compiling geometry.cpp (1/2) for x86_64-linux-musl') && novm.phases.some(([t]) => t === 'Linking'),
            `${JSON.stringify(novm.stderr)} ${timeline(novm)}`
        );
        check(
            'a Linux target fetches cc-cross and its own arch only, never cc.wasm or wasi-sysroot',
            // runner.js and sysroot.tar.gz come from the browser's cache,
            // fetched by the runs before.
            JSON.stringify(fetched) === JSON.stringify(['/packs/cpp/cc-cross.js', '/packs/cpp/cc-cross.wasm', '/packs/cpp/runner-linux.js', '/packs/cpp/targets/x86_64/include.tar', '/packs/cpp/targets/x86_64/lib.tar', '/packs/cpp/vm.js']),
            fetched.join(' ')
        );
    } else console.log('SKIP  Linux target without vm.js (no cc-cross.wasm: run build-cross.sh)');

    // 4. A program that never ends: the page terminates the worker.
    const t = Date.now();
    const forever = await run(FOREVER, { stopAfter: 'looping' });
    const alive = await page.evaluate(() => 1 + 1);
    check(
        'endless loop: terminated by the page, which stays responsive',
        forever.terminated && forever.code === null && forever.stdout === 'looping\n' && alive === 2,
        `stopped after ${Date.now() - t} ms; ${timeline(forever)}`
    );
} finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
    server.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

/** The `sample` object literal of one language in languages.ts, evaluated:
 * template literals of plain text keyed by file name. */
function sampleOf(source, id) {
    const at = source.indexOf(`id: '${id}'`);
    const start = source.indexOf('sample: {', at) + 'sample: '.length;
    let depth = 0;
    let i = start;
    let inTemplate = false;
    for (; i < source.length; i++) {
        const c = source[i];
        if (inTemplate) {
            if (c === '\\') i++;
            else if (c === '`') inTemplate = false;
        } else if (c === '`') inTemplate = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
    }
    return new Function(`return (${source.slice(start, i + 1)});`)();
}
