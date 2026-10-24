/**
 * C and C++ compilation targets: which one a project is on, and how the top
 * bar's Target picker changes it.
 *
 * The target is one line of the project's `compile_flags.txt`,
 * `--target=<triple>`, the file clangd, the C++ pack's runner and its
 * explorer already read; nothing else records it, so the editor, Run and the
 * compiler output views agree by construction, and a hand-edited line is
 * honoured. No line means the default target, WebAssembly (WASI).
 *
 * `TARGETS` and the parse rule are copies of the pack's
 * (packs/cpp/src/targets.json and targets.js); tests/cpp-targets.mjs checks
 * that the table is equal to the JSON and that `targetOf` gives the answers
 * of packs/cpp/tests/fixtures/target-cases.json.
 *
 * Imports nothing, so `node` can load this file directly (tests/cpp-targets.mjs,
 * and export.ts under tests/export.mjs).
 */

/** Identifies a target, as targets.json does. */
export type CppTargetId = 'wasm32-wasi' | 'x86_64-linux' | 'aarch64-linux' | 'riscv64-linux';

/** The Monaco language of a target's assembly (asm-languages.ts). */
export type AsmLanguage = 'asm-wasm32' | 'asm-x86_64' | 'asm-aarch64' | 'asm-riscv64';

/** One row of targets.json. */
export interface CppTarget {
	readonly id: CppTargetId;
	/** Its name, as the Target picker shows it. */
	readonly label: string;
	/** The `--target=` value that selects it; for the default, the triple clang uses (`wasm32-wasip1`). */
	readonly triple: string;
	/** What runs a program built for it: the pack's WASI worker, or Linux under QEMU-Wasm. */
	readonly runtime: 'wasi' | 'linux';
	/** Which of the pack's two compilers builds for it: `cc.wasm` or `cc-cross.wasm`. */
	readonly compiler: 'cc' | 'cc-cross';
	/** True on the default target only. */
	readonly default?: true;
	/** A Linux target's architecture, as the pack names its directories (`targets/<arch>/`, `vm/<arch>/`). */
	readonly arch?: 'x86_64' | 'aarch64' | 'riscv64';
	/** The multiarch directory of a Linux target's headers and libraries. */
	readonly multiarch?: string;
	/** A Linux target's assembly language; the default's is `asm-wasm32`, implied (asmLanguageOf). */
	readonly asm?: AsmLanguage;
}

/**
 * Every target, in the order the picker lists them, the default first. The
 * same data as packs/cpp/src/targets.json, field for field (a unit test
 * compares them); change both together.
 */
export const TARGETS: readonly CppTarget[] = [
	{ id: 'wasm32-wasi', label: 'WebAssembly (WASI)', triple: 'wasm32-wasip1', runtime: 'wasi', compiler: 'cc', default: true },
	{ id: 'x86_64-linux', label: 'x86-64 Linux', triple: 'x86_64-linux-musl', runtime: 'linux', arch: 'x86_64', multiarch: 'x86_64-linux-gnu', compiler: 'cc-cross', asm: 'asm-x86_64' },
	{ id: 'aarch64-linux', label: 'AArch64 Linux', triple: 'aarch64-linux-musl', runtime: 'linux', arch: 'aarch64', multiarch: 'aarch64-linux-gnu', compiler: 'cc-cross', asm: 'asm-aarch64' },
	{ id: 'riscv64-linux', label: 'RISC-V 64 Linux', triple: 'riscv64-linux-musl', runtime: 'linux', arch: 'riscv64', multiarch: 'riscv64-linux-gnu', compiler: 'cc-cross', asm: 'asm-riscv64' },
];

/** The default target's row, WebAssembly (WASI). */
export const DEFAULT_TARGET: CppTarget = TARGETS[0]!;

/** The row of a target id; every `CppTargetId` has one. */
export function targetById(id: CppTargetId): CppTarget {
	return TARGETS.find((t) => t.id === id) ?? DEFAULT_TARGET;
}

/** Whether `value` is a target id, for values read from storage or a form. */
export function isCppTargetId(value: unknown): value is CppTargetId {
	return TARGETS.some((t) => t.id === value);
}

/**
 * Which target a project is on: `default` (no target flag), `target` (a
 * flag naming exactly a row's triple; `wasm32-wasip1` is the default row),
 * or `unsupported` with the triple named, case and all ("" for a `-target`
 * with nothing after it).
 */
export type TargetChoice = { kind: 'default'; target: CppTarget } | { kind: 'target'; target: CppTarget } | { kind: 'unsupported'; triple: string };

/**
 * Which target `compile_flags.txt` (its text, or null/undefined when the
 * project has none) puts the project on. One flag per line, each trimmed,
 * empty lines ignored, as clangd reads the file. The spellings clang's
 * driver accepts count: `--target=X`, and `-target` with X on the next
 * line; the last one wins, as in clang. `-target=X` and `--target` with a
 * separate value are not flags clang knows (it refuses them, so the project
 * fails to compile with clang's own message), and are not read as targets
 * here either: the runner and the explorer (packs/cpp/src/targets.js) read
 * the file the same way. Never throws.
 */
export function targetOf(flagsText: string | null | undefined): TargetChoice {
	const lines = (flagsText ?? '')
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	let triple: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith('--target=')) triple = line.slice('--target='.length);
		else if (line === '-target') triple = lines[++i] ?? '';
	}
	if (triple === null) return { kind: 'default', target: DEFAULT_TARGET };
	const target = TARGETS.find((t) => t.triple === triple);
	return target ? { kind: 'target', target } : { kind: 'unsupported', triple };
}

/**
 * `compile_flags.txt` with the project on target `id`: every target flag
 * removed (`--target=X`, `-target` and the value on its next non-empty line,
 * and also the spellings clang refuses, `-target=X` and `--target` with its
 * value on the next line, since whoever wrote them meant a target and they
 * would now contradict the choice), then, for a target other than the
 * default, `--target=<triple>` inserted as the first line, with the line
 * ending the file already uses. Every other line is kept byte for byte,
 * blank lines included. `flagsText` undefined means the project has no
 * compile_flags.txt: the result is then the new file (`''` for the
 * default, which needs no file).
 */
export function withTarget(flagsText: string | undefined, id: CppTargetId): string {
	const text = flagsText ?? '';
	const target = targetById(id);
	// Lines with their own terminators, so what is kept is kept exactly.
	const lines = text.split(/(?<=\n)/).filter((l) => l !== '');
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const flag = lines[i]!.trim();
		if (flag.startsWith('--target=') || flag.startsWith('-target=')) continue;
		if (flag === '-target' || flag === '--target') {
			// Its value is the next non-empty line; the blank lines between stay.
			let j = i + 1;
			while (j < lines.length && lines[j]!.trim() === '') kept.push(lines[j++]!);
			i = j;
			continue;
		}
		kept.push(lines[i]!);
	}
	if (target.default) return kept.join('');
	const eol = /\r\n/.test(text) ? '\r\n' : '\n';
	return `--target=${target.triple}${eol}${kept.join('')}`;
}

/** The Monaco language of the assembly a target's compiler prints (asm-languages.ts). */
export function asmLanguageOf(id: CppTargetId): AsmLanguage {
	return targetById(id).asm ?? 'asm-wasm32';
}

/** The emulation choices of a Linux target's Run (packs/CONTRACT.md, "Running a program"). */
export interface RunOptions {
	/** `system`: the program runs in Linux under QEMU (the default); `user`: QEMU's user mode, experimental. */
	emulation: 'system' | 'user';
	/** The guest's CPUs, system mode only. */
	cpus: 1 | 2 | 4;
	/** Whether the system calls are traced (strace), shown dimmed in the terminal. */
	strace: boolean;
}

/** What a project that never chose runs with. */
export const DEFAULT_RUN_OPTIONS: Readonly<RunOptions> = { emulation: 'system', cpus: 1, strace: false };

/**
 * `value` as run options: each field that is valid is kept, any other is the
 * default's; anything that is not an object is the defaults. Never throws,
 * so a saved project with a bad value still loads.
 */
export function runOptionsOf(value: unknown): RunOptions {
	const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
	const emulation = v['emulation'];
	const cpus = v['cpus'];
	const strace = v['strace'];
	return {
		emulation: emulation === 'system' || emulation === 'user' ? emulation : DEFAULT_RUN_OPTIONS.emulation,
		cpus: cpus === 1 || cpus === 2 || cpus === 4 ? cpus : DEFAULT_RUN_OPTIONS.cpus,
		strace: typeof strace === 'boolean' ? strace : DEFAULT_RUN_OPTIONS.strace,
	};
}
