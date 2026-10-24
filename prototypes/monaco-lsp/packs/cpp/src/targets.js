// The C/C++ pack's compilation targets (README, "Targets"): which one a
// project is on, read from its compile_flags.txt, the file clangd, the
// runner and the explorer already read, so the editor, Run and the compiler
// output views agree by construction. The app keeps a copy of the table and
// of this parse rule (app/src/lib/cpp-targets.ts); a unit test there checks
// that both give the answers in tests/fixtures/target-cases.json.

import TARGET_LIST from './targets.json' with { type: 'json' };

/**
 * The targets, in the order the app lists them: one row per target, exactly
 * src/targets.json. The first, `wasm32-wasi`, is the default (`default:
 * true`): a project without a target flag is on it. Every other row is a
 * Linux target (`runtime: 'linux'`) with its `arch`, the `multiarch`
 * directory name clang's Linux driver uses for its headers and libraries,
 * and the `asm` grammar id for its assembly; the default row has no `arch`,
 * and its assembly grammar is `asm-wasm32`, implied. Callers must treat the
 * rows as read-only.
 */
export const TARGETS = TARGET_LIST;

/** The default target's row (`wasm32-wasi`). */
export const DEFAULT_TARGET = TARGETS.find((t) => t.default);

/**
 * Which target the project is on, from its `compile_flags.txt` (one flag per
 * line, each trimmed, empty lines ignored, as clangd reads it).
 *
 * The two spellings clang's driver accepts count, `--target=X` and
 * `-target` followed by X on the next line, and the last one wins, as in
 * clang. `-target=X` and `--target` with a separate value are not target
 * flags (clang refuses both as unknown arguments, and so the project fails
 * to compile on the default target with clang's own message). A `-target`
 * on the last line, with no value, counts as the triple "" (clang refuses
 * it too). The answer is:
 *
 * - `{ kind: 'default', target }`: no target flag; `target` is the default row;
 * - `{ kind: 'target', target }`: X is exactly a row's `triple`
 *   (`wasm32-wasip1` gives the default row);
 * - `{ kind: 'unsupported', triple: X }`: anything else, case and all.
 *
 * `files` maps project paths to their text; only `compile_flags.txt` at the
 * project's root is read. Never throws.
 */
export function targetOf(files) {
    const triple = targetFlag(files?.['compile_flags.txt'] ?? '');
    if (triple === null) return { kind: 'default', target: DEFAULT_TARGET };
    const target = TARGETS.find((t) => t.triple === triple);
    return target ? { kind: 'target', target } : { kind: 'unsupported', triple };
}

/** The value of the last target flag in a compile_flags.txt, or null. */
function targetFlag(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let found = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const joined = /^--target=(.*)$/.exec(line);
        if (joined) found = joined[1];
        else if (line === '-target') {
            found = lines[i + 1] ?? '';
            i++;
        }
    }
    return found;
}

/**
 * The message for a project whose target flag names a triple no target has
 * (`targetOf` gave `unsupported`): what it named and every supported triple,
 * ending in a newline, as the runner prints it on stderr and the explorer
 * returns it as its error.
 */
export function unsupportedMessage(triple) {
    return `Unsupported target "${triple}" in compile_flags.txt; supported: ${TARGETS.map((t) => t.triple).join(', ')} (or no --target).\n`;
}
