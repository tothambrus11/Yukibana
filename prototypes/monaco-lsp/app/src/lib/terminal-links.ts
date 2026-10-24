/**
 * The terminal's links: a project file's path followed by a line, and
 * maybe a column (`main.cpp:12` or `main.cpp:12:5`), as compilers print a
 * diagnostic's place and the C and C++ sanitizers print a report's frames
 * (packs/cpp README, "Sanitizers"). The terminal shows each as a link that
 * opens the file at that line.
 *
 * Only paths of files the project has become links: a path is the
 * project's (`tests/geometry_test.cpp`), as the pack names it, so a frame in
 * a system header (`/usr/include/c++/v1/vector:1455`) stays plain text.
 *
 * Imports nothing, so `node` can load this file directly
 * (tests/terminal-links.mjs).
 */

/** Where a link goes: a project path, a line from 1, and a column from 1 or null for none. */
export interface Place {
	readonly path: string;
	readonly line: number;
	readonly column: number | null;
}

/** A piece of a terminal chunk's text: the text as printed, and where it goes when it is a link. */
export interface Piece {
	readonly text: string;
	readonly place: Place | null;
}

// A path is a run of characters a project path may hold, not starting
// with a slash (a project path is relative); the line and column are
// whole numbers. What comes before must not be a path character, so
// `/workspace/main.cpp:3` is not a link to main.cpp.
const PLACE = /(?<![\w./+-])([\w.+-][\w./+-]*):(\d+)(?::(\d+))?/g;

/**
 * `text` split into pieces, the links among them: every `path:line` or
 * `path:line:column` whose path is in `files`. The pieces' texts joined
 * are `text`. A text without a link is one piece, its place null.
 */
export function linksIn(text: string, files: ReadonlySet<string>): Piece[] {
	const pieces: Piece[] = [];
	let at = 0;
	for (const m of text.matchAll(PLACE)) {
		const [whole, path = '', line = '', column] = m;
		if (!files.has(path) || Number(line) < 1) continue;
		if (m.index > at) pieces.push({ text: text.slice(at, m.index), place: null });
		pieces.push({ text: whole, place: { path, line: Number(line), column: column ? Number(column) : null } });
		at = m.index + whole.length;
	}
	if (at < text.length || pieces.length === 0) pieces.push({ text: text.slice(at), place: null });
	return pieces;
}
