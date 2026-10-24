/**
 * C and C++ sanitizers: which ones a project has on, and how the top bar's
 * Sanitizers menu turns them on and off.
 *
 * A sanitizer is a flag of compile_flags.txt, `-fsanitize=address` or
 * `-fsanitize=undefined` (or both, `-fsanitize=address,undefined`): the file
 * clangd, the pack's runner and its explorer already read, so clangd
 * accepts the sanitizer's builtins, Run and Test compile and link with it
 * (fetching its runtime only then: packs/cpp README, "Sanitizers"), and
 * Download carries it to CMake. A flag written by hand is honoured as
 * clang reads it: lists, `-fno-sanitize=`, and other checks such as
 * `-fsanitize=signed-integer-overflow` are left alone by the menu.
 *
 * Imports nothing, so `node` can load this file directly
 * (tests/cpp-sanitizers.mjs).
 */

/** The sanitizers the menu offers. */
export type SanitizerId = 'address' | 'undefined';

/** One sanitizer as the menu shows it. */
export interface Sanitizer {
	/** The name -fsanitize= takes. */
	readonly id: SanitizerId;
	/** What the menu shows. */
	readonly label: string;
	/** One sentence on what it finds, for the menu. */
	readonly finds: string;
}

/** The menu's sanitizers, in its order. */
export const SANITIZERS: readonly Sanitizer[] = [
	{
		id: 'address',
		label: 'AddressSanitizer',
		finds: 'Out-of-bounds reads and writes on the heap, the stack and globals, use after free, double free, and leaks at exit.',
	},
	{
		id: 'undefined',
		label: 'UndefinedBehaviorSanitizer',
		finds: 'Signed overflow, bad shifts, out-of-range array indexes, null and misaligned pointers, invalid bool and enum values. The program goes on after a report.',
	},
];

/** Which of the menu's sanitizers are on. */
export type SanitizerChoice = Readonly<Record<SanitizerId, boolean>>;

const FLAGS = 'compile_flags.txt';
const ALL_UBSAN = 'undefined';

/**
 * The menu's sanitizers that compile_flags.txt (`text`, or undefined when
 * there is no such file) turns on, reading its -fsanitize= and
 * -fno-sanitize= lines in order as clang does (`all` included).
 * UndefinedBehaviorSanitizer is on only for the whole `undefined` group:
 * a project that checks one thing (`-fsanitize=signed-integer-overflow`)
 * shows it off, and keeps its line.
 */
export function sanitizersOf(text: string | undefined): SanitizerChoice {
	let on = new Set<string>();
	for (const line of (text ?? '').split(/\r?\n/)) {
		const m = /^-f(no-)?sanitize=(.*)$/.exec(line.trim());
		if (!m) continue;
		for (const name of (m[2] ?? '').split(',').filter(Boolean)) {
			if (!m[1]) on.add(name);
			else if (name === 'all') on = new Set();
			else on.delete(name);
		}
	}
	return { address: on.has('address'), undefined: on.has(ALL_UBSAN) };
}

/**
 * compile_flags.txt (`text`) with the menu's sanitizers as `choice` says:
 * `address` and `undefined` are taken out of every -fsanitize= and
 * -fno-sanitize= list (a list left empty goes, its line with it), and the
 * ones on go back as one `-fsanitize=` line at the end, address first.
 * Every other line stays as it was, in its place. Returns the new text,
 * ending in a newline; '' when nothing is left (no file is needed) and
 * there was no file.
 */
export function withSanitizers(text: string | undefined, choice: SanitizerChoice): string {
	const lines = (text ?? '').split(/\r?\n/);
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	const kept: string[] = [];
	for (const line of lines) {
		const m = /^(\s*)-f(no-)?sanitize=(.*?)(\s*)$/.exec(line);
		if (!m) {
			kept.push(line);
			continue;
		}
		const names = (m[3] ?? '').split(',').filter((n) => n && n !== 'address' && n !== ALL_UBSAN);
		if (names.length) kept.push(`${m[1]}-f${m[2] ?? ''}sanitize=${names.join(',')}${m[4]}`);
	}
	const on = SANITIZERS.filter((s) => choice[s.id]).map((s) => s.id);
	if (on.length) kept.push(`-fsanitize=${on.join(',')}`);
	if (kept.length === 0) return '';
	return kept.join('\n') + '\n';
}

/**
 * What the output panel says after the menu changed `choice`: which
 * sanitizers are on, and the line of compile_flags.txt that says so.
 */
export function describeSanitizers(choice: SanitizerChoice): string {
	const on = SANITIZERS.filter((s) => choice[s.id]);
	if (on.length === 0) return `Sanitizers: off (no -fsanitize= line in ${FLAGS}).`;
	return `Sanitizers: ${on.map((s) => s.label).join(' and ')} (-fsanitize=${on.map((s) => s.id).join(',')} in ${FLAGS}). Run and Test fetch the runtime the first time; a report names the file and line in the terminal.`;
}
