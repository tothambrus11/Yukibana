// The C/C++ pack's compiler output worker (README, "Compiler output
// views"; ../../CONTRACT.md, "Showing compiler output"): compiles the
// active source of the project to LLVM IR or assembly, with exactly the
// arguments Run uses (toolchain.js compileArgs) plus line tables, filters
// the output as Compiler Explorer does and maps each line to its source
// line (emit-filter.js), and demangles symbols with LLVM's demangler
// (demangle.wasm). Compile only, no link, so a Linux target fetches its
// headers but not its libraries.
//
// App to worker:
//   { type: 'emit', id, emit: 'llvm-ir' | 'asm', files, path,
//     options: { demangle, intel, directives, library } }
// Worker to app:
//   { type: 'loading', label, loaded, total }
//   { type: 'result', id, emit, ok: true, text, lines, target, triple, flags, ms }
//   { type: 'result', id, emit, ok: false, error, target, ms }
//
// The current target's compiled module is kept while the target's compiler
// stays the same; each compile is a fresh instance. Only the newest request of each kind is
// answered: one that a newer request of the same `emit` replaced while it
// waited, or while it compiled, gets no answer.

import { createToolchain, compileArgs } from './toolchain.js';
import { targetOf, unsupportedMessage } from './targets.js';
import { filterAsm, filterIr, demangleLines } from './emit-filter.js';

/* global CC_WASM_SIZE, CC_CROSS_WASM_SIZE, WASI_SYSROOT_SIZE, SYSROOT_SIZE, DEMANGLE_WASM_SIZE, TARGET_SIZES */
const SIZES = {
    'cc.wasm': typeof CC_WASM_SIZE === 'number' ? CC_WASM_SIZE : 0,
    'cc-cross.wasm': typeof CC_CROSS_WASM_SIZE === 'number' ? CC_CROSS_WASM_SIZE : 0,
    'wasi-sysroot.tar.gz': typeof WASI_SYSROOT_SIZE === 'number' ? WASI_SYSROOT_SIZE : 0,
    'sysroot.tar.gz': typeof SYSROOT_SIZE === 'number' ? SYSROOT_SIZE : 0,
    'demangle.wasm': typeof DEMANGLE_WASM_SIZE === 'number' ? DEMANGLE_WASM_SIZE : 0,
    ...(typeof TARGET_SIZES === 'object' ? TARGET_SIZES : {}),
};

/** The C-family sources a view can show (headers are compiled through them). */
const SOURCE = /\.(c|cc|cpp|cxx|c\+\+|C)$/;
const DEFAULTS = {
    asm: { demangle: true, intel: false, directives: false, library: false },
    'llvm-ir': { demangle: false, intel: false, directives: false, library: false },
};

const post = (msg) => self.postMessage(msg);
const base = new URL('./', import.meta.url);
const toolchain = createToolchain({ base, sizes: SIZES, post: (msg) => msg.type === 'loading' && post(msg) });
const decoder = new TextDecoder();

let demangler = null;
/** The compiler (`cc` or `cc-cross`) the last request used, or null. */
let lastCompiler = null;

/**
 * LLVM's demangler, demangle.wasm, loaded once: names in, names out. A load
 * that fails rejects (the request gets an error result) and is forgotten, so
 * the next request tries again.
 */
function loadDemangler() {
    demangler ??= (async () => {
        const [{ default: create }, response] = await Promise.all([
            import(new URL('demangle.js', base).href),
            toolchain.download('demangle.wasm'),
        ]);
        const module = await WebAssembly.compile(await response.arrayBuffer());
        // Emscripten's create() waits for done() and never hears that
        // instantiation failed; the failure rejects this instead (as in
        // toolchain.tool), or every later request would wait forever.
        let failed;
        const failure = new Promise((_, reject) => (failed = reject));
        const mod = await Promise.race([
            create({
                instantiateWasm(imports, done) {
                    WebAssembly.instantiate(module, imports).then(
                        (instance) => done(instance, module),
                        (error) => failed(new Error(`demangle.wasm could not start: ${error?.message ?? error}`)));
                    return {};
                },
            }),
            failure,
        ]);
        return (names) => {
            const input = mod.stringToNewUTF8(names.join('\n'));
            const output = mod._yk_demangle_lines(input);
            mod._free(input);
            if (!output) return names;
            const text = mod.UTF8ToString(output);
            mod._free(output);
            return text.split('\n');
        };
    })();
    const loading = demangler;
    loading.catch(() => {
        if (demangler === loading) demangler = null;
    });
    return loading;
}

/** clang's messages with the project's paths as the app shows them. */
const projectPaths = (text) => text.replaceAll('/workspace/', '');

/** Compiles one request; resolves to its result message. */
async function emit({ id, emit: kind, files, path, options }) {
    const started = performance.now();
    const done = (fields) => ({ type: 'result', id, emit: kind, ...fields, ms: Math.round(performance.now() - started) });
    const which = targetOf(files);
    if (which.kind === 'unsupported') return done({ ok: false, error: unsupportedMessage(which.triple), target: null });
    const target = which.target;
    // Another compiler (the project's target moved between WebAssembly and
    // Linux): drop the one before and its files rather than hold both, about
    // 110 MB of compiled code, for the rest of the session.
    if (lastCompiler !== null && lastCompiler !== target.compiler) toolchain.release();
    lastCompiler = target.compiler;
    if (kind !== 'asm' && kind !== 'llvm-ir') return done({ ok: false, error: `Unknown output "${kind}".\n`, target: target.id });
    if (!SOURCE.test(path) || typeof files[path] !== 'string')
        return done({ ok: false, error: `${path} is not a C or C++ source file of the project: open a .c or .cpp file to see its compiler output.\n`, target: target.id });
    const opts = { ...DEFAULTS[kind], ...options };
    const ir = kind === 'llvm-ir';
    const flags = [
        ...compileArgs(target, files, path, { view: true }),
        '-S',
        ...(ir ? ['-emit-llvm'] : []),
        ...(!ir && opts.intel && target.arch === 'x86_64' ? ['-masm=intel'] : []),
    ];
    const out = `.yukibana/view.${ir ? 'll' : 's'}`;
    const [result, demangle] = await Promise.all([
        toolchain.tool(target, 'clang', [...flags, '-fno-color-diagnostics', path, '-o', out], files, [out], { quiet: true }),
        opts.demangle ? loadDemangler() : null,
    ]);
    if (result.code !== 0 || !result.out[out])
        return done({ ok: false, error: projectPaths(result.text) || `clang exited with status ${result.code}\n`, target: target.id });
    const filtered = (ir ? filterIr : filterAsm)(decoder.decode(result.out[out]), opts);
    const text = demangle ? demangleLines(filtered.text, demangle) : filtered.text;
    return done({ ok: true, text, lines: filtered.lines, target: target.id, triple: target.triple, flags });
}

/** The newest request of each kind not yet started. */
const pending = new Map();
let busy = false;
/**
 * Lets the messages that arrived meanwhile be delivered. A compile runs
 * synchronously (callMain) and blocks this worker, so requests sent during
 * it are only queued; without this, the first of them would start before
 * the newer ones replaced it.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function pump() {
    if (busy) return;
    busy = true;
    try {
        await settle();
        while (pending.size) {
            const [kind, request] = pending.entries().next().value;
            pending.delete(kind);
            let message;
            try {
                message = await emit(request);
            } catch (error) {
                message = { type: 'result', id: request.id, emit: kind, ok: false, error: `${error?.message ?? error}\n`, target: null, ms: 0 };
            }
            // Superseded while it compiled: the app keeps only the newest.
            await settle();
            if (!pending.has(kind)) post(message);
        }
    } finally {
        busy = false;
    }
}

self.onmessage = ({ data }) => {
    if (data?.type !== 'emit') return;
    pending.set(data.emit, data);
    pump();
};
