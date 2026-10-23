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
// wasm), with timings.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

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
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
        window.runProject = (files, { inputs = [], stopAfter = null, entry = 'main.cpp', failInstantiate = false } = {}) =>
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
                worker.postMessage({ type: 'run', files, entry, stdin: sab });
            });
    });

    const run = (files, opts) => page.evaluate(([f, o]) => window.runProject(f, o), [files, opts ?? {}]);
    const timeline = (r) => r.phases.map(([t, ms]) => `${t}@${ms}`).join(', ');

    // 1. The sample, cold then warm.
    bytesSent = 0;
    const cold = await run(SAMPLE);
    const coldBytes = bytesSent;
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
