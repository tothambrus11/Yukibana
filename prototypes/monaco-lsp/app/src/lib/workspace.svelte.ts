/**
 * The state of the app: which language is selected, its project's files as
 * Monaco models, the language client serving them, and what the panels show
 * (problems, output, download progress). Components read it; only its
 * methods change it.
 */
import { monaco } from './monaco';
import { LanguageClient, type ClientState, type LoadingProgress, type LogLevel } from './lsp/client';
import { isLanguageId, languageOf, LANGUAGES, packOf, type ExploreKind, type LanguageId } from './languages';
import { Runner, type RunMode } from './run.svelte';
import { Preview } from './preview';
import { exportProject } from './export';
import { zip } from './zip';
import { chooseTestFramework, detectTestFramework, TESTS_DIR, type TestFramework } from './cpp-tests';
import { DEFAULT_RUN_OPTIONS, targetById, targetOf, withTarget, type CppTargetId, type RunOptions, type TargetChoice } from './cpp-targets';
import { describeSanitizers, sanitizersOf, withSanitizers, type SanitizerChoice } from './cpp-sanitizers';
import { cppLevelOf, defaultLevel, levelsOf, withCppLevel, type LevelChoice } from './optimization';
import type { Explorer } from './explorer.svelte';
import { baseName, loadLanguage, loadProject, parentOf, pathOf, pathProblem, ROOT_URI, sampleProject, saveLanguage, saveProject, type Project } from './project';

/** The model URI of a project path. */
export function uriOf(path: string): monaco.Uri {
	return monaco.Uri.parse(ROOT_URI + path.split('/').map(encodeURIComponent).join('/'));
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
	/** Opens the Preview panel (a web project's page), creating it the first time. */
	showPreview(): void;
	/** Closes the Preview panel, if it is open. */
	hidePreview(): void;
	/**
	 * Opens a compiler output view (LLVM IR, assembly) right of the editors,
	 * or brings it to the front; its panel tells `explorer` it opened.
	 */
	showView(kind: ExploreKind): void;
	/** Closes the compiler output views, if open: the language or project changed. */
	hideViews(): void;
}

/** The file that holds a C++ project's flags, its target among them (cpp-targets.ts). */
const COMPILE_FLAGS = 'compile_flags.txt';

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
	/**
	 * A C++ project's test framework, as its tests/ files include it
	 * (cpp-tests.ts): `mixed` when they include more than one, null when
	 * none (or the project is not C++).
	 */
	testFramework = $state<TestFramework | 'mixed' | null>(null);
	/**
	 * A C++ project's target, as its compile_flags.txt says (cpp-targets.ts);
	 * null when the project is not C++.
	 */
	target = $state<TargetChoice | null>(null);
	/**
	 * The sanitizers a C or C++ project has on, as its compile_flags.txt
	 * says (cpp-sanitizers.ts); null when the project is not C or C++.
	 */
	sanitizers = $state<SanitizerChoice | null>(null);
	/**
	 * How Run runs a C++ program built for a Linux target; saved with the
	 * project once changed. The defaults for any other project.
	 */
	runOptions = $state<RunOptions>({ ...DEFAULT_RUN_OPTIONS });
	/**
	 * The project's optimisation level (optimization.ts): a C or C++
	 * project's as its compile_flags.txt says, another's as chosen and saved
	 * with the project; null for a language without levels.
	 */
	optimization = $state<LevelChoice | null>(null);
	/**
	 * The program run from this project, if any, and the terminal's
	 * contents. The guest kernel's log and the run's timings go to the
	 * Output panel.
	 */
	readonly runner = new Runner({
		kernel: (line) => this.write('log', `[kernel] ${line}`),
		mark: (name, ms) => this.write('log', `timing: ${name} ${(ms / 1000).toFixed(2)} s`),
	});
	/**
	 * The compiler output views' client (languages with `explores`), loaded
	 * with the views the first time one opens: null until then, so the app
	 * shell carries none of it.
	 */
	explorer: Explorer | null = null;
	private explorerLoad: Promise<Explorer> | null = null;
	/** A web project's page, shown in the Preview panel; its console goes to the terminal. */
	readonly preview = new Preview(this.runner);

	private client: LanguageClient | null = null;
	private readonly models = new Map<string, monaco.editor.ITextModel>();
	private open: string[] = [];
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private logId = 0;
	private host: EditorHost | null = null;
	/** Whether the user chose run options for this project: only then are they saved with it. */
	private runOptionsChosen = false;
	/** The level chosen for a language whose level no project file holds (Swift, Scala), saved with the project; null: the default. */
	private chosenLevel: string | null = null;
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
			this.preview.stop();
			this.closeViews();
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
	 * `tests`), 'mutate' mutation-tests the project against them (languages
	 * with `mutates`). Every file goes along, as last edited.
	 */
	run(mode: RunMode = 'run'): void {
		const language = languageOf(this.language);
		if (mode === 'run' ? !language.runs : mode === 'test' ? !language.tests : !language.mutates) return;
		if (mode === 'run' && language.preview) {
			this.host?.showPreview();
			this.host?.showTerminal();
			this.runner.attach(`Previewing ${language.preview}. Its console appears here; edits reload the page, and a stylesheet edit is applied without a reload.`);
			this.preview.start(packOf(language), language.preview, () => this.currentFiles());
			return;
		}
		const entry = this.models.has(language.entry) ? language.entry : this.active;
		if (!entry) {
			this.write('warning', `There is no ${language.entry} to run.`);
			return;
		}
		// On a Linux target the runner runs GoogleTest tests (and RapidCheck)
		// under QEMU, and refuses Catch2 and doctest by name (packs/cpp README).
		const files = this.currentFiles();
		this.host?.showTerminal();
		// A C++ runner reads its level from compile_flags.txt; Swift's is sent.
		const level = this.language !== 'cpp' && this.optimization ? (this.optimization.kind === 'other' ? null : this.optimization.level.flag) : null;
		this.runner.start(packOf(language), files, entry, mode, this.language === 'cpp' ? { ...this.runOptions } : level ? { optimization: level } : undefined);
	}

	/**
	 * Opens a compiler output view of the active C or C++ source (languages
	 * with `explores`); does nothing for another language.
	 */
	async showView(kind: ExploreKind): Promise<void> {
		if (!languageOf(this.language).explores?.includes(kind)) return;
		const generation = this.generation;
		try {
			await this.loadExplorer();
		} catch (e) {
			this.write('error', `The compiler output views could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		// The language changed while the views' code downloaded: the request was for the old one.
		if (generation === this.generation) this.host?.showView(kind);
	}

	/** The explorer, loading its code the first time. */
	private loadExplorer(): Promise<Explorer> {
		this.explorerLoad ??= import('./explorer.svelte').then(({ Explorer }) => {
			const explorer = new Explorer({
				pack: () => {
					const language = languageOf(this.language);
					return language.explores?.length ? packOf(language) : null;
				},
				files: () => this.currentFiles(),
			});
			explorer.activeChanged(this.active);
			this.explorer = explorer;
			return explorer;
		});
		// A failed download may succeed on the next try.
		this.explorerLoad.catch(() => (this.explorerLoad = null));
		return this.explorerLoad;
	}

	/**
	 * Puts a C++ project on target `id` (cpp-targets.ts): compile_flags.txt
	 * is rewritten (or created) as one edit, which Undo takes back, then
	 * saved; clangd, Run and the views follow the file. The output panel
	 * says what changed.
	 */
	chooseTarget(id: CppTargetId): void {
		if (this.language !== 'cpp') return;
		const target = targetById(id);
		const model = this.models.get(COMPILE_FLAGS);
		const before = model?.getValue();
		const after = withTarget(before, id);
		if (model && after !== before) {
			model.pushStackElement();
			model.pushEditOperations([], [{ range: model.getFullModelRange(), text: after }], () => null);
			model.pushStackElement();
		} else if (!model && after) {
			this.addModel(COMPILE_FLAGS, after, true);
			this.files = [...this.models.keys()].sort();
			// A new model fires no content change, which is how an edit reaches the open views.
			this.explorer?.edited();
		}
		this.refreshTarget();
		const how = target.default ? `no --target line in ${COMPILE_FLAGS}` : `--target=${target.triple} in ${COMPILE_FLAGS}`;
		this.write('info', `Target: ${target.label} (${how}).${target.runtime === 'linux' ? ' Run compiles for Linux and runs the program under QEMU, and Test its GoogleTest tests (Catch2 and doctest run on WebAssembly only).' : ''}`);
		this.scheduleSave();
	}

	/**
	 * Turns the C or C++ project's sanitizers on or off as `choice` says
	 * (cpp-sanitizers.ts): compile_flags.txt's -fsanitize= line is
	 * rewritten (or the file created) as one edit, which Undo takes back,
	 * then saved; clangd, Run, Test, the views and Download follow the file.
	 * The output panel says what changed.
	 */
	chooseSanitizers(choice: SanitizerChoice): void {
		if (this.language !== 'cpp') return;
		const model = this.models.get(COMPILE_FLAGS);
		const before = model?.getValue();
		const after = withSanitizers(before, choice);
		if (model && after !== before) {
			model.pushStackElement();
			model.pushEditOperations([], [{ range: model.getFullModelRange(), text: after }], () => null);
			model.pushStackElement();
		} else if (!model && after) {
			this.addModel(COMPILE_FLAGS, after, true);
			this.files = [...this.models.keys()].sort();
			// A new model fires no content change, which is how an edit reaches the open views.
			this.explorer?.edited();
		}
		this.refreshTarget();
		this.write('info', describeSanitizers(choice));
		this.scheduleSave();
	}

	/**
	 * Puts the project on the optimisation level `flag` (optimization.ts).
	 * For C and C++ compile_flags.txt's `-O` line is rewritten (or the file
	 * created) as one edit, which Undo takes back, so clangd, Run and the
	 * views follow the file; for Swift and Scala the level is saved with the
	 * project and goes with Run (and Test). The output panel says what changed.
	 */
	chooseOptimization(flag: string): void {
		const levels = levelsOf(this.language);
		const level = levels?.find((l) => l.flag === flag);
		if (!levels || !level) return;
		if (this.language === 'cpp') {
			const model = this.models.get(COMPILE_FLAGS);
			const before = model?.getValue();
			const after = withCppLevel(before, flag);
			if (model && after !== before) {
				model.pushStackElement();
				model.pushEditOperations([], [{ range: model.getFullModelRange(), text: after }], () => null);
				model.pushStackElement();
			} else if (!model && after) {
				this.addModel(COMPILE_FLAGS, after, true);
				this.files = [...this.models.keys()].sort();
				this.explorer?.edited();
			}
			const how = level.default ? `no -O line in ${COMPILE_FLAGS}: Run and the views add ${flag}` : `${flag} in ${COMPILE_FLAGS}`;
			this.write('info', `Optimization: ${flag} (${how}).`);
		} else {
			this.chosenLevel = level.default ? null : flag;
			const what = languageOf(this.language).tests ? 'Run and Test' : 'Run';
			this.write('info', `Optimization: ${level.label}, for ${what}${level.default ? ' (the default)' : ''}.`);
		}
		this.refreshOptimization();
		this.scheduleSave();
	}

	/** Changes how Run runs a program built for a Linux target; saved with the project. */
	setRunOptions(options: Partial<RunOptions>): void {
		this.runOptions = { ...this.runOptions, ...options };
		this.runOptionsChosen = true;
		this.scheduleSave();
	}

	/**
	 * Downloads the project as `<language>-project.zip`, for an IDE: its files
	 * as last edited and its empty folders, in a folder of the same name, plus
	 * the build files, README and .gitignore it lacks (export.ts). Says in the
	 * output panel what was generated.
	 */
	async download(): Promise<void> {
		const language = languageOf(this.language);
		const files = this.currentFiles();
		const exported = exportProject(language, files, this.language === 'cpp' ? null : this.chosenLevel);
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

	/**
	 * Switches a C++ project's tests to `framework` (cpp-tests.ts): the
	 * sample's tests are rewritten for it, or a sample test file is added,
	 * and the output panel says which.
	 */
	chooseTestFramework(framework: TestFramework): void {
		const change = chooseTestFramework(this.currentFiles(), framework, languageOf('cpp').sample);
		for (const [path, text] of Object.entries(change.write)) {
			const model = this.models.get(path);
			if (model) model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
			else this.addModel(path, text, true);
		}
		this.files = [...this.models.keys()].sort();
		if (change.show) this.host?.open(change.show);
		this.write(change.mixed ? 'warning' : 'info', change.message);
		this.scheduleSave();
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

	/** Every file of the project as last edited. */
	private currentFiles(): Record<string, string> {
		const files: Record<string, string> = {};
		for (const [path, model] of this.models) files[path] = model.getValue();
		return files;
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
		this.explorer?.activeChanged(active);
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
		this.explorer?.edited();
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
		this.explorer?.edited();
		this.scheduleSave();
	}

	/** Deletes a file, or a folder with everything in it. */
	delete(path: string): void {
		const doomed = this.models.has(path) ? [path] : [...this.models.keys()].filter((p) => p.startsWith(path + '/'));
		for (const p of doomed) this.removeModel(p);
		this.folders = this.folders.filter((f) => f !== path && !f.startsWith(path + '/'));
		this.files = [...this.models.keys()].sort();
		this.explorer?.edited();
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
		this.runOptions = { ...(project.runOptions ?? DEFAULT_RUN_OPTIONS) };
		this.runOptionsChosen = project.runOptions !== undefined;
		this.chosenLevel = project.optimization ?? null;
		this.host?.closeAll();
		const entry = languageOf(this.language).entry;
		const open = project.open.length ? project.open : this.models.has(entry) ? [entry] : this.files.slice(0, 1);
		for (const p of open) this.host?.open(p);
		const active = project.active ?? open[0];
		if (active) this.host?.open(active);
		this.refreshTestFramework();
		this.refreshTarget();
		this.refreshOptimization();
	}

	private addModel(path: string, text: string, created: boolean): void {
		const model = monaco.editor.createModel(text, undefined, uriOf(path));
		model.onDidChangeContent(() => {
			this.scheduleSave(path);
			this.preview.changed(path);
			this.explorer?.edited();
		});
		this.models.set(path, model);
		if (created) this.preview.changed(path);
		this.client?.addModel(model, created);
	}

	private removeModel(path: string): void {
		const model = this.models.get(path);
		if (!model) return;
		this.host?.close(path);
		this.client?.removeModel(model);
		this.models.delete(path);
		this.preview.changed(path);
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

	/** Stops the compiler output views' worker and closes their panels. */
	private closeViews(): void {
		this.explorer?.reset();
		this.host?.hideViews();
	}

	/** Saves the project, stops its server, and removes its files from the editor. */
	private async closeProject(): Promise<void> {
		this.runner.stop(false);
		this.runner.clear();
		this.preview.stop();
		this.host?.hidePreview();
		this.closeViews();
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
			serverUrl: new URL(`packs/${packOf(language)}/server.js`, document.baseURI),
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
		// A runner kept warm starts once the server has: both load the same
		// compiler, and the editor's answers come first.
		this.runner.keepWarm(null);
		client.start(() => this.models.values()).then(
			() => {
				if (this.client === client && language.warmRunner && language.runs) this.runner.keepWarm(packOf(language));
			},
			async (e: unknown) => {
				if (this.client !== client) return;
				this.write('error', `${language.label} language server: ${e instanceof Error ? e.message : String(e)}`);
				// A worker that fails to load says nothing about why; a missing pack is the usual reason.
				const status = await fetch(client.serverUrl, { method: 'HEAD' }).then((r) => r.status, () => 0);
				if (status === 404) this.write('error', `The ${language.label} pack is not installed: ${client.serverUrl.pathname} was not found. Build it with packs/${packOf(language)}/build.sh.`);
			},
		);
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

	private refreshTestFramework(): void {
		if (this.language !== 'cpp') {
			this.testFramework = null;
			return;
		}
		// Only tests/ decides, so a keystroke elsewhere reads no other file.
		const tests: Record<string, string> = {};
		for (const [path, model] of this.models) if (path.startsWith(TESTS_DIR)) tests[path] = model.getValue();
		const detected = detectTestFramework(tests);
		this.testFramework = detected.mixed ? 'mixed' : detected.framework;
	}

	/** The target and the sanitizers, which compile_flags.txt says. */
	private refreshTarget(): void {
		const flags = this.models.get(COMPILE_FLAGS)?.getValue();
		this.target = this.language === 'cpp' ? targetOf(flags) : null;
		this.sanitizers = this.language === 'cpp' ? sanitizersOf(flags) : null;
	}

	private refreshOptimization(): void {
		const levels = levelsOf(this.language);
		if (!levels) this.optimization = null;
		else if (this.language === 'cpp') this.optimization = cppLevelOf(this.models.get(COMPILE_FLAGS)?.getValue());
		else {
			const level = levels.find((l) => l.flag === this.chosenLevel);
			this.optimization = level ? { kind: 'level', level } : { kind: 'default', level: defaultLevel(levels) };
		}
	}

	/**
	 * Saves shortly. `edited` is the file whose text changed, if that is all
	 * that did: the test framework is then looked at again only when it is
	 * under tests/, and the target only when it is compile_flags.txt, not on
	 * every keystroke in any file.
	 */
	private scheduleSave(edited?: string): void {
		if (edited === undefined || edited.startsWith(TESTS_DIR)) this.refreshTestFramework();
		if (edited === undefined || edited === COMPILE_FLAGS) {
			this.refreshTarget();
			this.refreshOptimization();
		}
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
	}

	private saveNow(): void {
		clearTimeout(this.saveTimer);
		const files = this.currentFiles();
		const project = { files, folders: this.folders, open: this.open.filter((p) => p in files), active: this.active, ...(this.runOptionsChosen ? { runOptions: { ...this.runOptions } } : {}), ...(this.chosenLevel ? { optimization: this.chosenLevel } : {}) };
		saveProject(this.language, project, (m) => this.write('error', m));
	}
}

/** The file name shown on a tab. */
export { baseName };
