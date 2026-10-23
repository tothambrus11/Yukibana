// The language server's type checker: a module Worker that server.js starts
// lazily and owns. It runs the real Swift 6.3.3 frontend
// (swift-frontend.wasm, the same file and URL as the runner's, so the
// browser holds one copy) with `-typecheck` over the project and returns
// what it printed. server.js turns that into publishDiagnostics.
//
// Protocol (plain objects):
//   in   { type: 'check', id, files: { 'main.swift': text, ... } }
//   out  { type: 'loading', label, loaded, total }
//        { type: 'ready', ms }                      the frontend is compiled
//        { type: 'result', id, code, output, ms }   output: the frontend's stderr
//        { type: 'failed', message }                it cannot run at all
//
// Checks are coalesced: when several arrive while one runs, only the newest
// is run next; the others are answered with nothing (server.js has
// discarded them anyway).

import { FRONTEND_WASM, loadSysroot, loadTool, runWasi, textSink, typecheckArgs, writeProject } from './toolchain.js';

const post = (msg) => self.postMessage(msg);
const WORK = '/workspace';

let toolchain = null;
let latest = null;
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

async function check({ id, files }) {
    const { frontend, root } = await load();
    const t0 = performance.now();
    const sources = writeProject(root, WORK, files, 'main.swift');
    const output = textSink();
    const code = sources.length
        ? await runWasi(frontend, { args: typecheckArgs(sources), root, stdout: output, stderr: output })
        : 0;
    post({ type: 'result', id, code, output: output.text, ms: Math.round(performance.now() - t0) });
}

async function drain() {
    if (running) return;
    running = true;
    try {
        while (latest) {
            const next = latest;
            latest = null;
            try {
                await check(next);
            } catch (e) {
                post({ type: 'failed', message: String(e?.message ?? e) });
                toolchain = null;
            }
            // Let checks that arrived meanwhile replace `latest` before choosing.
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
        latest = data;
        drain();
    }
};
