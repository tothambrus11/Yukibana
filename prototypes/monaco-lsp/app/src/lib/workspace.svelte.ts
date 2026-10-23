/**
 * The state of the app: which language is selected, its project's files as
 * Monaco models, the language client serving them, and what the panels show
 * (problems, output, download progress). Components read it; only its
 * methods change it.
 */
import { monaco } from './monaco';
import { LanguageClient, type ClientState, type LoadingProgress, type LogLevel } from './lsp/client';
import { isLanguageId, languageOf, LANGUAGES, type LanguageId } from './languages';
import { Runner } from './run.svelte';
import { exportProject } from './export';
import { zip } from './zip';
import { baseName, loadLanguage, loadProject, parentOf, pathProblem, sampleProject, saveLanguage, saveProject, type Project } from './project';

/** Every project file lives under this folder, as the servers see it. */
export const ROOT_URI = 'file:///workspace/';

/** The model URI of a project path. */
export function uriOf(path: string): monaco.Uri {
	return monaco.Uri.parse(ROOT_URI + path.split('/').map(encodeURIComponent).join('/'));
}

const ROOT_PATH = '/workspace/';

/** The project path of a model URI, or `null` for a URI outside the workspace. */
export function pathOf(uri: monaco.Uri): string | null {
	// `uri.path` is decoded; `toString(true)` would still escape `#` and `?`.
	return uri.scheme === 'file' && !uri.authority && uri.path.startsWith(ROOT_PATH) ? uri.path.slice(ROOT_PATH.length) : null;
}

/** One line of the output panel. */
export interface LogLine {
	id: number;
	level: LogLevel;
	text: string;
	time: Date;
}

/** One diagnostic as the problems panel lists it. */
export interface Problem {
	path: string;
	marker: monaco.editor.IMarker;
}

/** What the workspace asks of the editor area, which owns the tabs. */
export interface EditorHost {
	/** Shows a file in a tab, opening one if needed, and optionally selects a range. */
	open(path: string, selection?: monaco.IRange): void;
	/** Closes a file's tab, if it has one. */
	close(path: string): void;
	/** Closes every tab, before the project is replaced. */
	closeAll(): void;
	/** Brings the terminal panel to the front. */
	showTerminal(): void;
}

const SAVE_DELAY_MS = 400;
const MAX_LOG_LINES = 2000;

export class Workspace {
	language = $state<LanguageId>('python');
	/** File paths, sorted. */
	files = $state<string[]>([]);
	/** Explicit folders (empty ones included), sorted. */
	folders = $state<string[]>([]);
	active = $state<string | null>(null);
	clientState = $state<ClientState>({ kind: 'stopped' });
	progress = $state<LoadingProgress | null>(null);
	log = $state<LogLine[]>([]);
	problems = $state<Problem[]>([]);
	/** The program run from this project, if any, and the terminal's contents. */
	readonly runner = new Runner();

	private client: LanguageClient | null = null;
	private readonly models = new Map<string, monaco.editor.ITextModel>();
	private open: string[] = [];
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private logId = 0;
	private host: EditorHost | null = null;
	/** Bumped by every language switch, so a switch overtaken by a later one is skipped. */
	private generation = 0;
	/**
	 * Switching, resetting and restarting run one after another on this
	 * chain, so none of them sees the half-done state of another.
	 */
	private transitions: Promise<void> = Promise.resolve();

	constructor() {
		monaco.editor.onDidChangeMarkers(() => this.refreshProblems());
	}

	/** Connects the editor area and loads the language chosen last (or the first). */
	attach(host: EditorHost): void {
		this.host = host;
		const saved = loadLanguage();
		void this.switchTo(isLanguageId(saved) ? saved : LANGUAGES[0]!.id);
	}

	/**
	 * Selects a language: saves and closes the current project, stops its
	 * server, then loads the language's project and starts its server.
	 */
	switchTo(language: LanguageId): Promise<void> {
		const generation = ++this.generation;
		return this.serially(async () => {
			if (generation !== this.generation) return; // a later switch replaces this one
			await this.closeProject();
			this.language = language;
			saveLanguage(language);
			this.load(loadProject(language, (m) => this.write('warning', m)));
			this.startClient();
		});
	}

	/** Replaces the current project with the language's sample, after the user confirmed. */
	resetProject(): Promise<void> {
		return this.serially(async () => {
			await this.stopClient();
			this.disposeModels();
			this.load(sampleProject(this.language));
			this.saveNow();
			this.startClient();
		});
	}

	/** Restarts the language server on the same files. */
	restartServer(): Promise<void> {
		return this.serially(async () => {
			await this.stopClient();
			this.startClient();
		});
	}

	/**
	 * Runs the project: the language's entry file when the project has one,
	 * else the file shown; `mode` 'test' runs its tests instead (languages with
	 * `tests`). Every file goes along, as last edited.
	 */
	run(mode: 'run' | 'test' = 'run'): void {
		const language = languageOf(this.language);
		if (mode === 'run' ? !language.runs : !language.tests) return;
		const entry = this.models.has(language.entry) ? language.entry : this.active;
		if (!entry) {
			this.write('warning', `There is no ${language.entry} to run.`);
			return;
		}
		const files: Record<string, string> = {};
		for (const [path, model] of this.models) files[path] = model.getValue();
		this.host?.showTerminal();
		this.runner.start(this.language, files, entry, mode);
	}

	/**
	 * Downloads the project as `<language>-project.zip`, for an IDE: its files
	 * as last edited and its empty folders, in a folder of the same name, plus
	 * the build files, README and .gitignore it lacks (export.ts). Says in the
	 * output panel what was generated.
	 */
	async download(): Promise<void> {
		const language = languageOf(this.language);
		const files: Record<string, string> = {};
		for (const [path, model] of this.models) files[path] = model.getValue();
		const exported = exportProject(language, files);
		const paths = Object.keys(exported.files).sort();
		const empty = this.allFolders().filter((f) => !paths.some((p) => p.startsWith(f + '/')) && !this.folders.some((g) => g.startsWith(f + '/')));
		const name = `${language.id}-project`;
		try {
			const archive = await zip([
				...empty.map((f) => ({ path: `${name}/${f}/` })),
				...paths.map((p) => ({ path: `${name}/${p}`, text: exported.files[p] ?? '' })),
			]);
			const url = URL.createObjectURL(archive);
			const link = Object.assign(document.createElement('a'), { href: url, download: `${name}.zip` });
			link.click();
			// The download has its own copy once it starts; a minute is ample.
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (e) {
			this.write('error', `Could not make the zip archive: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		const generated = exported.generated.length ? `, with ${exported.generated.join(', ')} generated` : '';
		this.write('info', `Downloaded ${name}.zip${generated}.`);
	}

	/** Saves now instead of after the debounce: the page is being hidden or reloaded. */
	flush(): void {
		if (this.models.size) this.saveNow();
	}

	/**
	 * Another tab saved this language's project. Each tab keeps its own
	 * copy, so the last to save wins; say so rather than lose work silently.
	 */
	savedElsewhere(language: LanguageId): void {
		if (language === this.language) this.write('warning', `This ${languageOf(language).label} project was changed in another tab. Whichever tab saves last keeps its version.`);
	}

	/** Shows a file in the editor. */
	show(path: string, selection?: monaco.IRange): void {
		this.host?.open(path, selection);
	}

	/** The model of a project file. */
	model(path: string): monaco.editor.ITextModel | undefined {
		return this.models.get(path);
	}

	/** Called by the editor area when tabs change, so they are restored next time. */
	tabsChanged(open: string[], active: string | null): void {
		this.open = open;
		this.active = active;
		this.scheduleSave();
	}

	/** Why a new file or folder cannot be called `path`, or `null`. */
	nameProblem(path: string): string | null {
		const problem = pathProblem(path);
		if (problem) return problem;
		if (this.models.has(path) || this.folders.includes(path) || this.isImpliedFolder(path)) return `"${path}" already exists.`;
		// A server mirrors the project into a file system, where a file cannot also be a folder.
		for (let p = parentOf(path); p; p = parentOf(p)) if (this.models.has(p)) return `"${p}" is a file, not a folder.`;
		return null;
	}

	/** Creates an empty file (and its folders) and opens it. */
	createFile(path: string): void {
		const problem = this.nameProblem(path);
		if (problem) throw new Error(problem);
		this.addModel(path, '', true);
		this.files = [...this.models.keys()].sort();
		this.host?.open(path);
		this.scheduleSave();
	}

	/** Creates an empty folder. */
	createFolder(path: string): void {
		const problem = this.nameProblem(path);
		if (problem) throw new Error(problem);
		this.folders = [...this.folders, path].sort();
		this.scheduleSave();
	}

	/**
	 * Renames a file or a folder with everything in it. The server sees each
	 * moved file deleted and created, which is what a rename on disk is.
	 */
	rename(from: string, to: string): void {
		if (from === to) return;
		const problem = this.nameProblem(to);
		if (problem) throw new Error(problem);
		const moved = this.models.has(from) ? [[from, to] as const] : [...this.models.keys()].filter((p) => p.startsWith(from + '/')).map((p) => [p, to + p.slice(from.length)] as const);
		const reopen: string[] = [];
		for (const [oldPath, newPath] of moved) {
			const text = this.models.get(oldPath)!.getValue();
			if (this.open.includes(oldPath)) reopen.push(newPath);
			this.removeModel(oldPath);
			this.addModel(newPath, text, true);
		}
		this.folders = this.folders.map((f) => (f === from || f.startsWith(from + '/') ? to + f.slice(from.length) : f)).sort();
		this.files = [...this.models.keys()].sort();
		for (const p of reopen) this.host?.open(p);
		this.scheduleSave();
	}

	/** Deletes a file, or a folder with everything in it. */
	delete(path: string): void {
		const doomed = this.models.has(path) ? [path] : [...this.models.keys()].filter((p) => p.startsWith(path + '/'));
		for (const p of doomed) this.removeModel(p);
		this.folders = this.folders.filter((f) => f !== path && !f.startsWith(path + '/'));
		this.files = [...this.models.keys()].sort();
		this.scheduleSave();
	}

	/** Every folder to show: explicit ones and the parents of files. */
	allFolders(): string[] {
		const all = new Set(this.folders);
		for (const f of [...this.files, ...this.folders]) for (let p = parentOf(f); p; p = parentOf(p)) all.add(p);
		return [...all].sort();
	}

	/** Writes a line to the output panel. */
	write(level: LogLevel, text: string): void {
		const line = { id: this.logId++, level, text, time: new Date() };
		this.log = this.log.length >= MAX_LOG_LINES ? [...this.log.slice(-MAX_LOG_LINES + 1), line] : [...this.log, line];
	}

	clearLog(): void {
		this.log = [];
	}

	private isImpliedFolder(path: string): boolean {
		return [...this.models.keys()].some((p) => p.startsWith(path + '/'));
	}

	private load(project: Project): void {
		for (const [path, text] of Object.entries(project.files)) this.addModel(path, text, false);
		this.files = [...this.models.keys()].sort();
		this.folders = [...project.folders].sort();
		this.host?.closeAll();
		const entry = languageOf(this.language).entry;
		const open = project.open.length ? project.open : this.models.has(entry) ? [entry] : this.files.slice(0, 1);
		for (const p of open) this.host?.open(p);
		const active = project.active ?? open[0];
		if (active) this.host?.open(active);
	}

	private addModel(path: string, text: string, created: boolean): void {
		const model = monaco.editor.createModel(text, undefined, uriOf(path));
		model.onDidChangeContent(() => this.scheduleSave());
		this.models.set(path, model);
		this.client?.addModel(model, created);
	}

	private removeModel(path: string): void {
		const model = this.models.get(path);
		if (!model) return;
		this.host?.close(path);
		this.client?.removeModel(model);
		this.models.delete(path);
		model.dispose();
	}

	private disposeModels(): void {
		this.host?.closeAll();
		for (const model of this.models.values()) model.dispose();
		this.models.clear();
		this.files = [];
		this.problems = [];
	}

	private serially(transition: () => Promise<void>): Promise<void> {
		const next = this.transitions.then(transition);
		this.transitions = next.catch((e: unknown) => this.write('error', e instanceof Error ? e.message : String(e)));
		return this.transitions;
	}

	/** Saves the project, stops its server, and removes its files from the editor. */
	private async closeProject(): Promise<void> {
		this.runner.stop(false);
		this.runner.clear();
		this.flush();
		await this.stopClient();
		this.flush(); // edits typed while the server was shutting down
		this.disposeModels();
	}

	/**
	 * Starts the language's server on the current files. Does not wait for
	 * it: a pack may take a while to download, and a switch away meanwhile
	 * must not queue behind it. Stopping the client cancels the download.
	 */
	private startClient(): void {
		const language = languageOf(this.language);
		const client = new LanguageClient({
			// Relative to the page, so the app works from any folder of a static host.
			serverUrl: new URL(`packs/${language.id}/server.js`, document.baseURI),
			languages: language.monacoLanguages,
			rootUri: ROOT_URI,
			settings: language.settings,
			events: {
				state: (s) => {
					if (this.client === client) this.clientState = s;
				},
				loading: (p) => {
					if (this.client === client) this.progress = p;
				},
				log: (level, text) => this.write(level, text),
				open: (uri, selection) => {
					const path = pathOf(uri);
					if (path && this.models.has(path)) this.host?.open(path, selection);
				},
			},
		});
		this.client = client;
		this.write('info', `Starting the ${language.label} language server`);
				client.start(() => this.models.values()).catch(async (e: unknown) => {
			if (this.client !== client) return;
			this.write('error', `${language.label} language server: ${e instanceof Error ? e.message : String(e)}`);
			// A worker that fails to load says nothing about why; a missing pack is the usual reason.
			const status = await fetch(client.serverUrl, { method: 'HEAD' }).then((r) => r.status, () => 0);
			if (status === 404) this.write('error', `The ${language.label} pack is not installed: ${client.serverUrl.pathname} was not found. Build it with packs/${language.id}/build.sh.`);
		});
	}

	private async stopClient(): Promise<void> {
		const client = this.client;
		this.client = null;
		this.progress = null;
		this.clientState = { kind: 'stopped' };
		await client?.stop();
	}

	private refreshProblems(): void {
		const severityOrder = (m: monaco.editor.IMarker) => -m.severity;
		this.problems = monaco.editor
			.getModelMarkers({})
			.map((marker) => ({ path: pathOf(marker.resource), marker }))
			.filter((p): p is Problem => p.path !== null && this.models.has(p.path))
			.sort((a, b) => a.path.localeCompare(b.path) || severityOrder(a.marker) - severityOrder(b.marker) || a.marker.startLineNumber - b.marker.startLineNumber);
	}

	private scheduleSave(): void {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
	}

	private saveNow(): void {
		clearTimeout(this.saveTimer);
		const files: Record<string, string> = {};
		for (const [path, model] of this.models) files[path] = model.getValue();
		saveProject(this.language, { files, folders: this.folders, open: this.open.filter((p) => p in files), active: this.active }, (m) => this.write('error', m));
	}
}

/** The file name shown on a tab. */
export { baseName };
