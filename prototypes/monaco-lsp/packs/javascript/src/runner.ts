/**
 * Runs a JavaScript or TypeScript project in this worker, as the "Running a
 * program" section of packs/CONTRACT.md describes.
 *
 * The project's files are ES modules. Each one becomes a `blob:` URL whose
 * relative imports (`./geometry.js`, `../lib/x.js`, a literal `import()`)
 * have been rewritten to the URLs of the files they name, found with
 * es-module-lexer rather than a regular expression, so strings and comments
 * that merely look like imports are left alone. The entry is then imported,
 * and the browser runs the graph as it would any other module graph.
 *
 * `.ts` and `.mts` files have their types stripped first, as `node main.ts`
 * does (Node 22.18 and later): types become whitespace (strip.ts), so lines
 * and columns stay those of the source, and syntax that is more than types
 * (`enum`, `namespace`, parameter properties) is refused with Node's reason.
 * TypeScript itself is loaded only for a project that has such files, from
 * the file the language server downloads (one download, cached once).
 *
 * The program sees an ordinary worker plus the Node globals a command-line
 * program needs: `console` writes to the terminal, `prompt(message)` reads a
 * line from it (blocking, like the browser's own `prompt`), and `process`
 * (`argv`, `exit`, `exitCode`, `stdout.write`) and `node:readline` work over
 * the same terminal (src/node/process.ts). The program has ended when its
 * modules have been evaluated and no timer it started is pending; promises
 * it awaits without a timer (an unanswered `fetch`) are not tracked, and such
 * a program needs Stop.
 *
 * `node:test`, `node:assert` and `node:assert/strict` (and `assert`,
 * `assert/strict`) import this pack's own versions (`src/node/`), so a
 * project can be tested as with `node --test`. `type: 'test'` does that: it
 * imports every test file `node --test` would find, each with its own copy
 * of the project's modules, runs their tests one after another and prints a
 * report like Node's spec reporter; exit 0 only when every test passed.
 *
 * `type: 'mutate'` runs mutation testing with StrykerJS (src/mutate.ts):
 * its instrumenter, loaded only then, compiles every mutant into the
 * project, and each test file runs once per mutant in a fresh worker that
 * is this runner again, given `type: 'mutant'`: a Test of that one file,
 * whose report it keeps and answers with, instead of printing it.
 *
 * `type: 'preview'` is this pack's addition to the contract, for web
 * projects: the worker stays alive and answers each request with the page
 * (`index.html`) as one self-contained document for a sandboxed iframe,
 * its stylesheets inlined and its module scripts linked as `data:` URLs
 * (see `buildPage`).
 */
import { init, parse } from 'es-module-lexer/minimal';
import type * as TS from 'typescript';
import { legacy as assertLegacy, setSources, strict as assertStrict } from './node/assert';
import { createProcess, createReadline, ExitSignal, type Io } from './node/process';
import * as nodeTest from './node/test';
import { mutate, NAMESPACE, type MutantResult, type MutantRun } from './mutate';
import type * as Strip from './strip';
import type * as Stryker from './stryker/index';

// Injected by build.sh: the TypeScript file next to this script (the one the
// language server downloads) and its uncompressed size, for the progress bar.
declare const __TS_FILE__: string;
declare const __TS_SIZE__: number;
/**
 * Injected by build.sh: the npm packages this pack ships, by bare specifier,
 * each as one ES module file next to this script (`fast-check` is
 * `fast-check-<version>.js`, fast-check bundled with pure-rand). See
 * `packageUrl`.
 */
declare const __PACKAGES__: Record<string, string>;
/** Injected by build.sh: StrykerJS's bundle (src/stryker/index.ts) next to this script, and its size. */
declare const __STRYKER_FILE__: string;
declare const __STRYKER_SIZE__: number;

type ToApp =
	| { type: 'loading'; label: string; loaded: number; total: number }
	| { type: 'phase'; text: string }
	| { type: 'stdout' | 'stderr'; text: string }
	| { type: 'stdin' }
	| { type: 'exit'; code: number }
	| Page;

/**
 * The answer to a `preview` request: the page as one HTML document, or
 * `html: null` and the reasons it could not be built. `styles` are the
 * project paths of the stylesheets the page inlined, in the
 * `<style data-yukibana-href="path">` elements the app may swap in place.
 */
interface Page {
	type: 'page';
	id: number;
	html: string | null;
	styles: string[];
	errors: string[];
}

interface Run {
	type: 'run' | 'test' | 'mutate';
	files: Record<string, string>;
	entry: string;
	stdin: SharedArrayBuffer | null;
	/** Arguments after the entry in `process.argv`; none when absent. */
	args?: string[];
}

interface Preview {
	type: 'preview';
	/** Echoed in the answer, so the app can drop answers to requests it has replaced. */
	id: number;
	files: Record<string, string>;
	/** The page, e.g. `index.html`. */
	entry: string;
}

/**
 * In a mutant run's worker (`type: 'mutant'`), what the Test of its file
 * printed, and how long its tests took; null in any other run.
 */
let capture: { text: string; net: number } | null = null;

/**
 * Messages after the run has ended are dropped: `process.exit()` stops the
 * program's output there. In a mutant run, output is kept and the exit
 * becomes the result (src/mutate.ts).
 */
const send = (message: ToApp) => {
	if (exited) return;
	if (!capture) {
		postMessage(message);
		return;
	}
	if (message.type === 'stdout' || message.type === 'stderr') capture.text += message.text;
	else if (message.type === 'exit') {
		const ns = (globalThis as Record<string, unknown>)[NAMESPACE] as { mutantCoverage?: { static?: Record<string, number> }; hitCount?: number } | undefined;
		postMessage({ type: 'mutant-result', code: message.code, report: capture.text, net: capture.net, coverage: ns?.mutantCoverage?.static ?? {}, hitCount: ns?.hitCount ?? null } satisfies MutantResult);
	}
};

/** A problem in the project itself (a missing or circular import), reported without a stack. */
class ProjectError extends Error {}

onmessage = (e: MessageEvent<Run | Preview | MutantRun>) => {
	const m = e.data;
	// A preview worker serves one request after another until the app terminates it.
	if (m.type === 'preview') {
		void preview(m);
		return;
	}
	if (m.type === 'mutant') {
		onmessage = null;
		void runMutant(m);
		return;
	}
	if (m.type !== 'run' && m.type !== 'test' && m.type !== 'mutate') return;
	onmessage = null;
	void (m.type === 'test' ? runTests(m) : m.type === 'mutate' ? runMutate(m) : run(m));
};

/** The real timers, before `trackTimers` wraps them: test timeouts are not the program's timers. */
const realTimers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
const writeLine = (text: string) => send({ type: 'stdout', text: `${text}\n` });

/** How `node` links a project: exact paths, Node's built-in modules, types stripped strictly. */
const NODE: LinkOptions = { url: blobUrl, resolution: 'exact', builtins: true, lenient: false };

async function run({ files, entry, stdin, args }: Run): Promise<void> {
	installConsole();
	const process = installProcess(installPrompt(stdin), entry, args ?? []);
	const timers = trackTimers();
	addEventListener('unhandledrejection', (e) => fail(e.reason));
	addEventListener('error', (e) => {
		e.preventDefault();
		fail(e.error ?? e.message);
	});

	let url: string;
	try {
		await init();
		await loadTypeScriptFor(files);
		url = link(files, entry, NODE);
	} catch (e) {
		fail(e);
		return;
	}
	setSources(files);
	nodeTest.configure({ write: writeLine, ...realTimers, files: Object.keys(files) });
	nodeTest.startFile(entry);
	send({ type: 'phase', text: 'Running' });
	try {
		await import(/* @vite-ignore */ url);
	} catch (e) {
		fail(e);
		return;
	}
	await timers.idle();
	// `node main.js` runs the tests a program defines with node:test, and so does this.
	if (nodeTest.hasTests()) {
		const started = performance.now();
		await nodeTest.finishFile();
		exit(nodeTest.summary(performance.now() - started));
		return;
	}
	exit(Number(process.exitCode ?? 0) || 0);
}

/** TypeScript sources the runner strips: `.ts` and `.mts`, not declaration files. */
const isTypeScript = (path: string) => /\.m?ts$/.test(path) && !/\.d\.m?ts$/.test(path);

/**
 * The files `node --test` runs when given no paths (Node 22's defaults, with
 * type stripping): `*.test.js`, `*-test.js`, `*_test.js`, `test-*.js`,
 * `test.js` in any directory and every file under a `test/` directory,
 * `.mjs`, `.ts` and `.mts` too, outside node_modules.
 */
function isTestFile(path: string): boolean {
	if (!/\.m?[jt]s$/.test(path) || /\.d\.m?ts$/.test(path) || /(^|\/)node_modules\//.test(path)) return false;
	const name = path.slice(path.lastIndexOf('/') + 1);
	return /(^|\/)test\//.test(path) || /^(.+[.\-_]test|test-.*|test)\.m?[jt]s$/.test(name);
}

const NO_TEST_FILES = 'No test files found: node --test looks for *.test.js, *-test.js, *_test.js, test-*.js, test.js and test/**/*.js (and the same with .mjs, .ts and .mts).\n';

/**
 * Test, as `node --test`; with `only`, the Test of those files alone (a
 * mutant run), whose sources are already JavaScript.
 */
async function runTests({ files, stdin, entry, args }: Run, only?: string[]): Promise<void> {
	installConsole();
	installProcess(installPrompt(stdin), entry, args ?? []);
	const tests = only ?? Object.keys(files).filter(isTestFile).sort();
	if (tests.length === 0) {
		send({ type: 'stderr', text: NO_TEST_FILES });
		exit(1);
		return;
	}
	addEventListener('unhandledrejection', (e) => {
		e.preventDefault();
		if (!(e.reason instanceof ExitSignal)) nodeTest.reportUncaught(e.reason);
	});
	addEventListener('error', (e) => {
		e.preventDefault();
		if (!(e.error instanceof ExitSignal)) nodeTest.reportUncaught(e.error ?? e.message);
	});
	try {
		await init();
		if (!only) await loadTypeScriptFor(files);
	} catch (e) {
		fail(e);
		return;
	}
	setSources(files);
	nodeTest.configure({ write: writeLine, ...realTimers, files: Object.keys(files) });
	send({ type: 'phase', text: 'Testing' });
	const started = performance.now();
	for (const file of tests) {
		nodeTest.startFile(file);
		let error: unknown;
		try {
			// A fresh link per file: each test file gets its own instances of the
			// project's modules, as in Node, where every file is its own process.
			await import(/* @vite-ignore */ link(files, file, NODE));
		} catch (e) {
			error = e;
		}
		await nodeTest.finishFile(error);
	}
	if (capture) capture.net = performance.now() - started;
	exit(nodeTest.summary(performance.now() - started));
}

/** Mutate: mutation testing with StrykerJS (src/mutate.ts). */
async function runMutate({ files, stdin, entry, args }: Run): Promise<void> {
	installConsole();
	installProcess(installPrompt(stdin), entry, args ?? []);
	addEventListener('unhandledrejection', (e) => fail(e.reason));
	const testFiles = Object.keys(files).filter(isTestFile).sort();
	if (testFiles.length === 0) {
		send({ type: 'stderr', text: NO_TEST_FILES });
		exit(1);
		return;
	}
	try {
		await init();
		await loadTypeScriptFor(files);
		exit(
			await mutate({
				files,
				testFiles,
				toJavaScript: (path, source) => toJavaScript(path, source, false),
				load: loadStryker,
				workerUrl: import.meta.url,
				write: (text) => send({ type: 'stdout', text }),
				phase: (text) => send({ type: 'phase', text }),
				...realTimers,
			}),
		);
	} catch (e) {
		fail(e);
	}
}

/**
 * One test file of a mutant run, in a worker of its own (src/mutate.ts):
 * Stryker's namespace is set before the project's modules load, so their
 * instrumented code sees the active mutant from its first line, and the
 * file's Test is kept rather than printed (`capture`).
 */
async function runMutant({ files, testFile, activeMutant, hitLimit }: MutantRun): Promise<void> {
	capture = { text: '', net: 0 };
	javascriptOnly = true;
	Object.defineProperty(globalThis, NAMESPACE, {
		value: { ...(activeMutant !== null ? { activeMutant } : {}), ...(hitLimit !== null ? { hitLimit, hitCount: 0 } : {}) },
		writable: true,
		configurable: true,
	});
	await runTests({ type: 'test', files, entry: testFile, stdin: null }, [testFile]);
}

/** Loads StrykerJS's bundle, once, from the file next to this script. */
async function loadStryker(): Promise<typeof Stryker> {
	const started = performance.now();
	const bytes = await download(__STRYKER_FILE__, __STRYKER_SIZE__);
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/javascript' }));
	try {
		const stryker = (await import(/* @vite-ignore */ url)) as typeof Stryker;
		send({ type: 'phase', text: `Stryker loaded in ${Math.round(performance.now() - started)} ms` });
		return stryker;
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Node's built-in modules this runner provides, by specifier. Each becomes a
 * small module (a `blob:` URL, made once) that re-exports one of these
 * objects through a global symbol: the test files and the runner must share
 * one `node:test` registry, which a second copy of its code could not.
 * `node:process` and `node:readline` are added by `installProcess`.
 */
const BUILTINS: Record<string, Record<string, unknown>> = {
	'node:test': { ...nodeTest.test, default: nodeTest.test, test: nodeTest.test },
	'node:assert': { ...assertLegacy, default: assertLegacy },
	'node:assert/strict': { ...assertStrict, default: assertStrict },
};
BUILTINS['assert'] = BUILTINS['node:assert']!;
BUILTINS['assert/strict'] = BUILTINS['node:assert/strict']!;
Object.defineProperty(globalThis, Symbol.for('yukibana.builtins'), { value: BUILTINS });
const builtinUrls = new Map<string, string>();

/**
 * The URL of a package this pack ships (`__PACKAGES__`), for a bare import
 * of it in Run and Test: the file next to this script, which the browser
 * fetches only when a module imports it, and then once per worker, so every
 * test file shares one copy of it (Node would load it once per test file's
 * process; fast-check's `configureGlobal` is therefore shared by the files
 * of one Test). Any other bare specifier stays as written and fails as it
 * would without `node_modules`.
 */
function packageUrl(specifier: string): string | undefined {
	const file = Object.hasOwn(__PACKAGES__, specifier) ? __PACKAGES__[specifier] : undefined;
	return file === undefined ? undefined : new URL(file, import.meta.url).href;
}

function builtinUrl(specifier: string): string | undefined {
	const module = BUILTINS[specifier];
	if (!module) return undefined;
	let url = builtinUrls.get(specifier);
	if (!url) {
		const names = Object.keys(module).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
		const source = `const m = globalThis[Symbol.for('yukibana.builtins')][${JSON.stringify(specifier)}];\nexport default m.default;\nexport const { ${names.join(', ')} } = m;\n`;
		url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		builtinUrls.set(specifier, url);
	}
	return url;
}

/**
 * The `process` global, `node:process` and `node:readline(/promises)` (with
 * and without the prefix), over the terminal. `argv` is Node's shape:
 * `['node', '/workspace/main.ts', ...args]`.
 */
function installProcess(readLine: () => string | null, entry: string, args: string[]) {
	const io: Io = {
		write: (stream, text) => send({ type: stream, text }),
		readLine,
		exit,
		argv: ['node', `/workspace/${entry}`, ...args],
	};
	const process = createProcess(io);
	Object.defineProperty(globalThis, 'process', { value: process, writable: true, configurable: true });
	const { readline, promises } = createReadline(io);
	for (const [name, module] of [
		['process', { ...process, default: process }],
		['readline', readline],
		['readline/promises', promises],
	] as const) {
		BUILTINS[name] = module;
		BUILTINS[`node:${name}`] = module;
	}
	return process;
}

let exited = false;

function exit(code: number): void {
	if (exited) return;
	send({ type: 'exit', code });
	exited = true;
	close();
}

/** Reports an uncaught error and ends the program with code 1. */
function fail(error: unknown): void {
	if (exited) return;
	const text = error instanceof ProjectError ? error.message : error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : `Uncaught ${format([error])}`;
	send({ type: 'stderr', text: `${text}\n` });
	exit(1);
}

// ---------------------------------------------------------------------------
// TypeScript

let typescript: Promise<{ ts: typeof TS; strip: typeof Strip.blankSourceFile }> | null = null;

/** Loads TypeScript and the stripper, once, if the project has a `.ts` file. */
async function loadTypeScriptFor(files: Record<string, string>): Promise<void> {
	if (!Object.keys(files).some(isTypeScript)) return;
	typescript ??= (async () => {
		send({ type: 'phase', text: 'Loading TypeScript' });
		const started = performance.now();
		const bytes = await download(__TS_FILE__, __TS_SIZE__);
		// Imported from the bytes already fetched, as the server does, so it is downloaded once.
		const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/javascript' }));
		let ts: typeof TS;
		try {
			ts = ((await import(/* @vite-ignore */ url)) as { default: typeof TS }).default;
		} finally {
			URL.revokeObjectURL(url);
		}
		Object.defineProperty(globalThis, Symbol.for('yukibana.typescript'), { value: ts });
		const { blankSourceFile } = (await import(/* @vite-ignore */ new URL('strip.js', import.meta.url).href)) as typeof Strip;
		send({ type: 'phase', text: `TypeScript loaded in ${Math.round(performance.now() - started)} ms` });
		return { ts, strip: blankSourceFile };
	})();
	stripper = await typescript;
}

let stripper: { ts: typeof TS; strip: typeof Strip.blankSourceFile } | null = null;
/** True in a mutant run, whose project has been made JavaScript already (src/mutate.ts). */
let javascriptOnly = false;

/** Fetches `file` next to this script, reporting progress as `loading` messages. */
async function download(file: string, total: number): Promise<Uint8Array> {
	const response = await fetch(new URL(file, import.meta.url));
	if (!response.ok || !response.body) throw new ProjectError(`Could not load ${file}: HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	let reported = -1;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.byteLength;
		const step = Math.floor((loaded / Math.max(total, 1)) * 20);
		if (step !== reported) {
			reported = step;
			send({ type: 'loading', label: file, loaded, total: Math.max(total, loaded) });
		}
	}
	const bytes = new Uint8Array(loaded);
	let at = 0;
	for (const c of chunks) {
		bytes.set(c, at);
		at += c.byteLength;
	}
	return bytes;
}

/** What a construct `node` will not strip is called in its refusal. */
const UNSUPPORTED: Record<string, string> = {
	EnumDeclaration: 'An enum',
	ModuleDeclaration: 'A namespace with values',
	Parameter: 'A parameter property',
	ImportEqualsDeclaration: '`import x = require()`',
	ExportAssignment: '`export =`',
};

/**
 * The JavaScript of a project file: TypeScript with its types replaced by
 * whitespace, anything else as it is. Syntax that is more than types is a
 * `ProjectError` with Node's reason, unless `lenient`, in which case the
 * file is compiled with `ts.transpileModule` instead (as a bundler would;
 * its lines may then differ from the source's).
 */
function toJavaScript(path: string, source: string, lenient: boolean): string {
	if (!isTypeScript(path) || javascriptOnly) return source;
	if (!stripper) throw new Error('TypeScript was not loaded');
	const { ts, strip } = stripper;
	const file = ts.createSourceFile(path, source, { languageVersion: ts.ScriptTarget.ESNext, impliedNodeFormat: ts.ModuleKind.ESNext, jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, false, ts.ScriptKind.TS);
	const unsupported: TS.Node[] = [];
	const js = strip(file, (node) => unsupported.push(node));
	const first = unsupported[0];
	if (!first) return js;
	if (lenient) return ts.transpileModule(source, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
	const { line, character } = file.getLineAndCharacterOfPosition(first.getStart(file));
	const what = UNSUPPORTED[ts.SyntaxKind[first.kind]] ?? `TypeScript syntax (${ts.SyntaxKind[first.kind]})`;
	throw new ProjectError(
		`${path}:${line + 1}:${character + 1}: ${what} is not supported when types are only stripped, which is how node runs .ts files (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). The project's tsconfig.json can say so in the editor with "erasableSyntaxOnly": true.`,
	);
}

// ---------------------------------------------------------------------------
// Linking

interface LinkOptions {
	/** The URL a module (or JSON file) is loaded from. */
	url(text: string, type: string): string;
	/**
	 * 'exact': a relative import names the file, as in Node. 'bundler': as
	 * Vite resolves, also without the extension (`./x` is `x.ts` or `x.js`,
	 * or `x/index.ts`) and `./x.js` for `x.ts`.
	 */
	resolution: 'exact' | 'bundler';
	/**
	 * Whether `node:test`, `node:assert` and the rest resolve to the runner's
	 * own, and the packages it ships (`packageUrl`) to theirs.
	 */
	builtins: boolean;
	/** See `toJavaScript`. */
	lenient: boolean;
}

function blobUrl(text: string, type: string): string {
	return URL.createObjectURL(new Blob([text], { type }));
}

/** A `data:` URL, base64 so that nesting one in another module grows it by a third, not threefold. */
function dataUrl(text: string, type: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return `data:${type};base64,${btoa(binary)}`;
}

/** The files a relative import of `target` may mean, in order. */
function candidates(target: string, resolution: LinkOptions['resolution']): string[] {
	if (resolution === 'exact') return [target];
	const out = [target];
	if (/\.m?js$/.test(target)) out.push(target.replace(/js$/, 'ts'));
	if (!/\.[^/]*$/.test(target)) out.push(`${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`);
	return out;
}

/**
 * The `blob:` URL of `entry`, after giving every project module it reaches a
 * URL of its own. Throws a `ProjectError` naming an import that leaves the
 * project, names no file, or closes a cycle (a blob URL must exist before it
 * can be imported, so cyclic graphs cannot be linked this way).
 */
function link(files: Record<string, string>, entry: string, options: LinkOptions): string {
	return linker(files, options)(entry, null);
}

/** A function from a project path to its module URL, sharing one URL per module across calls. */
function linker(files: Record<string, string>, options: LinkOptions): (path: string, from: string | null) => string {
	const urls = new Map<string, string>();
	const visiting = new Set<string>();

	const visit = (path: string, from: string | null): string => {
		const done = urls.get(path);
		if (done) return done;
		const source = Object.hasOwn(files, path) ? files[path] : undefined;
		if (source === undefined) throw new ProjectError(from ? `${from}: cannot find module '${path}'` : `There is no file ${path} to run.`);
		if (visiting.has(path)) throw new ProjectError(`${path}: circular imports cannot be run here (${[...visiting, path].join(' -> ')})`);
		visiting.add(path);

		let url: string;
		if (path.endsWith('.json')) {
			url = options.url(source, 'application/json');
		} else {
			const js = toJavaScript(path, source, options.lenient);
			let imports;
			try {
				[imports] = parse(js, path);
			} catch (e) {
				throw new ProjectError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
			let out = '';
			let last = 0;
			for (const i of imports) {
				const specifier = i.n;
				if (specifier === undefined) continue;
				let targetUrl = options.builtins ? (builtinUrl(specifier) ?? packageUrl(specifier)) : undefined;
				if (targetUrl === undefined) {
					// Other bare specifiers ('lodash') and computed ones stay as written, and fail as they would anyway.
					if (!/^\.{1,2}\//.test(specifier) && !(options.resolution === 'bundler' && specifier.startsWith('/'))) continue;
					const target = specifier.startsWith('/') ? resolve('', specifier.slice(1)) : resolve(path, specifier);
					if (target === null) throw new ProjectError(`${path}: '${specifier}' points outside the project`);
					targetUrl = visit(candidates(target, options.resolution).find((c) => Object.hasOwn(files, c)) ?? target, path);
				}
				// A static import's range is the bare specifier; a dynamic one's is the
				// whole argument, quotes included.
				const quoted = i.d >= 0;
				out += js.slice(last, i.s) + (quoted ? JSON.stringify(targetUrl) : targetUrl);
				last = i.e;
			}
			out += js.slice(last) + `\n//# sourceURL=${path}`;
			url = options.url(out, 'text/javascript');
		}
		visiting.delete(path);
		urls.set(path, url);
		return url;
	};
	return visit;
}

/** `specifier` relative to the file `from`, as a project path, or `null` above the root. */
function resolve(from: string, specifier: string): string | null {
	const parts = from.split('/').slice(0, -1);
	for (const segment of specifier.split('/')) {
		if (segment === '.' || segment === '') continue;
		if (segment === '..') {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(segment);
	}
	return parts.join('/');
}

// ---------------------------------------------------------------------------
// Preview

/** How a page links its scripts: as a bundler (Vite) would, in the browser, without Node's modules. */
const PAGE: LinkOptions = { url: dataUrl, resolution: 'bundler', builtins: false, lenient: true };

async function preview({ id, files, entry }: Preview): Promise<void> {
	try {
		await init();
		await loadTypeScriptFor(files);
		postMessage({ type: 'page', id, ...buildPage(files, entry) } satisfies Page);
	} catch (e) {
		const error = e instanceof ProjectError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
		postMessage({ type: 'page', id, html: null, styles: [], errors: [error] } satisfies Page);
	}
}

/**
 * What the page runs before anything else: `console` and uncaught errors
 * are posted to the app (which shows them in the terminal), and the app's
 * `{ yukibana: 'css', href, text }` replaces a stylesheet in place. The
 * page is a sandboxed iframe with an opaque origin, so `postMessage` is
 * its only way out, and the app checks that a message comes from it.
 */
const BRIDGE = `<script>(() => {
const post = (type, text) => parent.postMessage({ yukibana: 'preview', type, text }, '*');
const show = (v) => { if (typeof v === 'string') return v; if (v instanceof Error) return v.stack || String(v); try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); } };
for (const [name, stream] of [['log', 'stdout'], ['info', 'stdout'], ['debug', 'stdout'], ['warn', 'stderr'], ['error', 'stderr']]) {
  const original = console[name].bind(console);
  console[name] = (...args) => { original(...args); post(stream, args.map(show).join(' ') + '\\n'); };
}
addEventListener('error', (e) => post('stderr', 'Uncaught ' + (e.error ? show(e.error) : e.message) + '\\n'));
addEventListener('unhandledrejection', (e) => post('stderr', 'Uncaught (in promise) ' + show(e.reason) + '\\n'));
addEventListener('message', (e) => {
  const m = e.data;
  if (e.source !== parent || !m || m.yukibana !== 'css') return;
  for (const s of document.querySelectorAll('style[data-yukibana-href]')) if (s.dataset.yukibanaHref === m.href) s.textContent = m.text;
});
})();</script>`;

/** Tags the page rewrites: comments (kept as they are), scripts with their text, and links. */
const TAGS = /<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script\s*>|<link\b([^>]*)>/gi;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributes(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of text.matchAll(ATTRIBUTE)) out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
	return out;
}

/** The project path a page's URL names, or `null` for one that is not a project file (`https:`, `data:`, `#top`). */
function local(page: string, href: string): string | null {
	const url = href.trim().replace(/[?#].*$/, '');
	if (url === '' || /^[a-z][\w+.-]*:/i.test(url) || url.startsWith('//')) return null;
	return url.startsWith('/') ? resolve('', decodeURI(url.slice(1))) : resolve(page, decodeURI(url));
}

const escapeAttribute = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The page `entry` as one document that needs nothing from the app's
 * origin: `<link rel="stylesheet">` to a project file becomes a `<style>`
 * holding it, `<script src>` to a project file and inline module scripts
 * get `data:` URLs whose imports are linked as Vite would resolve them (with
 * TypeScript compiled), and the bridge script goes first. Other URLs are
 * left as they are; a relative one that is not a stylesheet or a script
 * (an image, a CSS `url()`) does not resolve, since the document has no
 * folder of its own.
 */
function buildPage(files: Record<string, string>, entry: string): Omit<Page, 'type' | 'id'> {
	const html = Object.hasOwn(files, entry) ? files[entry] : undefined;
	if (html === undefined) throw new ProjectError(`There is no ${entry} to preview.`);
	const sources = { ...files };
	const visit = linker(sources, PAGE);
	const styles: string[] = [];
	let inline = 0;
	const body = html.replace(TAGS, (whole: string, scriptAttributes: string | undefined, scriptText: string | undefined, linkAttributes: string | undefined) => {
		if (scriptAttributes !== undefined) {
			const attrs = attributes(scriptAttributes);
			const module = attrs.get('type')?.toLowerCase() === 'module';
			const src = attrs.get('src');
			let url: string;
			if (src !== undefined) {
				const path = local(entry, src);
				if (path === null) return whole;
				if (module) url = visit(path, entry);
				else {
					const text = Object.hasOwn(files, path) ? files[path] : undefined;
					if (text === undefined) throw new ProjectError(`${entry}: cannot find script '${src}'`);
					url = dataUrl(toJavaScript(path, text, true) + `\n//# sourceURL=${path}`, 'text/javascript');
				}
			} else if (module && scriptText?.trim()) {
				const path = `${entry}#script${++inline}.js`;
				sources[path] = scriptText;
				url = visit(path, null);
			} else return whole;
			const rest = scriptAttributes.replace(/\s+src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '');
			return `<script${rest} src="${url}"></script>`;
		}
		const attrs = attributes(linkAttributes ?? '');
		const href = attrs.get('href');
		if (!/(^|\s)stylesheet(\s|$)/i.test(attrs.get('rel') ?? '') || href === undefined) return whole;
		const path = local(entry, href);
		if (path === null) return whole;
		const css = Object.hasOwn(files, path) ? files[path] : undefined;
		if (css === undefined) throw new ProjectError(`${entry}: cannot find stylesheet '${href}'`);
		styles.push(path);
		return `<style data-yukibana-href="${escapeAttribute(path)}">${css.replace(/<\/style/gi, '<\\/style')}</style>`;
	});
	const head = /<head\b[^>]*>/i.exec(body) ?? /<html\b[^>]*>/i.exec(body) ?? /<!doctype\b[^>]*>/i.exec(body);
	const at = head ? head.index + head[0].length : 0;
	return { html: body.slice(0, at) + BRIDGE + body.slice(at), styles, errors: [] };
}

/** `console` methods write to the terminal: `error`, `warn` and `trace` to stderr. */
function installConsole(): void {
	const out = (...args: unknown[]) => send({ type: 'stdout', text: format(args) + '\n' });
	const err = (...args: unknown[]) => send({ type: 'stderr', text: format(args) + '\n' });
	Object.assign(console, {
		log: out,
		info: out,
		debug: out,
		error: err,
		warn: err,
		trace: (...args: unknown[]) => err(...args, '\n' + (new Error().stack ?? '').split('\n').slice(2).join('\n')),
		table: out,
		dir: out,
	});
}

/** `console.log`'s formatting, approximately: strings as they are, everything else inspected. */
function format(args: unknown[]): string {
	return args.map((a) => (typeof a === 'string' ? a : inspect(a, 0, new Set()))).join(' ');
}

function inspect(value: unknown, depth: number, seen: Set<object>): string {
	switch (typeof value) {
		case 'string':
			return depth === 0 ? value : JSON.stringify(value);
		case 'bigint':
			return `${value}n`;
		case 'symbol':
		case 'number':
		case 'boolean':
		case 'undefined':
			return String(value);
		case 'function':
			return value.name ? `[Function: ${value.name}]` : '[Function (anonymous)]';
	}
	if (value === null) return 'null';
	const object = value as object;
	if (seen.has(object)) return '[Circular]';
	if (object instanceof Error) return object.stack ?? String(object);
	if (object instanceof Date) return object.toISOString();
	if (object instanceof RegExp) return String(object);
	if (depth > 2) return Array.isArray(object) ? '[Array]' : '[Object]';
	seen.add(object);
	try {
		const inner = (v: unknown) => inspect(v, depth + 1, seen);
		if (Array.isArray(object)) return `[ ${object.map(inner).join(', ')} ]`;
		if (object instanceof Map) return `Map(${object.size}) { ${[...object].map(([k, v]) => `${inner(k)} => ${inner(v)}`).join(', ')} }`;
		if (object instanceof Set) return `Set(${object.size}) { ${[...object].map(inner).join(', ')} }`;
		const name = object.constructor && object.constructor !== Object ? `${object.constructor.name} ` : '';
		const entries = Object.entries(object).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${inner(v)}`);
		return entries.length ? `${name}{ ${entries.join(', ')} }` : `${name}{}`;
	} finally {
		seen.delete(object);
	}
}

/**
 * `prompt(message)` writes the message and blocks until the user enters a
 * line, which it returns without its newline; `null` at end of input, or
 * when the page is not cross-origin isolated and there is no input at all.
 * Returns the line reader itself, which `process` and `readline` share.
 */
function installPrompt(stdin: SharedArrayBuffer | null): () => string | null {
	const decoder = new TextDecoder();
	let buffered = '';
	let ended = stdin === null;
	const read = (): void => {
		if (!stdin) return;
		const state = new Int32Array(stdin, 0, 2);
		Atomics.store(state, 0, 1);
		send({ type: 'stdin' });
		Atomics.wait(state, 0, 1);
		if (Atomics.load(state, 0) === 3) {
			ended = true;
		} else {
			const length = Atomics.load(state, 1);
			// TextDecoder refuses views of shared memory; copy the bytes out first.
			buffered += decoder.decode(new Uint8Array(stdin, 8, length).slice());
		}
		Atomics.store(state, 0, 0);
	};
	const readLine = (): string | null => {
		while (!buffered.includes('\n') && !ended) read();
		if (buffered === '') return null;
		const end = buffered.indexOf('\n');
		const line = end < 0 ? buffered : buffered.slice(0, end);
		buffered = end < 0 ? '' : buffered.slice(end + 1);
		return line;
	};
	const prompt = (message?: unknown): string | null => {
		if (message !== undefined && message !== '') send({ type: 'stdout', text: String(message) });
		return readLine();
	};
	Object.assign(globalThis, { prompt });
	return readLine;
}

/**
 * Counts the timers the program has pending, so the runner can tell when it
 * has finished. `idle` resolves once none is left (an interval never ends:
 * such a program runs until it is stopped).
 */
function trackTimers(): { idle(): Promise<void> } {
	const pending = new Set<number>();
	let wake: (() => void) | null = null;
	const settle = () => {
		if (pending.size === 0 && wake) {
			// Let the callback's own microtasks (and any timer they start) run first.
			queueMicrotask(() => setTimeoutOriginal(() => pending.size === 0 && wake?.()));
		}
	};
	const setTimeoutOriginal = globalThis.setTimeout.bind(globalThis);
	const clearTimeoutOriginal = globalThis.clearTimeout.bind(globalThis);
	const setIntervalOriginal = globalThis.setInterval.bind(globalThis);
	const clearIntervalOriginal = globalThis.clearInterval.bind(globalThis);
	Object.assign(globalThis, {
		setTimeout: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
			const id = setTimeoutOriginal(() => {
				pending.delete(id);
				try {
					callback(...args);
				} finally {
					settle();
				}
			}, ms);
			pending.add(id);
			return id;
		},
		clearTimeout: (id: number) => {
			clearTimeoutOriginal(id);
			pending.delete(id);
			settle();
		},
		setInterval: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
			const id = setIntervalOriginal(callback, ms, ...args);
			pending.add(id);
			return id;
		},
		clearInterval: (id: number) => {
			clearIntervalOriginal(id);
			pending.delete(id);
			settle();
		},
	});
	return {
		idle: () =>
			new Promise<void>((resolve) => {
				wake = resolve;
				settle();
			}),
	};
}
