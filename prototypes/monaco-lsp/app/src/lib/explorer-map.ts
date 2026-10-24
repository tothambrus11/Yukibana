/**
 * The source ↔ output line mapping of the compiler output views: which
 * lines of the LLVM IR or assembly came from a source line, and which source
 * line an output line came from. The pack's explorer sends one entry per
 * output line (packs/CONTRACT.md, "Showing compiler output"); these are the
 * lookups the views make on every caret move, so they are pure and tested
 * on their own (tests/explorer-map.mjs).
 *
 * Imports nothing, so `node` can load this file directly.
 */

/** A source line: a project path (or a path outside the project, for a system header) and a 1-based line. */
export interface SourceLine {
	file: string;
	line: number;
}

/** Per output line, in order, the source line it came from, or null (labels, directives, lines with no location). */
export type LineMap = readonly (SourceLine | null)[];

/**
 * The output lines (1-based, ascending) that came from line `line` of
 * `file`; empty when none did, or when `line` is not a positive integer.
 * `lines[i]` describes output line i + 1.
 */
export function outputLinesFor(lines: LineMap, file: string, line: number): number[] {
	const found: number[] = [];
	if (!Number.isInteger(line) || line < 1) return found;
	for (let i = 0; i < lines.length; i++) {
		const at = lines[i];
		if (at && at.line === line && at.file === file) found.push(i + 1);
	}
	return found;
}

/**
 * The source line output line `outputLine` (1-based) came from, or null
 * when it came from none, or is outside the output.
 */
export function sourceOf(lines: LineMap, outputLine: number): SourceLine | null {
	if (!Number.isInteger(outputLine) || outputLine < 1) return null;
	return lines[outputLine - 1] ?? null;
}

/**
 * Runs of consecutive output lines (1-based, inclusive) among `outputLines`,
 * which must be ascending: what a view decorates as one block each, so a
 * mapped stretch reads as one highlight rather than a stack of lines.
 */
export function runsOf(outputLines: readonly number[]): { start: number; end: number }[] {
	const runs: { start: number; end: number }[] = [];
	for (const n of outputLines) {
		const last = runs.at(-1);
		if (last && n === last.end + 1) last.end = n;
		else runs.push({ start: n, end: n });
	}
	return runs;
}

/** C and C++ sources, which the views compile; headers are compiled through a source that includes them. */
const SOURCE = /\.(c|cc|cpp|cxx|c\+\+|C)$/;

/** Whether `path` is a C or C++ source file (`.c .cc .cpp .cxx .c++ .C`), the kind a view can show. */
export function isViewSource(path: string): boolean {
	return SOURCE.test(path);
}

/**
 * The source a view shows once the editor shows `active`: `active` itself
 * when it is a C or C++ source, else (a header, any other file, no file) the
 * source shown before, `previous`, which may be null: the view then asks for
 * a source to be opened.
 */
export function viewSourceFor(active: string | null, previous: string | null): string | null {
	return active !== null && isViewSource(active) ? active : previous;
}

/**
 * clang's arguments as the view's toolbar shows them: the ones that say how
 * the code is compiled (`-O2`, `-std=`, `-f…`, `-m…`, `-D…`), without the
 * target (the toolbar shows its triple), the ones that only say where files
 * are (`-I`, `-isystem`, `--sysroot`, `-o`, `-resource-dir` and their values),
 * and the ones every view adds and that do not change the code (`-S`,
 * `-emit-llvm`, `-gline-tables-only`, `-fno-discard-value-names`). The full
 * list is the toolbar's title.
 */
export function shortFlags(flags: readonly string[]): string[] {
	const withValue = new Set(['-I', '-isystem', '-internal-isystem', '-idirafter', '-iquote', '-o', '-resource-dir', '--sysroot', '-isysroot', '-include', '-MF']);
	const joined = /^(-I|-isystem|-iquote|-idirafter|--sysroot=|-isysroot|-resource-dir=|-o)./;
	const same = new Set(['-S', '-emit-llvm', '-c', '-fno-color-diagnostics', '-fcolor-diagnostics', '-gline-tables-only', '-fno-discard-value-names']);
	const shown: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const f = flags[i]!;
		if (withValue.has(f)) {
			i++;
			continue;
		}
		if (joined.test(f) || same.has(f) || f.startsWith('--target=')) continue;
		shown.push(f);
	}
	return shown;
}
