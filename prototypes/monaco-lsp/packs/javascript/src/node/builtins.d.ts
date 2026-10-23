// Types of the Node built-in modules the runner provides (src/node/), for
// the language server: build.sh embeds this file in server.js, which adds it
// to every project as a root file, so `import { test } from 'node:test'` and
// `import assert from 'node:assert/strict'` resolve in a checked project
// (there is no @types/node to install). Only what the runner implements is
// declared, with @types/node's signatures, so a call the runner lacks
// (`mock.fn()`, `assert.partialDeepStrictEqual`) is an error here first.

declare module 'node:test' {
	interface TestOptions {
		/** Skip the test; a string is the reason shown in the report. */
		skip?: boolean | string;
		/** Mark the test as to do: it runs, but its failure does not fail the run. */
		todo?: boolean | string;
		/** Accepted for compatibility; as in Node without `--test-only`, every test still runs. */
		only?: boolean;
		/** Fail the test if it has not finished after this many milliseconds. */
		timeout?: number;
		/** Accepted for compatibility; tests always run one at a time here. */
		concurrency?: number | boolean;
		signal?: AbortSignal;
	}
	type TestFn = (t: TestContext, done: (result?: unknown) => void) => void | Promise<void>;
	type SuiteFn = (s: SuiteContext) => void | Promise<void>;
	type HookFn = (t: TestContext | SuiteContext, done: (result?: unknown) => void) => unknown;

	interface TestContext {
		/** The test's name. */
		readonly name: string;
		/** The names of the test and of its suites and parent tests, joined by ` > `. */
		readonly fullName: string;
		readonly signal: AbortSignal;
		/**
		 * Strict-mode assertions (`node:assert/strict`). Typed without
		 * `asserts` (as a void function), because TypeScript refuses an
		 * assertion call through `t`, a parameter without a type annotation.
		 */
		readonly assert: TestContextAssert;
		/** Report the test as skipped (it still runs to its end). */
		skip(message?: string): void;
		/** Report the test as to do. */
		todo(message?: string): void;
		/** Print a line under the test's result. */
		diagnostic(message: string): void;
		/** Run a subtest; the parent waits for it, awaited or not. */
		test(name?: string, fn?: TestFn): Promise<void>;
		test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
		test(options?: TestOptions, fn?: TestFn): Promise<void>;
		test(fn?: TestFn): Promise<void>;
		before(fn?: HookFn): void;
		after(fn?: HookFn): void;
		beforeEach(fn?: HookFn): void;
		afterEach(fn?: HookFn): void;
	}
	interface TestContextAssert {
		ok(value: unknown, message?: string | Error): void;
		equal(actual: unknown, expected: unknown, message?: string | Error): void;
		notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		throws(block: () => unknown, message?: string | Error): void;
		throws(block: () => unknown, error: import('node:assert').AssertPredicate, message?: string | Error): void;
		doesNotThrow(block: () => unknown, message?: string | Error): void;
		rejects(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
		rejects(block: (() => Promise<unknown>) | Promise<unknown>, error: import('node:assert').AssertPredicate, message?: string | Error): Promise<void>;
		doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
		ifError(value: unknown): void;
		match(value: string, regExp: RegExp, message?: string | Error): void;
		doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void;
		fail(message?: string | Error): never;
	}
	interface SuiteContext {
		readonly name: string;
		readonly signal: AbortSignal;
	}

	interface TestFunction {
		(name?: string, fn?: TestFn): Promise<void>;
		(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
		(options?: TestOptions, fn?: TestFn): Promise<void>;
		(fn?: TestFn): Promise<void>;
		skip: TestFunction;
		todo: TestFunction;
		only: TestFunction;
	}
	interface SuiteFunction {
		(name?: string, fn?: SuiteFn): Promise<void>;
		(name?: string, options?: TestOptions, fn?: SuiteFn): Promise<void>;
		(options?: TestOptions, fn?: SuiteFn): Promise<void>;
		(fn?: SuiteFn): Promise<void>;
		skip: SuiteFunction;
		todo: SuiteFunction;
		only: SuiteFunction;
	}

	/** Define a test. At the top of a file it runs after the file's other top-level code, one test at a time. */
	const test: TestFunction & {
		test: TestFunction;
		it: TestFunction;
		describe: SuiteFunction;
		suite: SuiteFunction;
		before: typeof before;
		after: typeof after;
		beforeEach: typeof beforeEach;
		afterEach: typeof afterEach;
	};
	/** An alias of `test`. */
	const it: TestFunction;
	/** Group tests: the function runs at once to define them; they run in order when the suite's turn comes. */
	const describe: SuiteFunction;
	/** An alias of `describe`. */
	const suite: SuiteFunction;
	/** Run once before the tests of the enclosing suite (or file). */
	function before(fn?: HookFn, options?: { timeout?: number }): void;
	/** Run once after the tests of the enclosing suite (or file). */
	function after(fn?: HookFn, options?: { timeout?: number }): void;
	/** Run before each test of the enclosing suite (or file), outer suites' hooks first. */
	function beforeEach(fn?: HookFn, options?: { timeout?: number }): void;
	/** Run after each test of the enclosing suite (or file), inner suites' hooks first. */
	function afterEach(fn?: HookFn, options?: { timeout?: number }): void;

	export { test, it, describe, suite, before, after, beforeEach, afterEach, TestContext, SuiteContext, TestOptions };
	export default test;
}

declare module 'node:assert' {
	/** Throws an `AssertionError` unless `value` is truthy (`assert.ok`). */
	function assert(value: unknown, message?: string | Error): asserts value;
	namespace assert {
		class AssertionError extends Error {
			actual: unknown;
			expected: unknown;
			operator: string;
			generatedMessage: boolean;
			code: 'ERR_ASSERTION';
			constructor(options?: { message?: string; actual?: unknown; expected?: unknown; operator?: string });
		}
		type AssertPredicate = RegExp | (new () => object) | ((thrown: unknown) => boolean) | object | Error;

		function fail(message?: string | Error): never;
		/** Throws unless `value` is truthy. */
		function ok(value: unknown, message?: string | Error): asserts value;
		/** Legacy mode: `actual == expected`. In `node:assert/strict`, `strictEqual`. */
		function equal(actual: unknown, expected: unknown, message?: string | Error): void;
		function notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		/** Legacy mode: prototypes ignored, primitives compared with `==`. In `node:assert/strict`, `deepStrictEqual`. */
		function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		/** `Object.is(actual, expected)`. */
		function strictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T;
		function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		/** Same prototypes, same own enumerable properties, recursively, primitives by `Object.is`. */
		function deepStrictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T;
		function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
		/** Calls `block` and throws unless it throws (an error matching `error`, when given). */
		function throws(block: () => unknown, message?: string | Error): void;
		function throws(block: () => unknown, error: AssertPredicate, message?: string | Error): void;
		function doesNotThrow(block: () => unknown, message?: string | Error): void;
		/** Awaits the promise (or the function's) and rejects unless it rejects (with an error matching `error`, when given). */
		function rejects(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
		function rejects(block: (() => Promise<unknown>) | Promise<unknown>, error: AssertPredicate, message?: string | Error): Promise<void>;
		function doesNotReject(block: (() => Promise<unknown>) | Promise<unknown>, message?: string | Error): Promise<void>;
		/** Throws `value` unless it is `null` or `undefined`. */
		function ifError(value: unknown): asserts value is null | undefined;
		/** Throws unless `value` is a string matching `regExp`. */
		function match(value: string, regExp: RegExp, message?: string | Error): void;
		function doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void;

		/** Strict mode: `equal` is `strictEqual`, `deepEqual` is `deepStrictEqual`. */
		const strict: Omit<typeof assert, 'equal' | 'notEqual' | 'deepEqual' | 'notDeepEqual' | 'strict'> & {
			(value: unknown, message?: string | Error): asserts value;
			equal: typeof strictEqual;
			notEqual: typeof notStrictEqual;
			deepEqual: typeof deepStrictEqual;
			notDeepEqual: typeof notDeepStrictEqual;
			strict: typeof strict;
		};
	}
	export = assert;
}

declare module 'node:assert/strict' {
	import { strict } from 'node:assert';
	export = strict;
}

declare module 'assert' {
	import assert = require('node:assert');
	export = assert;
}

declare module 'assert/strict' {
	import { strict } from 'node:assert';
	export = strict;
}
