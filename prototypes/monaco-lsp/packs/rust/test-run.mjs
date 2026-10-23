// Headless test of the Rust runner (../CONTRACT.md, "Running a program"),
// run the way the app runs it: app/static served over http WITH
// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy, so the page is
// crossOriginIsolated; `new Worker('/packs/rust/runner.js', { type: 'module' })`
// in Chromium; one { type: 'run' } or { type: 'test' } message; stdin through
// the SharedArrayBuffer protocol, driven from the page as the app's terminal
// does.
//
//   node test-run.mjs        (after ./build.sh; needs playwright-core)
//
// Cases: the app's sample project (languages.ts: Cargo.toml, src/main.rs
// using the library in src/lib.rs + src/point.rs) cold and warm, its tests
// (unit tests in src/point.rs, integration tests in tests/), a failing
// test, a prompt without newline and two lines of stdin, end of input, a
// type error and a borrow error (rustc's diagnostics, non-zero exit, nothing
// run), a panic (exit 101), process::exit, and a program that never ends,
// which the page stops by terminating the worker.
//
// Adapted from ../swift/test-run.mjs.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';

const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.tar': 'application/x-tar', '.html': 'text/html' };
const ISOLATION = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
};

// Static files with the isolation headers, serving the .br sibling when the
// browser accepts brotli, as the app's host does; cacheable, so the second
// run measures a warm cache.
let bytesSent = 0;
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION });
        res.end('<!doctype html><link rel=icon href="data:,"><title>rust runner test</title>');
        return;
    }
    if (path === '/__sw.js') {
        // What the app's service worker does for /packs/** (app/src/service-worker):
        // cache-first in Cache Storage, filled on the first download.
        res.writeHead(200, { 'content-type': 'text/javascript', ...ISOLATION });
        res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
    if (!new URL(e.request.url).pathname.startsWith('/packs/')) return;
    e.respondWith((async () => {
        const cache = await caches.open('packs');
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const response = await fetch(e.request);
        if (response.ok) e.waitUntil(cache.put(e.request, response.clone()));
        return response;
    })());
});`);
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

const languages = await readFile(resolve(HERE, '../../app/src/lib/languages.ts'), 'utf8');
const SAMPLE = sampleOf(languages, 'rust');
const MANIFEST = { 'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n' };
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

const STDIN = {
    ...MANIFEST,
    'src/main.rs': `use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    print!("first number: ");
    io::stdout().flush().unwrap();
    let a: i64 = lines.next().unwrap().unwrap().trim().parse().unwrap();
    print!("second number: ");
    io::stdout().flush().unwrap();
    let b: i64 = lines.next().unwrap().unwrap().trim().parse().unwrap();
    println!("sum: {}", a + b);
}
`,
};
const EOF = {
    ...MANIFEST,
    'src/main.rs': `use std::io::BufRead;

fn main() {
    let mut n = 0;
    for line in std::io::stdin().lock().lines() {
        n += 1;
        println!("got {}", line.unwrap());
    }
    println!("end of input after {n} lines");
}
`,
};
const TYPE_ERROR = { ...MANIFEST, 'src/main.rs': 'fn main() {\n    let x: i32 = "no";\n    println!("{x}");\n}\n' };
const BORROW_ERROR = {
    ...MANIFEST,
    'src/main.rs': 'fn main() {\n    let v = vec![1, 2, 3];\n    let w = v;\n    println!("{:?} {:?}", v, w);\n}\n',
};
const PANIC = { ...MANIFEST, 'src/main.rs': 'fn main() {\n    let v: Vec<i32> = Vec::new();\n    println!("before");\n    println!("{}", v[1]);\n}\n' };
const EXIT = { ...MANIFEST, 'src/main.rs': 'fn main() {\n    println!("leaving");\n    std::process::exit(3);\n}\n' };
const FOREVER = { ...MANIFEST, 'src/main.rs': 'fn main() {\n    println!("looping");\n    let mut i: u64 = 0;\n    loop {\n        i = i.wrapping_add(1);\n    }\n}\n' };
const SINGLE = { 'src/main.rs': 'use std::collections::HashMap;\n\nfn main() {\n    let mut m = HashMap::new();\n    for w in "a b a c b a".split(\' \') {\n        *m.entry(w).or_insert(0) += 1;\n    }\n    let mut v: Vec<_> = m.into_iter().collect();\n    v.sort();\n    println!("{v:?}");\n}\n' };

const browser = await chromium.launch({ executablePath: CHROMIUM });
let failed = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (m) => process.env.VERBOSE && console.log('[page]', m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/__test.html`);
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/__sw.js');
        await navigator.serviceWorker.ready;
    });
    await page.reload();
    check('the page is crossOriginIsolated and controlled by a service worker that caches /packs/',
        await page.evaluate(() => crossOriginIsolated && !!navigator.serviceWorker.controller));

    // In the page: start the runner, answer stdin requests from `inputs` (one
    // line each, then end of file), optionally terminate it after the program
    // printed `stopAfter`. Resolves with what came back and when.
    await page.evaluate(() => {
        window.runProject = (files, { inputs = [], stopAfter = null, entry = 'src/main.rs', type = 'run' } = {}) =>
            new Promise((done) => {
                const t0 = performance.now();
                const result = { stdout: '', stderr: '', code: null, phases: [], loading: {}, stdinRequests: 0, stdoutBeforeInput: [], terminated: false };
                const sab = new SharedArrayBuffer(8 + 65536);
                const state = new Int32Array(sab, 0, 2);
                const data = new Uint8Array(sab, 8);
                const worker = new Worker('/packs/rust/runner.js', { type: 'module' });
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
                    if (m.type === 'stdout') result.stdout += m.text.replace(/\u001b\[[0-9;]*m/g, '');
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
    const EXPECTED = '(0, 0) to (3, 4): 5\n5\n';
    bytesSent = 0;
    const cold = await run(SAMPLE);
    const coldBytes = bytesSent;
    check(
        'sample project (cold): src/main.rs uses the geometry library (src/lib.rs, src/point.rs), prints the distance and the norm, exit 0',
        cold.code === 0 && cold.stdout === EXPECTED,
        `${JSON.stringify(cold.stdout)} code=${cold.code} in ${cold.ms} ms, ${(coldBytes / 1e6).toFixed(1)} MB transferred; ${timeline(cold)}`,
    );
    if (cold.code !== 0) console.log(plain(cold.stderr));
    const loads = Object.entries(cold.loading).map(([k, [l, t]]) => `${k} ${l}/${t}`);
    check('loading messages for each download', loads.length === 2 && Object.values(cold.loading).every(([l, t]) => l === t && l > 0), loads.join(', '));
    bytesSent = 0;
    const warm = await run(SAMPLE);
    check('sample project (warm): same output from the browser cache', warm.code === 0 && warm.stdout === EXPECTED,
        `code=${warm.code} in ${warm.ms} ms, ${bytesSent} bytes transferred; ${timeline(warm)}`);

    // 2. Tests, as cargo test runs them.
    const tests = await run(SAMPLE, { type: 'test' });
    const results = [...tests.stdout.matchAll(/^test (\S+) \.\.\. (ok|FAILED)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    check(
        'cargo test: the unit test in src/point.rs and the three integration tests in tests/geometry.rs pass, exit 0',
        tests.code === 0 &&
            JSON.stringify(results) === JSON.stringify(['point::tests::norm_of_3_4_is_5 ok', 'distance_is_symmetric ok', 'distance_to_itself_is_zero ok', 'points_print_as_pairs ok']) &&
            /Running unittests src\/lib\.rs/.test(plain(tests.stderr)) && /Running tests\/geometry\.rs/.test(plain(tests.stderr)),
        `code=${tests.code} in ${tests.ms} ms ${JSON.stringify(results)}`,
    );
    if (tests.code !== 0) console.log(plain(tests.stderr), tests.stdout);
    const failing = await run({ ...SAMPLE, 'tests/geometry.rs': SAMPLE['tests/geometry.rs'].replace('"(1, 2.5)"', '"(1.0, 2.5)"') }, { type: 'test' });
    check(
        'cargo test: a failing assert_eq! is reported with both values, the others still run, exit 101',
        failing.code === 101 && /test points_print_as_pairs \.\.\. FAILED/.test(failing.stdout) && /test distance_is_symmetric \.\.\. ok/.test(failing.stdout) &&
            /left: "\(1, 2\.5\)"/.test(failing.stdout) && /test result: FAILED\. 2 passed; 1 failed/.test(failing.stdout),
        `code=${failing.code} ${failing.stdout.split('\n').filter((l) => /left|right|test result/.test(l)).join(' | ')}`,
    );
    const runOfTests = await run(SAMPLE, {});
    check("'run' of the same project runs the program, not its tests", runOfTests.code === 0 && runOfTests.stdout === EXPECTED);

    // 3. stdin: the prompt must be visible before the program waits.
    const r = await run(STDIN, { inputs: ['19', '23'] });
    check(
        'stdin: print! + flush prompt without newline, two lines read, their sum',
        r.code === 0 && r.stdout === 'first number: second number: sum: 42\n' && r.stdinRequests === 2 &&
            r.stdoutBeforeInput[0] === 'first number: ' && r.stdoutBeforeInput[1] === 'first number: second number: ',
        `${JSON.stringify(r.stdout)} requests=${r.stdinRequests} seen-before-input=${JSON.stringify(r.stdoutBeforeInput)} code=${r.code} ${r.ms} ms; ${timeline(r)}`,
    );
    if (r.code !== 0) console.log(plain(r.stderr));
    const eof = await run(EOF, { inputs: ['one', 'two'] });
    check('end of input (Ctrl-D) ends lines()', eof.code === 0 && eof.stdout === 'got one\ngot two\nend of input after 2 lines\n' && eof.stdinRequests === 3,
        `code=${eof.code} ${JSON.stringify(eof.stdout)} requests=${eof.stdinRequests}`);

    // 4. Compile errors: rustc's diagnostics on stderr, non-zero exit, nothing run.
    const broken = await run(TYPE_ERROR);
    check('type error: rustc E0308 on stderr with the location, non-zero exit, nothing run',
        broken.code !== 0 && /error\[E0308\]: mismatched types/.test(plain(broken.stderr)) && /src\/main\.rs:2:18/.test(plain(broken.stderr)) && broken.stdout === '',
        `code=${broken.code}\n${plain(broken.stderr).split('\n').slice(0, 3).join('\n')}`);
    const borrow = await run(BORROW_ERROR);
    check('borrow checker: use after move (E0382), non-zero exit',
        borrow.code !== 0 && /error\[E0382\]: borrow of moved value: `v`/.test(plain(borrow.stderr)) && borrow.stdout === '',
        `code=${borrow.code} ${plain(borrow.stderr).split('\n')[0]}`);

    // 5. Runtime: a panic exits 101 with Rust's message; process::exit's code.
    const panic = await run(PANIC);
    check('panic: index out of bounds is reported, exit 101',
        panic.code === 101 && panic.stdout === 'before\n' && /index out of bounds: the len is 0 but the index is 1/.test(plain(panic.stderr)),
        `code=${panic.code} ${JSON.stringify(panic.stdout)} ${plain(panic.stderr).split('\n').slice(0, 2).join(' | ')}`);
    if (panic.code !== 101) console.log(plain(panic.stderr));
    const exit = await run(EXIT);
    check('std::process::exit(3) exits 3', exit.code === 3 && exit.stdout === 'leaving\n', `code=${exit.code}`);
    const single = await run(SINGLE);
    check('a project without Cargo.toml: crate "app", edition 2021, HashMap and sorting from std',
        single.code === 0 && single.stdout === '[("a", 3), ("b", 2), ("c", 1)]\n', `code=${single.code} ${JSON.stringify(single.stdout)} ${plain(single.stderr).slice(0, 300)}`);

    // 6. A program that never ends: the page terminates the worker.
    const t = Date.now();
    const forever = await run(FOREVER, { stopAfter: 'looping' });
    const alive = await page.evaluate(() => 1 + 1);
    check('endless loop: terminated by the page, which stays responsive',
        forever.terminated && forever.code === null && forever.stdout === 'looping\n' && alive === 2, `stopped after ${Date.now() - t} ms; ${timeline(forever)}`);
} finally {
    await browser.close();
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
