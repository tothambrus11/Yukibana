// What a sanitized program needs from the runner (README, "Sanitizers"),
// fetched only when a project's compile_flags.txt asks for a sanitizer
// (runner.js and runner-linux.js import it then):
//
// - On WebAssembly, the host half of the sanitizer runtimes: what
//   Emscripten's JavaScript runtime gives compiler-rt's Emscripten port
//   (its libstack_trace.js) for a wasm32-wasip1 program. A wasm program
//   cannot walk its own stack, so the runtime asks the host: a stack is the
//   engine's own, `new Error().stack`, whose wasm frames read
//   `wasm-function[7]:0x1a3`, the offset of the call in the module's bytes,
//   which is what the runtime calls a program counter (as Emscripten does).
//   A program counter becomes functions, files and lines through
//   symbolizer.js, as llvm-symbolizer would print them. The C half is the
//   runtime's wasi_emscripten.c, which imports these functions from the
//   module "yukibana:sanitizer".
// - On Linux, the symbolizer the guest does not have: the sanitizer
//   runtimes there print a frame they cannot symbolize as
//   `#0 0x55b070773959  (/yk/prog+0x146959)`, and symbolizeReport rewrites
//   such lines as the runtime would have printed them with llvm-symbolizer
//   beside it.

import { wasmSymbolizer, wasmFunctionCode, elfSymbolizer } from './symbolizer.js';

const MODULE = 'yukibana:sanitizer';
const WASM_FRAME = /wasm-function\[\d+\]:0x([0-9a-f]+)/;
/** Frames kept from one stack: kStackTraceMax in compiler-rt is 255. */
const DEPTH = 256;

/**
 * The frames of the current stack, innermost first, without the "Error"
 * line: frame 0 is the caller of this function. Error.stackTraceLimit is
 * raised for the one capture (the default, 10, would cut every report).
 */
function frames() {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = DEPTH;
    const stack = String(new Error().stack ?? '');
    Error.stackTraceLimit = limit;
    const lines = stack.split('\n');
    if (/^Error\b/.test(lines[0] ?? '')) lines.shift();
    lines.shift(); // frames() itself
    return lines;
}

/** A frame's program counter: its offset in the module, or 0 for a JavaScript frame. */
const pcOf = (frame) => {
    const match = WASM_FRAME.exec(frame ?? '');
    return match ? parseInt(match[1], 16) : 0;
};

/** The project's path for a path the compiler saw: /workspace/main.cpp is main.cpp. */
export const projectPath = (path) => path.replace(/^\/workspace\//, '');

/**
 * The imports a sanitized program needs (`imports()`, merged into its import
 * object), for the module compiled from `bytes`. `setMemory` gives it the
 * program's memory once instantiated. File names are the project's
 * (projectPath), as clang's own diagnostics and the runtime's own source
 * locations name them. The module's debug sections are read on the first
 * symbolization only.
 */
export function createSanitizerHost(bytes) {
    let memory = null;
    let symbolize = null;
    let codeOf = null;
    let snapshot = { pc: 0, frames: [] };
    let last = { pc: -1, frames: [] };
    const encoder = new TextEncoder();

    /** The frames at `pc`, innermost first; the runtime asks field by field, so the last pc's are kept. */
    const framesAt = (pc) => {
        if (last.pc !== pc) {
            symbolize ??= wasmSymbolizer(bytes);
            last = { pc, frames: symbolize(pc) };
        }
        return last.frames;
    };
    const write = (text, ptr, size) => {
        if (!text || !size) return 0;
        const encoded = encoder.encode(text).subarray(0, size - 1);
        const into = new Uint8Array(memory.buffer, ptr, size);
        into.set(encoded);
        into[encoded.length] = 0;
        return encoded.length;
    };

    const host = {
        // As emscripten_return_address: frames [0] this function, [1]
        // wasi_emscripten.c's wrapper, [2] the function asking, [3 + level]
        // its callers.
        return_address: (level) => pcOf(frames()[3 + level]),
        // As emscripten_stack_snapshot: [2] is StackTrace::GetCurrentPc, [3]
        // the function that asked for the current pc.
        stack_snapshot() {
            const lines = frames();
            snapshot = { pc: pcOf(lines[3]), frames: lines };
            return snapshot.pc;
        },
        // As emscripten_stack_unwind_buffer: the frames from the one at `pc`
        // outwards, from the last snapshot when `pc` is its pc.
        stack_unwind(pc, buffer, depth) {
            const lines = snapshot.pc === pc ? snapshot.frames : frames();
            let from = 3;
            while (from < lines.length && pcOf(lines[from]) !== pc) from++;
            if (from >= lines.length) from = 3;
            const view = new DataView(memory.buffer);
            let n = 0;
            for (; n < depth && from + n < lines.length; n++) view.setUint32(buffer + n * 4, pcOf(lines[from + n]), true);
            return n;
        },
        // What llvm-symbolizer --inlines says about `pc`: the number of
        // frames, then each one's function, file, line and column, frame 0
        // the innermost. A string is written NUL-terminated into
        // [ptr, ptr + size), cut to fit; the result is its length, 0 for none.
        pc_frames: (pc) => framesAt(pc).length,
        pc_function: (pc, frame, ptr, size) => write(framesAt(pc)[frame]?.name, ptr, size),
        pc_file(pc, frame, ptr, size) {
            const file = framesAt(pc)[frame]?.file;
            return write(file ? projectPath(file) : null, ptr, size);
        },
        pc_line: (pc, frame) => framesAt(pc)[frame]?.line ?? 0,
        pc_column: (pc, frame) => framesAt(pc)[frame]?.column ?? 0,
        // The code a function pointer (a table index) points to, as a pc:
        // AddressSanitizer names a stack variable's frame by its function's
        // address.
        function_pc: (pointer) => (codeOf ??= wasmFunctionCode(bytes))(pointer),
    };

    return {
        imports: () => ({ [MODULE]: host }),
        setMemory(m) {
            memory = m;
        },
    };
}

/** Whether `module` (a WebAssembly.Module) was linked with a sanitizer runtime. */
export const isSanitized = (module) => WebAssembly.Module.imports(module).some((i) => i.module === MODULE);

// ---- Linux: symbolizing the runtime's report after the fact

// A stack frame as sanitizer_common's default stack_trace_format,
// "    #%n %p %F %L", prints one it could not symbolize: no function, so two
// spaces, then the module and the offset in it, and the module's build id
// when it has one. The colours of the line before may end at its start.
const FRAME = /^((?:\x1b\[[0-9;]*m)*)(\s*)#(\d+) (0x[0-9a-f]+)  \(([^()\s]+)\+0x([0-9a-f]+)\)((?: \(BuildId: [0-9a-f]+\))?)$/;
// The summary line, "SUMMARY: <tool>: <error> %L %F" of the first frame.
const SUMMARY = /^((?:\x1b\[[0-9;]*m)*SUMMARY: \w+: \S+) \(([^()\s]+)\+0x([0-9a-f]+)\) ?$/;

/**
 * Rewrites a sanitizer runtime's report from a Linux guest, line by line,
 * as the runtime prints it with llvm-symbolizer beside it: each frame of a
 * module in `modules` (its path in the guest, such as "/yk/prog", to its
 * ELF bytes) becomes one line per inlined function, the frames after it
 * numbered on, each with the function's demangled name and its source
 * location (or, without line tables, its module and offset as before), and
 * the SUMMARY line names the first frame's location and function. Lines it
 * does not recognise, and frames of other modules, pass through as they
 * were, renumbered.
 *
 * `demangle(names)` takes mangled names and returns their demangled forms
 * (demangle.wasm, as the explorer uses it). Paths are the project's
 * (projectPath). Returns `{ write(text), flush() }`, each returning the
 * text to show now: a line is held until its newline arrives.
 */
export function symbolizeReport(modules, demangle) {
    const symbolizers = new Map();
    const symbolize = (module, offset) => {
        const bytes = modules[module];
        if (!bytes) return [];
        try {
            if (!symbolizers.has(module)) symbolizers.set(module, elfSymbolizer(bytes));
            return symbolizers.get(module)(offset);
        } catch {
            // Debug information this reader does not follow: the frame stays as the runtime printed it.
            symbolizers.set(module, () => []);
            return [];
        }
    };
    const named = (name) => (name && /^_Z/.test(name) ? demangle([name])[0] || name : name);
    const location = ({ file, line, column }) => `${projectPath(file)}${line ? `:${line}` : ''}${line && column ? `:${column}` : ''}`;

    let partial = '';
    let next = 0; // the number of the current stack's next frame

    function rewrite(text) {
        const frame = FRAME.exec(text);
        if (frame) {
            const [, colour, indent, number, pc, module, offset, buildId] = frame;
            if (number === '0') next = 0;
            const found = symbolize(module, parseInt(offset, 16));
            if (found.length === 0) return `${colour}${indent}#${next++} ${pc}  (${module}+0x${offset})${buildId}`;
            return colour + found
                .map((f) => {
                    const name = named(f.name);
                    const where = f.file ? location(f) : `(${module}+0x${offset})${buildId}`;
                    return `${indent}#${next++} ${pc} ${name ? `in ${name} ` : ' '}${where}`;
                })
                .join('\n');
        }
        const summary = SUMMARY.exec(text);
        if (summary) {
            const [, head, module, offset] = summary;
            const f = symbolize(module, parseInt(offset, 16))[0];
            if (!f) return text;
            const name = named(f.name);
            return `${head} ${f.file ? location(f) : `(${module}+0x${offset})`}${name ? ` in ${name}` : ''}`;
        }
        return text;
    }

    return {
        write(text) {
            const lines = (partial + text).split('\n');
            partial = lines.pop();
            return lines.map((l) => rewrite(l) + '\n').join('');
        },
        flush() {
            const rest = partial;
            partial = '';
            return rest ? rewrite(rest) : '';
        },
    };
}
