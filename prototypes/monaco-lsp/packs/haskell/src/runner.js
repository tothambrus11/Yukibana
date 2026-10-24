// Haskell runner for the Yukibana IDE (packs/CONTRACT.md, "Running a
// program"): GHC 9.14 loads the project into its bytecode interpreter and
// runs `main`, as `runghc Main.hs` does; Test does the same with the test
// suite's file (tests/Spec.hs, hspec and QuickCheck), whose report is the
// output. GHC's compile errors go to stderr as ghc prints them, in colour.
//
// Protocol (one object per postMessage):
//   in:  { type: 'run' | 'test', files, entry, stdin: SharedArrayBuffer | null }
//   out: loading / phase / mark / stdout / stderr / stdin / exit (a run's
//        last message; `reusable: true` when the worker takes another run)
//
// GHC starts as soon as the worker does, before the run message arrives:
// unpacking and linking it is most of a run's time.
//
// stdout is unbuffered (hSetBuffering NoBuffering, as GHCi and runghc
// have it), so a prompt without a newline shows before the program reads;
// the bytes are posted in batches, at most every 30 ms. stdin: a read of fd
// 0 with no input left asks the app for a line and blocks on the
// SharedArrayBuffer, which a worker may do, leaving the program waiting in
// its read as on a terminal.

import { ConsoleStdout, Fd, Inode, wasi } from './wasi.js';
import { sourceRoots, startGhc, testEntry } from './ghc.js';

const post = (msg) => self.postMessage(msg);

/** An fd whose writes are posted as `type` messages, batched. */
class Output extends ConsoleStdout {
    constructor(type) {
        super(() => {});
        this.type = type;
        this.decoder = new TextDecoder();
        this.pending = '';
        this.last = 0;
        /** While true, writes are dropped (the warm-up run's). */
        this.silent = false;
    }
    fd_write(data) {
        if (this.silent) return { ret: 0, nwritten: data.byteLength };
        this.pending += this.decoder.decode(data, { stream: true });
        const now = performance.now();
        if (now - this.last > 30 || this.pending.length > 65536) this.flush(now);
        return { ret: 0, nwritten: data.byteLength };
    }
    flush(now = performance.now()) {
        this.last = now;
        if (!this.pending) return;
        post({ type: this.type, text: this.pending });
        this.pending = '';
    }
}

/**
 * fd 0 over the contract's SharedArrayBuffer (null: always end of file). A
 * read takes what is left of the last line, or flushes the outputs, asks
 * the app for a line and waits for it.
 */
class Input extends Fd {
    constructor(sab, outputs) {
        super();
        this.ino = Inode.issue_ino();
        this.outputs = outputs;
        this.attach(sab);
    }
    /** Reads from the run message's buffer from now on. */
    attach(sab) {
        this.state = sab ? new Int32Array(sab, 0, 2) : null;
        this.data = sab ? new Uint8Array(sab, 8) : null;
        this.rest = new Uint8Array(0);
    }
    fd_read(size) {
        if (this.rest.length === 0 && this.state) {
            for (const o of this.outputs) o.flush();
            Atomics.store(this.state, 0, 1);
            post({ type: 'stdin' });
            while (Atomics.load(this.state, 0) === 1) Atomics.wait(this.state, 0, 1);
            const s = Atomics.load(this.state, 0);
            this.rest = s === 2 ? this.data.slice(0, Math.min(Atomics.load(this.state, 1), this.data.length)) : new Uint8Array(0);
            // Back to idle; after Ctrl-D (3) a later read asks again, as a terminal does.
            Atomics.store(this.state, 0, 0);
        }
        const n = Math.min(size, this.rest.length);
        const out = this.rest.slice(0, n);
        this.rest = this.rest.subarray(n);
        return { ret: 0, data: out };
    }
    fd_filestat_get() {
        // What fstat says of a terminal; each run opens fd 0 afresh
        // (Yuki.hs's freshStdio), which asks.
        return { ret: 0, filestat: new wasi.Filestat(this.ino, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
    }
    fd_fdstat_get() {
        // A character device, as a terminal is.
        const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
        fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ);
        return { ret: 0, fdstat };
    }
}

const out = new Output('stdout');
const err = new Output('stderr');
const input = new Input(null, [out, err]);
/** The project files the last run wrote into GHC's file system. */
const written = new Set();
/**
 * What the warm-up compiles and runs, out of sight, before the program
 * comes: a module importing from the packages programs use most, so their
 * libraries are linked and GHC's interpreter has run once (the first run
 * costs some seconds more than the next). Tests' hspec and QuickCheck are
 * not among them: they take as long again, and Run is the common case.
 */
const WARM = `import qualified Data.Map.Strict
import qualified Data.Set
import Data.Char ()
import Data.List ()
import Control.Monad.State ()
main :: IO ()
main = print (Data.Map.Strict.size (Data.Map.Strict.fromList [(1 :: Int, Data.Set.empty :: Data.Set.Set Int)]))
`;
const WARM_DIR = '.yukibana-warm';
const ghc = startGhc({
    mode: 'runner',
    report: (p) => post({ type: 'loading', ...p }),
    fds: [input, out, err],
    // GHC asks its loader for libdl, which a wasm GHC has no use for, and
    // would warn of it on every run.
    flags: ['-fdiagnostics-color=always', '-Wno-missed-extra-shared-lib'],
}).then(async (g) => {
    const t0 = performance.now();
    out.silent = err.silent = true;
    try {
        g.write(`${WARM_DIR}/Main.hs`, WARM);
        await g.request(['run', `-i/workspace/${WARM_DIR}`, '==', `/workspace/${WARM_DIR}/Main.hs`]);
    } catch {
        // A warm-up that fails costs the run its head start, nothing else.
    } finally {
        out.silent = err.silent = false;
        g.remove(`${WARM_DIR}/Main.hs`);
    }
    g.timings.warm = Math.round(performance.now() - t0);
    return g;
});
ghc.catch(() => {});

/**
 * The runs, one after another: a run that arrives while another is going
 * waits for it. A worker runs program after program, as one GHCi session
 * does (Yuki.hs gives each run fresh standard handles), and says so with
 * `reusable` on its exit: the app keeps it for the next Run instead of
 * starting a worker, and GHC, linked and warm, answers in a few hundred
 * milliseconds. Starting workers instead is not only slower: a browser
 * that already holds the language server's GHC stops compiling wasm for a
 * few new ones in a row (the fourth stalls for tens of seconds in Chromium).
 */
let queue = Promise.resolve();
self.onmessage = ({ data: msg }) => {
    if (msg?.type !== 'run' && msg?.type !== 'test') return;
    queue = queue.then(() => runOnce(msg));
};

/** One run or test; its last message is its exit. */
async function runOnce(msg) {
    const t0 = performance.now();
    const mark = (name) => post({ type: 'mark', name, ms: Math.round(performance.now() - t0) });
    const testing = msg.type === 'test';
    const files = msg.files ?? {};
    let code = 1;
    let reusable = true;
    let g = null;
    try {
        const entry = testing ? testEntry(files) : (msg.entry ?? 'Main.hs');
        if (!entry || !(entry in files)) {
            post({ type: 'stderr', text: testing ? 'No tests: Test runs tests/Spec.hs (hspec), which this project does not have.\n' : `No ${entry} to run.\n` });
            post({ type: 'exit', code: 1, reusable });
            return;
        }
        input.attach(msg.stdin ?? null);
        post({ type: 'phase', text: 'Loading GHC' });
        g = await ghc;
        mark('ghc-ready');
        post({ type: 'mark', name: 'ghc-warm-up', ms: g.timings.warm ?? 0 });
        // The project as it is now: files an earlier run had and this one
        // has not are gone, so GHC cannot find a deleted module.
        for (const path of written) if (!(path in files)) g.remove(path);
        written.clear();
        for (const [path, text] of Object.entries(files)) {
            g.write(path, text);
            written.add(path);
        }
        post({ type: 'phase', text: testing ? 'Compiling and testing' : 'Compiling and running' });
        const roots = sourceRoots(files);
        // A Test's report is coloured (--color) but not redrawn as progress:
        // hspec draws progress whenever it colours, unless it runs on a CI
        // service, and the output pane shows text, not a redrawn line.
        const env = testing ? ['env:BUILDKITE=true'] : [];
        const answer = await g.request(['run', ...env, ...roots.map((r) => `-i${r}`), '==', `/workspace/${entry}`, ...(testing ? ['--color'] : [])]);
        code = answer.exit;
        mark('exit');
    } catch (e) {
        err.flush();
        post({ type: 'stderr', text: `haskell runner: ${e?.stack ?? e}\n` });
        code = 1;
        // GHC itself failed (not the program, whose failure is an exit
        // code): a fresh worker is the safe next step.
        reusable = false;
    }
    out.flush();
    err.flush();
    post({ type: 'exit', code, reusable });
}
