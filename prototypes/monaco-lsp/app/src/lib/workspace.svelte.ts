/**
 * The state of the app: which language is selected, its project's files as
 * Monaco models, the language client serving them, and what the panels show
 * (problems, output, download progress). Components read it; only its
 * methods change it.
 */
import { monaco } from './monaco';
import { LanguageClient, type ClientState, type LoadingProgress, type LogLevel } from './lsp/client';
import { isLanguageId, languageOf, LANGUAGES, type LanguageId } from './languages';
import { baseName, loadLanguage, loadProject, parentOf, pathProblem, sampleProject, saveLanguage, saveProject, type Project } from './project';

/** Every project file lives under this folder, as the servers see it. */
export const ROOT_URI = 'file:///workspace/';

/** The model URI of a project path. */
export function uriOf(path: string): monaco.Uri {
	return monaco.Uri.parse(ROOT_URI + path.split('/').map(encodeURIComponent).join('/'));
}

/** The project path of a model URI, or `null` for a URI outside the workspace. */
export function pathOf(uri: monaco.Uri): string | null {
	const s = uri.toString(true);
	return s.startsWith(ROOT_URI) ? s.slice(ROOT_URI.length) : null;
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

	private client: LanguageClient | null = null;
	private readonly models = new Map<string, monaco.editor.ITextModel>();
	private open: string[] = [];
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private logId = 0;
	private host: EditorHost | null = null;
	/** Bumped on every switch, so a slow start of an old client cannot win. */
	private generation = 0;

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
	async switchTo(language: LanguageId): Promise<void> {
		const generation = ++this.generation;
		if (this.models.size) this.saveNow();
		await this.stopClient();
		this.disposeModels();
		this.language = language;
		saveLanguage(language);
		this.load(loadProject(language, (m) => this.write('warning', m)));
		if (generation !== this.generation) return;
		await this.startClient(generation);
	}

	/** Replaces the current project with the language's sample, after the user confirmed. */
	async resetProject(): Promise<void> {
		const generation = ++this.generation;
		await this.stopClient();
		this.disposeModels();
		this.load(sampleProject(this.language));
		this.saveNow();
		await this.startClient(generation);
	}

	/** Restarts the language server on the same files. */
	async restartServer(): Promise<void> {
		const generation = ++this.generation;
		await this.stopClient();
		await this.startClient(generation);
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
		return pathProblem(path) ?? (this.models.has(path) || this.folders.includes(path) || this.isImpliedFolder(path) ? `"${path}" already exists.` : null);
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

	private async startClient(generation: number): Promise<void> {
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
		try {
			await client.start(this.models.values());
		} catch (e) {
			if (generation !== this.generation) return;
			this.write('error', `${language.label} language server: ${e instanceof Error ? e.message : String(e)}`);
			// A worker that fails to load says nothing about why; a missing pack is the usual reason.
			const status = await fetch(client.serverUrl, { method: 'HEAD' }).then((r) => r.status, () => 0);
			if (status === 404) this.write('error', `The ${language.label} pack is not installed: ${client.serverUrl.pathname} was not found. Build it with packs/${language.id}/build.sh.`);
		}
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
