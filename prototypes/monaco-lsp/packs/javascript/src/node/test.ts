/**
 * `node:test` for the runner (packs/CONTRACT.md, "Running a program",
 * `type: 'test'`): `test`/`it`, `describe`/`suite`, their `skip`/`todo`/`only`
 * variants, `before`/`after`/`beforeEach`/`afterEach`, subtests with
 * `t.test`, async tests and `(t, done)` callbacks, `timeout`, and a report in
 * the shape of Node 22's spec reporter (`node --test` on a terminal).
 *
 * How it runs, and how that matches Node: each test file is a module the
 * runner imports (`startFile` before, `finishFile` after). A top-level
 * `test()` is queued at once and runs after the module's synchronous code,
 * one at a time in order, so `await test(...)` at the top of a module works
 * as in Node. `describe()` calls its function at once to collect what it
 * contains and runs those children in order when its turn comes. Hooks at
 * the top of a file apply to that file only (Node runs each file in its own
 * process; here files share the worker's globals but not their project
 * modules, which the runner links afresh for each file).
 *
 * Differences, all toward running what Node runs: `only` does not filter
 * (Node needs `--test-only` for that too); subtests a test forgets to await
 * are waited for instead of cancelled; `concurrency` is ignored (everything
 * runs one at a time); `mock`, `snapshot` and `run` are not available.
 * Registering tests after an `await` inside a `describe` function is not
 * attributed to that suite (Node follows the async context; a worker
 * cannot).
 */
import { strict as assert } from './assert';
import { inspect } from './inspect';

export interface TestOptions {
	skip?: boolean | string;
	todo?: boolean | string;
	only?: boolean;
	timeout?: number;
	concurrency?: number | boolean;
	signal?: AbortSignal;
}

type TestFn = (t: TestContext, done: (error?: unknown) => void) => unknown;
type SuiteFn = (s: SuiteContext) => unknown;
type HookFn = (t: TestContext | SuiteContext, done: (error?: unknown) => void) => unknown;
type HookKind = 'before' | 'after' | 'beforeEach' | 'afterEach';
type Status = 'pass' | 'fail' | 'skip' | 'todo';

/** Where the report goes: the runner's stdout. */
let write: (text: string) => void = (text) => console.log(text);
/** Real timers: the runner wraps the global ones to track a program's end. */
let timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };

class Node {
	readonly children: Node[] = [];
	readonly hooks: Record<HookKind, HookFn[]> = { before: [], after: [], beforeEach: [], afterEach: [] };
	/** Subtests started with `t.test`, run one after another. */
	queue: Promise<void> = Promise.resolve();
	pending: Promise<void>[] = [];
	depth = 0;
	skip: boolean | string;
	todo: boolean | string;
	status: Status | undefined;
	error: unknown;
	headerShown = false;
	/** How long it ran, for the report. */
	ms = 0;
	diagnostics: string[] = [];
	readonly done: Promise<void>;
	finish!: () => void;
	constructor(
		readonly name: string,
		readonly kind: 'test' | 'suite' | 'file',
		readonly fn: TestFn | SuiteFn | undefined,
		readonly options: TestOptions,
		readonly parent: Node | null,
		readonly location: string | undefined,
	) {
		this.skip = options.skip ?? false;
		this.todo = options.todo ?? false;
		this.done = new Promise((resolve) => (this.finish = resolve));
	}
	get fullName(): string {
		const names: string[] = [];
		for (let n: Node | null = this; n && n.kind !== 'file'; n = n.parent) names.unshift(n.name);
		return names.join(' > ');
	}
}

/** What a test function receives: Node's `TestContext`, without `mock`, `plan` and `runOnly`. */
export class TestContext {
	readonly #node: Node;
	readonly signal: AbortSignal = new AbortController().signal;
	readonly assert = assert;
	constructor(node: Node) {
		this.#node = node;
	}
	get name(): string {
		return this.#node.name;
	}
	get fullName(): string {
		return this.#node.fullName;
	}
	/** Marks the test skipped; it still runs to its end, as in Node. */
	skip(message?: string): void {
		this.#node.skip = message ?? true;
	}
	todo(message?: string): void {
		this.#node.todo = message ?? true;
	}
	diagnostic(message: string): void {
		this.#node.diagnostics.push(message);
	}
	test(name?: string | TestOptions | TestFn, options?: TestOptions | TestFn, fn?: TestFn): Promise<void> {
		const parent = this.#node;
		const child = create('test', name, options, fn, parent);
		parent.children.push(child);
		const run = parent.queue.then(() => runNode(child));
		parent.queue = run;
		parent.pending.push(run);
		return child.done;
	}
	before(fn: HookFn): void {
		void this.#run(fn);
	}
	after(fn: HookFn): void {
		this.#node.hooks.after.push(fn);
	}
	beforeEach(fn: HookFn): void {
		this.#node.hooks.beforeEach.push(fn);
	}
	afterEach(fn: HookFn): void {
		this.#node.hooks.afterEach.push(fn);
	}
	get mock(): never {
		throw new Error('node:test mock is not available in this runner');
	}
	async #run(fn: HookFn): Promise<void> {
		await call(fn, this, Infinity);
	}
}

/** What a `describe` function receives. */
export class SuiteContext {
	readonly signal: AbortSignal = new AbortController().signal;
	constructor(readonly name: string) {}
}

// --- registration ---------------------------------------------------------------

/** The file being imported (or the last one). Its tests are the top level. */
let file: Node = new Node('', 'file', undefined, {}, null, undefined);
/** Where `test()`/`describe()` add to while a `describe` function runs. */
let collecting: Node | null = null;
/** The test whose function is running, for a bare `test()` inside one (Node makes it a subtest). */
let running: Node | null = null;
let fileQueue: Promise<void> = Promise.resolve();
let fileStarted = false;

/** Project paths, so a test's location and an error's stack name project files only. */
let projectFiles: ReadonlySet<string> = new Set();

/** `file:line:col` of the first stack frame in a project file. */
function locate(stack: string | undefined): string | undefined {
	for (const line of (stack ?? '').split('\n')) {
		const m = /\(?([^\s()]+):(\d+):(\d+)\)?\s*$/.exec(line);
		if (m && projectFiles.has(m[1] ?? '')) return `${m[1]}:${m[2]}:${m[3]}`;
	}
	return undefined;
}

/** A test or suite from the arguments Node accepts: `(name?, options?, fn?)`, any of them left out. */
function create(kind: 'test' | 'suite', a: unknown, b: unknown, c: unknown, parent: Node, extra: TestOptions = {}): Node {
	let name: unknown = a;
	let options: unknown = b;
	let fn: unknown = c;
	if (typeof name === 'function') {
		fn = name;
		options = {};
		name = (fn as { name?: string }).name || '<anonymous>';
	} else if (typeof name === 'object' && name !== null) {
		fn = options;
		options = name;
		name = '<anonymous>';
	}
	if (typeof options === 'function') {
		fn = options;
		options = {};
	}
	const opts = { ...(typeof options === 'object' && options !== null ? (options as TestOptions) : {}), ...extra };
	const node = new Node(String(name ?? '<anonymous>'), kind, typeof fn === 'function' ? (fn as TestFn) : undefined, opts, parent, locate(new Error().stack));
	// A test without a function is a todo, as in Node.
	if (!node.fn && kind === 'test' && !node.skip) node.todo ||= true;
	return node;
}

function register(kind: 'test' | 'suite', extra: TestOptions) {
	return (name?: unknown, options?: unknown, fn?: unknown): Promise<void> => {
		const parent = collecting ?? running ?? file;
		const node = create(kind, name, options, fn, parent, extra);
		if (kind === 'suite' && node.fn && !node.skip) {
			const outer = collecting;
			collecting = node;
			try {
				const result = (node.fn as SuiteFn)(new SuiteContext(node.name));
				if (isThenable(result)) node.pending.push(Promise.resolve(result).then(() => {}));
			} catch (e) {
				node.error = e;
			} finally {
				collecting = outer;
			}
		}
		if (parent === file) {
			parent.children.push(node);
			fileQueue = fileQueue.then(() => startFileOnce()).then(() => runNode(node));
		} else if (parent.kind === 'suite') {
			parent.children.push(node);
		} else {
			parent.children.push(node);
			const run = parent.queue.then(() => runNode(node));
			parent.queue = run;
			parent.pending.push(run);
		}
		return node.done;
	};
}

function variants(kind: 'test' | 'suite') {
	return Object.assign(register(kind, {}), {
		skip: register(kind, { skip: true }),
		todo: register(kind, { todo: true }),
		only: register(kind, { only: true }),
	});
}

export const test = variants('test');
export const it = test;
export const describe = variants('suite');
export const suite = describe;

function hook(kind: HookKind) {
	return (fn: HookFn): void => {
		const target = collecting ?? running ?? file;
		target.hooks[kind].push(fn);
	};
}
export const before = hook('before');
export const after = hook('after');
export const beforeEach = hook('beforeEach');
export const afterEach = hook('afterEach');

export const mock = new Proxy(
	{},
	{
		get(_, property) {
			throw new Error(`node:test mock.${String(property)} is not available in this runner`);
		},
	},
);

Object.assign(test, { test, it, describe, suite, before, after, beforeEach, afterEach, mock });

// --- running -------------------------------------------------------------------

const stats = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
const failures: Node[] = [];

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/** A test that ran out of time: Node reports it as cancelled, with this text. */
class Timeout {
	constructor(readonly ms: number) {}
	toString(): string {
		return `test timed out after ${this.ms}ms`;
	}
}

/** Calls a test or hook function, with a `done` callback when it declares one, within `timeout` ms. */
function call(fn: TestFn | HookFn, context: TestContext | SuiteContext, timeout: number): Promise<void> {
	const result =
		fn.length >= 2
			? new Promise<void>((resolve, reject) => {
					const r = (fn as HookFn)(context, (error?: unknown) => (error ? reject(error) : resolve()));
					if (isThenable(r)) reject(new Error('passed a callback but also returned a Promise'));
				})
			: Promise.resolve().then(() => (fn as HookFn)(context, () => {})).then(() => {});
	if (!Number.isFinite(timeout)) return result;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		result,
		new Promise<void>((_, reject) => {
			timer = timers.setTimeout(() => reject(new Timeout(timeout)), timeout);
		}),
	]).finally(() => timers.clearTimeout(timer));
}

async function hooksDown(node: Node, kind: 'beforeEach', context: TestContext): Promise<void> {
	const chain: Node[] = [];
	for (let n = node.parent; n; n = n.parent) chain.unshift(n);
	for (const n of chain) for (const h of n.hooks[kind]) await call(h, context, Infinity);
}

async function hooksUp(node: Node, kind: 'afterEach', context: TestContext): Promise<void> {
	for (let n = node.parent; n; n = n.parent) for (const h of n.hooks[kind]) await call(h, context, Infinity);
}

const pad = (depth: number) => '  '.repeat(depth);
const duration = (ms: number) => `(${Number(ms.toFixed(6))}ms)`;

/** Prints `▶ name` for a test that has subtests, once, before its first subtest's line. */
function header(node: Node | null): void {
	if (!node || node.kind === 'file' || node.headerShown) return;
	header(node.parent);
	node.headerShown = true;
	write(`${pad(node.depth)}▶ ${node.name}`);
}

/** Fails the running test with an uncaught error or unhandled rejection; null between tests. */
let uncaught: ((error: unknown) => void) | null = null;

/** Called by the runner for an uncaught error or unhandled rejection while tests run. */
export function reportUncaught(error: unknown): void {
	if (uncaught) uncaught(error);
	else fileErrors.push(error);
}
let fileErrors: unknown[] = [];

async function runNode(node: Node, inheritedError?: unknown): Promise<void> {
	node.depth = node.parent && node.parent.kind !== 'file' ? node.parent.depth + 1 : 0;
	const started = performance.now();
	if (node.kind === 'suite') {
		stats.suites++;
		// A skipped suite is one line; its tests are neither run nor counted.
		if (node.skip) return report(node, performance.now() - started, undefined);
		header(node);
		let error: unknown = node.error ?? inheritedError;
		if (error === undefined) {
			try {
				await Promise.all(node.pending);
				const context = new SuiteContext(node.name);
				for (const h of node.hooks.before) await call(h, context, Infinity);
			} catch (e) {
				error = e;
			}
		}
		for (const child of node.children) await runNode(child, error);
		if (error === undefined) {
			try {
				const context = new SuiteContext(node.name);
				for (const h of node.hooks.after) await call(h, context, Infinity);
			} catch (e) {
				error = e;
			}
		}
		if (error === undefined && node.children.some((c) => c.status === 'fail')) {
			const n = node.children.filter((c) => c.status === 'fail').length;
			error = new Error(`${n} subtest${n === 1 ? '' : 's'} failed`);
			(error as { quiet?: boolean }).quiet = true;
		}
		return report(node, performance.now() - started, error);
	}

	let error: unknown = inheritedError;
	if (error === undefined && !node.skip && node.fn) {
		const context = new TestContext(node);
		const outer = running;
		running = node;
		const caught = new Promise<never>((_, reject) => (uncaught = reject));
		try {
			await Promise.race([
				(async () => {
					await hooksDown(node, 'beforeEach', context);
					try {
						await call(node.fn as TestFn, context, node.options.timeout ?? Infinity);
					} finally {
						running = outer;
					}
					// Subtests started with t.test, awaited or not.
					for (let n = 0; n < node.pending.length; n++) await node.pending[n];
					await hooksUp(node, 'afterEach', context);
				})(),
				caught,
			]);
		} catch (e) {
			error = e;
		} finally {
			running = outer;
			uncaught = null;
		}
		if (error === undefined && node.children.some((c) => c.status === 'fail')) {
			const n = node.children.filter((c) => c.status === 'fail').length;
			error = new Error(`${n} subtest${n === 1 ? '' : 's'} failed`);
			(error as { quiet?: boolean }).quiet = true;
		}
		for (const h of node.hooks.after) {
			try {
				await call(h, context, Infinity);
			} catch (e) {
				error ??= e;
			}
		}
	}
	stats.tests++;
	return report(node, performance.now() - started, error);
}

/**
 * Prints a test's line and counts it, as Node 22's spec reporter does: the
 * error itself is printed only in the "failing tests" list at the end. A
 * todo that fails is marked ✖ and listed, but counts as todo, not as a
 * failure; a test that timed out counts as cancelled; a test failing only
 * because a subtest failed counts as failed but is not listed (its subtest
 * is).
 */
function report(node: Node, ms: number, error: unknown): void {
	let status: Status;
	if (node.skip) status = 'skip';
	else if (node.todo) status = 'todo';
	else status = error === undefined ? 'pass' : 'fail';
	node.status = status;
	node.error = error;
	node.ms = ms;
	if (node.kind === 'test') {
		if (status === 'skip') stats.skipped++;
		else if (status === 'todo') stats.todo++;
		else if (error instanceof Timeout) stats.cancelled++;
		else if (status === 'fail') stats.fail++;
		else stats.pass++;
	}
	const failed = error !== undefined && status !== 'skip';
	if (failed && !(error as { quiet?: boolean } | undefined)?.quiet) failures.push(node);
	header(node.parent);
	const mark = failed ? '✖' : status === 'skip' ? '﹣' : '✔';
	const directive = status === 'skip' ? ` # ${node.skip === true ? 'SKIP' : node.skip}` : node.todo ? ` # ${node.todo === true ? 'TODO' : node.todo}` : '';
	write(`${pad(node.depth)}${mark} ${node.name} ${duration(ms)}${directive}`);
	for (const d of node.diagnostics) write(`${pad(node.depth)}ℹ ${d}`);
	node.finish();
}

/** An error as Node's reporter prints it: the message, then only the frames in project files. */
function errorText(error: unknown, depth: number): string {
	let text: string;
	if (error instanceof Error) {
		const head = error.name === 'AssertionError' ? String(error) : `${error.name}: ${error.message}`;
		const frames = (error.stack ?? '')
			.split('\n')
			.filter((l) => /^\s+at /.test(l) && locate(l) !== undefined)
			.map((l) => `    ${l.trim()}`);
		// An assertion's message ends with a newline, which leaves the blank line Node shows before the stack.
		text = frames.length ? `${head}\n${frames.join('\n')}` : head;
	} else if (error instanceof Timeout) {
		text = inspect(String(error));
	} else {
		text = `Error: ${inspect(error)}`;
	}
	return text
		.split('\n')
		.map((l) => pad(depth) + l)
		.join('\n');
}

async function startFileOnce(): Promise<void> {
	if (fileStarted) return;
	fileStarted = true;
	const context = new SuiteContext(file.name);
	for (const h of file.hooks.before) await call(h, context, Infinity);
}

// --- the runner's side ------------------------------------------------------------

/** Called once before the first file: where the report goes, the real timers, the project's paths. */
export function configure(options: { write: (text: string) => void; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; files: Iterable<string> }): void {
	write = options.write;
	timers = { setTimeout: options.setTimeout, clearTimeout: options.clearTimeout };
	projectFiles = new Set(options.files);
}

/** Before importing a test file: its top-level tests and hooks start empty. */
export function startFile(path: string): void {
	file = new Node(path, 'file', undefined, {}, null, `${path}:1:1`);
	collecting = null;
	running = null;
	fileQueue = Promise.resolve();
	fileStarted = false;
	fileErrors = [];
}

/**
 * After the file's module has been imported (or failed to import, `error`):
 * waits for its queued tests, runs its top-level `after` hooks, and reports a
 * failure of the file itself as Node does, as a failed test named after it.
 */
export async function finishFile(error?: unknown): Promise<void> {
	const started = performance.now();
	let failure = error;
	try {
		await fileQueue;
		if (fileStarted) for (const h of file.hooks.after) await call(h, new SuiteContext(file.name), Infinity);
	} catch (e) {
		failure ??= e;
	}
	failure ??= fileErrors[0];
	if (failure !== undefined) {
		const node = new Node(file.name, 'test', undefined, {}, file, `${file.name}:1:1`);
		stats.tests++;
		report(node, performance.now() - started, failure);
	}
}

/** After every file: prints the summary and the failures again; returns the exit status. */
export function summary(ms: number): number {
	write(
		[
			`ℹ tests ${stats.tests}`,
			`ℹ suites ${stats.suites}`,
			`ℹ pass ${stats.pass}`,
			`ℹ fail ${stats.fail}`,
			`ℹ cancelled ${stats.cancelled}`,
			`ℹ skipped ${stats.skipped}`,
			`ℹ todo ${stats.todo}`,
			`ℹ duration_ms ${ms.toFixed(3)}`,
		].join('\n'),
	);
	if (failures.length) {
		write('\n✖ failing tests:\n');
		for (const node of failures) {
			const directive = node.todo ? ` # ${node.todo === true ? 'TODO' : node.todo}` : '';
			write(`test at ${node.location ?? node.name}\n✖ ${node.name} ${duration(node.ms)}${directive}\n${errorText(node.error, 1)}\n`);
		}
	}
	return stats.fail > 0 || stats.cancelled > 0 ? 1 : 0;
}

/** True when any test was registered: a program run with `node file.js` that defines tests runs them. */
export function hasTests(): boolean {
	return file.children.length > 0;
}
