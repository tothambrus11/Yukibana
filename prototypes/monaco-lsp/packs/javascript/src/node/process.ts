/**
 * The parts of Node's `process` and `node:readline` that make a command-line
 * program natural to write, over the runner's terminal (packs/CONTRACT.md,
 * "Running a program"): `process.argv`, `process.exit`, `process.exitCode`,
 * `process.stdout.write`, and lines from stdin through `readline`'s
 * `createInterface` (`question`, `'line'` events, `for await ... of rl`) and
 * `node:readline/promises`.
 *
 * Reading blocks the worker (the contract's stdin protocol), so each read is
 * done in a timer callback of its own: the program's other callbacks and
 * microtasks run between two lines, and the pending timer is what keeps the
 * run alive while an interface waits, as an open stdin keeps Node alive.
 * At end of input an interface closes (`'close'`), and a promise from
 * `readline/promises`' `question` is left pending, as in Node, where the
 * process then simply ends.
 */

/** What the runner gives these modules. */
export interface Io {
	write(stream: 'stdout' | 'stderr', text: string): void;
	/** The next line of input without its newline, blocking; `null` at end of input. */
	readLine(): string | null;
	/** Ends the run with this exit code (the runner's own `exit`). */
	exit(code: number): void;
	argv: string[];
}

/**
 * Thrown by `process.exit()` after the run has ended, to unwind the
 * program's stack: code after the call must not run, and a worker cannot
 * stop the task it is in. A `catch` in the program can swallow it, but the
 * run is over by then and later output is dropped.
 */
export class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

const decoder = new TextDecoder();
const textOf = (chunk: unknown) => (typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? decoder.decode(chunk) : String(chunk));

/** A writable stream as far as a CLI uses one. */
function writable(io: Io, stream: 'stdout' | 'stderr') {
	return {
		isTTY: true,
		columns: 80,
		rows: 24,
		fd: stream === 'stdout' ? 1 : 2,
		write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
			io.write(stream, textOf(chunk));
			const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
			if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
			return true;
		},
	};
}

export type Process = ReturnType<typeof createProcess>;

/** The `process` global and `node:process`. */
export function createProcess(io: Io) {
	const process = {
		argv: io.argv,
		argv0: 'node',
		execArgv: [] as string[],
		env: {} as Record<string, string | undefined>,
		/** Not a Node platform name on purpose: the program runs in a browser worker. */
		platform: 'browser',
		pid: 1,
		exitCode: undefined as number | string | undefined,
		stdout: writable(io, 'stdout'),
		stderr: writable(io, 'stderr'),
		/** Only a marker for `readline.createInterface({ input: process.stdin })`: lines are read through readline. */
		stdin: { isTTY: true, fd: 0 },
		cwd: () => '/workspace',
		nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
		exit(code?: number | string): never {
			const status = Number(code ?? process.exitCode ?? 0) || 0;
			io.exit(status);
			throw new ExitSignal(status);
		},
	};
	return process;
}

type Listener = (...args: unknown[]) => void;
type Output = { write(text: string): unknown } | undefined;

/** Runs `fn` in a timer of the program's own (the runner tracks those to know when the program ends). */
const later = (fn: () => void) => void globalThis.setTimeout(fn, 0);

/** `readline.Interface`, line-oriented, over the runner's stdin. */
class Interface {
	closed = false;
	private readonly listeners = new Map<string, Listener[]>();
	private promptText = '> ';

	constructor(
		private readonly io: Io,
		private readonly output: Output,
	) {}

	on(event: string, listener: Listener): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		if (event === 'line') this.schedule();
		return this;
	}
	addListener(event: string, listener: Listener): this {
		return this.on(event, listener);
	}
	once(event: string, listener: Listener): this {
		const once: Listener = (...args) => {
			this.off(event, once);
			listener(...args);
		};
		return this.on(event, once);
	}
	off(event: string, listener: Listener): this {
		this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener));
		return this;
	}
	removeListener(event: string, listener: Listener): this {
		return this.off(event, listener);
	}
	emit(event: string, ...args: unknown[]): boolean {
		const listeners = this.listeners.get(event) ?? [];
		for (const l of listeners) l.apply(this, args);
		return listeners.length > 0;
	}

	setPrompt(text: string): void {
		this.promptText = text;
	}
	getPrompt(): string {
		return this.promptText;
	}
	prompt(): void {
		this.output?.write(this.promptText);
	}
	write(text: string): void {
		this.output?.write(text);
	}

	/** Writes `query`, then calls back with the next line. */
	question(query: string, optionsOrCallback: unknown, callback?: (answer: string) => void): void {
		const done = typeof optionsOrCallback === 'function' ? (optionsOrCallback as (answer: string) => void) : callback;
		this.ask(query, (answer) => done?.(answer));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit('close');
	}
	pause(): this {
		return this;
	}
	resume(): this {
		return this;
	}

	/** `for await (const line of rl)`: one line per step, done at end of input or after `close()`. */
	[Symbol.asyncIterator](): AsyncIterableIterator<string> {
		const next = () =>
			new Promise<IteratorResult<string>>((resolve) => {
				if (this.closed) return resolve({ value: undefined, done: true });
				this.waiting.push((line) => resolve(line === null ? { value: undefined, done: true } : { value: line, done: false }));
				this.schedule();
			});
		const iterator: AsyncIterableIterator<string> = {
			next,
			return: async () => {
				this.close();
				return { value: undefined, done: true };
			},
			[Symbol.asyncIterator]: () => iterator,
		};
		return iterator;
	}

	/** Writes `query`; the next line goes to `answer` rather than to `'line'` listeners, as in Node. */
	protected ask(query: string, answer: (line: string) => void): void {
		if (this.closed) return;
		this.output?.write(query);
		this.waiting.push((line) => line !== null && answer(line));
		this.schedule();
	}

	/** Questions and `for await` steps waiting for a line, oldest first. */
	private readonly waiting: ((line: string | null) => void)[] = [];
	private scheduled = false;

	private schedule(): void {
		if (this.scheduled || this.closed) return;
		this.scheduled = true;
		later(() => {
			this.scheduled = false;
			this.step();
		});
	}

	/**
	 * Reads one line, if anything wants one, and hands it to the oldest
	 * waiter or else to the `'line'` listeners; at end of input every waiter
	 * gets `null` and the interface closes. One line per timer, so the
	 * program runs between two lines.
	 */
	private step(): void {
		if (this.closed || (this.waiting.length === 0 && !this.listeners.get('line')?.length)) return;
		const line = this.io.readLine();
		if (line === null) {
			const waiting = this.waiting.splice(0);
			this.close();
			for (const w of waiting) w(null);
			return;
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter(line);
		else this.emit('line', line);
		this.schedule();
	}
}

/** `node:readline/promises`' Interface: `question` returns a promise. */
class PromisesInterface extends Interface {
	// A different signature from the callback API's, as in Node (TypeScript allows it: fewer parameters).
	override question(query: string): Promise<string> {
		return new Promise((resolve) => this.ask(query, resolve));
	}
}

interface InterfaceOptions {
	input?: unknown;
	output?: Output;
	prompt?: string;
}

/** `node:readline` and `node:readline/promises`, as module namespaces. */
export function createReadline(io: Io): { readline: Record<string, unknown>; promises: Record<string, unknown> } {
	const make =
		<T extends Interface>(Kind: new (io: Io, output: Output) => T) =>
		(options: InterfaceOptions | unknown = {}, output?: Output): T => {
			// createInterface(options) or the old createInterface(input, output).
			const opts = (typeof options === 'object' && options !== null && 'input' in options ? options : { input: options, output }) as InterfaceOptions;
			const rl = new Kind(io, opts.output);
			if (opts.prompt !== undefined) rl.setPrompt(opts.prompt);
			return rl;
		};
	const promises = { createInterface: make(PromisesInterface), Interface: PromisesInterface };
	const readline = { createInterface: make(Interface), Interface, promises };
	return { readline: { ...readline, default: readline }, promises: { ...promises, default: promises } };
}
