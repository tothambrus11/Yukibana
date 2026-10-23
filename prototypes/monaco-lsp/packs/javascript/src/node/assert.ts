/**
 * `node:assert` and `node:assert/strict` for the runner (packs/CONTRACT.md,
 * "Running a program"): the functions students use, with Node's signatures,
 * semantics and, as far as is useful, its messages. `node:assert` is Node's
 * legacy mode (`equal` is `==`, `deepEqual` ignores prototypes and compares
 * primitives with `==`); `node:assert/strict` and `assert.strict` are strict
 * mode, where `equal` is `strictEqual` and `deepEqual` is `deepStrictEqual`.
 *
 * Not here: `partialDeepStrictEqual`, `CallTracker`, `snapshot`, and the
 * comparison of non-index properties of arrays or of symbol keys.
 */
import { inspect } from './inspect';

type Message = string | Error | undefined;

/** Node's `assert.AssertionError`: `code` is 'ERR_ASSERTION', `operator` names the check. */
export class AssertionError extends Error {
	readonly code = 'ERR_ASSERTION';
	actual: unknown;
	expected: unknown;
	operator: string;
	generatedMessage: boolean;
	constructor(options: { message?: string | undefined; actual?: unknown; expected?: unknown; operator?: string | undefined }) {
		super(options.message ?? 'Failed');
		this.name = 'AssertionError';
		this.actual = options.actual;
		this.expected = options.expected;
		this.operator = options.operator ?? 'fail';
		this.generatedMessage = options.message === undefined;
	}
	override toString(): string {
		return `${this.name} [${this.code}]: ${this.message}`;
	}
}

/** Project sources by path, so `assert.ok(expr)` can quote `expr` as Node does. */
let sources: Record<string, string> = {};
export function setSources(files: Record<string, string>): void {
	sources = files;
}

/**
 * The text of the assertion call that failed, read from the project file the
 * first non-runner stack frame names: what Node prints for a falsy
 * `assert.ok(...)`. Undefined when the frame or the call cannot be found.
 */
function callSource(): string | undefined {
	for (const line of (new Error().stack ?? '').split('\n')) {
		const m = /\(?([^\s()]+):(\d+):(\d+)\)?\s*$/.exec(line);
		if (!m) continue;
		const text = sources[m[1] ?? ''];
		if (text === undefined) continue;
		const lines = text.split('\n');
		let at = lines.slice(0, Number(m[2]) - 1).join('\n').length + (Number(m[2]) > 1 ? 1 : 0) + Number(m[3]) - 1;
		// The frame's column is at the callee's last segment (`ok` in `assert.ok(`); widen to the whole callee.
		while (at > 0 && /[\w$.]/.test(text[at - 1] ?? '')) at--;
		const open = text.indexOf('(', at);
		if (open < 0) return undefined;
		let depth = 0;
		for (let i = open; i < text.length; i++) {
			const c = text[i];
			if (c === '(') depth++;
			else if (c === ')' && --depth === 0) return text.slice(at, i + 1);
		}
		return undefined;
	}
	return undefined;
}

function raise(message: Message, generated: () => string, actual: unknown, expected: unknown, operator: string): never {
	if (message instanceof Error) throw message;
	const error = new AssertionError({ message: message ?? generated(), actual, expected, operator });
	throw error;
}

/** Lines of `a` (actual, `+`) against `b` (expected, `-`), as Node's diff marks them. */
function lineDiff(a: string, b: string): string {
	const x = a.split('\n');
	const y = b.split('\n');
	const n = x.length;
	const m = y.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && x[i] === y[j]) {
			out.push(`  ${x[i++]}`);
			j++;
		} else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(`+ ${x[i++]}`);
		else out.push(`- ${y[j++]}`);
	}
	return out.join('\n');
}

/** "Expected values to be …": one line `a !== b` when both are short, else a diff. */
function comparison(header: string, sign: string, actual: unknown, expected: unknown): string {
	const a = inspect(actual);
	const e = inspect(expected);
	if (!a.includes('\n') && !e.includes('\n') && a.length + e.length < 80) return `${header}\n\n${a} ${sign} ${e}\n`;
	return `${header}\n+ actual - expected\n\n${lineDiff(a, e)}\n`;
}

// --- equality ---------------------------------------------------------------

/** Node's `util.isDeepStrictEqual`: prototypes, `Object.is` for primitives, own enumerable keys. */
export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
	return deep(a, b, true, new Map());
}

function deep(a: unknown, b: unknown, strict: boolean, seen: Map<object, object>): boolean {
	if (strict ? Object.is(a, b) : a === b || (a !== a && b !== b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		// Legacy mode compares primitives with ==.
		return !strict && (typeof a !== 'object' || a === null) && (typeof b !== 'object' || b === null) && a == b;
	}
	if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (seen.get(a) === b) return true;
	seen.set(a, b);
	if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
	if (a instanceof Error && b instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
	if (a instanceof Map || b instanceof Map) {
		if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
		for (const [k, v] of a) if (!b.has(k) || !deep(v, b.get(k), strict, seen)) return false;
		return true;
	}
	if (a instanceof Set || b instanceof Set) {
		if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
		outer: for (const v of a) {
			if (b.has(v)) continue;
			for (const w of b) if (deep(v, w, strict, seen)) continue outer;
			return false;
		}
		return true;
	}
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deep(ra[k], rb[k], strict, seen));
}

// --- the checks ---------------------------------------------------------------

export function ok(...args: unknown[]): void {
	if (args.length === 0) raise(undefined, () => 'No value argument passed to `assert.ok()`', undefined, true, '==');
	const value = args[0];
	const message = args[1] as Message;
	if (!value) {
		raise(message, () => `The expression evaluated to a falsy value:\n\n  ${callSource() ?? `assert.ok(${inspect(value)})`}\n`, value, true, '==');
	}
}

export function strictEqual(actual: unknown, expected: unknown, message?: Message): void {
	if (!Object.is(actual, expected)) {
		raise(
			message,
			() =>
				typeof actual === 'object' && actual !== null && typeof expected === 'object' && expected !== null && isDeepStrictEqual(actual, expected)
					? `Values have same structure but are not reference-equal:\n\n${inspect(actual)}\n`
					: comparison('Expected values to be strictly equal:', '!==', actual, expected),
			actual,
			expected,
			'strictEqual',
		);
	}
}

export function notStrictEqual(actual: unknown, expected: unknown, message?: Message): void {
	if (Object.is(actual, expected)) raise(message, () => `Expected "actual" to be strictly unequal to: ${inspect(expected)}`, actual, expected, 'notStrictEqual');
}

export function deepStrictEqual(actual: unknown, expected: unknown, message?: Message): void {
	if (!isDeepStrictEqual(actual, expected)) raise(message, () => comparison('Expected values to be strictly deep-equal:', '!==', actual, expected), actual, expected, 'deepStrictEqual');
}

export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: Message): void {
	if (isDeepStrictEqual(actual, expected)) raise(message, () => `Expected "actual" not to be strictly deep-equal to: ${inspect(expected)}`, actual, expected, 'notDeepStrictEqual');
}

/** Legacy `equal`: `==`, with NaN equal to NaN. */
export function equal(actual: unknown, expected: unknown, message?: Message): void {
	if (!(actual == expected || (actual !== actual && expected !== expected))) raise(message, () => `${inspect(actual)} == ${inspect(expected)}`, actual, expected, '==');
}

export function notEqual(actual: unknown, expected: unknown, message?: Message): void {
	if (actual == expected || (actual !== actual && expected !== expected)) raise(message, () => `${inspect(actual)} != ${inspect(expected)}`, actual, expected, '!=');
}

/** Legacy `deepEqual`: prototypes ignored, primitives compared with `==`. */
export function deepEqual(actual: unknown, expected: unknown, message?: Message): void {
	if (!deep(actual, expected, false, new Map())) {
		raise(message, () => `Expected values to be loosely deep-equal:\n\n${inspect(actual)}\n\nshould loosely deep-equal\n\n${inspect(expected)}`, actual, expected, 'deepEqual');
	}
}

export function notDeepEqual(actual: unknown, expected: unknown, message?: Message): void {
	if (deep(actual, expected, false, new Map())) raise(message, () => `"actual" deepEqual "expected"`, actual, expected, 'notDeepEqual');
}

export function fail(message: Message = 'Failed'): never {
	if (message instanceof Error) throw message;
	throw new AssertionError({ message, operator: 'fail' });
}

export function match(string: string, regexp: RegExp, message?: Message): void {
	if (typeof string !== 'string' || !regexp.test(string)) {
		raise(
			message,
			() =>
				typeof string !== 'string'
					? `The "string" argument must be of type string. Received type ${typeof string} (${inspect(string)})`
					: `The input did not match the regular expression ${String(regexp)}. Input:\n\n${inspect(string)}\n`,
			string,
			regexp,
			'match',
		);
	}
}

export function doesNotMatch(string: string, regexp: RegExp, message?: Message): void {
	if (typeof string === 'string' && regexp.test(string)) {
		raise(message, () => `The input was expected to not match the regular expression ${String(regexp)}. Input:\n\n${inspect(string)}\n`, string, regexp, 'doesNotMatch');
	}
}

export function ifError(value: unknown): void {
	if (value === null || value === undefined) return;
	if (value instanceof Error) throw value;
	throw new AssertionError({ message: `ifError got unwanted exception: ${inspect(value)}`, actual: value, expected: null, operator: 'ifError' });
}

/** What `throws` and `rejects` accept as their second argument, as in Node. */
type Expected = RegExp | ((error: unknown) => boolean) | (new (...args: never[]) => unknown) | Record<string, unknown> | Error;

const NONE = Symbol('no exception');

function checkError(error: unknown, expected: Expected | undefined, message: Message, operator: string): void {
	if (expected === undefined) return;
	if (expected instanceof RegExp) {
		if (expected.test(String(error))) return;
		raise(message, () => `The input did not match the regular expression ${String(expected)}. Input:\n\n${inspect(String(error))}\n`, error, expected, operator);
	}
	if (typeof expected === 'function') {
		if (expected.prototype !== undefined && error instanceof (expected as new (...args: never[]) => unknown)) return;
		if (expected === Error || Object.prototype.isPrototypeOf.call(Error, expected)) {
			const got = error instanceof Error ? error.constructor.name : typeof error;
			raise(
				message,
				() => `The error is expected to be an instance of "${expected.name}". Received "${got}"\n\nError message:\n\n${error instanceof Error ? error.message : inspect(error)}`,
				error,
				expected,
				operator,
			);
		}
		const result: unknown = (expected as (error: unknown) => unknown).call({}, error);
		if (result !== true) {
			raise(message, () => `The ${expected.name ? `"${expected.name}" ` : ''}validation function is expected to return "true". Received ${inspect(result)}`, error, expected, operator);
		}
		return;
	}
	// An object (or an Error instance): each of its keys must match the error's.
	const record = expected as Record<string, unknown>;
	const keys = expected instanceof Error ? ['name', 'message', ...Object.keys(expected)] : Object.keys(expected);
	for (const key of keys) {
		const want = record[key];
		const got = typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined;
		if (want instanceof RegExp && typeof got === 'string' ? want.test(got) : isDeepStrictEqual(got, want)) continue;
		raise(message, () => comparison('Expected values to be strictly deep-equal:', '!==', got, want), error, expected, operator);
	}
}

export function throws(fn: () => unknown, expected?: Expected | string, message?: Message): void {
	if (typeof expected === 'string') {
		message = expected;
		expected = undefined;
	}
	let error: unknown = NONE;
	try {
		fn();
	} catch (e) {
		error = e;
	}
	const want = expected;
	if (error === NONE) {
		raise(message, () => `Missing expected exception${typeof want === 'function' && want.name ? ` (${want.name})` : ''}.`, undefined, want, 'throws');
	}
	checkError(error, want, message, 'throws');
}

export function doesNotThrow(fn: () => unknown, message?: Message): void {
	try {
		fn();
	} catch (e) {
		raise(undefined, () => `Got unwanted exception${typeof message === 'string' ? `: ${message}` : '.'}\nActual message: "${e instanceof Error ? e.message : String(e)}"`, e, undefined, 'doesNotThrow');
	}
}

export async function rejects(promiseOrFn: Promise<unknown> | (() => Promise<unknown>), expected?: Expected | string, message?: Message): Promise<void> {
	if (typeof expected === 'string') {
		message = expected;
		expected = undefined;
	}
	let error: unknown = NONE;
	try {
		await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
	} catch (e) {
		error = e;
	}
	const want = expected;
	if (error === NONE) {
		raise(message, () => `Missing expected rejection${typeof want === 'function' && want.name ? ` (${want.name})` : ''}.`, undefined, want, 'rejects');
	}
	checkError(error, want, message, 'rejects');
}

export async function doesNotReject(promiseOrFn: Promise<unknown> | (() => Promise<unknown>), message?: Message): Promise<void> {
	try {
		await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
	} catch (e) {
		raise(undefined, () => `Got unwanted rejection${typeof message === 'string' ? `: ${message}` : '.'}\nActual message: "${e instanceof Error ? e.message : String(e)}"`, e, undefined, 'doesNotReject');
	}
}

// --- the two modules ------------------------------------------------------------

const common = { ok, fail, match, doesNotMatch, ifError, throws, doesNotThrow, rejects, doesNotReject, strictEqual, notStrictEqual, deepStrictEqual, notDeepStrictEqual, AssertionError };

/** `node:assert/strict`, also `assert.strict`: a callable `ok` whose `equal` is `strictEqual`. */
export const strict = Object.assign((...args: unknown[]) => ok(...args), common, {
	equal: strictEqual,
	notEqual: notStrictEqual,
	deepEqual: deepStrictEqual,
	notDeepEqual: notDeepStrictEqual,
	strict: undefined as unknown,
});
strict.strict = strict;

/** `node:assert`: legacy mode, with `strict` reaching strict mode. */
export const legacy = Object.assign((...args: unknown[]) => ok(...args), common, { equal, notEqual, deepEqual, notDeepEqual, strict });
