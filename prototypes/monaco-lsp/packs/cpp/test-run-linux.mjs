// Headless test of Run on a Linux target, end to end through the C/C++ runner as
// the app drives it: app/static served over http WITH COOP/COEP (and .br siblings,
// as the app's host serves them), `new Worker('/packs/cpp/runner.js', {type:'module'})`,
// one { type: 'run', files, entry, stdin, options } message, stdin through the
// SharedArrayBuffer protocol. The project's compile_flags.txt carries the target
// (--target=<triple>, src/targets.json); runner.js compiles with cc-cross.wasm and
// runs the ELF with vm.js (QEMU-Wasm).
//
//   node test-run-linux.mjs [arch...]   (after build.sh: runner.js, cc-cross, targets/, vm/)
//
// Skips, saying why, until the compiler's half (cc-cross.wasm, targets/) is built.
// Per architecture: the app's sample project, a C++ cin sum, std::thread x 4 on 4
// vCPUs, an uncaught exception (134 with libc++abi's message), a null dereference
// (139), an endless loop stopped by terminating the worker, the user-mode variants
// of hello and threads, and the URLs each use case fetches (plan §2: only this
// arch's files; user/ only in user mode; strace.cpio only with strace).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PROPERTIES } from './tests/fixtures/properties.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(HERE, '../../app/static');
const OUT = path.join(STATIC, 'packs/cpp');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TARGETS = JSON.parse(fs.readFileSync(path.join(HERE, 'src/targets.json'), 'utf8')).filter((t) => t.runtime === 'linux');
const asked = process.argv.slice(2);
const LINUX = TARGETS.filter((t) => !asked.length || asked.includes(t.arch));
const ARCHES = TARGETS.map((t) => t.arch);

const missing = ['runner.js', 'cc-cross.wasm', 'vm.js', ...LINUX.flatMap((t) => [`targets/${t.arch}/lib.tar`, `vm/${t.arch}/kernel`])]
    .filter((f) => !fs.existsSync(path.join(OUT, f)));
// runner.js, or the runner-linux.js it imports for a Linux target, loads vm.js.
const runnerSource = ['runner.js', 'runner-linux.js'].map((f) => path.join(OUT, f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const skip = missing.length ? `not built yet: ${missing.join(', ')}` : !runnerSource.includes('vm.js') ? 'runner.js does not run Linux targets yet' : false;
if (skip) console.log(`# test-run-linux: skipped (${skip})`);

// The app's sample project (app/src/lib/languages.ts), as test-run.mjs reads it.
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
const SAMPLE = sampleOf(fs.readFileSync(path.resolve(HERE, '../../app/src/lib/languages.ts'), 'utf8'), 'cpp');
const withTarget = (files, triple) => ({ ...files, 'compile_flags.txt': `--target=${triple}\n${files['compile_flags.txt'] ?? ''}` });

const CIN = { 'main.cpp': `#include <iostream>
int main() {
    long a, b;
    std::cout << "first number: ";
    std::cin >> a;
    std::cout << "second number: ";
    std::cin >> b;
    std::cout << "sum " << a + b << std::endl;
}
` };
const THREADS = { 'main.cpp': `#include <atomic>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>
int main() {
    std::atomic<long> counted{0};
    long locked = 0;
    std::mutex mu;
    std::vector<std::thread> pool;
    for (int t = 0; t < 4; t++)
        pool.emplace_back([&] {
            for (long i = 0; i < 1000000; i++) {
                counted.fetch_add(1, std::memory_order_relaxed);
                if (i % 1000 == 0) { std::lock_guard<std::mutex> g(mu); locked++; }
            }
        });
    for (auto &t : pool) t.join();
    std::cout << "hardware_concurrency " << std::thread::hardware_concurrency() << "\\n";
    std::cout << "atomic " << counted << " mutex " << locked << "\\n";
}
` };
const THROW = { 'main.cpp': `#include <iostream>
#include <stdexcept>
int main() {
    std::cout << "before" << std::endl;
    throw std::runtime_error("boom");
}
` };
const NULLPTR = { 'main.cpp': `#include <cstdio>
int main() {
    std::puts("about to crash");
    std::fflush(stdout);
    volatile int *p = nullptr;
    return *p;
}
` };
const LOOP = { 'main.cpp': `#include <cstdio>
int main() {
    std::puts("spinning");
    std::fflush(stdout);
    for (volatile unsigned long i = 0;; i++) {}
}
` };
const HELLO = { 'main.cpp': `#include <iostream>
#include <sys/utsname.h>
int main() {
    utsname u;
    uname(&u);
    std::cout << "hello from " << u.machine << "\\n";
}
` };

// ---- server: app/static with isolation headers; every request path is logged
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
let requests = [];
const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/__test.html') return res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION }).end('<!doctype html><link rel=icon href="data:,"><title>linux run test</title>');
    requests.push(url);
    const file = path.normalize(path.join(STATIC, url));
    try {
        if (!file.startsWith(STATIC) || !fs.statSync(file).isFile()) throw new Error('not a file');
        const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600', ...ISOLATION };
        let body;
        if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '') && !file.endsWith('.gz') && fs.existsSync(file + '.br')) {
            body = fs.readFileSync(file + '.br');
            headers['content-encoding'] = 'br';
        }
        body ??= fs.readFileSync(file);
        res.writeHead(200, { ...headers, 'content-length': body.length }).end(body);
    } catch {
        res.writeHead(404).end();
    }
});

let browser, origin;
before(async () => {
    if (skip) return;
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: CHROMIUM });
});
after(async () => {
    await browser?.close();
    server.close();
});

/** A fresh page (and, with `cold`, a fresh cache) with window.runProject, the app's part of the runner protocol. */
async function newPage(cold) {
    const context = cold ? await browser.newContext() : (browser.contexts()[0] ?? (await browser.newContext()));
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/__test.html`);
    await page.evaluate(() => {
        window.runProject = (files, { inputs = [], stopAfter = null, options, type = 'run' } = {}) => new Promise((done) => {
            const t0 = performance.now();
            const r = { stdout: '', stderr: '', kernel: '', code: null, phases: [], marks: {}, terminated: false, stdinRequests: [] };
            const sab = new SharedArrayBuffer(8 + 65536);
            const state = new Int32Array(sab, 0, 2);
            const worker = new Worker('/packs/cpp/runner.js', { type: 'module' });
            const finish = () => { r.ms = Math.round(performance.now() - t0); done(r); };
            worker.onerror = (e) => { r.stderr += 'worker error: ' + e.message + '\n'; finish(); };
            worker.onmessage = ({ data: m }) => {
                if (m.type === 'stdout' || m.type === 'stderr' || m.type === 'kernel') r[m.type] += m.text;
                else if (m.type === 'phase') r.phases.push(m.text);
                else if (m.type === 'mark') r.marks[m.name] = m.ms;
                else if (m.type === 'stdin') {
                    r.stdinRequests.push(m.streaming === true);
                    const line = inputs.shift();
                    if (line === undefined) Atomics.store(state, 0, 3);
                    else {
                        const bytes = new TextEncoder().encode(line + '\n');
                        new Uint8Array(sab, 8).set(bytes);
                        Atomics.store(state, 1, bytes.length);
                        Atomics.store(state, 0, 2);
                    }
                    Atomics.notify(state, 0);
                } else if (m.type === 'exit') { r.code = m.code; worker.terminate(); finish(); }
                if (stopAfter && m.type === 'stdout' && r.stdout.includes(stopAfter) && !r.terminated) {
                    r.terminated = true;
                    setTimeout(() => { worker.terminate(); finish(); }, 1500);
                }
            };
            worker.postMessage({ type, files, entry: 'main.cpp', stdin: sab, ...(options ? { options } : {}) });
        });
    });
    return page;
}
let warm;
const run = async (files, opts = {}) => {
    warm ??= await newPage(false);
    return warm.evaluate(([f, o]) => window.runProject(f, o), [files, opts]);
};
/** Runs in a cold cache and returns the result with the /packs/cpp/ paths it fetched. */
const runCold = async (files, opts = {}) => {
    const page = await newPage(true);
    requests = [];
    const r = await page.evaluate(([f, o]) => window.runProject(f, o), [files, opts]);
    r.fetched = [...new Set(requests.filter((u) => u.startsWith('/packs/cpp/')).map((u) => u.slice('/packs/cpp/'.length)))].sort();
    await page.context().close();
    return r;
};
const why = (r) => `${r.stderr}\n--- kernel ---\n${r.kernel.slice(-2000)}`;

/** The URL rules of plan §2 for a Linux run on `arch`. */
function checkFetched(fetched, arch, { user = false, strace = false } = {}) {
    for (const f of fetched) {
        for (const other of ARCHES.filter((a) => a !== arch))
            assert.ok(!f.includes(`/${other}/`), `${f}: another architecture's file`);
        assert.ok(!/^(cc\.(js|wasm)|wasi-sysroot|gtest|catch2|doctest|explorer|demangle)/.test(f), `${f}: not needed to run on Linux`);
    }
    assert.equal(fetched.some((f) => f.startsWith('user/')), user, `user/ fetched only in user mode: ${fetched}`);
    assert.equal(fetched.some((f) => f.startsWith('vm/') && f !== `vm/${arch}/strace.cpio`), !user, `vm/ fetched only in system mode: ${fetched}`);
    assert.equal(fetched.includes(`vm/${arch}/strace.cpio`), strace, `strace.cpio only with strace: ${fetched}`);
    for (const f of ['runner.js', 'cc-cross.js', 'cc-cross.wasm', 'vm.js', `targets/${arch}/lib.tar`])
        assert.ok(fetched.includes(f), `${f} fetched: ${fetched}`);
}

for (const t of LINUX) {
    const { arch, triple } = t;
    test(`${arch}: the app's sample project prints 5.000000 twice (cold cache, only this arch's files)`, { skip }, async () => {
        const r = await runCold(withTarget(SAMPLE, triple));
        assert.equal(r.code, 0, why(r));
        assert.equal(r.stdout, '5.000000\n5.000000\n');
        checkFetched(r.fetched, arch);
        console.log(`# ${arch} sample, cold: ${r.ms} ms, marks ${JSON.stringify(r.marks)}`);
        const w = await run(withTarget(SAMPLE, triple));
        assert.equal(w.code, 0, why(w));
        console.log(`# ${arch} sample, warm: ${w.ms} ms, marks ${JSON.stringify(w.marks)}`);
    });

    test(`${arch}: C++ cin reads two numbers`, { skip }, async () => {
        const r = await run(withTarget(CIN, triple), { inputs: ['40', '2'] });
        assert.equal(r.code, 0, why(r));
        assert.equal(r.stdout, 'first number: second number: sum 42\n');
        // The guest's reads are not visible from the runner, so every request
        // is a streaming one (CONTRACT.md, "Standard input").
        assert.ok(r.stdinRequests.length >= 2 && r.stdinRequests.every(Boolean), `stdin requests ${JSON.stringify(r.stdinRequests)}`);
    });

    test(`${arch}: std::thread x 4 on 4 vCPUs, exact counts`, { skip }, async () => {
        const r = await run(withTarget(THREADS, triple), { options: { emulation: 'system', cpus: 4, strace: false } });
        assert.equal(r.code, 0, why(r));
        assert.equal(r.stdout, 'hardware_concurrency 4\natomic 4000000 mutex 4000\n');
    });

    test(`${arch}: an uncaught exception is SIGABRT (134) with libc++abi's message`, { skip }, async () => {
        const r = await run(withTarget(THROW, triple));
        assert.equal(r.code, 134, why(r));
        assert.equal(r.stdout, 'before\n');
        assert.match(r.stderr, /terminating due to uncaught exception of type std::runtime_error: boom/);
        assert.match(r.stderr, /Terminated by signal 6 \(SIGABRT\)/);
    });

    test(`${arch}: a null dereference is SIGSEGV (139)`, { skip }, async () => {
        const r = await run(withTarget(NULLPTR, triple));
        assert.equal(r.code, 139, why(r));
        assert.match(r.stderr, /Terminated by signal 11 \(SIGSEGV\)/);
    });

    test(`${arch}: an endless loop is stopped by terminating the worker`, { skip }, async () => {
        const r = await run(withTarget(LOOP, triple), { stopAfter: 'spinning' });
        assert.equal(r.terminated, true);
        assert.equal(r.code, null);
        assert.equal(r.stdout, 'spinning\n');
    });

    test(`${arch}: strace on fetches strace.cpio and traces the program`, { skip }, async () => {
        const r = await runCold(withTarget(HELLO, triple), { options: { emulation: 'system', cpus: 1, strace: true } });
        assert.equal(r.code, 0, why(r));
        assert.equal(r.stdout, `hello from ${arch}\n`);
        checkFetched(r.fetched, arch, { strace: true });
    });

    test(`${arch}: Test with GoogleTest and RapidCheck: the sample's tests and a property pass; a false property is shrunk to (1, 1), exit 1`, { skip: skip || (!fs.existsSync(path.join(OUT, `targets/${arch}/rapidcheck.tar`)) && 'build-test-frameworks-linux.sh has not run') }, async () => {
        const plain = (text) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');
        const ok = await run(withTarget({ ...SAMPLE, 'tests/properties_test.cpp': PROPERTIES.gtest(false) }, triple), { type: 'test' });
        assert.equal(ok.code, 0, why(ok) + ok.stdout);
        assert.match(plain(ok.stdout), /\[  PASSED  \] 5 tests\./);
        // GoogleTest's colours reach the guest (GTEST_COLOR=yes in its environment).
        assert.match(ok.stdout, /\x1b\[0;32m\[  PASSED  \] \x1b\[m5 tests\./);
        const bad = await runCold(withTarget({ ...SAMPLE, 'tests/properties_test.cpp': PROPERTIES.gtest(true) }, triple), { type: 'test' });
        assert.equal(bad.code, 1, why(bad) + bad.stdout);
        const out = plain(bad.stdout);
        assert.ok(out, `no report: ${why(bad)}`);
        assert.match(out, /Falsifiable after \d+ tests? and \d+ shrinks?\s+std::tuple<int, int>:\s+\(1, 1\)/);
        assert.match(out, /tests\/properties_test\.cpp:\d+:\s+RC_ASSERT\(p\.norm\(\) == std::floor\(p\.norm\(\)\)\)/);
        assert.match(out, /\[  FAILED  \] GeometryProperties\.NormIsAWholeNumber/);
        checkFetched(bad.fetched, arch);
        for (const f of [`targets/${arch}/gtest.tar`, `targets/${arch}/rapidcheck.tar`]) assert.ok(bad.fetched.includes(f), `${f} fetched: ${bad.fetched}`);
        console.log(`# ${arch} GoogleTest + RapidCheck, failing, cold: ${bad.ms} ms; ${out.match(/Falsifiable[^]*?\(1, 1\)/)?.[0].replace(/\s+/g, ' ')}`);
    });

    test(`${arch}: Test with Catch2 is refused by name (Catch2 is built for WebAssembly only)`, { skip }, async () => {
        const files = { ...SAMPLE, 'tests/geometry_test.cpp': '#include <catch2/catch_test_macros.hpp>\nTEST_CASE("x") { REQUIRE(true); }\n' };
        const r = await run(withTarget(files, triple), { type: 'test' });
        assert.equal(r.code, 1);
        assert.equal(r.stderr, `Catch2 runs on the WebAssembly target only, for now: on ${t.label} the tests can use GoogleTest (and RapidCheck).\n`);
    });

    const userBuilt = fs.existsSync(path.join(OUT, `user/${arch}/qemu-${arch}.wasm`));
    test(`${arch} user mode: hello and threads (one CPU), fetching user/ and no VM`, { skip: skip || (!userBuilt && 'user mode not staged') }, async () => {
        const r = await runCold(withTarget(HELLO, triple), { options: { emulation: 'user', cpus: 1, strace: false } });
        assert.equal(r.code, 0, why(r));
        assert.equal(r.stdout, `hello from ${arch}\n`);
        checkFetched(r.fetched, arch, { user: true });
        console.log(`# ${arch} user-mode hello, cold: ${r.ms} ms, marks ${JSON.stringify(r.marks)}`);
        const th = await run(withTarget(THREADS, triple), { options: { emulation: 'user', cpus: 4, strace: false } });
        assert.equal(th.code, 0, why(th));
        assert.equal(th.stdout, 'hardware_concurrency 1\natomic 4000000 mutex 4000\n');
    });
}
