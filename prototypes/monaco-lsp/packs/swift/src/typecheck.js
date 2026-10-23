// The language server's type checker: a module Worker that server.js starts
// lazily and owns. It runs the real Swift 6.3.3 frontend
// (swift-frontend.wasm, the same file and URL as the runner's, so the
// browser holds one copy) over the project, in two steps, and returns what
// it printed. server.js turns that into publishDiagnostics, and the typed
// syntax tree into hover, definition, references and completion.
//
//   1. `-dump-ast` (astArgs): type checking, its diagnostics, and the typed
//      tree, which src/ast.js reads here so that only the parts the server
//      uses cross to it.
//   2. `-emit-sil` (diagnoseArgs), only when step 1 found no error: the
//      mandatory SIL passes' diagnostics (missing return, use before
//      initialisation, ...). With type errors, -emit-sil stops after type
//      checking and would print the same thing again, so it is skipped.
//
// Protocol (plain objects):
//   in   { type: 'check', id, files: { 'main.swift': text, ... } }
//        { type: 'probe', id, files }   a variant of the project to type
//                                       (member completion: `xs.` with the
//                                       dot removed), answered before any check
//   out  { type: 'loading', label, loaded, total }
//        { type: 'ready', ms }                      the frontend is compiled
//        { type: 'result', id, phase, code, output, dia, ast, ms }
//                    phase: 'types' (step 1, with `ast`) or 'sil' (step 2);
//                    `final` is true when no step follows for this id.
//                    output: the frontend's stderr; dia: its serialized
//                    diagnostics (src/dia.js), the only report of fix-its,
//                    one buffer per file for -dump-ast (one per primary file)
//        { type: 'probe', id, ast, ms }
//        { type: 'failed', message }                it cannot run at all
//
// A running frontend cannot be interrupted (the worker's thread is inside
// the wasm until it returns), so superseded work is dropped before it
// starts: of the checks that arrive while one runs, only the newest runs
// next; a check's SIL step is dropped when a newer check is waiting; probes
// go first, and only the newest probe runs. Each step is a fresh instance of
// the compiled module: the frontend is a WASI command (`_start` runs main
// once and its static constructors cannot run twice), so an instance is not
// reused. The compiled module, the unpacked sysroot and clang's module cache
// for SwiftShims are kept for the worker's lifetime.

import { FRONTEND_WASM, astArgs, loadSysroot, loadTool, loadXCTest, readFile, remove, runWasi, textSink, diagnoseArgs, writeProject } from './toolchain.js';
import { dropOwnModuleImportWarnings, importsXCTest, projectModuleName } from './xctest.js';
import { parseDump } from './ast.js';

const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const WORK = '/workspace';
const DIA = (i) => `/tmp/typecheck-${i}.dia`;
const SIL = '/tmp/typecheck.sil';

let toolchain = null;
/** What runs next, in this order: the newest probe, the newest check, the SIL step of the last check. */
const pending = { probe: null, check: null, sil: null };
let running = false;

function load() {
    toolchain ??= (async () => {
        const t0 = performance.now();
        const onLoading = (label, loaded, total) => post({ type: 'loading', label, loaded, total });
        const [frontend, root] = await Promise.all([loadTool(FRONTEND_WASM, onLoading), loadSysroot(onLoading)]);
        post({ type: 'ready', ms: Math.round(performance.now() - t0) });
        return { frontend, root };
    })();
    return toolchain;
}

/** The loaded toolchain with the project written under /workspace. */
async function prepare(files) {
    const loaded = await load();
    const { frontend, root } = loaded;
    if (Object.values(files).some(importsXCTest)) {
        // The browser's XCTest, added to this sysroot by the first check that imports it.
        loaded.xctest ??= loadXCTest(root, (label, done, total) => post({ type: 'loading', label, loaded: done, total }));
        await loaded.xctest.catch((e) => {
            loaded.xctest = null; // try again on the next check
            throw e;
        });
    }
    // Test files are checked with the program, as one module named as the
    // runner names it (projectModuleName), so `@testable import App` works.
    const moduleName = projectModuleName(files);
    const sources = writeProject(root, WORK, files, 'main.swift');
    return { frontend, root, moduleName, sources };
}

/**
 * Runs the frontend with `args` over the prepared project: its exit code,
 * stdout, stderr and serialized diagnostics. `primaries` is how many
 * `-primary-file`s the arguments name: the frontend then wants one
 * diagnostics file per primary file, in order, and writes each file's there.
 */
async function frontendRun({ frontend, root, moduleName }, args, primaries = 0) {
    const stdout = textSink(), stderr = textSink();
    const paths = Array.from({ length: Math.max(1, primaries) }, (_, i) => DIA(i));
    for (const p of paths) remove(root, p);
    remove(root, SIL);
    const code = await runWasi(frontend, { args: [...args, ...paths.flatMap((p) => ['-serialize-diagnostics-path', p])], root, stdout, stderr });
    // A file without diagnostics gets an empty diagnostics file: leave those out.
    const dia = paths.map((p) => readFile(root, p)?.slice()).filter((d) => d?.length);
    const output = moduleName === 'main' ? stderr.text : dropOwnModuleImportWarnings(stderr.text);
    return { code, ast: stdout.text, output, dia };
}

async function check({ id, files }) {
    const project = await prepare(files);
    const t0 = performance.now();
    if (!project.sources.length) {
        post({ type: 'result', id, phase: 'types', final: true, code: 0, output: '', dia: [], ast: null, ms: 0 });
        return;
    }
    const r = await frontendRun(project, astArgs(project.sources, project.moduleName), project.sources.length);
    const ast = parseDump(r.ast, files, `${WORK}/`);
    const errors = /^[^\n]*: error: /m.test(r.output) || r.code !== 0;
    // The SIL step waits behind any probe and is dropped if a newer check arrives.
    if (!errors) pending.sil = { type: 'sil', id, files };
    post({ type: 'result', id, phase: 'types', final: errors, code: r.code, output: r.output, dia: r.dia, ast, ms: Math.round(performance.now() - t0) },
        r.dia.map((d) => d.buffer));
}

async function sil({ id, files }) {
    const project = await prepare(files);
    const t0 = performance.now();
    const r = await frontendRun(project, diagnoseArgs(project.sources, SIL, project.moduleName));
    post({ type: 'result', id, phase: 'sil', final: true, code: r.code, output: r.output, dia: r.dia, ms: Math.round(performance.now() - t0) },
        r.dia.map((d) => d.buffer));
}

async function probe({ id, files }) {
    const project = await prepare(files);
    const t0 = performance.now();
    const r = project.sources.length ? await frontendRun(project, astArgs(project.sources, project.moduleName), project.sources.length) : { ast: '' };
    post({ type: 'probe', id, ast: parseDump(r.ast, files, `${WORK}/`), ms: Math.round(performance.now() - t0) });
}

async function drain() {
    if (running) return;
    running = true;
    try {
        for (;;) {
            const next = pending.probe ?? pending.check ?? pending.sil;
            if (!next) break;
            if (next === pending.probe) pending.probe = null;
            else if (next === pending.check) pending.check = pending.sil = null;
            else pending.sil = null;
            try {
                await (next.type === 'probe' ? probe : next.type === 'sil' ? sil : check)(next);
            } catch (e) {
                post({ type: 'failed', message: String(e?.message ?? e) });
                if (next.type === 'probe') post({ type: 'probe', id: next.id, ast: null, ms: 0 });
                toolchain = null;
            }
            // Let work that arrived meanwhile replace what is pending before choosing.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        running = false;
    }
}

self.onmessage = ({ data }) => {
    if (data?.type === 'load') {
        load().catch((e) => post({ type: 'failed', message: String(e?.message ?? e) }));
    } else if (data?.type === 'check') {
        pending.check = data;
        pending.sil = null; // a newer check supersedes the last one's SIL step
        drain();
    } else if (data?.type === 'probe') {
        if (pending.probe) post({ type: 'probe', id: pending.probe.id, ast: null, ms: 0 }); // superseded
        pending.probe = data;
        drain();
    }
};
