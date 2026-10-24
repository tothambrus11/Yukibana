// Headless test of the C/C++ pack's Linux VM runtime: app/static/packs/cpp/vm.js
// (src/vm/*.js, staged by vm/stage.sh) and the QEMU-Wasm builds next to it, run the
// way the runner runs them. app/static is served over http WITH
// Cross-Origin-Opener-Policy / -Embedder-Policy (QEMU's threads need
// SharedArrayBuffer); a test-only module worker imports /packs/cpp/vm.js and calls
// runLinux on fixture programs (vm/fixtures/*.c, built here with the host's clang-18
// and the musl sysroots through vm/cc.sh), and the page plays the app's part of the
// stdin protocol.
//
//   node test-vm.mjs [arch...]      (after build-vm.sh; needs playwright-core, clang-18)
//   VM_ARCHES=aarch64 node --test test-vm.mjs     (the same, under node --test)
//
// Per architecture, system emulation: arguments and environment, a prompt without
// a newline and two lines of stdin then end of file (exit 3), SIGSEGV -> 139,
// abort() -> 134, 4 threads on 4 vCPUs with exact counts, strace's trace, the CPU an
// idle VM costs while the program waits for input, and Stop (terminating the worker
// leaves no QEMU worker behind). User emulation, where user/<arch> is staged: hello,
// stdin, threads, and the documented difference for a null dereference. Timings
// (boot, first output, a CPU benchmark against this machine) are printed at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(HERE, '../../app/static');
const OUT = path.join(STATIC, 'packs/cpp');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const ALL = ['x86_64', 'aarch64', 'riscv64'];
const asked = [...process.argv.slice(2), ...(process.env.VM_ARCHES ?? '').split(/[ ,]/)].filter((a) => ALL.includes(a));
const ARCHES = (asked.length ? asked : ALL).filter((a) => fs.existsSync(path.join(OUT, `vm/${a}/kernel`)));
const USER = ARCHES.filter((a) => fs.existsSync(path.join(OUT, `user/${a}/qemu-${a}.wasm`)));
const MACHINE = { x86_64: 'x86_64', aarch64: 'aarch64', riscv64: 'riscv64' };
const timings = [];

// ---- fixtures: vm/fixtures/*.c per architecture, static musl ELFs
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'yk-vm-fixtures-'));
const FIXTURES = ['hello', 'stdin', 'crash', 'abort', 'threads', 'bench'];
for (const arch of ARCHES)
    for (const name of FIXTURES)
        execFileSync(path.join(HERE, 'vm/cc.sh'), [arch, '-O2', '-std=gnu11', '-Wall', '-Wextra', '-Werror', '-o', path.join(FIX, `${name}-${arch}`), path.join(HERE, `vm/fixtures/${name}.c`)]);

// ---- the server: app/static plus the test page, worker and fixtures
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
const WORKER = `import { runLinux } from '/packs/cpp/vm.js';
onmessage = async ({ data }) => {
    const code = await runLinux({ ...data, post: (m) => postMessage(m), base: new URL('/packs/cpp/', location.href).href });
    postMessage({ type: 'exit', code });
};`;
// window.runVM(cfg): runs fixture cfg.prog on cfg.arch and resolves with everything the
// worker sent. Stdin: answers each request with the next of cfg.input (only once stdout
// contains cfg.waitFor, if given), then end of file if cfg.eof, then nothing.
const PAGE = `<!doctype html><link rel=icon href="data:,"><title>vm test</title><script type=module>
window.runVM = async (cfg) => {
    const program = new Uint8Array(await (await fetch('/__fixtures/' + cfg.prog + '-' + cfg.arch)).arrayBuffer());
    const sab = new SharedArrayBuffer(8 + 65536);
    const state = new Int32Array(sab, 0, 2);
    const lines = [...(cfg.input ?? [])];
    const r = window.__run = { stdout: '', stderr: '', kernel: '', trace: '', marks: {}, code: null, stdinRequests: 0,
        loading: {}, phases: [], stdoutAtFirstAnswer: null };
    let pending = false, sentEof = false;
    const answer = () => {
        if (!pending || (cfg.waitFor && !r.stdout.includes(cfg.waitFor))) return;
        const line = lines.shift();
        if (line === undefined) {
            if (cfg.eof && !sentEof) { sentEof = true; pending = false; Atomics.store(state, 0, 3); Atomics.notify(state, 0); }
            return;
        }
        if (r.stdoutAtFirstAnswer === null) r.stdoutAtFirstAnswer = r.stdout;
        const bytes = new TextEncoder().encode(line);
        new Uint8Array(sab, 8).set(bytes);
        Atomics.store(state, 1, bytes.length);
        pending = false;
        Atomics.store(state, 0, 2);
        Atomics.notify(state, 0);
    };
    const w = window.__worker = new Worker('/__vm-worker.js', { type: 'module' });
    return new Promise((resolve) => {
        const timer = setTimeout(() => { w.terminate(); r.code = 'timeout'; resolve(r); }, (cfg.timeout ?? 120) * 1000);
        w.onerror = (e) => { r.stderr += '[worker error] ' + e.message + '\\n'; };
        w.onmessage = ({ data: m }) => {
            if (m.type === 'stdout' || m.type === 'stderr' || m.type === 'kernel' || m.type === 'trace') { r[m.type] += m.text; answer(); }
            else if (m.type === 'mark') r.marks[m.name] = m.guestMs !== undefined ? { ms: m.ms, guestMs: m.guestMs } : m.ms;
            else if (m.type === 'loading') r.loading[m.label] = { loaded: m.loaded, total: m.total };
            else if (m.type === 'phase') r.phases.push(m.text);
            else if (m.type === 'stdin') { r.stdinRequests++; pending = true; answer(); }
            else if (m.type === 'exit') { clearTimeout(timer); r.code = m.code; if (!cfg.keep) w.terminate(); resolve(r); }
        };
        w.postMessage({ arch: cfg.arch, program, args: cfg.args ?? [], env: cfg.env ?? {}, options: cfg.options ?? {}, stdin: sab });
    });
};
</script>`;
const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const send = (type, body, extra = {}) => res.writeHead(200, { 'content-type': type, ...ISOLATION, ...extra }).end(body);
    if (url === '/__vm-test.html') return send('text/html', PAGE);
    if (url === '/__vm-worker.js') return send('text/javascript', WORKER);
    if (url.startsWith('/__fixtures/')) return send('application/octet-stream', fs.readFileSync(path.join(FIX, path.basename(url))));
    const file = path.normalize(path.join(STATIC, url));
    try {
        if (!file.startsWith(STATIC) || !fs.statSync(file).isFile()) throw new Error('not a file');
        const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600', ...ISOLATION };
        let body;
        if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '') && fs.existsSync(file + '.br')) {
            body = fs.readFileSync(file + '.br');
            headers['content-encoding'] = 'br';
        }
        body ??= fs.readFileSync(file);
        res.writeHead(200, { ...headers, 'content-length': body.length }).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- the browser (marked, so its processes can be told from other browsers here)
const MARK = `--yk-vm-test-${process.pid}`;
let browser, page, cdp;
before(async () => {
    browser = await chromium.launch({ executablePath: CHROMIUM, args: [MARK] });
    page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`${origin}/__vm-test.html`);
    cdp = await browser.newBrowserCDPSession();
});
after(async () => {
    await browser?.close();
    server.close();
    fs.rmSync(FIX, { recursive: true, force: true });
    if (timings.length) {
        console.log('\ntimings (ms since the worker started; boot = guest uptime when init ran the program)');
        for (const t of timings) console.log(JSON.stringify(t));
    }
});

const run = (cfg) => page.evaluate((c) => window.runVM(c), cfg);

/** The pids of this test's browser: the marked process and its descendants. */
function browserPids() {
    const parent = new Map();
    for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
            parent.set(d, fs.readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
        } catch {}
    }
    const mine = new Set();
    for (const d of parent.keys()) {
        try {
            if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(MARK)) mine.add(d);
        } catch {}
    }
    for (let grew = true; grew;) {
        grew = false;
        for (const [p, pp] of parent) if (!mine.has(p) && mine.has(pp)) { mine.add(p); grew = true; }
    }
    return mine;
}

/** CPU seconds used so far by this test's browser (the marked process and its descendants). */
function browserCpuSeconds() {
    const tick = Number(execFileSync('getconf', ['CLK_TCK']).toString());
    let cpu = 0;
    for (const p of browserPids()) {
        try {
            const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ');
            cpu += (Number(st[11]) + Number(st[12])) / tick;
        } catch {}
    }
    return cpu;
}

const workerTargets = async () => (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'worker' || t.type === 'shared_worker');
/**
 * The browser's CPU seconds in successive 3 s windows, until one is under 0.3 s or four
 * have passed. On a loaded machine (other builds running) a guest that has fallen behind
 * catches up on its timers for a few seconds after the prompt; the steady state is what
 * is asserted, and every window is reported.
 */
/**
 * Resident memory, in MiB, of this test's browser processes (the marked process and its
 * descendants): Pss where the kernel reports it (shared memory counted once across
 * processes), otherwise Rss.
 */
function browserMemoryMiB() {
    let kb = 0;
    for (const p of browserPids()) {
        try {
            const r = fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8');
            kb += Number((/^Pss:\s+(\d+)/m.exec(r) ?? /^Rss:\s+(\d+)/m.exec(r))[1]);
        } catch {}
    }
    return Math.round(kb / 1024);
}

async function idleCpu() {
    const windows = [];
    do {
        const a = browserCpuSeconds();
        await sleep(3000);
        windows.push(+(browserCpuSeconds() - a).toFixed(3));
    } while (windows.at(-1) >= 0.3 && windows.length < 4);
    return windows;
}
// Lets earlier runs' terminated workers go before a memory baseline is taken.
const stopSettleMs = 5000;
const workerIds = async () => new Set((await workerTargets()).map((t) => t.targetId));

/**
 * Terminates the current run's worker (what the app's Stop does) and waits until none of
 * the workers started since `before` (the runner worker and QEMU's threads) is left.
 * Chromium tears a terminated worker down asynchronously, and a user-mode QEMU's took up
 * to a few seconds here, so earlier runs' workers may still be listed: only this run's
 * count. Resolves with the milliseconds that took; fails after 20 s.
 */
async function stop(before) {
    const t0 = Date.now();
    await page.evaluate(() => window.__worker.terminate());
    let left;
    while ((left = (await workerTargets()).filter((t) => !before.has(t.targetId))).length && Date.now() - t0 < 20000) await sleep(100);
    assert.deepEqual(left.map((t) => t.url), [], 'no worker is left after terminate');
    return Date.now() - t0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const arch of ARCHES) {
    test(`${arch}: a program gets its arguments, environment and a terminal, and exits 0`, async () => {
        const r = await run({ arch, prog: 'hello', args: ['two words', 'ü'] });
        assert.equal(r.code, 0, r.stderr + r.kernel);
        assert.equal(r.stdout, `hello from ${MACHINE[arch]} 6.12.114, argv[0]=main, isatty(0)=1 isatty(1)=1 isatty(2)=1, HOME=/, argc=3 [two words] [ü]\n`);
        assert.equal(r.stderr, '');
        assert.deepEqual(r.phases, [`Starting Linux (${arch})`, 'Running']);
        // exec and the first stdout come over different virtqueues, in either order.
        assert.ok(r.marks['vm-loaded'] < Math.min(r.marks.exec.ms, r.marks['first-stdout']) && Math.max(r.marks.exec.ms, r.marks['first-stdout']) <= r.marks.exit, JSON.stringify(r.marks));
        // Progress totals are the decoded sizes, though the server sends brotli.
        const k = r.loading[`vm/${arch}/kernel`];
        assert.ok(k && k.loaded === k.total && k.total === fs.statSync(path.join(OUT, `vm/${arch}/kernel`)).size, JSON.stringify(r.loading));
        assert.ok(!Object.keys(r.loading).some((l) => l.includes('strace')), 'strace.cpio is fetched only when tracing');
        timings.push({ arch, mode: 'system', case: 'hello', exec: r.marks.exec.ms, bootGuestMs: r.marks.exec.guestMs, firstStdout: r.marks['first-stdout'], exit: r.marks.exit });
    });

    test(`${arch}: a prompt without a newline shows before input; two lines, then end of file; exit 3`, async () => {
        const r = await run({ arch, prog: 'stdin', input: ['Ada\n', 'Lovelace\n'], eof: true, waitFor: 'name? ' });
        assert.equal(r.code, 3, r.stderr + r.kernel);
        assert.equal(r.stdoutAtFirstAnswer, 'name? ');
        assert.equal(r.stdout, 'name? got: Ada\ngot: Lovelace\neof after 2 lines\n');
        assert.equal(r.stderr, 'this is stderr\n', 'stderr is its own channel, without kernel messages');
    });

    test(`${arch}: a null dereference is SIGSEGV, exit 139, after the program's output`, async () => {
        const r = await run({ arch, prog: 'crash' });
        assert.equal(r.code, 139, r.stderr + r.kernel);
        assert.equal(r.stdout, 'about to crash\n');
        assert.match(r.stderr, /Terminated by signal 11 \(SIGSEGV\)/);
    });

    test(`${arch}: abort() is SIGABRT, exit 134`, async () => {
        const r = await run({ arch, prog: 'abort' });
        assert.equal(r.code, 134, r.stderr + r.kernel);
        assert.equal(r.stdout, 'about to abort\n');
        assert.match(r.stderr, /Terminated by signal 6 \(SIGABRT\)/);
    });

    test(`${arch}: four threads on four vCPUs share memory correctly`, async () => {
        const r = await run({ arch, prog: 'threads', options: { cpus: 4 } });
        assert.equal(r.code, 0, r.stderr + r.kernel);
        assert.match(r.stdout, /^online CPUs 4\n/);
        assert.match(r.stdout, /atomic=8000000 mutex=7816\n/);
        timings.push({ arch, mode: 'system', case: 'threads cpus=4', stdout: r.stdout.trim().split('\n').slice(1).join(' | ') });
    });

    test(`${arch}: with strace on, the trace arrives on its own channel and the output is unchanged`, async () => {
        const r = await run({ arch, prog: 'hello', options: { strace: true } });
        assert.equal(r.code, 0, r.stderr + r.kernel);
        assert.match(r.stdout, /^hello from .* argv\[0\]=main, .*argc=1\n$/);
        assert.match(r.trace, /execve\("\/yk\/prog", \["main"\]/);
        assert.match(r.trace, /exit_group\(0\)/);
        assert.ok(r.loading[`vm/${arch}/strace.cpio`], 'strace.cpio was fetched');
    });

    test(`${arch}: the CPU benchmark (LCG, 1e8 iterations, one thread)`, async () => {
        const r = await run({ arch, prog: 'bench', args: ['100000000', '1'] });
        assert.equal(r.code, 0, r.stderr + r.kernel);
        const m = /Miter\/s=([\d.]+)/.exec(r.stdout);
        assert.ok(m, r.stdout);
        const native = execFileSync(path.join(FIX, 'bench-x86_64'), ['100000000', '1']).toString();
        timings.push({ arch, mode: 'system', case: 'bench', guestMiterPerS: Number(m[1]), hostNativeMiterPerS: Number(/Miter\/s=([\d.]+)/.exec(native)[1]) });
    });

    test(`${arch}: a program waiting for input costs the browser almost no CPU, and Stop ends every QEMU thread`, async () => {
        const before = await workerIds();
        await sleep(stopSettleMs);
        const memBefore = browserMemoryMiB();
        // Never resolves (the worker is terminated below), so its rejection at browser close is expected.
        page.evaluate((c) => window.runVM(c), { arch, prog: 'stdin', options: { cpus: 2 }, keep: true, timeout: 120 }).catch(() => {});
        await page.waitForFunction(() => window.__run?.stdout.includes('name? '), null, { timeout: 120000 });
        assert.ok((await workerTargets()).length >= 2, 'the runner worker and QEMU workers are running');
        await sleep(2000);
        const idle = await idleCpu();
        timings.push({ arch, mode: 'system', case: 'idle on stdin, cpus=2', cpuSecondsPer3s: idle, browserMiB: browserMemoryMiB(), browserMiBBefore: memBefore });
        assert.ok(idle.at(-1) < 0.3, `idle VM used ${idle.join(', ')} s of CPU in successive 3 s windows`);
        const ms = await stop(before);
        timings.push({ arch, mode: 'system', case: 'Stop', msUntilNoWorkerLeft: ms });
    });
}

for (const arch of USER) {
    test(`${arch} user mode: hello, with arguments and a terminal`, async () => {
        const r = await run({ arch, prog: 'hello', args: ['two words', 'ü'], options: { emulation: 'user' } });
        assert.equal(r.code, 0, r.stderr + r.kernel);
        assert.match(r.stdout, new RegExp(`^hello from ${MACHINE[arch]} \\S+, argv\\[0\\]=main, isatty\\(0\\)=1 isatty\\(1\\)=1 isatty\\(2\\)=1, HOME=/, argc=3 \\[two words\\] \\[ü\\]\\n$`));
        assert.deepEqual(r.phases, [`Starting QEMU (${arch}, user mode)`, 'Running']);
        timings.push({ arch, mode: 'user', case: 'hello', exec: r.marks.exec, firstStdout: r.marks['first-stdout'], exit: r.marks.exit, uname: r.stdout.split(' ')[3] });
    });

    test(`${arch} user mode: a prompt, two lines of stdin and end of file`, async () => {
        const r = await run({ arch, prog: 'stdin', input: ['Ada\n', 'Lovelace\n'], eof: true, waitFor: 'name? ', options: { emulation: 'user' } });
        assert.equal(r.code, 3, r.stderr + r.kernel);
        assert.equal(r.stdoutAtFirstAnswer, 'name? ');
        assert.equal(r.stdout, 'name? got: Ada\ngot: Lovelace\neof after 2 lines\n');
        assert.equal(r.stderr, 'this is stderr\n');
    });

    test(`${arch} user mode: four threads (on one CPU) share memory correctly`, async () => {
        const r = await run({ arch, prog: 'threads', options: { emulation: 'user', cpus: 4 } });
        assert.equal(r.code, 0, r.stderr + r.kernel);
        assert.match(r.stdout, /^online CPUs 1\n/, 'user mode reports one CPU (documented)');
        assert.match(r.stdout, /atomic=8000000 mutex=7816\n/);
        timings.push({ arch, mode: 'user', case: 'threads', stdout: r.stdout.trim().split('\n').slice(1).join(' | ') });
    });

    test(`${arch} user mode: abort() is SIGABRT, exit 134`, async () => {
        const r = await run({ arch, prog: 'abort', options: { emulation: 'user' } });
        assert.equal(r.code, 134, r.stderr + r.kernel);
        assert.match(r.stderr, /Terminated by signal 6 \(SIGABRT\)/);
    });

    test(`${arch} user mode: a null dereference is NOT caught (documented: no page protection)`, async () => {
        const r = await run({ arch, prog: 'crash', options: { emulation: 'user' } });
        console.log(`# ${arch} user mode null dereference: exit ${r.code}, stdout ${JSON.stringify(r.stdout)} (system mode: 139, SIGSEGV)`);
        assert.equal(r.code, 0);
        assert.equal(r.stdout, 'about to crash\n');
    });

    test(`${arch} user mode: the CPU benchmark, and Stop ends every QEMU thread`, async () => {
        const r = await run({ arch, prog: 'bench', args: ['100000000', '1'], options: { emulation: 'user' } });
        assert.equal(r.code, 0, r.stderr + r.kernel);
        timings.push({ arch, mode: 'user', case: 'bench', guestMiterPerS: Number(/Miter\/s=([\d.]+)/.exec(r.stdout)?.[1]) });
        const before = await workerIds();
        await sleep(stopSettleMs);
        const memBefore = browserMemoryMiB();
        page.evaluate((c) => window.runVM(c), { arch, prog: 'stdin', options: { emulation: 'user' }, keep: true }).catch(() => {});
        await page.waitForFunction(() => window.__run?.stdout.includes('name? '), null, { timeout: 60000 });
        await sleep(1000);
        const idle = await idleCpu();
        timings.push({ arch, mode: 'user', case: 'idle on stdin', cpuSecondsPer3s: idle, browserMiB: browserMemoryMiB(), browserMiBBefore: memBefore });
        assert.ok(idle.at(-1) < 0.3, `idle QEMU used ${idle.join(', ')} s of CPU in successive 3 s windows`);
        timings.push({ arch, mode: 'user', case: 'Stop', msUntilNoWorkerLeft: await stop(before) });
    });
}
