// The C++ targets end to end, in the built app, measured: for each target
// (WebAssembly and the three Linux targets under QEMU-Wasm) a fresh browser
// session builds and runs a hello world and a pthreads program, checks what
// the terminal shows and the exit status, opens and closes the LLVM IR and
// assembly views and checks what they show, and records every request the
// page and its workers make, with the bytes the server actually sent for it
// (the precompressed .br or .gz sibling serve.py chose) and the run's timing
// marks. A WebAssembly session must download exactly what it did before the
// targets existed.
//
//   npm run build && node tests/e2e-targets.mjs [target ...] [--json out.json]
//
// Targets are the ids of cpp-targets.ts (wasm32-wasi, x86_64-linux,
// aarch64-linux, riscv64-linux); all four by default. Serves app/build with
// ../serve.py on a free port, with service workers blocked so every byte is
// a network byte. Exits non-zero naming every check that failed.
import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, '..', 'build');

/** Per target: its picker value, the macro its compiler defines, and what its assembly must show. */
const TARGETS = {
	// WASI's crt calls __original_main, which clang names a main() without arguments.
	'wasm32-wasi': { arch: 'wasm32', triple: 'wasm32-unknown-wasip1', main: '__original_main', asm: (t) => t.includes('end_function') },
	'x86_64-linux': { arch: 'x86_64', triple: 'x86_64-unknown-linux-musl', asm: (t) => /^\s+(retq?|pushq)\b/m.test(t) && t.includes('%r') },
	'aarch64-linux': { arch: 'aarch64', triple: 'aarch64-unknown-linux-musl', asm: (t) => /^\s+ret\b/m.test(t) && /\b(x29|x30|sp)\b/.test(t) },
	'riscv64-linux': { arch: 'riscv64', triple: 'riscv64-unknown-linux-musl', asm: (t) => /^\s+ret\b/m.test(t) && /\b(sp|ra|a0)\b/.test(t) },
};

/** Prints which architecture it was compiled for and exits 0. */
const HELLO = `#include <cstdio>

int main() {
#if defined(__x86_64__)
    const char *arch = "x86_64";
#elif defined(__aarch64__)
    const char *arch = "aarch64";
#elif defined(__riscv) && __riscv_xlen == 64
    const char *arch = "riscv64";
#elif defined(__wasm32__)
    const char *arch = "wasm32";
#else
    const char *arch = "unknown";
#endif
    std::printf("hello, world from %s (sizeof(long)=%zu)\\n", arch, sizeof(long));
    return 0;
}
`;

/** Four POSIX threads, each adding 250000 to an atomic and, under a mutex, to a plain counter; exits 5 so the status is checked too. */
const PTHREADS = `#include <atomic>
#include <cstdio>
#include <cstring>
#include <pthread.h>

static std::atomic<long> counted{0};
static long locked = 0;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;

static void *work(void *arg) {
    static_cast<void>(arg);
    for (int i = 0; i < 250000; ++i) {
        counted.fetch_add(1, std::memory_order_relaxed);
        pthread_mutex_lock(&mu);
        ++locked;
        pthread_mutex_unlock(&mu);
    }
    return nullptr;
}

int main(void) {
    pthread_t threads[4];
    for (int t = 0; t < 4; ++t)
        if (const int rc = pthread_create(&threads[t], nullptr, work, nullptr); rc != 0) {
            std::printf("pthread_create failed: %s\\n", std::strerror(rc));
            return 2;
        }
    for (int t = 0; t < 4; ++t) pthread_join(threads[t], nullptr);
    std::printf("threads=4 atomic=%ld mutex=%ld\\n", counted.load(), locked);
    return 5;
}
`;

/** Says it is ready, then reads two numbers typed into the terminal after that, and prints their sum. */
const ASK = `#include <iostream>

int main() {
    std::cout << "ready" << std::endl;
    long a = 0, b = 0;
    if (!(std::cin >> a >> b)) return 1;
    std::cout << "sum=" << a + b << std::endl;
    return 0;
}
`;

/** HELLO with a function of its own, kept out of line so the views show it at any -O. */
// Its argument is read from a volatile, or -O2 would fold the call away (IPSCCP sees through noinline).
const WITH_ANSWER = HELLO.replace('return 0;', 'return answer(seed);').replace('int main() {', 'static volatile int seed = 6;\n__attribute__((noinline)) static int answer(int v) { return v * 7 - 42; }\n\nint main() {');

/**
 * What a session on the default target downloaded before the targets
 * existed: editing (clangd) plus Run. Nothing may be added to it.
 */
const WASM_BASELINE = ['cc.js', 'cc.wasm', 'clangd.js', 'clangd.wasm', 'runner.js', 'server.js', 'sysroot.tar.gz', 'wasi-sysroot.tar.gz'];
/** Pack files only a Linux target or a view may fetch. */
const NEW_FILES = ['cc-cross', 'targets/', 'vm.js', 'vm/', 'user/', 'explorer.js', 'demangle', 'runner-linux.js'];

const argv = process.argv.slice(2);
const jsonAt = argv.indexOf('--json');
const jsonOut = jsonAt >= 0 ? argv.splice(jsonAt, 2)[1] : null;
const chosen = argv.length ? argv : Object.keys(TARGETS);
for (const t of chosen) if (!TARGETS[t]) throw new Error(`unknown target ${t}; known: ${Object.keys(TARGETS).join(', ')}`);
if (!existsSync(join(build, 'packs', 'cpp', 'runner.js'))) throw new Error('app/build has no C++ pack: run npm run build after packs/cpp/build.sh');

const failures = [];
const report = { targets: {} };
const check = (where, ok, what) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${where}: ${what}`);
	if (!ok) failures.push(`${where}: ${what}`);
	return ok;
};

const port = await new Promise((resolve) => {
	const s = createServer().listen(0, () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
const server = spawn('python3', [join(here, '..', '..', 'serve.py'), build, '--port', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });

try {
	for (const id of chosen) {
		try {
			report.targets[id] = await session(id);
		} catch (e) {
			check(id, false, `session failed: ${e instanceof Error ? e.stack : e}`);
		}
		// Views first, on a fresh session: what the views alone download.
		try {
			report.targets[id] ??= {};
			report.targets[id].viewsFirst = await viewsFirst(id);
		} catch (e) {
			check(id, false, `views-first session failed: ${e instanceof Error ? e.stack : e}`);
		}
	}
} finally {
	await browser.close();
	server.kill();
}

printSummary();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, '\t'));
if (failures.length) {
	console.error(`\n${failures.length} check(s) failed:\n` + failures.map((f) => `  - ${f}`).join('\n'));
	process.exit(1);
}
console.log(`\nall checks passed for ${chosen.join(', ')}`);

/**
 * A fresh session recording each response: its URL, the encoding the
 * server chose, and the bytes it sent (the size of the file it served).
 */
async function open() {
	const context = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' });
	const page = await context.newPage();
	const responses = [];
	const pending = [];
	context.on('response', (r) => {
		const url = new URL(r.url());
		if (url.port !== String(port)) return;
		const encoding = r.headers()['content-encoding'] ?? null;
		// The bytes the network really carried: a second worker's fetch of a
		// file the browser has cached carries none (its body size is 0).
		const entry = { path: decodeURIComponent(url.pathname), encoding, status: r.status(), network: null };
		responses.push(entry);
		pending.push(
			r.finished().then(() => r.request().sizes()).then(
				(z) => (entry.network = z.responseBodySize),
				() => {},
			),
		);
	});
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	// The runner's timing marks and exit codes, as its worker posts them to
	// the page (the Output panel shows the marks only while it is in front).
	await page.addInitScript(() => {
		const Native = globalThis.Worker;
		globalThis.ykMarks = [];
		globalThis.Worker = class extends Native {
			constructor(...args) {
				super(...args);
				this.addEventListener('message', (e) => {
					const m = e.data;
					if (m && typeof m === 'object' && (m.type === 'mark' || m.type === 'exit')) globalThis.ykMarks.push({ type: m.type, name: m.name, ms: m.ms, code: m.code });
				});
			}
		};
	});
	// `?trace` exposes `monaco` (and logs LSP traffic to the console).
	await page.goto(`http://127.0.0.1:${port}/?trace`);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await page.selectOption('header select', 'cpp');
	await page.locator('footer .state').filter({ hasNotText: /Starting|Downloading|stopped/ }).waitFor({ timeout: 240_000 });
	await page.locator('.explorer .row .name', { hasText: /^main\.cpp$/ }).click();
	return { context, page, responses, errors, settled: () => Promise.all(pending.splice(0)) };
}

/** The bytes of `path` as served with `encoding`, and its br, gz and raw sizes, from app/build. */
function sizes(path, encoding) {
	const file = join(build, path);
	const size = (f) => (existsSync(f) ? statSync(f).size : null);
	const raw = size(file);
	const br = path.endsWith('.gz') ? null : size(file + '.br');
	const gz = path.endsWith('.gz') ? raw : size(file + '.gz');
	const sent = encoding === 'br' ? br : encoding === 'gzip' ? gz : raw;
	return { raw, br, gz, sent };
}

/** The pack files among `responses` (paths under packs/cpp/), each once, with sizes. */
function packFiles(responses) {
	const seen = new Map();
	for (const r of responses) {
		const m = /^\/packs\/cpp\/(.*)$/.exec(r.path);
		if (!m) continue;
		const prior = seen.get(m[1]);
		if (prior) {
			prior.fetches++;
			prior.network += r.network ?? 0;
			continue;
		}
		seen.set(m[1], { file: m[1], encoding: r.encoding, ...sizes(r.path, r.encoding), network: r.network ?? 0, fetches: 1 });
	}
	return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** The app's own files (not packs) among `responses`, each once. */
function appFiles(responses) {
	return [...new Set(responses.map((r) => r.path).filter((p) => p.startsWith('/_app/')))].sort();
}

/** Totals of a list from packFiles, in MB (10^6 bytes). */
function total(files) {
	const sum = (k) => files.reduce((s, f) => s + (f[k] ?? f.raw ?? 0), 0) / 1e6;
	return { count: files.length, networkMB: +sum('network').toFixed(3), sentMB: +sum('sent').toFixed(3), brMB: +sum('br').toFixed(3), gzMB: +sum('gz').toFixed(3), rawMB: +sum('raw').toFixed(3) };
}

/** Replaces a project file's text through its model, as an edit. */
function setText(page, path, text) {
	return page.evaluate(([path, text]) => globalThis.monaco.editor.getModels().find((m) => m.uri.path === `/workspace/${path}`)?.setValue(text), [path, text]);
}

/** The text a compiler output view shows (`llvm-ir` or `asm`). */
function viewText(page, kind) {
	return page.evaluate((kind) => globalThis.monaco?.editor.getModel(globalThis.monaco.Uri.parse(`yukibana-output:/${kind}`))?.getValue() ?? '', kind);
}

/** Waits until `predicate(text)` holds for view `kind`; returns whether it did, the text and the seconds taken. */
async function viewShows(page, kind, predicate, timeout) {
	const t0 = Date.now();
	let text = '';
	while (Date.now() - t0 < timeout) {
		text = await viewText(page, kind);
		if (predicate(text)) return { ok: true, text, seconds: (Date.now() - t0) / 1000 };
		await page.waitForTimeout(200);
	}
	return { ok: false, text, seconds: (Date.now() - t0) / 1000 };
}

/** Chooses `id` in the Target picker and waits until compile_flags.txt says so. */
async function chooseTarget(page, id) {
	await page.locator('header .target select').selectOption(id);
	const triple = id === 'wasm32-wasi' ? null : `--target=${id.replace('-linux', '-linux-musl')}`;
	await page.waitForFunction(
		(triple) => {
			const text = globalThis.monaco.editor.getModels().find((m) => m.uri.path === '/workspace/compile_flags.txt')?.getValue() ?? '';
			return triple ? text.split('\n')[0] === triple : !text.includes('--target');
		},
		triple,
		{ timeout: 10_000 },
	);
}

/** Sets the Run options through the popover (Linux targets only). */
async function runOptions(page, { emulation, cpus, strace }) {
	await page.locator('header .run-options button.toggle').click();
	const pop = page.locator('header .run-options .popover');
	await pop.locator(`input[value="${emulation}"]`).check();
	if (emulation === 'system') await pop.locator('select').selectOption(String(cpus));
	const box = pop.locator('input[type=checkbox]');
	if ((await box.isChecked()) !== strace) await box.click();
	await page.keyboard.press('Escape');
}

/**
 * Runs main.cpp holding `source` and waits for the run to end. Returns the
 * terminal's status and text, the wall time from the click, the timing
 * marks the run wrote to the Output panel, and the files it fetched.
 */
async function run(s, source, timeout = 600_000) {
	const { page, responses } = s;
	await setText(page, 'main.cpp', source);
	await page.evaluate(() => (globalThis.ykMarks.length = 0));
	const from = responses.length;
	const t0 = Date.now();
	await page.locator('header button.run').click();
	const status = page.locator('.terminal .status');
	// The status still shows the previous run's end until this one starts.
	await status.filter({ hasNotText: /Exited|Stopped/ }).waitFor({ timeout: 30_000 }).catch(() => {});
	const done = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout }).then(() => true, () => false);
	const wall = (Date.now() - t0) / 1000;
	const posted = await page.evaluate(() => globalThis.ykMarks.slice());
	await s.settled();
	const marks = {};
	for (const m of posted) if (m.type === 'mark') marks[m.name] = +(m.ms / 1000).toFixed(2);
	const exit = posted.find((m) => m.type === 'exit')?.code ?? null;
	return {
		done,
		status: ((await status.textContent()) ?? '').trim(),
		shown: (await page.locator('.terminal pre').textContent()) ?? '',
		wall: +wall.toFixed(2),
		marks,
		exit,
		fetched: packFiles(responses.slice(from)),
	};
}

/**
 * Runs main.cpp holding `source`, waits until the terminal shows `ready`,
 * notes the status line, then types `line` into the terminal's input and
 * presses Enter, and waits for the run to end. Returns `done`, `marks`,
 * `status`, `shown` and `wall` as `run` does (no `fetched`), and
 * `statusWhileRunning`.
 */
async function typedWhileRunning(s, source, ready, line, timeout = 600_000) {
	const { page } = s;
	await setText(page, 'main.cpp', source);
	await page.evaluate(() => (globalThis.ykMarks.length = 0));
	const t0 = Date.now();
	await page.locator('header button.run').click();
	const status = page.locator('.terminal .status');
	await status.filter({ hasNotText: /Exited|Stopped/ }).waitFor({ timeout: 30_000 }).catch(() => {});
	await page.locator('.terminal pre', { hasText: ready }).waitFor({ timeout });
	// Give a runner that would ask only once the time to have asked and been answered.
	await page.waitForTimeout(1000);
	const statusWhileRunning = ((await status.textContent()) ?? '').trim();
	const input = page.locator('.terminal .input input');
	await input.fill(line);
	await input.press('Enter');
	const done = await status.filter({ hasText: /Exited|Stopped/ }).waitFor({ timeout: 60_000 }).then(() => true, async () => {
		await page.locator('header button.stop').click().catch(() => {});
		return false;
	});
	const posted = await page.evaluate(() => globalThis.ykMarks.slice());
	await s.settled();
	const marks = {};
	for (const m of posted) if (m.type === 'mark') marks[m.name] = +(m.ms / 1000).toFixed(2);
	return {
		done,
		marks,
		status: ((await status.textContent()) ?? '').trim(),
		statusWhileRunning,
		shown: (await page.locator('.terminal pre').textContent()) ?? '',
		wall: +((Date.now() - t0) / 1000).toFixed(2),
	};
}

/** Exit code from the terminal's status line, or null. */
function codeOf(status) {
	const m = /code (\d+)/.exec(status);
	return m ? Number(m[1]) : null;
}

/** One target in one fresh session: hello, pthreads, (user mode, strace,) views. */
async function session(id) {
	const t = TARGETS[id];
	const linux = id !== 'wasm32-wasi';
	const result = { runs: {}, views: {} };
	const s = await open();
	const { page, responses, errors } = s;
	try {
		if (linux) await chooseTarget(page, id);
		await page.waitForTimeout(1500);
		await s.settled();
		const editing = packFiles(responses);
		result.editing = { files: editing, ...total(editing) };

		// Hello world (system mode on Linux).
		const hello = await run(s, HELLO);
		result.runs.hello = hello;
		check(id, hello.done && codeOf(hello.status) === 0 && hello.shown.includes(`hello, world from ${t.arch} (sizeof(long)=${t.arch === 'wasm32' ? 4 : 8})`),
			`hello world prints its architecture and exits 0 (${hello.status}; ${JSON.stringify(hello.shown.trim().slice(-200))})`);

		// pthreads: four threads on four CPUs (Linux), exact counts, exit 5.
		if (linux) await runOptions(page, { emulation: 'system', cpus: 4, strace: false });
		const threads = await run(s, PTHREADS);
		result.runs.pthreads = threads;
		if (linux) {
			check(id, threads.done && codeOf(threads.status) === 5 && threads.shown.includes('threads=4 atomic=1000000 mutex=1000000') && !threads.shown.includes("kernel's log"),
				`4 pthreads on 4 vCPUs count exactly, and the program's status 5 is the exit code with no note about the VM (${threads.status}; ${JSON.stringify(threads.shown.trim().slice(-200))})`);
		} else {
			// wasm32-wasip1 is single-threaded: wasi-libc's pthread_create is a stub that fails, so the program reports it and exits 2.
			check(id, threads.done && codeOf(threads.status) === 2 && threads.shown.includes('pthread_create failed'),
				`pthreads builds on WebAssembly, pthread_create fails at run time (single-threaded WASI) and the program's status 2 is the exit code (${threads.status}; ${JSON.stringify(threads.shown.trim().slice(-300))})`);
		}

		if (linux) {
			// User mode, experimental: hello, then pthreads on its one CPU.
			await runOptions(page, { emulation: 'user', cpus: 1, strace: false });
			const user = await run(s, HELLO);
			result.runs.userHello = user;
			check(id, user.done && codeOf(user.status) === 0 && user.shown.includes(`hello, world from ${t.arch}`), `user mode: hello world exits 0 (${user.status}; ${user.wall} s)`);
			const userThreads = await run(s, PTHREADS);
			result.runs.userPthreads = userThreads;
			check(id, userThreads.done && codeOf(userThreads.status) === 5 && userThreads.shown.includes('atomic=1000000 mutex=1000000'), `user mode: 4 pthreads count exactly (${userThreads.status}; ${userThreads.wall} s)`);
			// strace (system mode): the trace is in the terminal and the program still runs.
			await runOptions(page, { emulation: 'system', cpus: 1, strace: true });
			const traced = await run(s, HELLO);
			result.runs.straceHello = traced;
			check(id, traced.done && codeOf(traced.status) === 0 && /\b(write|writev)\(1,/.test(traced.shown) && traced.shown.includes('hello, world'),
				`strace shows the program's write to fd 1 (${traced.status}; ${traced.fetched.map((f) => f.file).join(', ')})`);
			await runOptions(page, { emulation: 'system', cpus: 1, strace: false });
			// Input typed while the program runs (after its first output) reaches it, in both modes.
			for (const emulation of ['system', 'user']) {
				await runOptions(page, { emulation, cpus: 1, strace: false });
				const asked = await typedWhileRunning(s, ASK, 'ready', '2 3');
				result.runs[`${emulation}Stdin`] = asked;
				check(id, asked.done && codeOf(asked.status) === 0 && asked.shown.includes('sum=5'),
					`${emulation} mode: a line typed after the program printed "ready" reaches std::cin (${asked.status}; ${JSON.stringify(asked.shown.trim().slice(-120))})`);
				check(id, !asked.statusWhileRunning.includes('Waiting for input'),
					`${emulation} mode: a running program is not shown as waiting for input (status was "${asked.statusWhileRunning}")`);
			}
			await runOptions(page, { emulation: 'system', cpus: 1, strace: false });
		}

		await setText(page, 'main.cpp', WITH_ANSWER);
		result.views = await views(s, id, 'session');
		check(id, errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`);
		await s.settled();
		const all = packFiles(responses);
		result.session = { files: all, ...total(all) };
		result.appFiles = appFiles(responses);
		if (!linux) {
			const runFiles = packFiles(responses.slice(0, responses.length)).map((f) => f.file);
			const beforeViews = [...new Set([...result.editing.files, ...result.runs.hello.fetched, ...result.runs.pthreads.fetched].map((f) => f.file))].sort();
			check(id, JSON.stringify(beforeViews) === JSON.stringify(WASM_BASELINE),
				`editing and Run on WebAssembly fetch exactly what they did before the targets (${beforeViews.join(', ')})`);
			const extra = runFiles.filter((f) => !WASM_BASELINE.includes(f));
			check(id, extra.every((f) => /^(explorer\.js|demangle\.(js|wasm))$/.test(f)),
				`opening the views on WebAssembly adds only explorer.js and demangle.* (${extra.join(', ')})`);
		} else {
			const others = Object.values(TARGETS).map((x) => x.arch).filter((a) => a !== t.arch && a !== 'wasm32');
			const foreign = all.filter((f) => others.some((a) => f.file.includes(`/${a}/`)));
			check(id, foreign.length === 0, `fetches no file of another architecture (${foreign.map((f) => f.file).join(', ') || 'none'})`);
			check(id, !all.some((f) => /^(cc\.(js|wasm)|wasi-sysroot)/.test(f.file)), 'fetches nothing of the WebAssembly compiler');
		}
	} finally {
		await s.context.close();
	}
	return result;
}

/**
 * Opens the LLVM IR view, then the assembly view, on main.cpp; checks what
 * they show, the caret mapping and an edit; closes both and opens them again
 * (the toggle). Returns timings and the files the views fetched.
 */
async function views({ page, responses, settled }, id, where) {
	const t = TARGETS[id];
	const from = responses.length;
	const out = {};
	await page.locator('.explorer .row .name', { hasText: /^main\.cpp$/ }).click();
	await page.locator('header button.view', { hasText: /^IR$/ }).click();
	const ir = await viewShows(page, 'llvm-ir', (x) => x.includes(`target triple = "${t.triple}"`) && /^define .*@main\(/m.test(x), 240_000);
	out.irSeconds = ir.seconds;
	out.irHasDbg = ir.text.includes('!dbg');
	out.irHasAnswer = ir.text.includes('answer');
	if (process.env.DUMP_VIEWS) writeFileSync(join(process.env.DUMP_VIEWS, `${id}-${where.replace(/ /g, '-')}.ll`), ir.text);
	check(id, ir.ok && !ir.text.includes('!dbg') && ir.text.includes('answer'),
		`${where}: the LLVM IR view shows target triple "${t.triple}", define @main and the static answer(), without !dbg (${ir.seconds.toFixed(1)} s; ${JSON.stringify(ir.text.slice(0, 120))})`);
	await page.locator('header button.view', { hasText: /^Asm$/ }).click();
	const asm = await viewShows(page, 'asm', (x) => new RegExp(`^${t.main ?? 'main'}:`, 'm').test(x) && t.asm(x), 240_000);
	out.asmSeconds = asm.seconds;
	const triple = ((await page.locator('[data-view="asm"] .yk-view-triple').textContent().catch(() => '')) ?? '').trim();
	check(id, asm.ok, `${where}: the assembly view shows main: in ${t.arch} assembly (${asm.seconds.toFixed(1)} s; toolbar triple ${triple}; ${JSON.stringify(asm.text.slice(0, 160))})`);
	const tabs = await page.locator('.dv-tab .dock-tab').allTextContents();
	check(id, tabs.some((x) => x.includes('LLVM IR')) && tabs.some((x) => x.includes('Assembly')), `${where}: the views are tabs LLVM IR and Assembly (${tabs.join(', ')})`);

	// The caret on the call maps to assembly lines.
	await page.evaluate(() => {
		for (const e of globalThis.monaco.editor.getEditors()) {
			const match = e.getModel()?.findMatches('answer(seed)', false, false, true, null, false)[0];
			if (!match || e.getModel()?.uri.path !== '/workspace/main.cpp') continue;
			e.setPosition({ lineNumber: match.range.startLineNumber, column: match.range.startColumn + 1 });
			e.focus();
		}
	});
	const mapped = await page.locator('[data-view="asm"] .yk-mapped').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
	check(id, mapped, `${where}: the caret on answer(seed) highlights assembly lines (${await page.locator('[data-view="asm"] .yk-mapped').count()})`);

	// An edit recompiles.
	const before = await viewText(page, 'asm');
	await page.evaluate(() => {
		const m = globalThis.monaco.editor.getModels().find((x) => x.uri.path === '/workspace/main.cpp');
		m?.setValue(`${m.getValue()}\nint edited_function_xyz(int v) { return v * 13; }\n`);
	});
	const edited = await viewShows(page, 'asm', (x) => x !== before && x.includes('edited_function_xyz'), 15_000);
	out.editSeconds = edited.seconds;
	check(id, edited.ok, `${where}: an edit updates the assembly (${edited.seconds.toFixed(1)} s)`);

	// Toggle: close both tabs, open again; they come back with content.
	for (const title of ['LLVM IR', 'Assembly']) {
		const tab = page.locator('.dv-tab', { has: page.locator('.dock-tab', { hasText: title }) }).first();
		await tab.hover();
		await tab.locator('.dock-tab-close').click({ timeout: 5_000 }).catch(() => {});
	}
	const closed = await page.locator('.dv-tab .dock-tab', { hasText: /LLVM IR|Assembly/ }).count();
	check(id, closed === 0, `${where}: both views close from their tabs (${closed} left)`);
	await page.locator('header button.view', { hasText: /^Asm$/ }).click();
	const again = await viewShows(page, 'asm', (x) => x.includes('edited_function_xyz') && new RegExp(`^${t.main ?? 'main'}:`, 'm').test(x), 60_000);
	check(id, again.ok, `${where}: the assembly view opens again with the current code (${again.seconds.toFixed(1)} s)`);
	await settled();
	out.fetched = packFiles(responses.slice(from));
	return out;
}

/** A fresh session that opens the views before any Run: what the views alone download. */
async function viewsFirst(id) {
	const s = await open();
	try {
		if (id !== 'wasm32-wasi') await chooseTarget(s.page, id);
		await s.page.waitForTimeout(1500);
		const from = s.responses.length;
		await setText(s.page, 'main.cpp', WITH_ANSWER);
		const v = await views(s, id, 'views first');
		await s.settled();
		const files = packFiles(s.responses.slice(from));
		return { ...v, files, ...total(files) };
	} finally {
		await s.context.close();
	}
}

function printSummary() {
	console.log('\n== downloads (MB, as served; br / gz for reference)');
	const line = (label, tot) => console.log(`${label.padEnd(44)} ${String(tot.sentMB).padStart(8)} served-file  ${String(tot.networkMB).padStart(8)} network  br ${tot.brMB}  gz ${tot.gzMB}  (${tot.count} files)`);
	for (const [id, r] of Object.entries(report.targets)) {
		if (!r?.runs) continue;
		line(`${id}: editing`, r.editing);
		const firstRun = [...r.editing.files, ...(r.runs.hello?.fetched ?? [])];
		const dedup = [...new Map(firstRun.map((f) => [f.file, f])).values()];
		line(`${id}: editing + first Run (hello)`, total(dedup));
		line(`${id}: first Run alone`, total(r.runs.hello?.fetched ?? []));
		if (r.runs.userHello) line(`${id}: then user mode`, total(r.runs.userHello.fetched));
		if (r.runs.straceHello) line(`${id}: then strace`, total(r.runs.straceHello.fetched));
		line(`${id}: then views`, total(r.views?.fetched ?? []));
		if (r.viewsFirst) line(`${id}: views first (after editing)`, r.viewsFirst);
		line(`${id}: whole session`, r.session ?? total([]));
	}
	console.log('\n== timings (s): wall from the Run click; marks from the runner');
	for (const [id, r] of Object.entries(report.targets)) {
		for (const [name, x] of Object.entries(r?.runs ?? {})) {
			console.log(`${`${id} ${name}`.padEnd(30)} wall ${String(x.wall).padStart(6)}  ${Object.entries(x.marks).map(([k, v]) => `${k} ${v}`).join(', ')}`);
		}
		if (r?.views) console.log(`${`${id} views`.padEnd(30)} IR ${r.views.irSeconds?.toFixed(1)}  asm ${r.views.asmSeconds?.toFixed(1)}  edit ${r.views.editSeconds?.toFixed(1)}`);
		if (r?.viewsFirst) console.log(`${`${id} views first`.padEnd(30)} IR ${r.viewsFirst.irSeconds?.toFixed(1)}  asm ${r.viewsFirst.asmSeconds?.toFixed(1)}  edit ${r.viewsFirst.editSeconds?.toFixed(1)}`);
	}
}
