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

/**
 * Where an output line came from: its source line, and the column there the
 * compiler recorded (1-based; 0 or absent: none), which is where the
 * expression the line computes starts, or its operator (packs/CONTRACT.md).
 */
export interface MappedLine extends SourceLine {
	column?: number;
}

/** Per output line, in order, the source line it came from, or null (labels, directives, lines with no location). */
export type LineMap = readonly (MappedLine | null)[];

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

/** `file:line`, the key a source line goes by in `hueGroups`. */
export const lineKey = (file: string, line: number) => `${file}:${line}`;

/**
 * A hue (an index below `hues`) for every source line that produced code in
 * any of `maps`, keyed by `lineKey`, such that two lines whose output sits
 * side by side in a view (consecutive rows), or which are next to each other
 * in the source, never share one; among the hues their neighbours leave, a
 * line takes the one used least so far (the lowest on a tie). Lines are
 * coloured in source order (file, then line), so the same output gets the
 * same colours. With more neighbours than hues, a line shares one with a
 * neighbour rather than going without.
 */
export function hueGroups(maps: readonly LineMap[], hues: number): Map<string, number> {
	const lines = new Map<string, SourceLine>();
	const near = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		if (a === b) return;
		for (const [x, y] of [[a, b], [b, a]] as const) {
			let set = near.get(x);
			if (!set) near.set(x, (set = new Set()));
			set.add(y);
		}
	};
	for (const map of maps) {
		let previous: string | null = null;
		for (const at of map) {
			const key = at ? lineKey(at.file, at.line) : null;
			if (at && key) lines.set(key, { file: at.file, line: at.line });
			if (key && previous) link(key, previous);
			previous = key;
		}
	}
	for (const [key, at] of lines) {
		const below = lineKey(at.file, at.line + 1);
		if (lines.has(below)) link(key, below);
	}
	const order = [...lines.entries()].sort(([, a], [, b]) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
	const hue = new Map<string, number>();
	const used = new Array<number>(hues).fill(0);
	for (const [key] of order) {
		const taken = new Set([...(near.get(key) ?? [])].map((n) => hue.get(n)).filter((h) => h !== undefined));
		let best = -1;
		for (let h = 0; h < hues; h++) if (!taken.has(h) && (best < 0 || used[h]! < used[best]!)) best = h;
		if (best < 0) best = used.indexOf(Math.min(...used));
		hue.set(key, best);
		used[best]!++;
	}
	return hue;
}

/** A part of one source line: columns `start` (1-based, inclusive) to `end` (exclusive). */
export interface Part {
	start: number;
	end: number;
}

/** A language server range (0-based lines and characters, end exclusive), as `textDocument/selectionRange` gives them. */
export interface ServerRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

/**
 * The part of line `line` that code recorded at `column` came from, out of
 * the selection ranges at that position (`chain`, innermost first, as a
 * language server's `selectionRange` nests them): the largest range on the
 * line alone that starts at `column` (a call, `++i`, a member access), or,
 * when none starts there (the compiler records a binary expression at its
 * operator, the `<` of `i < n`), the innermost range on the line alone, which
 * is the expression the operator belongs to. Null when no range of the chain
 * lies on the line alone, or `column` is 0.
 */
export function partFromChain(chain: readonly ServerRange[], line: number, column: number): Part | null {
	if (column < 1) return null;
	const onLine = chain
		.filter((r) => r.start.line === line - 1 && r.end.line === line - 1 && r.end.character > r.start.character)
		.map((r) => ({ start: r.start.character + 1, end: r.end.character + 1 }))
		.filter((p) => p.start <= column && column < p.end);
	let largest: Part | null = null;
	for (const p of onLine) if (p.start === column && (!largest || p.end - p.start > largest.end - largest.start)) largest = p;
	return largest ?? onLine[0] ?? null;
}

/**
 * The part a caret at `column` is in: the smallest of `parts` that contains
 * it (a caret right after a part's last character counts as in it, when no
 * part contains it otherwise), or null.
 */
export function partAt(parts: readonly Part[], column: number): Part | null {
	const smallest = (fits: (p: Part) => boolean) => {
		let best: Part | null = null;
		for (const p of parts) if (fits(p) && (!best || p.end - p.start < best.end - best.start)) best = p;
		return best;
	};
	return smallest((p) => p.start <= column && column < p.end) ?? smallest((p) => column === p.end);
}

export const samePart = (a: Part | null, b: Part | null) => !!a && !!b && a.start === b.start && a.end === b.end;

/**
 * Which of `runs` (output line runs, as runsOf gives them) to bring into a
 * view showing lines `top` to `bottom`: null when one is already in view
 * (no scrolling), else the one nearest to it.
 */
export function runToReveal(runs: readonly { start: number; end: number }[], top: number, bottom: number): { start: number; end: number } | null {
	if (runs.some((r) => r.end >= top && r.start <= bottom)) return null;
	let best: { start: number; end: number } | null = null;
	let distance = Infinity;
	for (const r of runs) {
		const d = r.start > bottom ? r.start - bottom : top - r.end;
		if (d < distance) (best = r), (distance = d);
	}
	return best;
}
