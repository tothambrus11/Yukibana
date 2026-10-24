/**
 * Conversions of LSP answers that need nothing from Monaco at run time, so
 * the unit tests can load them in Node (`convert.ts` imports the editor).
 * Lines here are Monaco's: counted from 1.
 */
import type * as lsp from 'vscode-languageserver-protocol';
import type * as monaco from 'monaco-editor/editor/editor.api';

/** At most this many characters of a server's error are shown to a person. */
const REASON_LIMIT = 300;

/**
 * A server's error message as one readable sentence, for a rename's
 * `rejectReason`. Only the first line is kept; Phpactor appends its PHP
 * stack trace to the message without a line break ("There are no file path
 * candidates#0 /opt/phpactor/…"), so a `#0 /` and what follows is dropped
 * too. Never empty: a server that said nothing gets a generic reason.
 */
export function reasonOf(message: string): string {
	const line = (message.split('\n')[0] ?? '').replace(/#0 \/.*$/, '').trim();
	if (!line) return 'The language server could not do this.';
	return line.length > REASON_LIMIT ? line.slice(0, REASON_LIMIT - 1) + '…' : line;
}

/**
 * A folding range in Monaco's lines, with LSP's kind string (`comment`,
 * `imports`, `region`, or a server's own) for the caller to turn into a
 * `FoldingRangeKind`.
 */
export interface Fold {
	start: number;
	end: number;
	kind?: string;
}

/**
 * LSP folding ranges as Monaco's. Monaco folds whole lines, and the client
 * declares `lineFoldingOnly` (which makes clangd end a range above its
 * closing brace, so the brace stays visible), so the characters are
 * ignored. A range of one line, or one that ends before it starts, folds
 * nothing and is dropped.
 */
export function toFolds(ranges: readonly lsp.FoldingRange[]): Fold[] {
	return ranges
		.filter((r) => r.endLine > r.startLine)
		.map((r) => ({ start: r.startLine + 1, end: r.endLine + 1, ...(r.kind !== undefined && { kind: r.kind }) }));
}

/**
 * An LSP selection range, a linked list from the innermost range outwards,
 * as the list Monaco wants for one position, innermost first. A parent that
 * does not contain its child breaks the chain there: LSP requires
 * containment, and Monaco's smart select would jump to an unrelated range.
 */
export function toSelectionChain(range: lsp.SelectionRange): monaco.languages.SelectionRange[] {
	const chain: monaco.languages.SelectionRange[] = [];
	let previous: lsp.Range | undefined;
	for (let r: lsp.SelectionRange | undefined = range; r; r = r.parent) {
		if (previous && !contains(r.range, previous)) break;
		chain.push({
			range: { startLineNumber: r.range.start.line + 1, startColumn: r.range.start.character + 1, endLineNumber: r.range.end.line + 1, endColumn: r.range.end.character + 1 },
		});
		previous = r.range;
	}
	return chain;
}

/** Whether LSP range `outer` contains `inner` (equal ranges count). */
function contains(outer: lsp.Range, inner: lsp.Range): boolean {
	const before = (a: lsp.Position, b: lsp.Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
	return before(outer.start, inner.start) && before(inner.end, outer.end);
}
