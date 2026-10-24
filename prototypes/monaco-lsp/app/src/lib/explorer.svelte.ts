/**
 * The compiler output views' client: asks the pack's `explorer.js` worker
 * (packs/CONTRACT.md, "Showing compiler output") for the LLVM IR or the
 * assembly of the active C or C++ source, and keeps what each view shows.
 *
 * The worker is started the first time a view opens, and only then, so a
 * session that never opens one downloads nothing for them; it is stopped
 * when the language changes or the project is reset. A view asks only while
 * it is visible: when it opens, when the active source changes, when one of
 * its options changes, and 500 ms after the project was last edited. A view
 * hidden behind another tab is marked stale instead and asks when it is
 * shown again. Every request carries a new id and only the newest answer of
 * each view is kept, so a slow compile never overwrites a newer one.
 */
import type { ExploreKind, Files } from './languages';
import type { CppTargetId } from './cpp-targets';
import { viewSourceFor, type LineMap } from './explorer-map';

/** What a view shows. */
export interface ViewState {
	/**
	 * `idle`: nothing asked yet, or no source to show (`path` null);
	 * `loading`: the compiler is downloading (`progress`); `compiling`: a
	 * request is out; `ok`: `text` is the newest output; `error`: `error`
	 * is why there is none. While loading or compiling, `text` is the last
	 * output, kept to show under "Updating…".
	 */
	status: 'idle' | 'loading' | 'compiling' | 'ok' | 'error';
	/** The IR or assembly, filtered (and demangled if asked). */
	text: string;
	/** Per line of `text`, the source line it came from (explorer-map.ts). */
	lines: LineMap;
	/** The target the output is for, null before the first answer or when the project's target is unsupported. */
	target: CppTargetId | null;
	/** That target's triple, '' until known. */
	triple: string;
	/** The clang arguments the output was made with. */
	flags: readonly string[];
	/** How long the compile took, in milliseconds. */
	ms: number;
	/** clang's messages (project-relative paths) when the compile failed, or why there is no output. */
	error: string;
	/** The download in progress, while `loading`. */
	progress: { label: string; loaded: number; total: number } | null;
	/** The source the output is (or will be) of: a project path. */
	path: string | null;
}

/** A view's options, as the explorer protocol names them. */
export interface ViewOptions {
	/** Symbols demangled with LLVM's demangler. */
	demangle: boolean;
	/** x86-64 assembly in Intel syntax (`-masm=intel`); other targets ignore it. */
	intel: boolean;
	/** Assembler directives kept (`.section`, `.p2align`, …); off, only code and data are shown. */
	directives: boolean;
	/** Functions that come only from headers outside the project (the standard library) kept. */
	library: boolean;
}

/** What the explorer needs of the workspace. */
export interface ExplorerHost {
	/** The pack whose `explorer.js` serves the current language, or null when it has no views. */
	pack(): string | null;
	/** Every file of the project as last edited. */
	files(): Files;
}

/** How long after the last edit a visible view asks again. */
const EDIT_DELAY_MS = 500;

const KINDS: readonly ExploreKind[] = ['llvm-ir', 'asm'];

/** The options a view starts with: assembly demangled, IR as LLVM wrote it. */
export const DEFAULT_VIEW_OPTIONS: Readonly<Record<ExploreKind, ViewOptions>> = {
	'llvm-ir': { demangle: false, intel: false, directives: false, library: false },
	asm: { demangle: true, intel: false, directives: false, library: false },
};

const empty = (): ViewState => ({ status: 'idle', text: '', lines: [], target: null, triple: '', flags: [], ms: 0, error: '', progress: null, path: null });

/** Messages explorer.js posts. */
type FromExplorer =
	| { type: 'loading'; label: string; loaded: number; total: number }
	| { type: 'result'; id: number; emit: ExploreKind; ok: true; text: string; lines: LineMap; target: CppTargetId; triple: string; flags: string[]; ms: number }
	| { type: 'result'; id: number; emit: ExploreKind; ok: false; error: string; target: CppTargetId | null; ms: number };

export class Explorer {
	/**
	 * What each view shows. Read it in components; it changes only through
	 * this class, a whole view at a time. Raw, not deeply reactive: an
	 * output has thousands of lines, and nothing reads into one in place.
	 */
	views = $state.raw<Record<ExploreKind, ViewState>>({ 'llvm-ir': empty(), asm: empty() });
	/** Each view's options. */
	options = $state<Record<ExploreKind, ViewOptions>>({ 'llvm-ir': { ...DEFAULT_VIEW_OPTIONS['llvm-ir'] }, asm: { ...DEFAULT_VIEW_OPTIONS.asm } });
	/** The source the views show: the active editor's when it is a C or C++ source, else the last one that was. */
	source = $state<string | null>(null);

	private worker: Worker | null = null;
	private nextId = 0;
	/** The id of each view's newest request; an answer to any other is dropped. */
	private readonly latest: Record<ExploreKind, number> = { 'llvm-ir': 0, asm: 0 };
	/** Views whose panel is open. */
	private readonly open = new Set<ExploreKind>();
	/** Open views whose panel is in front (not behind another tab). */
	private readonly visible = new Set<ExploreKind>();
	/** Open views that missed a change while hidden: they ask when shown. */
	private readonly stale = new Set<ExploreKind>();
	private editTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly listeners = new Set<(kind: ExploreKind) => void>();

	constructor(private readonly host: ExplorerHost) {}

	/**
	 * Calls `listener` with a view's kind after its state or options change
	 * (for code outside Svelte's reactivity: the views' Monaco editors).
	 * Returns the function that unsubscribes.
	 */
	subscribe(listener: (kind: ExploreKind) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** A view's panel opened (or was brought back): it is visible and asks for its output. */
	opened(kind: ExploreKind): void {
		this.open.add(kind);
		this.visible.add(kind);
		this.request(kind);
	}

	/**
	 * A view's panel closed: it asks for nothing more, and its last output is
	 * forgotten. When no view is left open the worker is stopped: it holds a
	 * compiled compiler or two and their unpacked headers (over 100 MB), which
	 * a Linux Run needs room for. Opening a view again starts a new one, whose
	 * downloads come from the service worker's cache.
	 */
	closed(kind: ExploreKind): void {
		this.open.delete(kind);
		this.visible.delete(kind);
		this.stale.delete(kind);
		this.latest[kind] = ++this.nextId;
		this.set(kind, { ...empty(), path: this.source });
		this.changed(kind);
		if (this.open.size === 0) {
			clearTimeout(this.editTimer);
			this.worker?.terminate();
			this.worker = null;
		}
	}

	/** A view's panel came to the front or went behind another; shown again after a change, it asks. */
	setVisible(kind: ExploreKind, visible: boolean): void {
		if (!this.open.has(kind)) return;
		if (!visible) {
			this.visible.delete(kind);
			return;
		}
		this.visible.add(kind);
		if (this.stale.has(kind)) this.request(kind);
	}

	/** Changes one of a view's options, and asks again. */
	setOption(kind: ExploreKind, option: keyof ViewOptions, value: boolean): void {
		if (this.options[kind][option] === value) return;
		this.options[kind] = { ...this.options[kind], [option]: value };
		this.changed(kind);
		this.refresh(kind);
	}

	/**
	 * The editor now shows `path` (null: no file). A C or C++ source becomes
	 * the views' source; anything else (a header, compile_flags.txt) keeps
	 * the one before, as a header's code is in the source that includes it.
	 */
	activeChanged(path: string | null): void {
		const source = viewSourceFor(path, this.source);
		if (source === this.source) return;
		this.source = source;
		for (const kind of KINDS) this.refresh(kind);
	}

	/** A project file was edited, created, renamed or deleted: the open views ask again once editing pauses. */
	edited(): void {
		if (!this.open.size) return;
		clearTimeout(this.editTimer);
		this.editTimer = setTimeout(() => {
			// A source deleted or renamed is no longer one to show.
			if (this.source !== null && !(this.source in this.host.files())) this.source = null;
			for (const kind of KINDS) this.refresh(kind);
		}, EDIT_DELAY_MS);
	}

	/**
	 * Stops the worker and forgets every view's output and the source: the
	 * language changed or the project was replaced. The views' panels are
	 * the editor area's to close; options are kept for the session.
	 */
	reset(): void {
		clearTimeout(this.editTimer);
		this.worker?.terminate();
		this.worker = null;
		this.source = null;
		this.open.clear();
		this.visible.clear();
		this.stale.clear();
		for (const kind of KINDS) {
			this.latest[kind] = ++this.nextId;
			this.set(kind, empty());
			this.changed(kind);
		}
	}

	/** Asks now when the view is open and visible; marks it stale when it is open but hidden. */
	private refresh(kind: ExploreKind): void {
		if (!this.open.has(kind)) return;
		if (this.visible.has(kind)) this.request(kind);
		else this.stale.add(kind);
	}

	/** Sends a request for `kind` of the current source, replacing any still out. */
	private request(kind: ExploreKind): void {
		this.stale.delete(kind);
		const id = ++this.nextId;
		this.latest[kind] = id;
		const view = this.views[kind];
		const path = this.source;
		if (path === null) {
			this.set(kind, { ...empty(), path: null });
			this.changed(kind);
			return;
		}
		const worker = this.start();
		if (!worker) {
			this.set(kind, { ...view, status: 'error', error: 'The current language has no compiler output views.', path, progress: null });
			this.changed(kind);
			return;
		}
		// The last output stays, under "Updating…", until the new one arrives; another file's does not.
		const keep = view.path === path && view.status !== 'error';
		this.set(kind, { ...(keep ? view : { ...empty(), target: view.target, triple: view.triple }), status: 'compiling', error: '', progress: null, path });
		this.changed(kind);
		worker.postMessage({ type: 'emit', id, emit: kind, files: { ...this.host.files() }, path, options: { ...this.options[kind] } });
	}

	/** The worker, started on first use; null when the language has no views. */
	private start(): Worker | null {
		if (this.worker) return this.worker;
		const pack = this.host.pack();
		if (!pack) return null;
		const url = new URL(`packs/${pack}/explorer.js`, document.baseURI);
		const worker = new Worker(url, { type: 'module' });
		this.worker = worker;
		worker.onmessage = (e: MessageEvent<FromExplorer>) => {
			if (this.worker === worker) this.receive(e.data);
		};
		worker.onerror = (e) => {
			if (this.worker !== worker) return;
			e.preventDefault();
			worker.terminate();
			this.worker = null;
			// A worker that fails to load at all is most likely not built.
			void fetch(url, { method: 'HEAD' }).then(
				(r) => this.failAll(r.ok ? `The compiler output worker failed: ${e.message || 'unknown error'}` : `The compiler output views are not installed (packs/${pack}/explorer.js).`),
				() => this.failAll(`The compiler output worker failed: ${e.message || 'unknown error'}`),
			);
		};
		return worker;
	}

	private receive(m: FromExplorer): void {
		if (m.type === 'loading') {
			for (const kind of KINDS) {
				const view = this.views[kind];
				if (view.status !== 'loading' && view.status !== 'compiling') continue;
				const done = m.total > 0 && m.loaded >= m.total;
				this.set(kind, { ...view, status: done ? 'compiling' : 'loading', progress: done ? null : { label: m.label, loaded: m.loaded, total: m.total } });
				this.changed(kind);
			}
			return;
		}
		if (m.type !== 'result' || !KINDS.includes(m.emit) || m.id !== this.latest[m.emit]) return;
		const view = this.views[m.emit];
		this.set(m.emit, m.ok
			? { ...view, status: 'ok', text: m.text, lines: m.lines, target: m.target, triple: m.triple, flags: m.flags, ms: m.ms, error: '', progress: null }
			: { ...view, status: 'error', target: m.target, ms: m.ms, error: m.error, progress: null });
		this.changed(m.emit);
	}

	/** Every view that waits for an answer shows `message` instead. */
	private failAll(message: string): void {
		for (const kind of KINDS) {
			const view = this.views[kind];
			if (view.status !== 'loading' && view.status !== 'compiling') continue;
			this.latest[kind] = ++this.nextId;
			this.set(kind, { ...view, status: 'error', error: message, progress: null });
			this.changed(kind);
		}
	}

	private set(kind: ExploreKind, view: ViewState): void {
		this.views = { ...this.views, [kind]: view };
	}

	private changed(kind: ExploreKind): void {
		for (const listener of this.listeners) listener(kind);
	}
}
