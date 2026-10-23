/**
 * Runs the project with its pack's runner (`packs/<id>/runner.js`, see
 * packs/CONTRACT.md, "Running a program") and keeps what the terminal shows:
 * the program's output, what the user typed, and how it ended.
 */
import type { Files, LanguageId } from './languages';

/** One stretch of terminal text; consecutive output of one kind is merged. */
export interface Chunk {
	id: number;
	kind: 'stdout' | 'stderr' | 'stdin' | 'info';
	text: string;
}

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
	| { type: 'stdin' }
	| { type: 'exit'; code: number };

/** Bytes of the stdin buffer's data area, after its two Int32 words. */
const STDIN_BYTES = 64 * 1024;
/** More terminal text than this drops the oldest; a runaway loop must not exhaust memory. */
const MAX_CHARS = 2_000_000;

export class Runner {
	state = $state<RunState>({ kind: 'idle' });
	chunks = $state<Chunk[]>([]);

	private worker: Worker | null = null;
	private stdin: SharedArrayBuffer | null = null;
	private started = 0;
	private nextId = 0;
	private chars = 0;
	/** Lines typed before the program asked for them, oldest first. */
	private typedAhead: string[] = [];

	/** True while a program is loading or running. */
	get busy(): boolean {
		return this.state.kind === 'loading' || this.state.kind === 'running';
	}

	/**
	 * Starts `entry` of `files` with the runner of `language`, stopping any
	 * program still running. Output from the previous run is cleared.
	 */
	start(language: LanguageId, files: Files, entry: string): void {
		this.stop(false);
		this.chunks = [];
		this.chars = 0;
		this.typedAhead = [];
		this.started = performance.now();
		this.state = { kind: 'running', phase: 'Starting', waiting: false };
		this.stdin = crossOriginIsolated ? new SharedArrayBuffer(8 + STDIN_BYTES) : null;
		if (!this.stdin) this.append('info', 'This page is not cross-origin isolated, so programs cannot read input.\n');

		const worker = new Worker(new URL(`packs/${language}/runner.js`, document.baseURI), { type: 'module' });
		this.worker = worker;
		worker.onmessage = (e: MessageEvent<FromRunner>) => {
			if (this.worker === worker) this.receive(e.data);
		};
		worker.onerror = (e) => {
			if (this.worker !== worker) return;
			e.preventDefault();
			// A runner that fails to load at all is most likely not built.
			void fetch(new URL(`packs/${language}/runner.js`, document.baseURI), { method: 'HEAD' }).then(
				(r) => this.finish(null, r.ok ? `The runner failed: ${e.message || 'unknown error'}` : `Running ${language} is not available: its runner is not installed (packs/${language}/runner.js).`),
				() => this.finish(null, `The runner failed: ${e.message || 'unknown error'}`),
			);
		};
		worker.postMessage({ type: 'run', files: { ...files }, entry, stdin: this.stdin });
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
				this.state = { kind: 'running', phase: m.text, waiting: false };
				break;
			case 'stdout':
			case 'stderr':
				if (this.state.kind === 'loading') this.state = { kind: 'running', phase: 'Running', waiting: false };
				this.append(m.type, m.text);
				break;
			case 'stdin':
				if (this.state.kind === 'running') this.state = { ...this.state, waiting: true };
				else this.state = { kind: 'running', phase: 'Running', waiting: true };
				this.feed();
				break;
			case 'exit':
				this.worker?.terminate();
				this.worker = null;
				this.finish(m.code, null);
				break;
		}
	}

	/** Hands the oldest typed-ahead line to a runner that is waiting for input. */
	private feed(): void {
		const buffer = this.stdin;
		if (!buffer || this.state.kind !== 'running' || !this.state.waiting) return;
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
		this.state = { ...this.state, waiting: false };
	}

	private finish(code: number | null, note: string | null): void {
		if (note) this.append('info', (this.chunks.at(-1)?.text.endsWith('\n') === false ? '\n' : '') + note + '\n');
		this.state = { kind: 'ended', code, seconds: (performance.now() - this.started) / 1000 };
	}

	private append(kind: Chunk['kind'], text: string): void {
		if (!text) return;
		const last = this.chunks.at(-1);
		if (last && last.kind === kind) last.text += text;
		else this.chunks.push({ id: this.nextId++, kind, text });
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
