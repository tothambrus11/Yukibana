/**
 * Runs a JavaScript project in this worker, as the "Running a program"
 * section of packs/CONTRACT.md describes.
 *
 * The project's files are ES modules. Each one becomes a `blob:` URL whose
 * relative imports (`./geometry.js`, `../lib/x.js`, a literal `import()`)
 * have been rewritten to the URLs of the files they name, found with
 * es-module-lexer rather than a regular expression, so strings and comments
 * that merely look like imports are left alone. The entry is then imported,
 * and the browser runs the graph as it would any other module graph.
 *
 * The program sees an ordinary worker: `console` writes to the terminal and
 * `prompt(message)` reads a line from it (blocking, like the browser's own
 * `prompt`). The program has ended when its modules have been evaluated and
 * no timer it started is pending; promises it awaits without a timer
 * (an unanswered `fetch`) are not tracked, and such a program needs Stop.
 */
import { init, parse } from 'es-module-lexer/minimal';

type ToApp =
	| { type: 'phase'; text: string }
	| { type: 'stdout' | 'stderr'; text: string }
	| { type: 'stdin' }
	| { type: 'exit'; code: number };

interface Run {
	type: 'run';
	files: Record<string, string>;
	entry: string;
	stdin: SharedArrayBuffer | null;
}

const send = (message: ToApp) => postMessage(message);

/** A problem in the project itself (a missing or circular import), reported without a stack. */
class ProjectError extends Error {}

onmessage = (e: MessageEvent<Run>) => {
	if (e.data.type !== 'run') return;
	onmessage = null;
	void run(e.data);
};

async function run({ files, entry, stdin }: Run): Promise<void> {
	installConsole();
	installPrompt(stdin);
	const timers = trackTimers();
	addEventListener('unhandledrejection', (e) => fail(e.reason));
	addEventListener('error', (e) => {
		e.preventDefault();
		fail(e.error ?? e.message);
	});

	let url: string;
	try {
		await init();
		url = link(files, entry);
	} catch (e) {
		fail(e);
		return;
	}
	send({ type: 'phase', text: 'Running' });
	try {
		await import(/* @vite-ignore */ url);
	} catch (e) {
		fail(e);
		return;
	}
	await timers.idle();
	exit(0);
}

let exited = false;

function exit(code: number): void {
	if (exited) return;
	exited = true;
	send({ type: 'exit', code });
	close();
}

/** Reports an uncaught error and ends the program with code 1. */
function fail(error: unknown): void {
	if (exited) return;
	const text = error instanceof ProjectError ? error.message : error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : `Uncaught ${format([error])}`;
	send({ type: 'stderr', text: `${text}\n` });
	exit(1);
}

/**
 * The `blob:` URL of `entry`, after giving every project module it reaches a
 * URL of its own. Throws a `ProjectError` naming an import that leaves the
 * project, names no file, or closes a cycle (a blob URL must exist before it
 * can be imported, so cyclic graphs cannot be linked this way).
 */
function link(files: Record<string, string>, entry: string): string {
	const urls = new Map<string, string>();
	const visiting = new Set<string>();

	const visit = (path: string, from: string | null): string => {
		const done = urls.get(path);
		if (done) return done;
		const source = files[path];
		if (source === undefined) throw new ProjectError(from ? `${from}: cannot find module '${path}'` : `There is no file ${path} to run.`);
		if (visiting.has(path)) throw new ProjectError(`${path}: circular imports cannot be run here (${[...visiting, path].join(' -> ')})`);
		visiting.add(path);

		let url: string;
		if (path.endsWith('.json')) {
			url = URL.createObjectURL(new Blob([source], { type: 'application/json' }));
		} else {
			let imports;
			try {
				[imports] = parse(source, path);
			} catch (e) {
				throw new ProjectError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
			let out = '';
			let last = 0;
			for (const i of imports) {
				const specifier = i.n;
				// Bare specifiers ('lodash') and computed ones stay as written, and fail as they would anyway.
				if (specifier === undefined || !/^\.{1,2}\//.test(specifier)) continue;
				const target = resolve(path, specifier);
				if (target === null) throw new ProjectError(`${path}: '${specifier}' points outside the project`);
				const targetUrl = visit(target, path);
				// A static import's range is the bare specifier; a dynamic one's is the
				// whole argument, quotes included.
				const quoted = i.d >= 0;
				out += source.slice(last, i.s) + (quoted ? JSON.stringify(targetUrl) : targetUrl);
				last = i.e;
			}
			out += source.slice(last) + `\n//# sourceURL=${path}`;
			url = URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
		}
		visiting.delete(path);
		urls.set(path, url);
		return url;
	};

	return visit(entry, null);
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
 */
function installPrompt(stdin: SharedArrayBuffer | null): void {
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
	const prompt = (message?: unknown): string | null => {
		if (message !== undefined && message !== '') send({ type: 'stdout', text: String(message) });
		while (!buffered.includes('\n') && !ended) read();
		if (buffered === '') return null;
		const end = buffered.indexOf('\n');
		const line = end < 0 ? buffered : buffered.slice(0, end);
		buffered = end < 0 ? '' : buffered.slice(end + 1);
		return line;
	};
	Object.assign(globalThis, { prompt });
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
