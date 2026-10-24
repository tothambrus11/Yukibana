// Haskell runner for the Yukibana IDE (packs/CONTRACT.md, "Running a
// program"): MicroHs compiles the project in the browser and runs it in the
// same process, as `mhs -r` does; Test does the same with the test suite's
// file (tests/Spec.hs), whose hspec report is the output.
//
// Protocol (one object per postMessage):
//   in:  { type: 'run' | 'test', files, entry, stdin: SharedArrayBuffer | null }
//   out: loading / phase / stdout / stderr / stdin / exit (exit is last)
//
// stdin: a read of fd 0 comes to `input` one byte at a time (Emscripten's
// stdin device). With no input left the runner flushes the program's
// stdout (C's stdio, line buffered: a prompt without a newline is still in
// it), asks the app for a line and blocks on the SharedArrayBuffer, which is
// allowed in a worker and leaves the program waiting in its read as on a
// terminal.

import { ROOT, sourceRoots, startYuki, testEntry, writeProjectFile } from './project.js';

const post = (msg) => self.postMessage(msg);
const report = (p) => post({ type: 'loading', ...p });

/**
 * Collects a stream's bytes and posts them as text: at each newline, when
 * 4 KB have gathered, and when flushed (before input is read, at the end).
 * The program runs synchronously, so nothing would post them otherwise
 * before it ends.
 */
function stream(type) {
    const decoder = new TextDecoder();
    let bytes = [];
    const flush = () => {
        if (bytes.length === 0) return;
        const text = decoder.decode(new Uint8Array(bytes), { stream: true });
        bytes = [];
        if (text) post({ type, text });
    };
    const write = (byte) => {
        if (byte === null || byte === undefined) return;
        bytes.push(byte < 0 ? byte + 256 : byte);
        if (byte === 10 || bytes.length >= 4096) flush();
    };
    return { write, flush };
}

/**
 * The byte source for fd 0 over the contract's SharedArrayBuffer (null:
 * always end of file). Emscripten's device reads up to the buffer's length
 * and stops at `undefined`: after a line is handed out the next call returns
 * undefined once, which ends that read with the line, so the next read is the
 * one that waits for the app.
 */
function terminal(sab, beforeWait) {
    if (!sab) return () => null;
    const state = new Int32Array(sab, 0, 2);
    const data = new Uint8Array(sab, 8);
    let line = new Uint8Array(0);
    let at = 0;
    let endOfRead = false;
    return () => {
        if (at < line.length) {
            const byte = line[at++];
            if (at === line.length) endOfRead = true;
            return byte;
        }
        if (endOfRead) {
            endOfRead = false;
            return undefined;
        }
        beforeWait();
        Atomics.store(state, 0, 1);
        post({ type: 'stdin' });
        while (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1);
        const s = Atomics.load(state, 0);
        line = s === 2 ? data.slice(0, Math.min(Atomics.load(state, 1), data.length)) : new Uint8Array(0);
        at = 0;
        // Back to idle; after Ctrl-D (3) a later read asks again, as a terminal does.
        Atomics.store(state, 0, 0);
        if (line.length === 0) return null;
        const byte = line[at++];
        if (at === line.length) endOfRead = true;
        return byte;
    };
}

let started = false;
self.onmessage = async ({ data: msg }) => {
    if ((msg?.type !== 'run' && msg?.type !== 'test') || started) return;
    started = true;
    const testing = msg.type === 'test';
    const files = msg.files ?? {};
    const out = stream('stdout');
    const err = stream('stderr');
    let code = 1;
    try {
        const entry = testing ? testEntry(files) : (msg.entry ?? 'Main.hs');
        if (!entry || !(entry in files)) {
            post({ type: 'stderr', text: testing ? 'No tests: Test runs tests/Spec.hs (hspec), which this project does not have.\n' : `No ${entry} to run.\n` });
            post({ type: 'exit', code: 1 });
            return;
        }
        post({ type: 'phase', text: 'Loading MicroHs' });
        let yuki = null;
        const input = terminal(msg.stdin ?? null, () => {
            yuki?._fflush(0);
            out.flush();
            err.flush();
        });
        yuki = await startYuki(report, {
            preRun: [(m) => m.FS.init(input, out.write, err.write)],
        });
        for (const [path, text] of Object.entries(files)) writeProjectFile(yuki, path, text);
        yuki.FS.chdir(ROOT);
        post({ type: 'phase', text: testing ? 'Compiling and testing' : 'Compiling and running' });
        try {
            code = yuki.callMain([testing ? 'test' : 'run', `${ROOT}/${entry}`, ...sourceRoots(files)]);
        } catch (e) {
            // exit() with a code (Yuki.hs's cExit) unwinds as Emscripten's ExitStatus.
            if (e?.name === 'ExitStatus' || typeof e?.status === 'number') code = e.status;
            else throw e;
        }
        yuki._fflush(0);
        if (typeof code !== 'number') code = 0;
    } catch (e) {
        err.flush();
        post({ type: 'stderr', text: `haskell runner: ${e?.stack ?? e}\n` });
        code = 1;
    }
    out.flush();
    err.flush();
    post({ type: 'exit', code });
};
