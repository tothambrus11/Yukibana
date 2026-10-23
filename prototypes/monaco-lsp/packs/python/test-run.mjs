// Headless test of the Python runner (packs/CONTRACT.md, "Running a program"),
// run the way the app runs it: app/static served over http with COOP/COEP so
// the page is crossOriginIsolated, `new Worker('/packs/python/runner.js',
// { type: 'module' })` in Chromium, the stdin SharedArrayBuffer driven from
// the page as the app's terminal drives it.
//
//   node test-run.mjs        (after ./build.sh; needs playwright-core)
//
// "cold" is the first run in a fresh browser profile: every byte downloaded,
// the wasm compiled. "warm" is a later run in a new worker on the same page:
// the files come from the HTTP cache (the server sends max-age, standing in
// for the app's service worker), which is what pressing Run again costs.

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TYPES = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
    '.html': 'text/html',
};
const ISOLATION = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
};

// Raw files, no content-encoding negotiation: the worst-case transfer.
let bytesServed = 0;
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION });
        res.end('<!doctype html><link rel=icon href="data:,"><title>python runner test</title>');
        return;
    }
    const file = normalize(join(STATIC, path));
    try {
        if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
        const body = await readFile(file);
        bytesServed += body.length;
        res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
            'content-length': body.length,
            'cache-control': 'max-age=3600',
            ...ISOLATION,
        });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

// A persistent profile in a fresh temporary directory: an incognito context's
// in-memory HTTP cache does not keep 10 MB entries, a disk cache does.
const profile = await mkdtemp(join(tmpdir(), 'yukibana-runner-test-'));
const browser = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM });
const page = browser.pages()[0] ?? (await browser.newPage());
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${origin}/__test.html`);

// In the page: start a runner, answer its stdin requests from `inputs`
// (a string is a line, null is Ctrl-D), collect every message in order.
// With `stopAfterMs`, terminate the worker that long after "Running", as the
// app's Stop button does.
await page.evaluate(() => {
    window.runProgram = (files, entry, inputs = [], { stopAfterMs = 0, timeoutMs = 120000 } = {}) =>
        new Promise((done) => {
            const t0 = performance.now();
            const sab = crossOriginIsolated ? new SharedArrayBuffer(8 + 65536) : null;
            const state = sab && new Int32Array(sab, 0, 2);
            const data = sab && new Uint8Array(sab, 8);
            const events = [];
            const out = { stdout: '', stderr: '', code: null, events, stopped: false, loading: {}, phases: [] };
            const worker = new Worker('/packs/python/runner.js', { type: 'module' });
            const finish = () => {
                worker.terminate();
                out.ms = Math.round(performance.now() - t0);
                done(out);
            };
            const timer = setTimeout(() => {
                out.timedOut = true;
                finish();
            }, timeoutMs);
            worker.onerror = (e) => {
                out.workerError = e.message ?? String(e);
                clearTimeout(timer);
                finish();
            };
            worker.onmessage = ({ data: m }) => {
                const at = Math.round(performance.now() - t0);
                if (m.type === 'loading') {
                    out.loading[m.label] = { loaded: m.loaded, total: m.total };
                    return;
                }
                events.push({ ...m, at });
                if (m.type === 'phase') {
                    out.phases.push(`${m.text}@${at}ms`);
                    if (m.text === 'Running') out.runningAt = at;
                    if (m.text === 'Running' && stopAfterMs) {
                        setTimeout(() => {
                            out.stopped = true;
                            clearTimeout(timer);
                            finish();
                        }, stopAfterMs);
                    }
                }
                if (m.type === 'stdout') out.stdout += m.text;
                if (m.type === 'stderr') out.stderr += m.text;
                if (m.type === 'stdin') {
                    const line = inputs.shift();
                    // Answer asynchronously, as a person typing would.
                    setTimeout(() => {
                        if (line === undefined || line === null) {
                            Atomics.store(state, 0, 3);
                        } else {
                            const bytes = new TextEncoder().encode(line);
                            data.set(bytes);
                            Atomics.store(state, 1, bytes.length);
                            Atomics.store(state, 0, 2);
                        }
                        Atomics.notify(state, 0);
                    }, 20);
                }
                if (m.type === 'exit') {
                    out.code = m.code;
                    clearTimeout(timer);
                    finish();
                }
            };
            worker.postMessage({ type: 'run', files, entry, stdin: sab });
        });
});

const SAMPLE = {
    'main.py': `from geometry import Point, distance


def main() -> None:
    a = Point(0, 0)
    b = Point(3, 4)
    print(f"{a} to {b}: {distance(a, b)}")
    print(a.norm())


if __name__ == "__main__":
    main()
`,
    'geometry.py': `import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Point:
    """A point in the plane."""

    x: float
    y: float

    def norm(self) -> float:
        """Distance from the origin."""
        return math.hypot(self.x, self.y)


def distance(a: Point, b: Point) -> float:
    """Euclidean distance between two points."""
    return math.hypot(a.x - b.x, a.y - b.y)
`,
};

let failures = 0;
const short = (s, n = 160) => JSON.stringify(s.length > n ? `${s.slice(0, n)}...` : s);
function check(name, ok, detail) {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
const run = (files, entry, inputs, opts) => page.evaluate(([f, e, i, o]) => window.runProgram(f, e, i, o), [files, entry, inputs, opts]);
const timing = (r) => `(${r.ms} ms total, Running at ${r.runningAt ?? '-'} ms)`;

check('the page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated));

// 1. The sample project, cold and warm.
const before = bytesServed;
const cold = await run(SAMPLE, 'main.py', []);
const coldBytes = bytesServed - before;
const expectSample = 'Point(x=0, y=0) to Point(x=3, y=4): 5.0\n0.0\n';
check(
    'cold: the sample project prints the distance and the norm, exit 0',
    cold.stdout === expectSample && cold.stderr === '' && cold.code === 0,
    `${timing(cold)} stdout=${short(cold.stdout)} stderr=${short(cold.stderr)} code=${cold.code}`,
);
console.log(`      cold downloads: ${(coldBytes / 1e6).toFixed(2)} MB raw over http; progress: ${JSON.stringify(cold.loading)}; phases: ${cold.phases.join(', ')}`);
const before2 = bytesServed;
const warm = await run(SAMPLE, 'main.py', []);
check(
    'warm: the same run in a new worker, files from the HTTP cache',
    warm.stdout === expectSample && warm.code === 0,
    `${timing(warm)} served ${bytesServed - before2} bytes`,
);
// Warm startup must be cheaper than cold: the wasm comes from the HTTP cache
// and, because runner.js hands Pyodide the original Response (with its URL),
// V8 can reuse its compiled-code cache. An earlier runner rebuilt the
// Response and every Run recompiled. Median of three, against the cold run.
const warms = [warm.runningAt];
for (let i = 0; i < 2; i++) warms.push((await run(SAMPLE, 'main.py', [])).runningAt);
const warmMedian = [...warms].sort((a, b) => a - b)[1];
check(
    'warm runs reach Running faster than the cold run',
    warmMedian < cold.runningAt * 0.9,
    `cold ${cold.runningAt} ms, warm ${warms.join('/')} ms (median ${warmMedian})`,
);

// 2. A prompt without a newline, two lines of stdin, their sum.
const SUM = `a = int(input("First number: "))
b = int(input("Second number: "))
print(f"{a} + {b} = {a + b}")
`;
const sum = await run({ 'main.py': SUM }, 'main.py', ['2\n', '40\n']);
const firstStdin = sum.events.findIndex((e) => e.type === 'stdin');
const beforeStdin = sum.events.slice(0, firstStdin).filter((e) => e.type === 'stdout').map((e) => e.text).join('');
check(
    'input() reads two lines through the SharedArrayBuffer and prints their sum',
    sum.stdout === 'First number: Second number: 2 + 40 = 42\n' && sum.code === 0,
    `${timing(sum)} stdout=${short(sum.stdout)} code=${sum.code}`,
);
check('the prompt without a newline arrives before the runner asks for input', beforeStdin === 'First number: ', `before first stdin: ${JSON.stringify(beforeStdin)}`);


// 2b. sys.stdin.readline() does not flush stdout in CPython; the runner does.
const RL = `import sys
print("name? ", end="")
name = sys.stdin.readline().strip()
print("hello,", name)
rest = sys.stdin.read()
print("rest:", repr(rest))
`;
const rl = await run({ 'main.py': RL }, 'main.py', ['Ada\n', 'more\n', null]);
const rlBefore = rl.events.slice(0, rl.events.findIndex((e) => e.type === 'stdin')).filter((e) => e.type === 'stdout').map((e) => e.text).join('');
check(
    'sys.stdin.readline() after print(end="") shows the prompt first; read() runs to Ctrl-D',
    rlBefore === 'name? ' && rl.stdout === "name? hello, Ada\nrest: 'more\\n'\n" && rl.code === 0,
    `${timing(rl)} before stdin ${JSON.stringify(rlBefore)}, stdout=${short(rl.stdout)} stderr=${short(rl.stderr)}`,
);

// 2c. End of file at input() is EOFError, as in a terminal.
const eof = await run({ 'main.py': 'x = input("? ")\n' }, 'main.py', [null]);
check('Ctrl-D at input() raises EOFError: traceback on stderr, exit 1', eof.code === 1 && /EOFError/.test(eof.stderr), `stderr=${short(eof.stderr)}`);

// 3. A syntax error: on stderr, exit non-zero, nothing on stdout.
const SYNTAX = { 'main.py': 'from helper import f\nprint(f(2))\n', 'helper.py': 'def f(x)\n    return x * 2\n' };
const syn = await run(SYNTAX, 'main.py', []);
check(
    'a syntax error in an imported module is reported on stderr with its file and line, exit 1',
    syn.code === 1 && syn.stdout === '' && /helper\.py", line 1/.test(syn.stderr) && /SyntaxError/.test(syn.stderr),
    `${timing(syn)} stderr=${short(syn.stderr, 400)}`,
);
check('the traceback starts at the project, not in the runner or runpy', !/runpy|_yukibana/.test(syn.stderr));
const syn2 = await run({ 'main.py': 'print("never"\n' }, 'main.py', []);
check('a syntax error in the entry itself: stderr, exit 1, nothing runs', syn2.code === 1 && syn2.stdout === '' && /SyntaxError/.test(syn2.stderr), `stderr=${short(syn2.stderr, 300)}`);

// 3b. Runtime errors and exit codes.
const rt = await run({ 'main.py': 'print("before")\nimport geometry\ngeometry.boom()\n', 'geometry.py': 'def boom():\n    return 1 / 0\n' }, 'main.py', []);
check(
    'an uncaught exception: output so far, then a traceback through both files, exit 1',
    rt.code === 1 && rt.stdout === 'before\n' && /^Traceback/.test(rt.stderr) && /main\.py", line 3/.test(rt.stderr) && /ZeroDivisionError/.test(rt.stderr),
    `stderr=${short(rt.stderr, 400)}`,
);
const ex = await run({ 'main.py': 'import sys\nprint("bye")\nsys.exit(3)\n' }, 'main.py', []);
check('sys.exit(3) exits with 3', ex.code === 3 && ex.stdout === 'bye\n' && ex.stderr === '', `code=${ex.code}`);
const exs = await run({ 'main.py': 'raise SystemExit("fatal: no input")\n' }, 'main.py', []);
check('SystemExit with a message prints it to stderr and exits 1', exs.code === 1 && exs.stderr === 'fatal: no input\n', `stderr=${short(exs.stderr)}`);
const ex256 = await run({ 'main.py': 'import sys\nsys.exit(256)\n' }, 'main.py', []);
const exNeg = await run({ 'main.py': 'import sys\nsys.exit(-1)\n' }, 'main.py', []);
check('exit statuses wrap to 0-255 as the shell sees them: sys.exit(256) is 0, sys.exit(-1) is 255', ex256.code === 0 && exNeg.code === 255, `codes=${ex256.code},${exNeg.code}`);
const osx = await run({ 'main.py': 'import os\nprint("x", flush=True)\nos._exit(7)\nprint("never")\n' }, 'main.py', []);
check('os._exit(7) exits with 7, no runner stack trace on stderr', osx.code === 7 && osx.stdout === 'x\n' && osx.stderr === '', `code=${osx.code} stdout=${short(osx.stdout)} stderr=${short(osx.stderr)}`);

// 3c. Packages in subdirectories, __name__, UTF-8, interleaving.
const pkg = await run(
    {
        'main.py': 'import sys\nfrom shapes.circle import area\nprint(__name__, round(area(1), 5))\nprint("ünïcödé ✓ 雪花", file=sys.stderr)\nprint("done")\n',
        'shapes/__init__.py': '',
        'shapes/circle.py': 'import math\n\ndef area(r):\n    return math.pi * r * r\n',
    },
    'main.py',
    [],
);
check(
    'a package in a subdirectory imports; __name__ is __main__; UTF-8 survives',
    pkg.code === 0 && pkg.stdout === '__main__ 3.14159\ndone\n' && pkg.stderr === 'ünïcödé ✓ 雪花\n',
    `stdout=${short(pkg.stdout)} stderr=${short(pkg.stderr)}`,
);
const order = pkg.events.filter((e) => e.type === 'stdout' || e.type === 'stderr').map((e) => e.type[3]).join('');
check('stdout and stderr arrive in program order', order === 'oeo', order);

// 3d. Streaming: output arrives while the program runs, not at the end.
const slow = await run({ 'main.py': 'import time\nfor i in range(3):\n    print(i)\n    time.sleep(0.3)\n' }, 'main.py', []);
const outs = slow.events.filter((e) => e.type === 'stdout');
const exitAt = slow.events.find((e) => e.type === 'exit')?.at ?? 0;
check(
    'output is streamed as printed (time.sleep blocks the worker in between)',
    slow.stdout === '0\n1\n2\n' && outs.length === 3 && outs[2].at - outs[0].at >= 500,
    `stdout events at ${outs.map((e) => e.at).join(', ')} ms, exit at ${exitAt} ms`,
);

// 3e. A large amount of output.
const big = await run({ 'main.py': 'for i in range(100000):\n    print(i)\n' }, 'main.py', []);
check('100 000 printed lines all arrive', big.code === 0 && big.stdout.split('\n').length === 100001, `${timing(big)}, ${big.events.filter((e) => e.type === 'stdout').length} stdout messages`);

// 4. A program that never ends: output so far arrives, Stop terminates it.
const loop = await run({ 'main.py': 'print("spinning", flush=True)\nwhile True:\n    pass\n' }, 'main.py', [], { stopAfterMs: 1000 });
check(
    'an infinite loop is stopped by terminating the worker; its output arrived first',
    loop.stopped && loop.code === null && loop.stdout === 'spinning\n',
    `${timing(loop)} stopped=${loop.stopped}`,
);
const loop2 = await run({ 'main.py': 'print("no flush, no newline", end="")\nwhile True:\n    pass\n' }, 'main.py', [], { stopAfterMs: 1000 });
check(
    'known limit: a prompt without newline followed by a busy loop stays buffered, as in CPython on a terminal',
    loop2.stopped && loop2.stdout === '',
    `stdout=${JSON.stringify(loop2.stdout)}`,
);
const after = await run(SAMPLE, 'main.py', []);
check('after Stop, the page is responsive and a new run works', after.code === 0 && after.stdout === expectSample, timing(after));

// Without isolation (stdin null): input() sees end of file.
const noSab = await page.evaluate(
    () =>
        new Promise((done) => {
            const w = new Worker('/packs/python/runner.js', { type: 'module' });
            let err = '';
            w.onmessage = ({ data: m }) => {
                if (m.type === 'stderr') err += m.text;
                if (m.type === 'exit') {
                    w.terminate();
                    done({ code: m.code, err });
                }
            };
            w.postMessage({ type: 'run', files: { 'main.py': 'input()\n' }, entry: 'main.py', stdin: null });
        }),
);
check('with stdin null, input() raises EOFError', noSab.code === 1 && /EOFError/.test(noSab.err));

check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await browser.close();
await rm(profile, { recursive: true, force: true });
server.close();
process.exit(failures ? 1 : 0);
