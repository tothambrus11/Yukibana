// Headless test of the sanitizers (README, "Sanitizers") through the C/C++
// runner as the app drives it: app/static served over http with COOP/COEP
// and .br siblings, `new Worker('/packs/cpp/runner.js', { type: 'module' })`,
// one { type: 'run' } message per project, compile_flags.txt asking for
// -fsanitize=address and/or -fsanitize=undefined.
//
//   node test-sanitizers.mjs            the default target (wasm32-wasip1)
//   node test-sanitizers.mjs x86_64 ... also those Linux targets (QEMU-Wasm)
//
// After build.sh (build-sanitizers.sh, pack-runner.sh). Each bug class has a
// tiny program that commits it, and the report is checked as clang's
// runtime prints it natively: the error line, the frames with function,
// file, line and column (inlined frames included), the SUMMARY line, and
// the exit status (1 for AddressSanitizer and for LeakSanitizer under it, as
// natively, 0 for UBSan, which recovers, 1 with -fno-sanitize-recover). A clean program,
// with exceptions, containers and stdin, reports nothing. A run without a
// sanitizer fetches none of their files. SHOW=1 prints every run's output.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(HERE, '../../app/static');
const OUT = path.join(STATIC, 'packs/cpp');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TARGETS = JSON.parse(fs.readFileSync(path.join(HERE, 'src/targets.json'), 'utf8'));
const LINUX = TARGETS.filter((t) => t.runtime === 'linux' && process.argv.slice(2).includes(t.arch));

const missing = ['runner.js', 'sanitizer.js', 'cc.wasm', 'asan.tar', 'ubsan.tar', ...LINUX.flatMap((t) => [`targets/${t.arch}/asan.tar`, `vm/${t.arch}/kernel`])]
    .filter((f) => !fs.existsSync(path.join(OUT, f)));
if (missing.length) {
    console.log(`# test-sanitizers: not built yet: ${missing.join(', ')} (build.sh)`);
    process.exit(process.env.ALLOW_SKIP ? 0 : 1);
}

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
const requested = [];
const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requested.push(url);
    if (url === '/__test.html') return res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION }).end('<!doctype html><title>t</title>');
    const file = path.normalize(path.join(STATIC, url));
    try {
        if (!file.startsWith(STATIC) || !fs.statSync(file).isFile()) throw new Error();
        const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600', ...ISOLATION };
        let body;
        if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '') && fs.existsSync(file + '.br')) {
            body = fs.readFileSync(file + '.br');
            headers['content-encoding'] = 'br';
        } else body = fs.readFileSync(file);
        res.writeHead(200, headers).end(body);
    } catch {
        res.writeHead(404).end();
    }
});

let browser, page;
before(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    browser = await chromium.launch({ executablePath: CHROMIUM });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/__test.html`);
    await page.evaluate(() => {
        window.runProject = (files, { inputs = [], type = 'run' } = {}) =>
            new Promise((done) => {
                const result = { stdout: '', stderr: '', code: null };
                const sab = new SharedArrayBuffer(8 + 65536);
                const state = new Int32Array(sab, 0, 2);
                const data = new Uint8Array(sab, 8);
                const worker = new Worker('/packs/cpp/runner.js', { type: 'module' });
                worker.onerror = (e) => {
                    result.stderr += `worker error: ${e.message}\n`;
                    done(result);
                };
                worker.onmessage = ({ data: m }) => {
                    if (m.type === 'stdout') result.stdout += m.text;
                    else if (m.type === 'stderr') result.stderr += m.text;
                    else if (m.type === 'stdin') {
                        const line = inputs.shift();
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
                        done(result);
                    }
                };
                worker.postMessage({ type, files, entry: Object.keys(files).find((f) => /^main\./.test(f)), stdin: sab });
            });
    });
});
after(async () => {
    await browser?.close();
    server.close();
});

async function run(files, opts) {
    const result = await page.evaluate(([f, o]) => window.runProject(f, o), [files, opts ?? {}]);
    if (process.env.SHOW) console.log(`# ${JSON.stringify(files['compile_flags.txt'])} ${JSON.stringify(opts?.inputs ?? [])}\n${show(result)}`);
    return result;
}
/** stderr without colours, and the lines of its stack frames ("#0 0x... in f file:1:2"). */
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const frames = (text) => plain(text).split('\n').filter((l) => /^\s+#\d+ 0x/.test(l)).map((l) => l.trim().replace(/^#(\d+) 0x[0-9a-f]+ /, '#$1 '));
const show = (r) => `exit ${r.code}\n--- stdout\n${r.stdout}--- stderr\n${plain(r.stderr)}`;

const flags = (target, ...more) => [...(target.runtime === 'linux' ? [`--target=${target.triple}`] : []), '-std=c++20', '-O1', ...more].join('\n') + '\n';

// Line numbers below are the lines of these sources.
const ASAN = `#include <cstdio>
#include <cstdlib>
#include <cstring>
int g[4];
__attribute__((noinline)) int heap_overflow(int i) { int *a = (int *)malloc(4 * sizeof(int)); a[i] = 1; int r = a[0]; free(a); return r; }
__attribute__((noinline)) int use_after_free(int i) { int *a = new int[4]; delete[] a; return a[i]; }
__attribute__((noinline)) int stack_overflow(int i) { int a[4] = {0}; return a[i]; }
__attribute__((noinline)) int global_overflow(int i) { return g[i]; }
__attribute__((noinline)) void leak() { void *volatile p = malloc(100); p = nullptr; }
static inline __attribute__((always_inline)) int load(int *a, int i) { return a[i]; }
__attribute__((noinline)) int inlined(int i) { int *a = new int[2](); int r = load(a, i); delete[] a; return r; }
int main(int argc, char **) {
  char which[16] = "";
  if (std::scanf("%15s", which) != 1) return 2;
  if (!strcmp(which, "heap")) return heap_overflow(argc + 3);
  if (!strcmp(which, "uaf")) return use_after_free(argc);
  if (!strcmp(which, "stack")) return stack_overflow(argc + 3);
  if (!strcmp(which, "global")) return global_overflow(argc + 3);
  if (!strcmp(which, "double")) { int *volatile p = (int *)malloc(4); free(p); free(p); return 0; }
  if (!strcmp(which, "leak")) { leak(); return 0; }
  if (!strcmp(which, "inline")) return inlined(argc + 1);
  return 3;
}
`;

const UBSAN = `#include <climits>
#include <cstdio>
int add(int a, int b) { return a + b; }
int shift(int a, int b) { return a << b; }
int at(int i) { int a[4] = {1, 2, 3, 4}; return a[i]; }
bool truth(const char *byte) { bool b; __builtin_memcpy(&b, byte, 1); return b; }
int main(int argc, char **) {
  volatile int big = INT_MAX, n = 33, i = 4;
  std::printf("%d\\n", add(big, argc));
  std::printf("%d\\n", shift(argc, n));
  std::printf("%d\\n", at(i));
  std::printf("%d\\n", truth("\\2"));
  std::printf("done\\n");
}
`;

const CLEAN = `#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
struct Shape { virtual ~Shape() = default; virtual double area() const = 0; };
struct Square : Shape { double s; explicit Square(double s) : s(s) {} double area() const override { return s * s; } };
int parse(const std::string &s) { if (s.empty()) throw std::invalid_argument("empty"); return std::stoi(s); }
int main() {
  std::vector<std::unique_ptr<Shape>> shapes;
  for (int i = 1; i <= 100; i++) shapes.push_back(std::make_unique<Square>(i));
  double total = 0;
  for (auto &s : shapes) total += s->area();
  std::map<std::string, int> counts;
  for (const char *w : {"a", "b", "a", "c", "a"}) counts[w]++;
  std::string text;
  for (int i = 0; i < 1000; i++) text += char('a' + i % 26);
  int caught = 0;
  for (int i = 0; i < 50; i++) { try { parse(""); } catch (const std::invalid_argument &) { caught++; } }
  long a, b;
  std::cin >> a >> b;
  std::cout << total << " " << counts["a"] << " " << text.size() << " " << caught << " " << a + b << "\\n";
}
`;

const PLAIN_C = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  char *s = malloc(32);
  strcpy(s, "hello");
  printf("%s %zu\\n", s, strlen(s));
  free(s);
  return 0;
}
`;

// First, while the browser's cache is empty.
test('wasm32-wasip1: a run without a sanitizer fetches none of their files; a run with one fetches its own', async () => {
    requested.length = 0;
    const r = await run({ 'main.c': PLAIN_C, 'compile_flags.txt': '-O1\n' });
    assert.equal(r.code, 0, show(r));
    assert.deepEqual(requested.filter((u) => /asan|ubsan|sanitizer|demangle/.test(u)), []);
    requested.length = 0;
    await run({ 'main.c': PLAIN_C, 'compile_flags.txt': '-fsanitize=undefined\n' });
    assert.deepEqual(requested.filter((u) => /asan|ubsan|sanitizer|demangle/.test(u)).sort(), ['/packs/cpp/sanitizer.js', '/packs/cpp/ubsan.tar']);
});

for (const target of [TARGETS.find((t) => t.runtime !== 'linux'), ...LINUX]) {
    const linux = target.runtime === 'linux';
    const where = linux ? target.arch : 'wasm32-wasip1';
    // A Linux run boots a guest: allow for it.
    const timeout = linux ? 600_000 : 120_000;
    const asan = (which) => run({ 'main.cpp': ASAN, 'compile_flags.txt': flags(target, '-fsanitize=address') }, { inputs: [which] });

    test(`${where}: a heap buffer overflow is reported by AddressSanitizer with its frames, and the program exits 1`, { timeout }, async () => {
        const r = await asan('heap');
        const err = plain(r.stderr);
        assert.equal(r.code, 1, show(r));
        assert.match(err, /==\d+==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x[0-9a-f]+ at pc 0x[0-9a-f]+/, show(r));
        assert.match(err, /WRITE of size 4 at 0x[0-9a-f]+ thread T0/, show(r));
        const f = frames(r.stderr);
        assert.equal(f[0], '#0 in heap_overflow(int) main.cpp:5:100', show(r));
        assert.match(f[1], /^#1 in main main\.cpp:15:/, show(r));
        assert.match(err, /0x[0-9a-f]+ is located 0 bytes after 16-byte region/, show(r));
        // The interceptor's name: Alpine's runtime has two symbols at its
        // address and llvm-symbolizer takes __interceptor_malloc; the wasm
        // name section has one, malloc.
        assert.match(err, /allocated by thread T0 here:\n\s+#0 0x[0-9a-f]+ in (__interceptor_)?malloc/, show(r));
        assert.match(err, /\n\s+#1 0x[0-9a-f]+ in heap_overflow\(int\) main\.cpp:5:70\n/, show(r));
        assert.match(err, /SUMMARY: AddressSanitizer: heap-buffer-overflow main\.cpp:5:100 in heap_overflow\(int\)/, show(r));
        assert.match(err, /Shadow bytes around the buggy address:/, show(r));
    });

    test(`${where}: a use after free names where the memory was freed and allocated`, { timeout }, async () => {
        const r = await asan('uaf');
        const err = plain(r.stderr);
        assert.equal(r.code, 1, show(r));
        assert.match(err, /ERROR: AddressSanitizer: heap-use-after-free/, show(r));
        assert.equal(frames(r.stderr)[0], '#0 in use_after_free(int) main.cpp:6:95', show(r));
        assert.match(err, /freed by thread T0 here:\n\s+#0 0x[0-9a-f]+ in operator delete\[\]\(void\*\)/, show(r));
        // size_t: unsigned long on wasm32 and on the 64-bit Linux targets.
        assert.match(err, /previously allocated by thread T0 here:\n\s+#0 0x[0-9a-f]+ in operator new\[\]\(unsigned long\)/, show(r));
    });

    test(`${where}: a stack buffer overflow names the array in its frame`, { timeout }, async () => {
        const r = await asan('stack');
        const err = plain(r.stderr);
        assert.equal(r.code, 1, show(r));
        assert.match(err, /ERROR: AddressSanitizer: stack-buffer-overflow/, show(r));
        assert.equal(frames(r.stderr)[0], '#0 in stack_overflow(int) main.cpp:7:78', show(r));
        assert.match(err, /is located in stack of thread T0 at offset \d+ in frame\n\s+#0 0x[0-9a-f]+ in stack_overflow\(int\) main\.cpp:7\b/, show(r));
        assert.match(err, /This frame has 1 object\(s\):\n\s+\[\d+, \d+\) 'a' \(line 7\) <== Memory access at offset \d+ overflows this variable/, show(r));
    });

    test(`${where}: a global buffer overflow names the global`, { timeout }, async () => {
        const r = await asan('global');
        const err = plain(r.stderr);
        assert.equal(r.code, 1, show(r));
        assert.match(err, /ERROR: AddressSanitizer: global-buffer-overflow/, show(r));
        assert.equal(frames(r.stderr)[0], '#0 in global_overflow(int) main.cpp:8:63', show(r));
        assert.match(err, /is located 0 bytes after global variable 'g' defined in 'main\.cpp' \(0x[0-9a-f]+\) of size 16/, show(r));
    });

    test(`${where}: a double free is reported`, { timeout }, async () => {
        const r = await asan('double');
        assert.equal(r.code, 1, show(r));
        assert.match(plain(r.stderr), /ERROR: AddressSanitizer: attempting double-free on 0x[0-9a-f]+ in thread T0/, show(r));
    });

    test(`${where}: a leak is reported by LeakSanitizer at exit, and the program exits 1`, { timeout }, async () => {
        const r = await asan('leak');
        const err = plain(r.stderr);
        assert.equal(r.code, 1, show(r));
        assert.match(err, /ERROR: LeakSanitizer: detected memory leaks/, show(r));
        assert.match(err, /Direct leak of 100 byte\(s\) in 1 object\(s\) allocated from:\n\s+#0 0x[0-9a-f]+ in (__interceptor_)?malloc/, show(r));
        assert.match(err, /\n\s+#1 0x[0-9a-f]+ in leak\(\) main\.cpp:9:60\n/, show(r));
        assert.match(err, /SUMMARY: AddressSanitizer: 100 byte\(s\) leaked in 1 allocation\(s\)\./, show(r));
    });

    test(`${where}: an inlined function is a frame of its own, as llvm-symbolizer prints it`, { timeout }, async () => {
        const r = await asan('inline');
        assert.equal(r.code, 1, show(r));
        const f = frames(r.stderr);
        assert.equal(f[0], '#0 in load main.cpp:10:79', show(r));
        assert.equal(f[1], '#1 in inlined(int) main.cpp:11:79', show(r));
        assert.equal(f[2], '#2 in main main.cpp:21:40', show(r));
        // Both frames of the inlined code are at the same address.
        const pcs = plain(r.stderr).split('\n').filter((l) => /^\s+#[01] 0x/.test(l)).map((l) => l.trim().split(' ')[1]);
        assert.equal(pcs[0], pcs[1], show(r));
    });

    test(`${where}: undefined behaviour is reported where it happens and the program goes on, exit 0`, { timeout }, async () => {
        const r = await run({ 'main.cpp': UBSAN, 'compile_flags.txt': flags(target, '-fsanitize=undefined') });
        const err = plain(r.stderr);
        assert.equal(r.code, 0, show(r));
        assert.match(r.stdout, /done\n$/, show(r));
        assert.match(err, /main\.cpp:3:34: runtime error: signed integer overflow: 2147483647 \+ 1 cannot be represented in type 'int'/, show(r));
        assert.match(err, /main\.cpp:4:36: runtime error: shift exponent 33 is too large for 32-bit type 'int'/, show(r));
        assert.match(err, /main\.cpp:5:49: runtime error: index 4 out of bounds for type 'int\[4\]'/, show(r));
        assert.match(err, /main\.cpp:6:\d+: runtime error: load of value 2, which is not a valid value for type 'bool'/, show(r));
        // One SUMMARY line per report, as natively.
        assert.equal(err.match(/^SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior main\.cpp:\d+:\d+ $/gm)?.length, 4, show(r));
    });

    test(`${where}: with -fno-sanitize-recover the first undefined behaviour stops the program, exit 1`, { timeout }, async () => {
        const r = await run({ 'main.cpp': UBSAN, 'compile_flags.txt': flags(target, '-fsanitize=undefined', '-fno-sanitize-recover=undefined') });
        assert.equal(r.code, 1, show(r));
        assert.equal(r.stdout, '', show(r));
        assert.match(plain(r.stderr), /main\.cpp:3:34: runtime error: signed integer overflow/, show(r));
        assert.doesNotMatch(plain(r.stderr), /shift exponent/, show(r));
    });

    test(`${where}: print_stacktrace=1 (__ubsan_default_options) adds the stack, symbolized`, { timeout }, async () => {
        const r = await run({
            'main.cpp': UBSAN.replace('int main(int argc, char **) {', 'extern "C" const char *__ubsan_default_options() { return "print_stacktrace=1"; }\nint main(int argc, char **) {'),
            'compile_flags.txt': flags(target, '-fsanitize=undefined'),
        });
        assert.equal(r.code, 0, show(r));
        // add() is inlined into main: two frames at one address, the
        // inlined one named as DWARF names it, as llvm-symbolizer does.
        assert.match(plain(r.stderr), /runtime error: signed integer overflow[^\n]*\n\s+#0 0x[0-9a-f]+ in add main\.cpp:3:34\n\s+#1 0x[0-9a-f]+ in main main\.cpp:10:23\n/, show(r));
    });

    test(`${where}: a clean program with exceptions, containers and stdin reports nothing under both sanitizers`, { timeout }, async () => {
        const r = await run({ 'main.cpp': CLEAN, 'compile_flags.txt': flags(target, '-fsanitize=address,undefined') }, { inputs: ['2 3'] });
        assert.equal(r.code, 0, show(r));
        assert.equal(r.stdout, '338350 3 1000 50 5\n', show(r));
        assert.equal(plain(r.stderr), '', show(r));
    });

    test(`${where}: a clean C program reports nothing under AddressSanitizer`, { timeout }, async () => {
        const r = await run({ 'main.c': PLAIN_C, 'compile_flags.txt': flags(target, '-fsanitize=address').replace('-std=c++20\n', '') });
        assert.equal(r.code, 0, show(r));
        assert.equal(r.stdout, 'hello 5\n', show(r));
        assert.equal(plain(r.stderr), '', show(r));
    });
}

test('wasm32-wasip1: the minimal UBSan runtime prints its one line per check', async () => {
    const r = await run({ 'main.cpp': UBSAN, 'compile_flags.txt': flags({}, '-fsanitize=undefined', '-fsanitize-minimal-runtime') });
    assert.equal(r.code, 0, show(r));
    assert.match(plain(r.stderr), /^ubsan: add-overflow by 0x[0-9a-f]+$/m, show(r));
});

test('wasm32-wasip1: an uncaught exception under AddressSanitizer still ends in terminate, exit 134', async () => {
    const r = await run({
        'main.cpp': '#include <vector>\nint main() { std::vector<int> v; return v.at(3); }\n',
        'compile_flags.txt': flags({}, '-fsanitize=address'),
    });
    assert.equal(r.code, 134, show(r));
    assert.match(plain(r.stderr), /terminating due to uncaught exception of type std::out_of_range: vector/, show(r));
});

test('wasm32-wasip1: a main without parameters is named main in a frame, as natively, not __original_main', async () => {
    const r = await run({
        'main.cpp': '#include <cstdlib>\nint main() {\n  int *volatile a = (int *)malloc(8);\n  return a[2];\n}\n',
        'compile_flags.txt': flags({}, '-fsanitize=address'),
    });
    assert.equal(r.code, 1, show(r));
    assert.equal(frames(r.stderr)[0], '#0 in main main.cpp:4:10', show(r));
});
