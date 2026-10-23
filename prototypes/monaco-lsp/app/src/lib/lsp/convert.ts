/**
 * Pure conversions between LSP values and Monaco values. LSP lines and
 * characters count from 0 in UTF-16 code units; Monaco's line numbers and
 * columns count from 1 in UTF-16 code units, so a position converts by
 * adding or subtracting one and nothing else.
 */
import type * as lsp from 'vscode-languageserver-protocol';
import { monaco } from '../monaco';

type Range = monaco.IRange;

/** A Monaco position as an LSP position. */
export function toPosition(p: monaco.IPosition): lsp.Position {
	return { line: p.lineNumber - 1, character: p.column - 1 };
}

/** A Monaco range as an LSP range. */
export function toLspRange(r: Range): lsp.Range {
	return {
		start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
		end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
	};
}

/** An LSP range as a Monaco range. */
export function toRange(r: lsp.Range): Range {
	return {
		startLineNumber: r.start.line + 1,
		startColumn: r.start.character + 1,
		endLineNumber: r.end.line + 1,
		endColumn: r.end.character + 1,
	};
}

/** Whether two LSP ranges share at least one position (touching counts). */
export function rangesTouch(a: lsp.Range, b: lsp.Range): boolean {
	const before = (x: lsp.Position, y: lsp.Position) => x.line < y.line || (x.line === y.line && x.character < y.character);
	return !before(a.end, b.start) && !before(b.end, a.start);
}

/** The URI string a server sent, normalised to how Monaco prints the same URI. */
export function uriKey(uri: string): string {
	return monaco.Uri.parse(uri).toString();
}

/** Escapes text so Markdown renders it literally. */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/**
 * Hover text, documentation or a diagnostic message as Markdown. Plain text
 * is escaped rather than trusted to contain no Markdown; a `MarkedString`
 * with a language becomes a fenced code block. Links in server Markdown are
 * shown but never trusted to run commands.
 */
export function toMarkdown(value: lsp.MarkupContent | lsp.MarkedString): monaco.IMarkdownString {
	if (typeof value === 'string') return { value };
	if ('kind' in value) return { value: value.kind === 'markdown' ? value.value : escapeMarkdown(value.value) };
	return { value: '```' + value.language + '\n' + value.value + '\n```' };
}

/** Documentation as Monaco takes it: plain strings stay plain. */
export function toDocumentation(doc: string | lsp.MarkupContent | undefined): string | monaco.IMarkdownString | undefined {
	if (doc === undefined || typeof doc === 'string') return doc;
	return doc.kind === 'markdown' ? { value: doc.value } : doc.value;
}

/** LSP `DiagnosticSeverity` (1 error … 4 hint, absent meaning error) as a Monaco severity. */
export function toSeverity(s: lsp.DiagnosticSeverity | undefined): monaco.MarkerSeverity {
	switch (s) {
		case 2:
			return monaco.MarkerSeverity.Warning;
		case 3:
			return monaco.MarkerSeverity.Info;
		case 4:
			return monaco.MarkerSeverity.Hint;
		default:
			return monaco.MarkerSeverity.Error;
	}
}

/** An LSP diagnostic as a Monaco marker. */
export function toMarker(d: lsp.Diagnostic): monaco.editor.IMarkerData {
	const tags = (d.tags ?? []).map((t) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated));
	const code = d.code === undefined ? undefined : String(d.code);
	return {
		...toRange(d.range),
		message: d.message,
		severity: toSeverity(d.severity),
		...(d.source !== undefined && { source: d.source }),
		...(code !== undefined && { code }),
		...(tags.length > 0 && { tags }),
		...(d.relatedInformation && {
			relatedInformation: d.relatedInformation.map((r) => ({
				resource: monaco.Uri.parse(r.location.uri),
				message: r.message,
				...toRange(r.location.range),
			})),
		}),
	};
}

/** LSP `CompletionItemKind` (1-based, Text … TypeParameter) as Monaco's own enum. */
const COMPLETION_KINDS: readonly monaco.languages.CompletionItemKind[] = (() => {
	const k = monaco.languages.CompletionItemKind;
	return [
		k.Text, k.Text, k.Method, k.Function, k.Constructor, k.Field, k.Variable, k.Class, k.Interface, k.Module,
		k.Property, k.Unit, k.Value, k.Enum, k.Keyword, k.Snippet, k.Color, k.File, k.Reference, k.Folder,
		k.EnumMember, k.Constant, k.Struct, k.Event, k.Operator, k.TypeParameter,
	];
})();

/** An LSP completion item kind as Monaco's; unknown kinds read as text. */
export function toCompletionKind(kind: lsp.CompletionItemKind | undefined): monaco.languages.CompletionItemKind {
	return COMPLETION_KINDS[kind ?? 1] ?? monaco.languages.CompletionItemKind.Text;
}

/** An LSP text edit as a Monaco one. */
export function toTextEdit(e: lsp.TextEdit): monaco.languages.TextEdit {
	return { range: toRange(e.range), text: e.newText };
}

/**
 * An LSP completion item as a Monaco suggestion. `defaultRange` is the word
 * before the cursor, used when neither the item nor the list's defaults
 * say what the item replaces.
 */
export function toSuggestion(
	item: lsp.CompletionItem,
	defaults: lsp.CompletionList['itemDefaults'],
	defaultRange: Range,
): monaco.languages.CompletionItem {
	const edit = item.textEdit;
	const editRange = defaults?.editRange;
	let range: monaco.languages.CompletionItem['range'] = defaultRange;
	let text = item.insertText ?? item.label;
	if (edit) {
		text = edit.newText;
		range = 'range' in edit ? toRange(edit.range) : { insert: toRange(edit.insert), replace: toRange(edit.replace) };
	} else if (editRange) {
		range = 'start' in editRange ? toRange(editRange) : { insert: toRange(editRange.insert), replace: toRange(editRange.replace) };
	}
	const format = item.insertTextFormat ?? defaults?.insertTextFormat;
	const documentation = toDocumentation(item.documentation);
	const commitCharacters = item.commitCharacters ?? defaults?.commitCharacters;
	return {
		label: item.labelDetails
			? { label: item.label, ...(item.labelDetails.detail !== undefined && { detail: item.labelDetails.detail }), ...(item.labelDetails.description !== undefined && { description: item.labelDetails.description }) }
			: item.label,
		kind: toCompletionKind(item.kind),
		insertText: text,
		range,
		...(format === 2 && { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }),
		...(item.detail != null && { detail: item.detail }),
		...(documentation !== undefined && { documentation }),
		...(item.sortText !== undefined && { sortText: item.sortText }),
		...(item.filterText !== undefined && { filterText: item.filterText }),
		...(item.preselect !== undefined && { preselect: item.preselect }),
		...(commitCharacters !== undefined && { commitCharacters }),
		...((item.deprecated || item.tags?.includes(1)) && { tags: [monaco.languages.CompletionItemTag.Deprecated] }),
		...(item.additionalTextEdits && { additionalTextEdits: item.additionalTextEdits.map(toTextEdit) }),
	};
}

/** LSP `SymbolKind` is 1-based, Monaco's is the same list from 0. */
export function toSymbolKind(kind: lsp.SymbolKind): monaco.languages.SymbolKind {
	return (kind - 1) as monaco.languages.SymbolKind;
}

/** A document symbol tree, or a flat `SymbolInformation` list, as Monaco symbols. */
export function toDocumentSymbols(symbols: lsp.DocumentSymbol[] | lsp.SymbolInformation[]): monaco.languages.DocumentSymbol[] {
	return symbols.map((s): monaco.languages.DocumentSymbol => {
		if ('location' in s) {
			const range = toRange(s.location.range);
			return { name: s.name, detail: '', kind: toSymbolKind(s.kind), tags: [], range, selectionRange: range, ...(s.containerName !== undefined && { containerName: s.containerName }) };
		}
		return {
			name: s.name,
			detail: s.detail ?? '',
			kind: toSymbolKind(s.kind),
			tags: s.tags?.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
			range: toRange(s.range),
			selectionRange: toRange(s.selectionRange),
			...(s.children && { children: toDocumentSymbols(s.children) }),
		};
	});
}

/** A definition-like answer (one location, several, or links) as Monaco location links. */
export function toLocations(result: lsp.Location | lsp.Location[] | lsp.LocationLink[] | null): monaco.languages.LocationLink[] {
	if (!result) return [];
	const list: (lsp.Location | lsp.LocationLink)[] = Array.isArray(result) ? result : [result];
	return list.map((l) =>
		'targetUri' in l
			? {
					uri: monaco.Uri.parse(l.targetUri),
					range: toRange(l.targetRange),
					targetSelectionRange: toRange(l.targetSelectionRange),
					...(l.originSelectionRange && { originSelectionRange: toRange(l.originSelectionRange) }),
				}
			: { uri: monaco.Uri.parse(l.uri), range: toRange(l.range) },
	);
}

/**
 * An LSP workspace edit as a Monaco one. Only text edits are carried: file
 * creation, renaming and deletion are returned in `unsupported` so the
 * caller can say they were not applied instead of dropping them.
 */
export function toWorkspaceEdit(edit: lsp.WorkspaceEdit): { edit: { edits: monaco.languages.IWorkspaceTextEdit[] }; unsupported: string[] } {
	const edits: monaco.languages.IWorkspaceTextEdit[] = [];
	const unsupported: string[] = [];
	const add = (uri: string, e: lsp.TextEdit | lsp.AnnotatedTextEdit) =>
		edits.push({ resource: monaco.Uri.parse(uri), textEdit: toTextEdit(e), versionId: undefined });
	for (const [uri, list] of Object.entries(edit.changes ?? {})) for (const e of list) add(uri, e);
	for (const change of edit.documentChanges ?? []) {
		if ('textDocument' in change) for (const e of change.edits) add(change.textDocument.uri, e);
		else unsupported.push(`${change.kind} ${'uri' in change ? change.uri : change.oldUri}`);
	}
	return { edit: { edits }, unsupported };
}
