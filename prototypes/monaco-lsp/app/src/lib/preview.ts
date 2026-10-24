/**
 * The Preview panel of a web project: its page in a sandboxed iframe,
 * reloaded live as the project changes, with the page's console in the
 * terminal.
 *
 * The page is built by the pack's runner (`type: 'preview'`, see
 * packs/javascript/README.md, "Preview"), a worker kept for as long as the
 * preview is shown, so TypeScript is loaded once: it answers with one HTML
 * document in which the stylesheets are inlined and the scripts are `data:`
 * URLs. That document is the iframe's `srcdoc`:
 *
 * - The iframe is sandboxed without `allow-same-origin`, so the page has an
 *   opaque origin: it cannot reach the app's storage, cookies or DOM, and
 *   its only way out is `postMessage`. A service worker cannot serve an
 *   opaque-origin document, and `blob:` URLs are bound to the app's origin,
 *   which is why the page carries everything inline.
 * - The app is cross-origin isolated (COEP `require-corp`); an `about:srcdoc`
 *   document inherits that policy and loads nothing over the network, so it
 *   is allowed. A page that fetches from another origin needs CORS (or, for
 *   an image, a `Cross-Origin-Resource-Policy` header) as any isolated page
 *   does.
 *
 * Live reload: edits are collected for 300 ms. When every changed file is
 * a stylesheet the page has inlined, its `<style>` is replaced in place
 * (the page keeps its state); any other change rebuilds the page and
 * reloads the iframe. This is live reload, not module hot replacement.
 */
import type { Files } from './languages';

const RELOAD_DELAY_MS = 300;
/**
 * How long a build may go unanswered before the terminal says so. The first
 * build loads the runner and, for TypeScript, the compiler, so this is
 * generous; the usual answer takes well under a second.
 */
const SILENT_RUNNER_MS = 15_000;

/** Where the page's console and build errors go (the terminal). */
export interface PreviewOutput {
	print(kind: 'stdout' | 'stderr' | 'info', text: string): void;
}

/** The runner's answer to a `preview` request. */
interface Page {
	type: 'page';
	id: number;
	html: string | null;
	styles: string[];
	errors: string[];
}

/** What the page's bridge script posts (see the runner's BRIDGE). */
interface FromPage {
	yukibana: 'preview';
	type: 'stdout' | 'stderr';
	text: string;
}

const isFromPage = (data: unknown): data is FromPage => typeof data === 'object' && data !== null && (data as { yukibana?: unknown }).yukibana === 'preview';

export class Preview {
	private frame: HTMLIFrameElement | null = null;
	private placeholder: HTMLElement | null = null;
	private worker: Worker | null = null;
	private pack = '';
	private entry = '';
	private files: () => Files = () => ({});
	/** The id of the latest request; older answers are dropped. */
	private requested = 0;
	/** Stylesheets of the page shown, which an edit can swap in place. */
	private styles: string[] = [];
	/** The document shown, kept so that a panel mounted later (or moved by dockview) shows it too. */
	private html: string | null = null;
	private readonly pending = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Fires when the latest build went unanswered for SILENT_RUNNER_MS. */
	private watchdog: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly output: PreviewOutput) {
		addEventListener('message', (e: MessageEvent<unknown>) => {
			// Only the iframe's own messages: anything else may post to the app too.
			if (!this.frame || e.source !== this.frame.contentWindow || !isFromPage(e.data)) return;
			this.output.print(e.data.type === 'stderr' ? 'stderr' : 'stdout', String(e.data.text));
		});
	}

	/** Whether a page is being previewed (Run was pressed and nothing stopped it). */
	get active(): boolean {
		return this.worker !== null;
	}

	/** Puts the iframe into the panel's element. */
	mount(element: HTMLElement): void {
		const frame = document.createElement('iframe');
		frame.className = 'preview-frame';
		frame.title = 'Preview';
		// Scripts, forms and alert() run; same-origin, popups and top navigation do not.
		frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
		frame.referrerPolicy = 'no-referrer';
		const placeholder = document.createElement('p');
		placeholder.className = 'preview-empty';
		placeholder.textContent = 'Press Run (Ctrl+Enter) to show the page here. It reloads as you edit.';
		element.append(placeholder, frame);
		this.frame = frame;
		this.placeholder = placeholder;
		this.render(this.html);
	}

	unmount(): void {
		this.frame?.remove();
		this.placeholder?.remove();
		this.frame = null;
		this.placeholder = null;
	}

	/**
	 * Shows the page `entry` of the project, built with the runner of the
	 * pack `pack`; `files` gives the project as it is now, at each rebuild.
	 */
	start(pack: string, entry: string, files: () => Files): void {
		if (pack !== this.pack) this.stop();
		this.pack = pack;
		this.entry = entry;
		this.files = files;
		this.pending.clear();
		this.build();
	}

	/** Stops previewing: the worker ends and the panel is emptied. */
	stop(): void {
		clearTimeout(this.timer);
		clearTimeout(this.watchdog);
		this.pending.clear();
		this.worker?.terminate();
		this.worker = null;
		this.styles = [];
		this.render(null);
	}

	/** A project file changed, was created or was deleted: reload, or swap a stylesheet, shortly. */
	changed(path: string): void {
		if (!this.active) return;
		this.pending.add(path);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), RELOAD_DELAY_MS);
	}

	private flush(): void {
		const paths = [...this.pending];
		this.pending.clear();
		const files = this.files();
		const window = this.frame?.contentWindow;
		if (this.html !== null && window && paths.length > 0 && paths.every((p) => this.styles.includes(p) && p in files)) {
			for (const href of paths) window.postMessage({ yukibana: 'css', href, text: files[href] }, '*');
		} else this.build();
	}

	private build(): void {
		if (!this.worker) {
			const url = new URL(`packs/${this.pack}/runner.js`, document.baseURI);
			const worker = new Worker(url, { type: 'module' });
			worker.onmessage = (e: MessageEvent<Page | { type: string }>) => {
				if (this.worker === worker && e.data.type === 'page') this.receive(e.data as Page);
			};
			worker.onerror = (e) => {
				if (this.worker !== worker) return;
				e.preventDefault();
				clearTimeout(this.watchdog);
				this.worker = null;
				this.output.print('stderr', `The preview could not be built: ${e.message || `the runner (packs/${this.pack}/runner.js) did not load`}\n`);
			};
			this.worker = worker;
		}
		this.worker.postMessage({ type: 'preview', id: ++this.requested, files: { ...this.files() }, entry: this.entry });
		// A runner that never answers leaves the panel blank and says nothing.
		// The one seen so far was an old runner.js, from before previews
		// existed, served by the previous version's service worker until the
		// new version took over: it ignores `preview` requests.
		clearTimeout(this.watchdog);
		this.watchdog = setTimeout(() => {
			this.output.print(
				'stderr',
				`The preview runner (packs/${this.pack}/runner.js) has not answered for ${SILENT_RUNNER_MS / 1000} s. ` +
					'If the app just updated, an old cached copy may still be running: reload the page and press Run again.\n',
			);
		}, SILENT_RUNNER_MS);
	}

	private receive(page: Page): void {
		if (page.id !== this.requested) return;
		clearTimeout(this.watchdog);
		if (page.html === null) {
			// The page shown stays as it was; the reasons go to the terminal.
			this.output.print('stderr', page.errors.join('\n') + '\n');
			return;
		}
		this.styles = page.styles;
		this.render(page.html);
	}

	private render(html: string | null): void {
		this.html = html;
		if (this.placeholder) this.placeholder.hidden = html !== null;
		if (!this.frame) return;
		this.frame.hidden = html === null;
		this.frame.srcdoc = html ?? '';
	}
}
