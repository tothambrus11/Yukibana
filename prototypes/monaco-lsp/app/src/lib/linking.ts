/**
 * The source, the LLVM IR and the assembly as one picture (Ambrus's design,
 * from the linked-panes prototype of 2026-10-24):
 *
 * - While a view is open, every source line that produced code has a hue
 *   (explorer-map.ts `hueGroups`), and its rows are tinted with it in the
 *   source and in every view, so they can be matched without moving the
 *   caret.
 * - One line has focus: the caret's, in the source or in a view (the
 *   anchor), or, while Ctrl/Cmd is held, the one under the mouse (a peek).
 *   It is drawn stronger in every pane at once, and everything else fades.
 * - Within the line, the part the caret is in, or the part the instruction
 *   under the view's caret came from, is the selected expression: inverted
 *   in the source, and its instructions are the primary rows in the views;
 *   the line's other instructions are secondary rows, which look like the
 *   source line. The parts come from the compiler's columns (packs/CONTRACT.md)
 *   and the language server's selection ranges at them
 *   (explorer-map.ts `partFromChain`).
 * - The other panes scroll to the focused line when it is off screen. A peek
 *   scrolls them back where they were when Ctrl/Cmd is released.
 *
 * Colours: link-colours.ts. One Linker serves every view of an explorer;
 * views join and leave it, and the last one to leave takes the source's
 * decorations with it.
 *
 * Loaded with compiler-view.ts; Monaco is the host's, for the reason
 * asm-languages.ts gives.
 */
import type { monaco as Monaco } from './monaco';
import { hueGroups, lineKey, partAt, partFromChain, runsOf, runToReveal, samePart, type LineMap, type MappedLine, type Part, type ServerRange, type SourceLine } from './explorer-map';
import { HUES, linkStyleSheet } from './link-colours';
import type { Hex, Theme } from './palette';
import type { ExploreKind } from './languages';

type Editor = Monaco.editor.ICodeEditor;

/** A caret in a source editor: its file, line and column (1-based). */
export interface Caret extends SourceLine {
	column: number;
}

/** A selection range chain as a language server nests them (vscode-languageserver-protocol's SelectionRange). */
export interface ServerSelectionRange {
	range: ServerRange;
	parent?: ServerSelectionRange;
}

/** What the linker needs of the editor area. */
export interface LinkHost {
	monaco: typeof Monaco;
	/** The editor showing project file `path`, if one is open. */
	editorFor(path: string): Editor | null;
	/** The model of project file `path`, if it is one. */
	modelFor(path: string): Monaco.editor.ITextModel | null;
	/** As ViewHost.onSourceCursor, with the caret's column. */
	onSourceCursor(listener: (caret: Caret | null) => void): Monaco.IDisposable;
	/** The language server's selection ranges at `positions` of `path`, one chain per position, or null. */
	selectionRanges(path: string, positions: Monaco.IPosition[]): Promise<ServerSelectionRange[] | null>;
	/** Every text colour a tinted row can show, per theme (theme.svelte.ts VIEW_TEXT). */
	textColours: Record<Theme, Hex[]>;
}

/** The line in focus, and where the focus came from: a source caret (`column`: the caret's) or a view's row (`column`: its instruction's). */
interface Focus {
	file: string;
	line: number;
	column: number;
	from: 'source' | ExploreKind;
}

const sameFocus = (a: Focus | null, b: Focus | null) => a === b || (!!a && !!b && a.file === b.file && a.line === b.line && a.column === b.column && a.from === b.from);

/** Where the mouse is: a pane, and the line and column under it. */
interface Pointer {
	pane: 'source' | ExploreKind;
	editor: Editor;
	file: string | null;
	line: number;
	column: number;
}

/** One decorated stretch of rows: the row's classes, its text's, its line number's. */
interface RowLook {
	row: string;
	text: string;
	number: string;
}

const STYLE_ID = 'yk-link-style';

const linkers = new WeakMap<object, Linker>();

/** The linker of the views keyed by `owner` (the explorer), created with the first. */
export function linkerFor(owner: object, host: LinkHost): Linker {
	let linker = linkers.get(owner);
	if (!linker) {
		linker = new Linker(host, () => linkers.delete(owner));
		linkers.set(owner, linker);
	}
	return linker;
}

export class Linker {
	private readonly monaco: typeof Monaco;
	private readonly views = new Map<ExploreKind, { editor: Editor; lines: LineMap; decorations: Monaco.editor.IEditorDecorationsCollection; listeners: Monaco.IDisposable[] }>();
	/** The source editors decorated, by project path. */
	private readonly sources = new Map<string, { editor: Editor; decorations: Monaco.editor.IEditorDecorationsCollection; listeners: Monaco.IDisposable[] }>();
	private hues = new Map<string, number>();
	private anchor: Focus | null = null;
	private peek: Focus | null = null;
	private pointer: Pointer | null = null;
	/** Before a peek: every pane's scroll position; the panes the peek scrolled go back to it. */
	private readonly rest = new Map<Editor, number>();
	private readonly scrolled = new Set<Editor>();
	/** The parts of a line, by `file:line@version`: per recorded column, the part (null: none found); absent while asked for. */
	private readonly parts = new Map<string, Map<number, Part | null>>();
	private readonly disposables: Monaco.IDisposable[] = [];

	constructor(
		private readonly host: LinkHost,
		private readonly forget: () => void,
	) {
		this.monaco = host.monaco;
		if (!document.getElementById(STYLE_ID)) {
			const style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = linkStyleSheet(host.textColours);
			document.head.append(style);
		}
		const key = (down: boolean) => (e: KeyboardEvent) => {
			if (e.key !== 'Control' && e.key !== 'Meta') return;
			if (down && this.pointer) this.peekAt(this.focusAt(this.pointer));
			if (!down) this.endPeek();
		};
		const keydown = key(true);
		const keyup = key(false);
		const blur = () => this.endPeek();
		addEventListener('keydown', keydown, true);
		addEventListener('keyup', keyup, true);
		addEventListener('blur', blur);
		this.disposables.push(
			{ dispose: () => (removeEventListener('keydown', keydown, true), removeEventListener('keyup', keyup, true), removeEventListener('blur', blur)) },
			host.onSourceCursor((caret) => this.sourceCaret(caret)),
		);
	}

	/**
	 * Shows `lines` (the map of the text `editor` shows; null: no mapped
	 * output, such as clang's errors) as view `kind`'s, and redraws.
	 */
	setView(kind: ExploreKind, editor: Editor, lines: LineMap | null): void {
		let view = this.views.get(kind);
		if (!view || view.editor !== editor) {
			if (view) for (const d of view.listeners) d.dispose();
			view = { editor, lines: [], decorations: editor.createDecorationsCollection(), listeners: this.listen(editor, kind) };
			view.listeners.push(
				editor.onDidChangeCursorPosition((e) => {
					if (e.reason === this.monaco.editor.CursorChangeReason.Explicit) this.outputCaret(kind, e.position.lineNumber);
				}),
				// A view in a tab behind another is laid out again when its tab is shown: the focus moved meanwhile.
				editor.onDidLayoutChange(() => this.revealIn(kind)),
			);
			this.views.set(kind, view);
		}
		view.lines = lines ?? [];
		this.hues = hueGroups([...this.views.values()].map((v) => v.lines), HUES.length);
		this.render();
		this.revealIn(kind);
	}

	/** Brings the focus's rows into view `kind` when none is in view (its text or its size changed, not the focus). */
	private revealIn(kind: ExploreKind): void {
		const focus = this.peek ?? this.anchor;
		const editor = this.views.get(kind)?.editor;
		if (focus && editor) this.reveal(focus, null, !!this.peek, editor);
	}

	/** Takes view `kind` out; the last view out clears the source's decorations and ends the linker. */
	removeView(kind: ExploreKind): void {
		const view = this.views.get(kind);
		if (!view) return;
		for (const d of view.listeners) d.dispose();
		view.decorations.clear();
		this.views.delete(kind);
		if (this.views.size) {
			this.hues = hueGroups([...this.views.values()].map((v) => v.lines), HUES.length);
			this.render();
			return;
		}
		for (const s of this.sources.values()) {
			s.decorations.clear();
			for (const d of s.listeners) d.dispose();
		}
		this.sources.clear();
		for (const d of this.disposables) d.dispose();
		this.forget();
	}

	/** The source line a view's row came from, or null. */
	private entry(kind: ExploreKind, line: number): MappedLine | null {
		return this.views.get(kind)?.lines[line - 1] ?? null;
	}

	private sourceCaret(caret: Caret | null): void {
		const focus: Focus | null = caret && { file: caret.file, line: caret.line, column: caret.column, from: 'source' };
		if (sameFocus(focus, this.anchor)) return;
		this.anchor = focus;
		if (this.peek) return;
		this.render();
		if (focus) this.reveal(focus, null, false);
	}

	/** The caret moved to row `line` of view `kind` (by the user): that row's source line is the anchor. */
	private outputCaret(kind: ExploreKind, line: number): void {
		const at = this.entry(kind, line);
		const focus: Focus | null = at && { file: at.file, line: at.line, column: at.column ?? 0, from: kind };
		if (sameFocus(focus, this.anchor)) return;
		this.anchor = focus;
		if (this.peek) return;
		this.render();
		if (focus) this.reveal(focus, this.views.get(kind)?.editor ?? null, false);
	}

	/** Mouse listeners on a pane: Ctrl/Cmd + move peeks, a move without it ends the peek. */
	private listen(editor: Editor, pane: 'source' | ExploreKind, file: string | null = null): Monaco.IDisposable[] {
		return [
			editor.onMouseMove((e) => {
				const position = e.target.position;
				this.pointer = position ? { pane, editor, file, line: position.lineNumber, column: position.column } : null;
				if ((e.event.ctrlKey || e.event.metaKey) && this.pointer) this.peekAt(this.focusAt(this.pointer));
				else this.endPeek();
			}),
			editor.onMouseLeave(() => {
				if (this.pointer?.editor === editor) this.pointer = null;
			}),
		];
	}

	/** The focus the pointer gives: its source line, or its row's; null over a row that came from no line. */
	private focusAt(p: Pointer): Focus | null {
		if (p.pane === 'source') return p.file ? { file: p.file, line: p.line, column: p.column, from: 'source' } : null;
		const at = this.entry(p.pane, p.line);
		return at && { file: at.file, line: at.line, column: at.column ?? 0, from: p.pane };
	}

	private peekAt(focus: Focus | null): void {
		if (!focus || sameFocus(focus, this.peek)) return;
		if (!this.peek) {
			this.rest.clear();
			this.scrolled.clear();
			for (const e of this.panes()) this.rest.set(e, e.getScrollTop());
		}
		this.peek = focus;
		this.render();
		this.reveal(focus, this.pointer?.editor ?? null, true);
	}

	/** Ends a peek: the anchor has focus again, and the panes the peek scrolled go back. */
	private endPeek(): void {
		if (!this.peek) return;
		this.peek = null;
		for (const e of this.scrolled) {
			const top = this.rest.get(e);
			if (top !== undefined) e.setScrollTop(top, this.monaco.editor.ScrollType.Immediate);
		}
		this.scrolled.clear();
		this.rest.clear();
		this.render();
	}

	private panes(): Editor[] {
		return [...[...this.views.values()].map((v) => v.editor), ...[...this.sources.values()].map((s) => s.editor)];
	}

	/**
	 * Brings `focus`'s rows into every pane but `except` where none is in
	 * view, at once (Ambrus: everything instant); into `only` alone when given.
	 */
	private reveal(focus: Focus, except: Editor | null, peeking: boolean, only: Editor | null = null): void {
		const immediate = this.monaco.editor.ScrollType.Immediate;
		const visible = (e: Editor) => {
			const ranges = e.getVisibleRanges();
			return { top: ranges[0]?.startLineNumber ?? 1, bottom: ranges.at(-1)?.endLineNumber ?? 1 };
		};
		for (const view of this.views.values()) {
			if (view.editor === except || (only && view.editor !== only)) continue;
			const rows: number[] = [];
			view.lines.forEach((at, i) => {
				if (at && at.file === focus.file && at.line === focus.line) rows.push(i + 1);
			});
			const { top, bottom } = visible(view.editor);
			const run = runToReveal(runsOf(rows), top, bottom);
			if (!run) continue;
			view.editor.revealLineInCenter(run.start, immediate);
			if (peeking) this.scrolled.add(view.editor);
		}
		const source = this.sources.get(focus.file)?.editor;
		if (source && source !== except && !only) {
			const { top, bottom } = visible(source);
			if (focus.line < top || focus.line > bottom) {
				source.revealLineInCenter(focus.line, immediate);
				if (peeking) this.scrolled.add(source);
			}
		}
	}

	/**
	 * The parts of `file`'s line `line`, per column an instruction recorded
	 * there, or null while the language server is asked (render runs again
	 * when it answers).
	 */
	private partsOf(file: string, line: number): Map<number, Part | null> | null {
		const model = this.host.modelFor(file);
		if (!model || line < 1 || line > model.getLineCount()) return new Map();
		const key = `${lineKey(file, line)}@${model.getVersionId()}`;
		const known = this.parts.get(key);
		if (known) return known;
		if (this.parts.has(key + '?')) return null;
		const columns = new Set<number>();
		for (const view of this.views.values()) for (const at of view.lines) if (at && at.file === file && at.line === line && at.column) columns.add(at.column);
		const wanted = [...columns];
		if (wanted.length === 0) {
			const none = new Map<number, Part | null>();
			this.parts.set(key, none);
			return none;
		}
		this.parts.set(key + '?', new Map());
		const max = model.getLineMaxColumn(line);
		this.host.selectionRanges(file, wanted.map((c) => ({ lineNumber: line, column: Math.min(c, max) }))).then(
			(chains) => {
				const found = new Map<number, Part | null>();
				wanted.forEach((c, i) => {
					const chain: ServerRange[] = [];
					for (let r: ServerSelectionRange | undefined = chains?.[i]; r; r = r.parent) chain.push(r.range);
					found.set(c, partFromChain(chain, line, c));
				});
				this.parts.delete(key + '?');
				this.parts.set(key, found);
				this.render();
			},
			() => {
				this.parts.delete(key + '?');
				this.parts.set(key, new Map());
			},
		);
		return null;
	}

	/** The selected expression of `focus`: the part its caret is in, or its instruction's. */
	private selected(focus: Focus, parts: Map<number, Part | null> | null): Part | null {
		if (!parts) return null;
		if (focus.from !== 'source') return parts.get(focus.column) ?? null;
		return partAt([...parts.values()].filter((p): p is Part => p !== null), focus.column);
	}

	/**
	 * Redraws every pane for the focus (the peek's, else the anchor's). A
	 * focus on a line that produced no code (a blank line, an include) is
	 * none: fading every pane for it would only hide the links.
	 */
	private render(): void {
		const wanted = this.peek ?? this.anchor;
		const focus = wanted && this.hues.has(lineKey(wanted.file, wanted.line)) ? wanted : null;
		const parts = focus ? this.partsOf(focus.file, focus.line) : null;
		const selected = focus ? this.selected(focus, parts) : null;
		const look = (key: string | null, isFocus: boolean, primary: boolean): RowLook => {
			const hue = key === null ? undefined : this.hues.get(key);
			const h = hue === undefined ? '' : ` yk-h${hue}`;
			if (isFocus) {
				const lift = primary ? 'yk-lift-strong' : 'yk-lift';
				return { row: `yk-row ${primary ? 'yk-prim' : 'yk-sec'}${h}`, text: `yk-tx ${lift}`, number: `yk-ln ${lift}` };
			}
			if (!focus) return { row: hue === undefined ? '' : `yk-row yk-rest${h}`, text: '', number: '' };
			return hue === undefined ? { row: '', text: 'yk-tx yk-plain', number: '' } : { row: `yk-row yk-fade${h}`, text: 'yk-tx yk-faded', number: '' };
		};

		for (const view of this.views.values()) {
			const looks = view.lines.map((at) => {
				const isFocus = !!focus && !!at && at.file === focus.file && at.line === focus.line;
				const primary = isFocus && samePart(parts?.get(at!.column ?? 0) ?? null, selected);
				return look(at ? lineKey(at.file, at.line) : null, isFocus, primary);
			});
			view.decorations.set(this.decorationsOf(view.editor.getModel(), looks, []));
		}

		const files = new Set<string>();
		for (const view of this.views.values()) for (const at of view.lines) if (at) files.add(at.file);
		if (focus) files.add(focus.file);
		for (const [file, s] of this.sources)
			if (!files.has(file) || this.host.editorFor(file) !== s.editor) {
				s.decorations.clear();
				for (const d of s.listeners) d.dispose();
				this.sources.delete(file);
			}
		for (const file of files) {
			const editor = this.host.editorFor(file);
			const model = editor?.getModel();
			if (!editor || !model) continue;
			let source = this.sources.get(file);
			if (!source) this.sources.set(file, (source = { editor, decorations: editor.createDecorationsCollection(), listeners: this.listen(editor, 'source', file) }));
			const looks: RowLook[] = [];
			for (let n = 1; n <= model.getLineCount(); n++) {
				const isFocus = !!focus && focus.file === file && focus.line === n;
				looks.push(look(lineKey(file, n), isFocus, false));
			}
			const extra: Monaco.editor.IModelDeltaDecoration[] = [];
			if (focus && focus.file === file && focus.line <= model.getLineCount()) {
				const hue = this.hues.get(lineKey(file, focus.line));
				const h = hue === undefined ? '' : ` yk-h${hue}`;
				if (selected) extra.push({ range: new this.monaco.Range(focus.line, selected.start, focus.line, selected.end), options: { className: `yk-part-fill${h}`, inlineClassName: `yk-part${h}` } });
				// The positions the compiler recorded on the line: where each part's code starts.
				for (const column of parts?.keys() ?? []) {
					if (column > model.getLineMaxColumn(focus.line)) continue;
					const word = model.getWordAtPosition({ lineNumber: focus.line, column });
					const end = word && word.startColumn === column ? word.endColumn : column + 1;
					extra.push({ range: new this.monaco.Range(focus.line, column, focus.line, end), options: { inlineClassName: `yk-at${h}` } });
				}
			}
			source.decorations.set(this.decorationsOf(model, looks, extra));
		}
	}

	/** Decorations for `looks` (one per line of `model`), consecutive lines that look the same as one, and `extra`. */
	private decorationsOf(model: Monaco.editor.ITextModel | null, looks: RowLook[], extra: Monaco.editor.IModelDeltaDecoration[]): Monaco.editor.IModelDeltaDecoration[] {
		if (!model) return [];
		const out: Monaco.editor.IModelDeltaDecoration[] = [];
		const lineCount = model.getLineCount();
		for (let i = 0; i < looks.length && i < lineCount; ) {
			const l = looks[i]!;
			let j = i;
			while (j + 1 < looks.length && j + 1 < lineCount && looks[j + 1]!.row === l.row && looks[j + 1]!.text === l.text && looks[j + 1]!.number === l.number) j++;
			const start = i + 1;
			const end = j + 1;
			if (l.row || l.number)
				out.push({ range: new this.monaco.Range(start, 1, end, 1), options: { isWholeLine: true, ...(l.row && { className: l.row }), ...(l.number && { lineNumberClassName: l.number }) } });
			if (l.text) out.push({ range: new this.monaco.Range(start, 1, end, model.getLineMaxColumn(end)), options: { inlineClassName: l.text } });
			i = j + 1;
		}
		return out.concat(extra);
	}
}
