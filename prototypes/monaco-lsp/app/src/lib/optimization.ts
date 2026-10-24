/**
 * Optimisation levels: which languages have one worth choosing, which level
 * a project is on, and how the top bar's Optimization picker changes it.
 *
 * Only languages whose compiler in the browser does something different at
 * another level have levels here; each pack's README says why its language
 * has them or not.
 *
 * C and C++: the level is the `-O` line of compile_flags.txt, the file
 * clangd, the pack's runner and its explorer already read, so Run and the
 * LLVM IR and assembly views follow it by construction, a hand-edited line
 * is honoured, and Download carries it to CMake. No line means `-O2`, what
 * the runner and the views add when the project gives no `-O`
 * (packs/cpp/src/toolchain.js, compileArgs).
 *
 * Swift: saved with the project (no project file of the browser's sets it)
 * and sent with Run and Test; Download writes it into Package.swift.
 *
 * Scala: whether the Scala.js linker runs its optimizer, saved with the
 * project and sent with Run. Download cannot carry it: the downloaded
 * project is an sbt project for the JVM, which has no such switch.
 *
 * Imports nothing, so `node` can load this file directly (tests/optimization.mjs).
 */

/** One level of a language, in the order the picker lists them. */
export interface OptimizationLevel {
	/**
	 * The flag that selects it, as the compiler spells it (`-O2`, `-Onone`),
	 * or, for Scala, whose linker takes no flag, `off` or `on`: what Run
	 * sends as `options.optimization` (packs/CONTRACT.md).
	 */
	readonly flag: string;
	/** What the picker shows. */
	readonly label: string;
	/** The level a project is on when it chose none. */
	readonly default?: true;
	/**
	 * Why the level cannot be chosen yet, when it cannot: the picker shows it
	 * disabled with this as its tooltip, and a saved project naming it is on
	 * the default level.
	 */
	readonly unavailable?: string;
}

/** The languages with levels. */
export type OptimizingLanguage = 'cpp' | 'swift' | 'scala';

/**
 * Clang's levels. `-O2` is the default because it is what Run used before
 * the level could be chosen: a project without a `-O` line runs as it did.
 */
export const CPP_LEVELS: readonly OptimizationLevel[] = [
	{ flag: '-O0', label: '-O0 (none)' },
	{ flag: '-O1', label: '-O1' },
	{ flag: '-O2', label: '-O2', default: true },
	{ flag: '-O3', label: '-O3' },
	{ flag: '-Os', label: '-Os (size)' },
	{ flag: '-Oz', label: '-Oz (smallest)' },
];

/**
 * Why Swift's optimising levels are not offered yet: the pinned compiler
 * (swift-toolchain-wasm swift-6.3.3-wasm-3) corrupts its heap at -O and
 * -Osize (an AllocStackInst or DebugValueInst allocated without the padding
 * its debug expression needs on a 32-bit host) and traps in free() on
 * ordinary programs. The fix is that project's patch 0004; packs/swift
 * README, "Optimization", says what is left.
 */
const SWIFT_O_UNAVAILABLE = 'Not available yet: the browser\'s Swift compiler crashes at this level (a heap corruption, fixed in the next toolchain release). See the Swift pack\'s README, "Optimization".';

/**
 * swift-frontend's levels. `-Onone` is the default, what `swift build`
 * uses in its debug configuration and what Run used before the level could
 * be chosen.
 */
export const SWIFT_LEVELS: readonly OptimizationLevel[] = [
	{ flag: '-Onone', label: '-Onone', default: true },
	{ flag: '-O', label: '-O', unavailable: SWIFT_O_UNAVAILABLE },
	{ flag: '-Osize', label: '-Osize', unavailable: SWIFT_O_UNAVAILABLE },
];

/**
 * The Scala.js linker's optimizer, off or on. Off is the default because it
 * is what Run did before (each Run links the whole program, and the
 * optimizer adds about a second to that); on is what `sbt fastLinkJS` does,
 * and makes collection-heavy programs about a fifth faster (packs/scala
 * README, "Optimization").
 */
export const SCALA_LEVELS: readonly OptimizationLevel[] = [
	{ flag: 'off', label: 'Optimizer off', default: true },
	{ flag: 'on', label: 'Optimizer on' },
];

/** The levels of `language`, or null for a language without them. */
export function levelsOf(language: string): readonly OptimizationLevel[] | null {
	return language === 'cpp' ? CPP_LEVELS : language === 'swift' ? SWIFT_LEVELS : language === 'scala' ? SCALA_LEVELS : null;
}

/** The default level of a language with levels. */
export function defaultLevel(levels: readonly OptimizationLevel[]): OptimizationLevel {
	return levels.find((l) => l.default) ?? levels[0]!;
}

/**
 * Which level a project is on: `default` (it chose none), `level` (it
 * chose one of the list's), or `other` with the flag as it is spelt (a
 * hand-written `-Og` or `-Ofast` in compile_flags.txt, which clang takes
 * but the picker does not offer).
 */
export type LevelChoice = { kind: 'default'; level: OptimizationLevel } | { kind: 'level'; level: OptimizationLevel } | { kind: 'other'; flag: string };

/**
 * The level compile_flags.txt (its text, or null/undefined when the project
 * has none) puts a C or C++ project on. One flag per line, each trimmed,
 * empty lines ignored, as clangd reads the file; every line starting with
 * `-O` is a level, and the last one wins, as in clang, and as the C++
 * runner decides whether to add its own `-O2`. Never throws.
 */
export function cppLevelOf(flagsText: string | null | undefined): LevelChoice {
	const lines = (flagsText ?? '').split(/\r?\n/).map((l) => l.trim());
	const flag = lines.filter((l) => l.startsWith('-O')).at(-1);
	if (flag === undefined) return { kind: 'default', level: defaultLevel(CPP_LEVELS) };
	const level = CPP_LEVELS.find((l) => l.flag === flag);
	return level ? { kind: 'level', level } : { kind: 'other', flag };
}

/**
 * compile_flags.txt with the project on level `flag` (one of CPP_LEVELS):
 * every `-O` line removed, then, for a level other than the default, the
 * flag appended as the last line, with the line ending the file already
 * uses. Every other line is kept byte for byte. Appending rather than
 * prepending keeps the file's first line where it was (the Target picker
 * puts `--target=` there). `flagsText` undefined means the project has no
 * compile_flags.txt: the result is then the new file (`''` for the
 * default, which needs no file).
 */
export function withCppLevel(flagsText: string | undefined, flag: string): string {
	const text = flagsText ?? '';
	const lines = text.split(/(?<=\n)/).filter((l) => l !== '' && !l.trim().startsWith('-O'));
	const level = CPP_LEVELS.find((l) => l.flag === flag);
	if (!level || level.default) return lines.join('');
	const eol = /\r\n/.test(text) ? '\r\n' : '\n';
	const last = lines.at(-1);
	if (last !== undefined && !last.endsWith('\n')) lines[lines.length - 1] = last + eol;
	return `${lines.join('')}${flag}${eol}`;
}

/**
 * A saved level as the project's level of `language`: a flag of its list,
 * or null (the default) for anything else, so a saved project with a bad
 * value still loads. Never throws.
 */
export function savedLevelOf(language: string, value: unknown): string | null {
	const levels = levelsOf(language);
	return levels?.some((l) => l.flag === value && !l.unavailable) ? (value as string) : null;
}
