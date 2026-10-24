/**
 * Runs the project with its pack's runner (`packs/<id>/runner.js`, see
 * packs/CONTRACT.md, "Running a program") and keeps what the terminal shows:
 * the program's output, what the user typed, and how it ended.
 */
import { AnsiStream } from './ansi';
import type { Files } from './languages';
import type { RunOptions } from './cpp-targets';

/**
 * One stretch of terminal text in one style; consecutive text of one kind
 * and style is merged. `text` is plain: the program's escape sequences are
 * already taken out (see ansi.ts), so the terminal's text, and what is
 * copied from it, is what the program printed without them.
 */
export interface Chunk {
	id: number;
	/** `trace`: system calls the program made (strace, on a Linux target), interleaved with its output. */
	kind: 'stdout' | 'stderr' | 'stdin' | 'info' | 'trace';
	text: string;
	/** Inline CSS for the program's colours (SGR escapes), '' for the stream's own style. */
	style: string;
}

/**
 * `waiting`: the program is blocked reading its input (a runner asked with a
 * plain `stdin`); a runner that streams input (`stdin` with `streaming`, an
 * emulated machine) takes lines while running without ever setting it.
 */
export type RunState =
	| { kind: 'idle' }
	| { kind: 'loading'; label: string; loaded: number; total: number }
	| { kind: 'running'; phase: string; waiting: boolean }
	| { kind: 'ended'; code: number | null; seconds: number };

/** Messages a runner posts, as the contract defines them. */
type FromRunner =
	| { type: 'loading'; label: string; loaded: number; total: number }
	| { type: 'phase'; text: string }
	| { type: 'stdout' | 'stderr'; text: string }
	| { type: 'stdin'; streaming?: boolean }
	| { type: 'exit'; code: number; reusable?: boolean }
	| { type: 'trace' | 'kernel'; text: string }
	| { type: 'mark'; name: string; ms: number };

/**
 * Where a runner's messages that are not the program's own go: the guest
 * kernel's console and QEMU's messages (`kernel`, one line at a time,
 * without its newline) and timings, for the Output panel.
 */
export interface RunnerLog {
	kernel(line: string): void;
	mark(name: string, ms: number): void;
}

/**
 * What a runner is asked to do: run the program, run its tests, or
 * mutation-test it (languages with `tests` and `mutates`).
 */
export type RunMode = 'run' | 'test' | 'mutate';

/** Bytes of the stdin buffer's data area, after its two Int32 words. */
const STDIN_BYTES = 64 * 1024;
/** More terminal text than this drops the oldest; a runaway loop must not exhaust memory. */
const MAX_CHARS = 2_000_000;

export class Runner {
	state = $state<RunState>({ kind: 'idle' });
	chunks = $state<Chunk[]>([]);

	private worker: Worker | null = null;
	/** The pack of the worker running now (or last), for `warm`. */
	private pack: string | null = null;
	/** The pack whose runner is kept started ahead of the next Run (`keepWarm`), or null. */
	private warm: string | null = null;
	/**
	 * A runner started ahead of a Run, waiting for its message: what it
	 * posted meanwhile is kept, to be read when a Run takes it.
	 */
	private spare: { pack: string; worker: Worker; early: FromRunner[] } | null = null;
	private stdin: SharedArrayBuffer | null = null;
	private started = 0;
	private nextId = 0;
	private chars = 0;
	/** Lines typed before the program asked for them, oldest first. */
	private typedAhead: string[] = [];
	/**
	 * The runner has asked for input (stored 1 in the state word) and has had
	 * no answer yet. Separate from `state.waiting`, which is what the terminal
	 * shows: a streaming request is outstanding while the program runs.
	 */
	private asked = false;
	/**
	 * The terminal state of each output stream. Two, not one as on a real
	 * terminal: stdout and stderr arrive as separate messages here, and a
	 * colour left on in one must not leak into the other.
	 */
	private ansi = { stdout: new AnsiStream(), stderr: new AnsiStream() };
	/** The kernel's text after its last newline, not yet a line. */
	private kernelRest = '';

	/** `log` receives what the Output panel shows of a run; without it, that is dropped. */
	constructor(private readonly log: RunnerLog | null = null) {}

	/** True while a program is loading or running. */
	get busy(): boolean {
		return this.state.kind === 'loading' || this.state.kind === 'running';
	}

	/**
	 * Starts `entry` of `files` with the runner of the pack `language` (its
	 * directory under `packs/`), stopping any program still running; `mode`
	 * 'test' runs the project's tests instead, 'mutate' mutation-tests it.
	 * Output from the previous run is cleared. `options` go to the runner as
	 * they are (packs/CONTRACT.md: how a C++ program built for Linux is
	 * emulated, or the optimisation level a Swift program is compiled at; a
	 * runner that has no use for them ignores them).
	 */
	start(language: string, files: Files, entry: string, mode: RunMode = 'run', options?: RunOptions | { optimization: string }): void {
		this.stop(false);
		this.chunks = [];
		this.chars = 0;
		this.typedAhead = [];
		this.asked = false;
		this.kernelRest = '';
		this.ansi = { stdout: new AnsiStream(), stderr: new AnsiStream() };
		this.started = performance.now();
		this.state = { kind: 'running', phase: 'Starting', waiting: false };
		this.stdin = crossOriginIsolated ? new SharedArrayBuffer(8 + STDIN_BYTES) : null;
		if (!this.stdin) this.append('info', 'This page is not cross-origin isolated, so programs cannot read input.\n');

		const spare = this.spare?.pack === language ? this.spare : null;
		if (spare) this.spare = null;
		const worker = spare?.worker ?? new Worker(new URL(`packs/${language}/runner.js`, document.baseURI), { type: 'module' });
		this.worker = worker;
		this.pack = language;
		worker.onmessage = (e: MessageEvent<FromRunner>) => {
			if (this.worker === worker) this.receive(e.data);
		};
		// What a spare said while it waited, but its download progress: that
		// is over, and would show as this run's.
		for (const m of spare?.early ?? []) if (m.type !== 'loading') this.receive(m);
		worker.onerror = (e) => {
			if (this.worker !== worker) return;
			e.preventDefault();
			// A runner that fails to load at all is most likely not built.
			void fetch(new URL(`packs/${language}/runner.js`, document.baseURI), { method: 'HEAD' }).then(
				(r) => this.finish(null, r.ok ? `The runner failed: ${e.message || 'unknown error'}` : `Running ${language} is not available: its runner is not installed (packs/${language}/runner.js).`),
				() => this.finish(null, `The runner failed: ${e.message || 'unknown error'}`),
			);
		};
		worker.postMessage({ type: mode, files: { ...files }, entry, stdin: this.stdin, ...(options ? { options: { ...options } } : {}) });
	}

	/**
	 * Keeps a runner of `pack` started ahead of each Run, null none: a
	 * runner whose own start (loading a compiler, as Haskell's GHC) is most
	 * of a run's time then answers Run at once. The first starts now; each
	 * Run takes it, and when that run ends its worker is kept for the next
	 * when it says it takes another (`reusable`), or a new one starts, so
	 * two never compete for the processor. packs/CONTRACT.md: a runner may
	 * receive its message long after it started.
	 */
	keepWarm(pack: string | null): void {
		this.warm = pack;
		if (this.spare && this.spare.pack !== pack) {
			this.spare.worker.terminate();
			this.spare = null;
		}
		if (pack && !this.busy) this.prewarm(pack);
	}

	private prewarm(pack: string): void {
		if (this.spare?.pack === pack) return;
		const worker = new Worker(new URL(`packs/${pack}/runner.js`, document.baseURI), { type: 'module' });
		const spare = { pack, worker, early: [] as FromRunner[] };
		this.keep(spare);
	}

	/**
	 * Lets the worker that just exited go: kept as the spare when it said it
	 * takes another run (`reusable`) and its pack is kept warm, terminated
	 * otherwise. A reused runner is warmer than a fresh one, so it replaces
	 * a spare that is still starting.
	 */
	private release(reusable: boolean): void {
		const worker = this.worker;
		this.worker = null;
		if (!worker) return;
		const pack = this.pack;
		if (!reusable || !pack || this.warm !== pack) {
			worker.terminate();
			return;
		}
		this.spare?.worker.terminate();
		this.keep({ pack, worker, early: [] });
	}

	/** Makes `spare` the spare, keeping what it posts until a Run takes it. */
	private keep(spare: { pack: string; worker: Worker; early: FromRunner[] }): void {
		const { worker } = spare;
		worker.onmessage = (e: MessageEvent<FromRunner>) => {
			spare.early.push(e.data);
		};
		worker.onerror = (e) => {
			// A spare that fails is dropped; the Run that would have taken it
			// starts its own, and reports what goes wrong.
			e.preventDefault();
			worker.terminate();
			if (this.spare === spare) this.spare = null;
		};
		this.spare = spare;
	}

	/** Stops the running program; `say` notes it in the terminal. */
	stop(say = true): void {
		if (!this.worker) return;
		this.worker.terminate();
		this.worker = null;
		if (!this.busy) return;
		if (say) this.finish(null, 'Stopped.');
		else this.state = { kind: 'idle' };
	}

	/**
	 * Gives the program a line of input (without its newline). Typed while the
	 * program is not waiting, it is kept until the program asks.
	 */
	input(line: string): void {
		if (!this.busy) return;
		this.append('stdin', line + '\n');
		this.typedAhead.push(line + '\n');
		this.feed();
	}

	/** Ends the program's input (Ctrl-D): its next read sees end of file. */
	endInput(): void {
		if (!this.busy) return;
		this.typedAhead.push('');
		this.feed();
	}

	/**
	 * Starts showing output that does not come from a runner (a web page in
	 * the Preview panel): stops any program, clears the terminal and says
	 * what follows.
	 */
	attach(note: string): void {
		this.stop(false);
		this.clear();
		// A colour or half-read escape left by the last program must not tint the page's console.
		this.ansi = { stdout: new AnsiStream(), stderr: new AnsiStream() };
		this.state = { kind: 'idle' };
		this.append('info', note + '\n');
	}

	/** Shows text from a source that is not a runner, such as a previewed page's console. */
	print(kind: 'stdout' | 'stderr' | 'info', text: string): void {
		if (kind === 'info') this.append('info', text);
		else for (const span of this.ansi[kind].feed(text)) this.append(kind, span.text, span.css);
	}

	/** Empties the terminal; a running program keeps running. */
	clear(): void {
		this.chunks = [];
		this.chars = 0;
	}

	private receive(m: FromRunner): void {
		switch (m.type) {
			case 'loading':
				this.state = { kind: 'loading', label: m.label, loaded: m.loaded, total: m.total };
				break;
			case 'phase':
				// A new phase does not answer an outstanding request for input.
				this.state = { kind: 'running', phase: m.text, waiting: this.state.kind === 'running' && this.state.waiting };
				break;
			case 'stdout':
			case 'stderr':
				if (this.state.kind === 'loading') this.state = { kind: 'running', phase: 'Running', waiting: false };
				for (const span of this.ansi[m.type].feed(m.text)) this.append(m.type, span.text, span.css);
				break;
			case 'stdin':
				this.asked = true;
				// A streaming runner takes input whenever it comes; the program
				// is not known to be blocked, so the terminal does not say so.
				if (!m.streaming) {
					if (this.state.kind === 'running') this.state = { ...this.state, waiting: true };
					else this.state = { kind: 'running', phase: 'Running', waiting: true };
				}
				this.feed();
				break;
			case 'trace':
				if (this.state.kind === 'loading') this.state = { kind: 'running', phase: 'Running', waiting: false };
				this.append('trace', m.text);
				break;
			case 'kernel':
				this.kernel(m.text);
				break;
			case 'mark':
				this.log?.mark(m.name, m.ms);
				break;
			case 'exit':
				this.release(m.reusable === true);
				this.kernel('\n');
				// No note of the app's own: a program's non-zero status is its
				// own business, and a VM that failed already said where its
				// kernel log is (vm.js, CONTRACT.md "Running a program").
				this.finish(m.code, null);
				break;
			default:
				// A message type this app does not know (a newer runner's): ignored, as the contract says.
				break;
		}
	}

	/** Passes the kernel's text on a line at a time; a newline flushes what is left. */
	private kernel(text: string): void {
		const lines = (this.kernelRest + text).split(/\r?\n/);
		this.kernelRest = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			this.log?.kernel(line);
		}
	}

	/** Hands the oldest typed-ahead line to a runner that has asked for input. */
	private feed(): void {
		const buffer = this.stdin;
		if (!buffer || !this.busy || !this.asked) return;
		const line = this.typedAhead.shift();
		if (line === undefined) return;
		const state = new Int32Array(buffer, 0, 2);
		if (line === '') {
			Atomics.store(state, 0, 3);
		} else {
			const bytes = new TextEncoder().encode(line).subarray(0, STDIN_BYTES);
			new Uint8Array(buffer, 8, STDIN_BYTES).set(bytes);
			Atomics.store(state, 1, bytes.length);
			Atomics.store(state, 0, 2);
		}
		Atomics.notify(state, 0);
		this.asked = false;
		if (this.state.kind === 'running') this.state = { ...this.state, waiting: false };
	}

	private finish(code: number | null, note: string | null): void {
		if (note) this.append('info', (this.chunks.at(-1)?.text.endsWith('\n') === false ? '\n' : '') + note + '\n');
		this.state = { kind: 'ended', code, seconds: (performance.now() - this.started) / 1000 };
		if (this.warm && this.warm === this.pack) this.prewarm(this.warm);
	}

	private append(kind: Chunk['kind'], text: string, style = ''): void {
		if (!text) return;
		const last = this.chunks.at(-1);
		if (last && last.kind === kind && last.style === style) last.text += text;
		else this.chunks.push({ id: this.nextId++, kind, text, style });
		this.chars += text.length;
		while (this.chars > MAX_CHARS) {
			const first = this.chunks[0];
			if (!first) break;
			const excess = this.chars - MAX_CHARS;
			if (this.chunks.length > 1 && first.text.length <= excess) {
				this.chunks.shift();
				this.chars -= first.text.length;
			} else {
				first.text = first.text.slice(excess);
				this.chars -= excess;
			}
		}
	}
}
