// Python runner for the Yukibana IDE (packs/CONTRACT.md, "Running a program").
//
// A module worker that runs the project with Pyodide: CPython compiled to
// WebAssembly, the real interpreter and standard library, served from
// /packs/python/ next to this file. Pyodide starts loading as soon as the
// worker starts, so the download overlaps the app sending `run`.
//
// Protocol (one object per postMessage):
//   in:  { type: 'run' | 'test', files, entry, stdin: SharedArrayBuffer | null }
//   out: loading / phase / stdout / stderr / stdin / exit (exit is last)
//
// `test` runs pytest over the project instead of the entry, with pytest
// fetched only then (PYTEST_ZIP).

import { loadPyodide, version } from './pyodide.mjs';

// The upstream lock file lists ~350 optional packages that this pack does not
// ship. Pyodide only needs its `info` (ABI, platform) to start, so the build
// inlines that and an empty package list: nothing is fetched for it, and
// nothing can be fetched from a CDN by `loadPackage`.
const LOCK = /* LOCK_INFO */ { info: {}, packages: {} };

// pytest, pluggy, iniconfig, packaging and the part of pygments pytest
// imports, as one stored zip of their wheels' files (scripts/make-pytest-zip.py),
// named by pytest's version; the build writes the name in.
const PYTEST_ZIP = /* PYTEST_ZIP */ "pytest.zip";

const BASE = new URL('./', import.meta.url).href;
const WORKDIR = '/workspace';

const post = (msg) => self.postMessage(msg);

// Report downloads of our own files as `loading` messages. Pyodide fetches
// pyodide.asm.wasm and python_stdlib.zip with fetch(). It gets the original
// Response back untouched: a Response rebuilt around a counting stream has no
// URL, and WebAssembly.instantiateStreaming then cannot use V8's cache of the
// compiled module, so the 9.6 MB wasm was recompiled on every Run (measured:
// ~0.5 s slower to "Running" with the old wrapper). The bytes are counted on
// a clone read in the background. The wrapper is removed once Pyodide has
// loaded, so the program's own code never sees a patched fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const res = await realFetch.call(globalThis, input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!res.ok || !res.body || !url.startsWith(BASE)) return res;
    const label = url.slice(BASE.length).split(/[?#]/)[0];
    // With Content-Encoding the length is of the compressed body while the
    // stream yields decompressed bytes, so the total is unknown (0).
    const total = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length') ?? 0);
    countBytes(res.clone().body, label, total);
    return res;
};

async function countBytes(body, label, total) {
    let loaded = 0;
    let last = 0;
    post({ type: 'loading', label, loaded, total });
    try {
        for (const reader = body.getReader(); ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            const now = performance.now();
            if (now - last > 50) {
                last = now;
                post({ type: 'loading', label, loaded, total });
            }
        }
    } catch {
        // A failed download is reported by Pyodide itself, as an error.
        return;
    }
    post({ type: 'loading', label, loaded, total: total || loaded });
}

post({ type: 'phase', text: 'Loading Python' });
const ready = loadPyodide({
    indexURL: BASE,
    lockFileContents: LOCK,
    packageBaseUrl: BASE,
    // No ANSI colours in tracebacks: the output panel is not a terminal.
    env: { HOME: '/home/pyodide', PYTHON_COLORS: '0', NO_COLOR: '1' },
});
ready.finally(() => {
    globalThis.fetch = realFetch;
}).catch(() => {});

// --- output -----------------------------------------------------------------

// Pyodide calls write() with a view into wasm memory: decode it at once.
// `stream: true` keeps a UTF-8 sequence split across two writes intact.
// isatty makes Python line-buffer the text layer, as in a terminal; the
// driver also flushes before every read of stdin and at exit. Tests run with
// isatty false: pytest on a terminal redraws its "collecting ..." line with
// carriage returns, which the app's output panel would show as garbage (the
// driver line-buffers stdout itself either way).
function writer(type, isatty = true) {
    const decoder = new TextDecoder();
    return {
        isatty,
        write(bytes) {
            const text = decoder.decode(bytes, { stream: true });
            if (text) post({ type, text });
            return bytes.length;
        },
    };
}

// --- input ------------------------------------------------------------------

/** stdin over the contract's SharedArrayBuffer; null means always end of file. */
function reader(sab) {
    const state = sab ? new Int32Array(sab, 0, 2) : null;
    const data = sab ? new Uint8Array(sab, 8) : null;
    let pending = new Uint8Array(0);
    return {
        isatty: false,
        read(buffer) {
            if (pending.length === 0) {
                if (!state || !data) return 0;
                // stdout is already flushed: the driver's sys.stdin flushes
                // before every read (see DRIVER).
                Atomics.store(state, 0, 1);
                post({ type: 'stdin' });
                while (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1);
                const s = Atomics.load(state, 0);
                if (s === 2) {
                    const length = Math.min(Atomics.load(state, 1), data.length);
                    pending = data.slice(0, length);
                }
                // On 3 (end of file) `pending` stays empty and read returns 0;
                // back to idle, so a later read asks again, as a terminal does
                // after Ctrl-D.
                Atomics.store(state, 0, 0);
                if (pending.length === 0) return 0;
            }
            const n = Math.min(buffer.length, pending.length);
            buffer.set(pending.subarray(0, n));
            pending = pending.subarray(n);
            return n;
        },
    };
}

// --- running ----------------------------------------------------------------

// Runs the entry as __main__ the way `python main.py` does in WORKDIR:
// sys.path[0] is the directory, so sibling modules import. Returns the exit
// status: 0, SystemExit's code, or 1 after printing an uncaught exception's
// traceback to stderr (with the runner's own frames cut off, as the
// interpreter cuts off its startup code).
//
// sys.stdin is replaced by the same fd 0 behind a raw reader that flushes
// stdout and stderr first, so `print("name? ", end="")` followed by
// sys.stdin.readline() shows the prompt, as the contract requires (CPython
// itself flushes only in input()). It cannot be done from the JS read
// handler: calling back into Python there, inside a blocking read, fails
// with EIO.
const DRIVER = `
import io as _io

class _YukibanaStdin(_io.RawIOBase):
    def readable(self):
        return True

    def fileno(self):
        return 0

    def readinto(self, b):
        import os, sys
        for s in (sys.stdout, sys.stderr):
            try:
                s.flush()
            except Exception:
                pass
        data = os.read(0, len(b))
        b[: len(data)] = data
        return len(data)

def _yukibana_run(workdir, entry):
    import io, os, runpy, sys, traceback
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    sys.stdin = sys.__stdin__ = io.TextIOWrapper(io.BufferedReader(_YukibanaStdin()), encoding="utf-8", errors="replace")
    path = os.path.join(workdir, entry)
    os.chdir(workdir)
    sys.argv = [path]
    sys.path.insert(0, os.path.dirname(path))
    code = 0
    try:
        runpy.run_path(path, run_name="__main__")
    except SystemExit as e:
        c = e.code
        if c is None:
            code = 0
        elif isinstance(c, int):
            # As a POSIX shell sees it: sys.exit(256) is 0, sys.exit(-1) 255.
            code = c & 0xFF
        else:
            print(c, file=sys.stderr)
            code = 1
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and not tb.tb_frame.f_code.co_filename.startswith(workdir + "/"):
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        code = 1
    finally:
        for s in (sys.stdout, sys.stderr):
            try:
                s.flush()
            except Exception:
                pass
    return code

def _yukibana_test(workdir, site):
    # Runs pytest as "python -m pytest" does in the project directory.
    #
    # The cwd is the project and is on sys.path (what -m adds), so tests in
    # tests/ import the project's modules ("from geometry import Point").
    # No path arguments: pytest's own discovery from the rootdir, which
    # honours testpaths in pyproject.toml/pytest.ini and otherwise collects
    # every test_*.py / *_test.py, tests/ included, and unittest.TestCase
    # classes in them. The cache plugin is off: .pytest_cache would vanish
    # with the worker. Colours are off through NO_COLOR (set at startup): the
    # app's output panel is not a terminal. Returns pytest's exit status (0
    # only when every collected test passed; 1 failures, 2 collection
    # errors, 5 no tests).
    import io, os, sys, traceback
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    sys.stdin = sys.__stdin__ = io.TextIOWrapper(io.BufferedReader(_YukibanaStdin()), encoding="utf-8", errors="replace")
    os.chdir(workdir)
    sys.path.insert(0, workdir)
    sys.argv = ["pytest"]
    code = 0
    try:
        if site not in sys.path:
            sys.path.append(site)
        import pytest
        code = int(pytest.main(["-p", "no:cacheprovider"]))
    except SystemExit as e:
        c = e.code
        code = 0 if c is None else c & 0xFF if isinstance(c, int) else 1
    except BaseException:
        traceback.print_exc()
        code = 1
    finally:
        for s in (sys.stdout, sys.stderr):
            try:
                s.flush()
            except Exception:
                pass
    return code

`;

function writeFiles(pyodide, files) {
    const FS = pyodide.FS;
    FS.mkdirTree(WORKDIR);
    for (const [rel, text] of Object.entries(files)) {
        const parts = rel.split('/').filter((p) => p && p !== '.');
        if (parts.length === 0 || parts.includes('..')) throw new Error(`bad project path: ${rel}`);
        const path = `${WORKDIR}/${parts.join('/')}`;
        FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
        FS.writeFile(path, text);
    }
}

/**
 * Fetches the pytest bundle, reporting it as a `loading` message (the fetch
 * wrapper above is gone by now), while Pyodide itself loads.
 */
async function fetchPytest() {
    const url = new URL(PYTEST_ZIP, BASE);
    const res = await realFetch.call(globalThis, url);
    if (!res.ok || !res.body) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
    const total = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length') ?? 0);
    countBytes(res.clone().body, PYTEST_ZIP, total);
    return res.arrayBuffer();
}

/** Unpacks the pytest bundle into site-packages; returns that directory. */
function installPytest(pyodide, bytes) {
    const site = pyodide.runPython('import sysconfig; sysconfig.get_paths()["purelib"]');
    pyodide.unpackArchive(bytes, 'zip', { extractDir: site });
    return site;
}

let started = false;
self.onmessage = async ({ data: msg }) => {
    if ((msg?.type !== 'run' && msg?.type !== 'test') || started) return;
    started = true;
    const testing = msg.type === 'test';
    let code = 1;
    try {
        if (testing) post({ type: 'phase', text: 'Loading Python and pytest' });
        const [pyodide, pytestZip] = await Promise.all([ready, testing ? fetchPytest() : null]);
        pyodide.setStdout(writer('stdout', !testing));
        pyodide.setStderr(writer('stderr', !testing));
        pyodide.setStdin(reader(msg.stdin ?? null));
        writeFiles(pyodide, msg.files ?? {});
        pyodide.runPython(DRIVER);
        if (testing) {
            const site = installPytest(pyodide, pytestZip);
            post({ type: 'phase', text: 'Testing' });
            const test = pyodide.globals.get('_yukibana_test');
            code = test(WORKDIR, site);
            test.destroy();
        } else {
            post({ type: 'phase', text: 'Running' });
            const run = pyodide.globals.get('_yukibana_run');
            code = run(WORKDIR, msg.entry ?? 'main.py');
            run.destroy();
        }
    } catch (err) {
        if (err?.name === 'Exit' && Number.isInteger(err.status)) {
            // os._exit(n): Emscripten's exit() unwinds as an `Exit` error
            // carrying the status. Like CPython's os._exit it does not flush
            // Python's buffers. The interpreter is gone afterwards, which is
            // fine: a worker runs one program.
            code = err.status & 0xff;
        } else {
            post({ type: 'stderr', text: `python runner (Pyodide ${version}): ${err?.stack ?? err}\n` });
            code = 1;
        }
    }
    post({ type: 'exit', code: Number.isInteger(code) ? code : 1 });
};
