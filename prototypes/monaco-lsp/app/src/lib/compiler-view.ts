/**
 * A compiler output view (LLVM IR or assembly) inside a dockview panel: a
 * toolbar saying what the output is of (target, triple, flags, file, how
 * long it took) with the view's toggles, a progress bar while the compiler
 * downloads, and a read-only Monaco editor showing the output, or clang's
 * messages when the source does not compile.
 *
 * The output is mapped to the source a line at a time (explorer-map.ts): the
 * caret in a source editor lights up the output lines it produced (class
 * `yk-mapped`), and the caret on, or the mouse over, an output line lights up
 * its source line in that file's editor (`yk-mapped-source`, which the
 * editor area draws); Ctrl/Cmd+click on an output line opens its source line.
 *
 * Loaded by dynamic `import()` from dock.ts when a view first opens, with
 * the grammars it needs (asm-languages.ts), so a session that never opens
 * one does not download either. Monaco is the host's (`ViewHost.monaco`),
 * not imported, for the reason asm-languages.ts gives.
 */
import type { monaco as Monaco } from './monaco';
import { registerOutputLanguages } from './asm-languages';
import { asmLanguageOf, targetById } from './cpp-targets';
import { outputLinesFor, runsOf, shortFlags, sourceOf, type SourceLine } from './explorer-map';
import type { Explorer, ViewOptions, ViewState } from './explorer.svelte';
import type { ExploreKind } from './languages';

/** What a view needs of the editor area, which owns the source editors. */
export interface ViewHost {
	/** The app's Monaco (monaco.ts), and the editors' font. */
	monaco: typeof Monaco;
	editorFont: string;
	/** The views' state, and where options are changed. */
	explorer: Explorer;
	/** Whether `path` is a project file (a mapped header outside the project is not). */
	isProjectFile(path: string): boolean;
	/** Opens a project file and selects a range in it (Ctrl/Cmd+click). */
	open(path: string, selection: Monaco.IRange): void;
	/**
	 * Calls `listener` with the active source editor's caret (its file and
	 * line) whenever it moves or another editor becomes active, and once
	 * right away with the current one (null: no editor). Returns the
	 * subscription, to dispose.
	 */
	onSourceCursor(listener: (place: SourceLine | null) => void): Monaco.IDisposable;
	/** Decorates `place`'s line in its file's editor as mapped (null: no line). */
	markSource(place: SourceLine | null): void;
}

/** One view, as dock.ts holds it. */
export interface CompilerView {
	dispose(): void;
}

const TITLES: Record<ExploreKind, string> = { 'llvm-ir': 'LLVM IR', asm: 'Assembly' };

/** The toggles a view offers, in toolbar order, with what each does. */
const TOGGLES: { key: keyof ViewOptions; label: string; title: string; asmOnly?: boolean }[] = [
	{ key: 'demangle', label: 'Demangle', title: "Show C++ names as written (LLVM's demangler) instead of their mangled symbols" },
	{ key: 'intel', label: 'Intel', title: 'x86-64 assembly in Intel syntax (-masm=intel) instead of AT&T', asmOnly: true },
	{ key: 'directives', label: 'Directives', title: 'Keep the assembler directives (.section, .p2align, …) and labels nothing uses' },
	{ key: 'library', label: 'Library functions', title: "Keep functions that come only from headers outside the project, such as the standard library's" },
];

const STYLE_ID = 'yk-compiler-view-style';

/**
 * The views' styles, added to the document once: the editor area's
 * decorations included, since only a view ever asks for them.
 */
function addStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.yk-view { display: flex; flex-direction: column; height: 100%; }
.yk-view-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.7rem; padding: 0.3rem 0.75rem; border-bottom: 1px solid var(--gray-5); color: var(--gray-3); font-size: 0.75rem; line-height: 1.4; }
.yk-view-info { display: flex; flex-wrap: wrap; gap: 0.2rem 0.6rem; min-width: 0; flex: 1; }
.yk-view-info > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.yk-view-target { color: var(--white); font-weight: 600; }
.yk-view-triple, .yk-view-flags { font-family: var(--font-mono); }
.yk-view-state { color: var(--accent-high); }
.yk-view-state.error { color: var(--red-high); }
.yk-view-toggles { display: flex; gap: 0.3rem; flex-wrap: wrap; }
.yk-view-toggles button { padding: 0.05rem 0.5rem; border: 1px solid var(--gray-5); border-radius: 0.35rem; background: var(--gray-6); color: var(--gray-3); font: inherit; cursor: pointer; }
.yk-view-toggles button[aria-pressed='true'] { border-color: var(--accent); color: var(--white); }
.yk-view-toggles button:hover { color: var(--white); }
.yk-view-progress { height: 2px; background: transparent; }
.yk-view-progress > span { display: block; height: 100%; width: 0; background: var(--accent-high); transition: width 0.2s; }
.yk-view-progress.indeterminate > span { width: 30%; animation: yk-view-slide 1.2s ease-in-out infinite; }
@keyframes yk-view-slide { from { margin-left: -30%; } to { margin-left: 100%; } }
.yk-view-body { position: relative; flex: 1; min-height: 0; }
.yk-view-editor { position: absolute; inset: 0; }
.yk-view-note { position: absolute; inset: 0; padding: 0.75rem 1rem; color: var(--gray-3); font-size: 0.8125rem; pointer-events: none; }
.yk-mapped, .yk-mapped-source { background: color-mix(in oklch, var(--accent) 22%, transparent); }
`;
	document.head.append(style);
}

/** `<span class>` with text and an optional title. */
function span(className: string, text: string, title?: string): HTMLSpanElement {
	const s = document.createElement('span');
	s.className = className;
	s.textContent = text;
	if (title) s.title = title;
	return s;
}

/**
 * Shows view `kind` in `element` and keeps it up to date with the explorer's
 * state until disposed. `element` is the panel's content element, which the
 * view fills; the caller keeps the panel's visibility in the explorer.
 */
export function createCompilerView(element: HTMLElement, kind: ExploreKind, host: ViewHost): CompilerView {
	addStyles();
	const { explorer, monaco } = host;
	registerOutputLanguages(monaco);
	element.classList.add('yk-view');
	element.dataset['view'] = kind;

	const bar = document.createElement('div');
	bar.className = 'yk-view-bar';
	const info = document.createElement('div');
	info.className = 'yk-view-info';
	const toggles = document.createElement('div');
	toggles.className = 'yk-view-toggles';
	bar.append(info, toggles);
	const progress = document.createElement('div');
	progress.className = 'yk-view-progress';
	const progressFill = document.createElement('span');
	progress.append(progressFill);
	const body = document.createElement('div');
	body.className = 'yk-view-body';
	const editorElement = document.createElement('div');
	editorElement.className = 'yk-view-editor';
	const note = document.createElement('div');
	note.className = 'yk-view-note';
	body.append(editorElement, note);
	element.append(bar, progress, body);

	// Not a project file: no language server sees it, nothing saves it.
	const uri = monaco.Uri.parse(`yukibana-output:/${kind}`);
	monaco.editor.getModel(uri)?.dispose();
	const model = monaco.editor.createModel('', kind === 'llvm-ir' ? 'llvm-ir' : 'asm-wasm32', uri);
	const editor = monaco.editor.create(editorElement, {
		model,
		automaticLayout: true,
		fontFamily: host.editorFont,
		fontSize: 13,
		lineHeight: 20,
		fontLigatures: false,
		minimap: { enabled: false },
		scrollBeyondLastLine: false,
		renderLineHighlight: 'all',
		readOnly: true,
		domReadOnly: true,
		padding: { top: 6 },
		tabSize: 8,
		lineNumbersMinChars: 4,
		folding: false,
		wordWrap: 'off',
		fixedOverflowWidgets: true,
		// The clang messages of a failed compile name files and lines, not links to follow.
		links: false,
	});
	const mapped = editor.createDecorationsCollection();
	/** The output lines (text and map) the decorations were made against. */
	let shown: ViewState | null = null;
	/** The source editor's caret, for decorating output that arrives later. */
	let caret: SourceLine | null = null;
	/** The source line the output caret or mouse points at, as last marked. */
	let marked: SourceLine | null = null;

	const markSource = (place: SourceLine | null) => {
		if (place?.file === marked?.file && place?.line === marked?.line) return;
		marked = place;
		host.markSource(place);
	};

	/** Lights up the output lines of the source caret's line, and brings the first into view when it is off screen. */
	const decorate = (reveal: boolean) => {
		const view = shown;
		const lines = view && view.status !== 'error' && caret ? outputLinesFor(view.lines, caret.file, caret.line) : [];
		mapped.set(runsOf(lines).map((r) => ({ range: new monaco.Range(r.start, 1, r.end, 1), options: { isWholeLine: true, className: 'yk-mapped' } })));
		const first = lines[0];
		if (reveal && first !== undefined) {
			const visible = editor.getVisibleRanges();
			if (!visible.some((r) => first >= r.startLineNumber && first <= r.endLineNumber)) editor.revealLineInCenter(first, monaco.editor.ScrollType.Smooth);
		}
	};

	const outputSource = (line: number | undefined): SourceLine | null => (shown && shown.status !== 'error' && line !== undefined ? sourceOf(shown.lines, line) : null);

	const disposables: Monaco.IDisposable[] = [
		host.onSourceCursor((place) => {
			caret = place;
			decorate(true);
		}),
		editor.onDidChangeCursorPosition((e) => markSource(outputSource(e.position.lineNumber))),
		editor.onMouseMove((e) => {
			const line = e.target.position?.lineNumber;
			markSource(outputSource(line) ?? outputSource(editor.getPosition()?.lineNumber));
		}),
		editor.onMouseLeave(() => markSource(editor.hasTextFocus() ? outputSource(editor.getPosition()?.lineNumber) : null)),
		editor.onDidBlurEditorText(() => markSource(null)),
		editor.onMouseDown((e) => {
			if (!(e.event.ctrlKey || e.event.metaKey)) return;
			const source = outputSource(e.target.position?.lineNumber);
			if (!source || !host.isProjectFile(source.file)) return;
			e.event.preventDefault();
			host.open(source.file, new monaco.Range(source.line, 1, source.line, 1));
		}),
	];

	/** The toolbar's toggles, rebuilt when the options or the target change. */
	const renderToggles = (view: ViewState) => {
		const options = explorer.options[kind];
		toggles.replaceChildren(
			...TOGGLES.filter((t) => !t.asmOnly || (kind === 'asm' && view.target === 'x86_64-linux')).map((t) => {
				const b = document.createElement('button');
				b.type = 'button';
				b.textContent = t.label;
				b.title = t.title;
				b.dataset['option'] = t.key;
				b.setAttribute('aria-pressed', String(options[t.key]));
				b.addEventListener('click', () => explorer.setOption(kind, t.key, !explorer.options[kind][t.key]));
				return b;
			}),
		);
	};

	const renderInfo = (view: ViewState) => {
		const parts: HTMLElement[] = [];
		if (view.target) parts.push(span('yk-view-target', targetById(view.target).label));
		if (view.triple) parts.push(span('yk-view-triple', view.triple));
		if (view.flags.length) parts.push(span('yk-view-flags', shortFlags(view.flags).join(' '), `clang ${view.flags.join(' ')}`));
		if (view.path) parts.push(span('yk-view-file', view.path));
		if (view.status === 'ok') parts.push(span('yk-view-ms', `${view.ms} ms`));
		const busy = view.status === 'loading' || view.status === 'compiling';
		if (busy) {
			const p = view.progress;
			const what = p ? `Downloading ${p.label}${p.total ? ` ${Math.round((100 * p.loaded) / p.total)}%` : ''}…` : view.text ? 'Updating…' : 'Compiling…';
			parts.push(span('yk-view-state', what));
		} else if (view.status === 'error') parts.push(span('yk-view-state error', 'clang failed'));
		info.replaceChildren(...parts);
	};

	const renderProgress = (view: ViewState) => {
		const p = view.progress;
		const busy = view.status === 'loading' || view.status === 'compiling';
		progress.classList.toggle('indeterminate', busy && !(p && p.total > 0));
		progressFill.style.width = busy && p && p.total > 0 ? `${Math.min(100, (100 * p.loaded) / p.total)}%` : busy ? '' : '0';
		progress.hidden = !busy;
	};

	/** Puts `text` in the model in `language`, keeping the scroll position when only the text changed. */
	const show = (text: string, language: string) => {
		if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
		if (model.getValue() === text) return;
		const top = editor.getScrollTop();
		model.setValue(text);
		editor.setScrollTop(top);
	};

	const render = () => {
		const view = explorer.views[kind];
		renderInfo(view);
		renderToggles(view);
		renderProgress(view);
		const what = TITLES[kind];
		if (view.status === 'error') {
			note.hidden = true;
			shown = view;
			show(view.error, 'plaintext');
		} else if (view.path === null) {
			note.hidden = false;
			note.textContent = `Open a .c or .cpp file to see its ${what}.`;
			shown = null;
			show('', 'plaintext');
		} else if (!view.text) {
			note.hidden = false;
			note.textContent = view.status === 'idle' ? '' : `Compiling ${view.path}…`;
			shown = null;
			show('', 'plaintext');
		} else {
			note.hidden = true;
			// While a newer compile runs the old text stays, with its map.
			show(view.text, kind === 'llvm-ir' ? 'llvm-ir' : asmLanguageOf(view.target ?? 'wasm32-wasi'));
			shown = view;
		}
		decorate(false);
		if (marked && !outputSource(editor.getPosition()?.lineNumber)) markSource(null);
	};
	const unsubscribe = explorer.subscribe((k) => {
		if (k === kind) render();
	});
	render();

	return {
		dispose(): void {
			unsubscribe();
			markSource(null);
			for (const d of disposables) d.dispose();
			editor.dispose();
			model.dispose();
		},
	};
}
