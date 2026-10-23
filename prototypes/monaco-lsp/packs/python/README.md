# Python pack: basedpyright in a Web Worker

**Server:** [basedpyright](https://github.com/detachhead/basedpyright) 1.40.2
(commit `344759687c2fff3bd0a7d6a83a9d1847f806b795`), a fork of Microsoft's
Pyright, built from upstream source by `build.sh`. This is the real language
server: pyright's parser, binder, checker and language service, the same code
as `basedpyright-langserver`, running in one module Web Worker. Nothing is
emulated and there is no fallback.

Why basedpyright and not Microsoft's pyright: Microsoft does not publish or
maintain a browser build. basedpyright keeps one upstream
(`packages/browser-pyright`, the build behind basedpyright.com's playground,
published to npm as `browser-basedpyright`), so the browser-specific parts
(polyfill config, an in-memory file system, a server without a real disk) are
maintained by the project that also maintains the checker.

## What is in `app/static/packs/python/`

| file | raw | gzip | brotli | what |
|---|---|---|---|---|
| `server.js` | 2.28 MB | 559 KB | 437 KB | the server, minified ES module |
| `typeshed-stdlib.tar.gz` | 4.0 MB tar | 608 KB | (is gzip) | typeshed stdlib stubs + docstrings |
| `LICENSE-*.txt` | 14 KB | | | basedpyright (MIT), typeshed (Apache-2.0); the runner's are listed under Running |

A first load transfers about **1.05 MB** where the host serves `server.js.br`,
**1.17 MB** where it serves `.gz`, and 2.9 MB from a host that serves raw
files only (the stubs archive is gzip either way). For comparison, the npm
package `browser-basedpyright@1.40.2` is one 18 MB `pyright.worker.js` (3.2 MB
gzipped), because it inlines all of typeshed, third-party stubs included.

`crossOriginIsolated` is **not** required: pyright's file system is
synchronous, but everything lives in worker memory, so no blocking reads are
needed.

## How it differs from upstream's browser build, and why

`src/server.ts` replaces upstream's `packages/browser-pyright/src/worker.ts`
(and reuses its `BrowserWorkersHost`); `src/rspack.config.js` replaces its
`rspack.config.js`. No upstream file is patched: `build.sh` copies `src/` into
the checkout as `packages/browser-pyright/src-yukibana/` and builds with
upstream's own rspack, ts-loader (type-checked) and polyfills.

* **Starts at once, one worker.** Upstream waits for a private
  `browser/boot` message and asks the page to create a second "background
  analysis" worker (`browser/newWorker`). The pack contract has neither, and
  the server is already off the main thread, so analysis runs in this worker
  (`createBackgroundAnalysis()` returns `undefined`, a mode pyright supports:
  it analyses in time slices between requests).
* **Stubs are a separate, lazily read download.** Upstream compiles typeshed
  into the bundle and expects the client to send it again in
  `initializationOptions.files`. Here only the stdlib stubs ship, as a
  deterministic ustar archive (`scripts/make-stubs-tar.py`). The worker starts
  fetching it on load (reporting `yukibana/loading`), inflates it with the
  browser's `DecompressionStream`, indexes the tar headers, and mounts it at
  `/typeshed-fallback` with pyright's own vfs `mountSync` and a
  `FileSystemResolver` (`src/tarResolver.ts`). A stub file is only turned into
  a `Buffer` (a zero-copy view of the archive) when pyright reads it. The
  `initialize` response waits for the archive; nothing else does.
* **Docstrings for compiled stdlib modules.** The stubs are basedpyright's
  "docstubs": upstream's `build/py_old/generate_docstubs.py` with docify
  1.2.1 copies docstrings from a real CPython into the stubs, so hover on
  `len`, `math.sqrt` or `str.split` has documentation. Upstream's CI does this
  under Python 3.10-3.15 on three OSes; `build.sh` does it once, with CPython
  3.13 on Linux (fetched by `uv`), so a docstring that exists only on Windows
  or only in another Python version is missing. Type information is
  unaffected: it comes from the typeshed stubs themselves.
* **English messages only.** pyright bundles 15 message catalogues (~1.4 MB
  raw). The build swaps the 14 non-English ones for `{}`; pyright already
  falls back to English for a key a catalogue lacks.
* **Open documents are mirrored into the vfs.** pyright resolves `import x`
  against the file system, not against open documents. `didOpen`/`didChange`
  write the file into the in-memory file system; a file that did not exist
  before, and every `workspace/didChangeWatchedFiles`, invalidates pyright's
  import caches (what its own file watcher does on a real disk); a `Deleted`
  change removes the file.
* **Non-Python files are not analysed.** The client opens every project file;
  only `.py`/`.pyi` reach pyright as documents. Everything else is only
  mirrored, which is how `pyproject.toml` and `pyrightconfig.json` reach
  pyright; opening or changing one reloads the configuration.
* **`standard` type checking by default.** basedpyright's default mode,
  `recommended`, reports every unannotated or partially unknown value, which
  is noise in a teaching project. Without a client setting
  (`basedpyright.analysis.typeCheckingMode`) the pack uses pyright's
  `standard`. As in pyright, a config file in the project
  (`[tool.basedpyright]` in `pyproject.toml`, or `pyrightconfig.json`) takes
  precedence over client settings, so a project with one gets basedpyright's
  own default, `recommended`, unless the file says `typeCheckingMode`.

## What works

Everything pyright's language server offers, with nothing turned off:
diagnostics (push), completion with resolve and auto-import, hover, signature
help, definition / declaration / type definition, references, document
highlight, document and workspace symbols, rename, code actions (quick fixes,
organise imports), semantic tokens, inlay hints, call hierarchy. Positions are
UTF-16. `test.mjs` checks the ones the contract names, in Chromium, over http,
as the app starts the worker.

## What does not

* **No third-party packages.** Only the standard library is known. `import
  numpy` is reported as unresolved (`reportMissingImports`), as it would be
  for a real interpreter without numpy. typeshed's third-party stubs (27 MB
  raw) are deliberately not shipped.
* **No interpreter.** pyright never runs Python; it assumes the newest Python
  version it knows and no `site-packages`. A project can set `pythonVersion`
  in its config file.
* **No `workspace/executeCommand` for `basedpyright.createtypestub` or
  `writeBaseline`** in a meaningful way: they write files to a disk the app
  cannot see.
* Docstrings of pure-Python stdlib modules (e.g. `os.path.join`,
  `json.dumps`) come from source files pyright would read from a real
  interpreter; there is none, so hover shows the signature only. Compiled
  modules (`builtins`, `math`, `str` methods...) do have docs (see above).

## Build

```sh
./build.sh      # ~60 s from an empty cache, ~25 s after (most of it rspack + ts type-check)
npm install     # playwright-core, for the test only
node test.mjs
```

`build.sh` needs git, Node 22, pnpm (the lockfile's 11.21.0 is fetched with
`npx` if the installed one differs), python3 and `uv`. It caches in
`$PACK_CACHE/python` (default `~/.cache/yukibana-packs/python`, ~470 MB:
the checkout and the node_modules of `pyright-internal` and
`browser-pyright`). Dependencies come from upstream's frozen lockfile. The
stubs archive is byte-for-byte reproducible.

## Test output (2026-10-23, Chromium 141 headless)

```text
PASS  initialize answers after the stubs download, with progress notifications  (260 ms, 2 progress messages, last {"label":"typeshed-stdlib.tar.gz","loaded":608122,"total":608122}, server basedpyright 1.40.2)
PASS  an import of a file the project does not have is reported, as a warning because pyproject.toml says so  (709 ms) ["Import \"helpers\" could not be resolved",...]
PASS  adding that file resolves the import, and the project has no errors  []
PASS  assigning a str to an int is an error on that line  "Type \"Literal['five']\" is not assignable to declared type \"int\"..."
PASS  completion after `p.` offers the members of Point from models.py  ["__doc__","__module__","__init__","norm","x","y",...]
PASS  hover on `norm` shows its signature and docstring  "```python\n(method) def norm() -> float\n```\n---\nDistance from the origin."
PASS  hover on `math.sqrt` shows the stdlib stub and its documentation  "...def sqrt(\n    x: _SupportsFloatOrIndex,\n    /\n) -> float\n```\n---\nReturn the square root of x."
PASS  go to definition of `Point` lands in models.py on its class line  [{"uri":"file:///workspace/models.py","range":{"start":{"line":0,"character":6},...}}]
PASS  deleting that file makes its import unresolved again
PASS  a non-Python project file is not analysed as Python
PASS  shutdown answers
PASS  the worker reported no errors  []
all checks passed
```

The times are from a local http server; on a real network the first
`initialize` waits for ~0.6 MB of stubs on top of the worker script itself.

# Running

**Runner:** [Pyodide](https://github.com/pyodide/pyodide) 314.0.7 (the npm
package `pyodide@314.0.7`, MPL-2.0): **CPython 3.14.2** compiled to
WebAssembly with Emscripten 5.0.3, and its standard library. This is the real
interpreter: compiler, bytecode VM, `traceback`, `runpy`, `dataclasses`, all
of it the CPython source. Nothing is reimplemented or simulated.
`runner.js` is a module worker separate from `server.js`, following
`packs/CONTRACT.md` ("Running a program").

`build-runner.sh` (called at the end of `build.sh`, or run on its own)
downloads the npm tarball, checks it against the registry's sha512 integrity
(pinned in the script), and copies out only the core. Nothing is compiled.

## What is in `app/static/packs/python/` for running

| file | raw | gzip | brotli | what |
|---|---|---|---|---|
| `runner.js` | 9.9 KB | 4.0 KB | 3.4 KB | the worker (hand-written, not minified) |
| `pyodide.mjs` | 17.9 KB | 7.2 KB | 6.4 KB | Pyodide's loader |
| `pyodide.asm.mjs` | 1.25 MB | 261 KB | 207 KB | the Emscripten JS glue |
| `pyodide.asm.wasm` | 9.60 MB | 3.59 MB | 2.74 MB | CPython 3.14.2 |
| `python_stdlib.zip` | 9.67 MB | 2.21 MB | 1.59 MB | the standard library, re-stored (see below) |
| lock file | not shipped | | | upstream's is 119 KB |
| `LICENSE-pyodide.txt`, `LICENSE-cpython.txt` | 17 KB, 14 KB | | | Pyodide (MPL-2.0); CPython 3.14.2 (PSF licence), both pinned by sha256 |
| **total** (one Run, licences excluded) | **20.5 MB** | **6.08 MB** | **4.55 MB** | |

The language server and the runner share no files: basedpyright is
TypeScript and never needs an interpreter, so pressing Run downloads ~4.5 MB
(brotli) that the editor did not, and the editor never downloads Pyodide.

Two changes against the upstream files, both in the build, none in Pyodide's
code:

* **`python_stdlib.zip` is re-stored without compression**
  (`scripts/store-zip.py`). Upstream deflates each member, so brotli over the
  file gains 2 %; stored, brotli sees the whole stdlib at once and the
  transfer drops from 2.49 MB to 1.59 MB (gzip: 2.50 MB to 2.21 MB). The
  cost is the raw size (2.5 MB to 9.7 MB) on a host that serves no
  compressed siblings, and 7 MB more worker memory. Same members, order and
  timestamps; `zipimport` reads stored members without inflating them.
* **No lock file.** `pyodide-lock.json` lists ~350 optional packages
  (numpy, pandas...) that are not shipped. Pyodide refuses to start without
  the lock's `info` (its ABI check), so the build inlines `info` into
  `runner.js` with an empty package list. Consequently `pyodide.loadPackage`
  and `micropip` cannot fetch anything, from here or from a CDN.

## How a run works

1. The worker starts loading Pyodide as soon as it is created (phase
   "Loading Python"); `pyodide.asm.wasm` and `python_stdlib.zip` are reported
   as `loading` messages with byte counts (a `fetch` wrapper counts the body
   on a clone of the response, read in the background, while Pyodide gets
   the original `Response` untouched; `total` is 0 if the host sent
   `Content-Encoding`). The original keeps its URL, so V8 can reuse its
   compiled-code cache for the wasm: an earlier version handed Pyodide a
   rebuilt `Response`, and warm runs were no faster than cold. The wrapper is
   removed once Pyodide has loaded, so programs never see a patched `fetch`.
2. On `run`, every project file is written to `/workspace/<path>` in
   Pyodide's in-memory file system (subdirectories created), the directory is
   made the cwd and `sys.path[0]`, `sys.argv = ["/workspace/main.py"]`, and
   the entry runs with `runpy.run_path(path, run_name="__main__")`, which is
   what `python main.py` does. `from geometry import Point` and packages in
   subdirectories import normally.
3. stdout and stderr are Pyodide `write` handlers posting UTF-8-decoded text
   as it is written (line-buffered, as in a terminal). stdin is a raw reader
   on the contract's `SharedArrayBuffer` (`Atomics.wait`); `sys.stdin` is
   wrapped so that every read flushes stdout and stderr first, so a prompt
   without a newline is visible before the program blocks, for `input()` and
   for `sys.stdin.readline()`. Ctrl-D (state 3) is end of file:
   `EOFError` from `input()`, `""` from `read()`.
4. Exit status: 0; `n & 0xFF` for `SystemExit(n)` / `sys.exit(n)`, as a
   POSIX shell sees it (`sys.exit(256)` is 0, `sys.exit(-1)` is 255);
   `n & 0xFF` for `os._exit(n)` (which, as in CPython, does not flush
   Python's buffers; Emscripten unwinds it as an `Exit` error with the
   status, which the runner reports instead of a stack trace); 1 with the
   message on stderr for `sys.exit("message")`; 1 for an uncaught exception,
   whose traceback goes to stderr with the runner's and `runpy`'s frames cut
   off, so it starts at `File "/workspace/main.py"` as `python main.py` would
   print it. Syntax errors are uncaught exceptions too (CPython compiles at
   import), so they come out the same way, with file, line and caret.

## Limits

* **`crossOriginIsolated` is needed for stdin.** Without it the app passes
  `stdin: null` and every read is end of file (`input()` raises `EOFError`).
  Everything else works without isolation.
* **Standard library only.** No numpy etc.: not shipped, and the runner
  cannot download packages (no lock entries, no network to a CDN).
* **No threads, no subprocesses.** CPython is built for Emscripten without
  pthreads: `threading.Thread(...).start()` raises
  `RuntimeError("can't start new thread")`; `subprocess.run` raises
  `OSError(138, 'emscripten does not support processes.')`.
* **No network.** There is no TCP in a browser. Emscripten's socket layer
  maps `connect` onto a WebSocket to that host, so
  `socket.create_connection(("example.com", 80))` appears to succeed, but
  nothing comes back: `recv` and `urllib.request.urlopen` time out
  (checked: `TimeoutError` / `URLError(TimeoutError)`).
* **Files are temporary.** A program may create and read files (MEMFS), but
  they disappear with the worker and never reach the project.
* **The worker is busy while Python runs.** `time.sleep` blocks the worker
  (it works, output streams in between). A program is stopped by terminating
  the worker (the app's Stop); there is no `KeyboardInterrupt`.
* **Output written without a newline and without `flush=True`, followed by
  a long computation, appears only when a newline, a read of stdin, or the
  end of the program flushes it**, exactly as CPython does on a terminal.
* **Startup cost.** Each Run is a fresh interpreter (a new worker), so every
  run pays CPython's start-up: about 2.0 s warm and 2.7 s cold in the test
  on a shared 4-core container (load average 4-5 during the run; 3-4 s
  at load 8-10), most of it in
  `loadPyodide` (instantiating 9.6 MB of wasm and initialising the
  interpreter), not in the download once cached. On an idle desktop it
  should be well under that, but it was not measured here.

## Build and test

```sh
./build-runner.sh   # ~50 s on an idle machine, ~2 min under load: almost all of it
                    # brotli quality 11 over the two ~10 MB files
node test-run.mjs   # Chromium, app/static over http with COOP/COEP
```

Caches `$PACK_CACHE/python/pyodide-314.0.7.tgz` (6.5 MB, sha512-pinned) and
the two licence texts (sha256-pinned), so a build with a warm cache makes no
network request.

Licences: the npm tarball carries none, so the build ships Pyodide's
`LICENSE` (MPL-2.0) and CPython 3.14.2's `LICENSE` (PSF), fetched from the
upstream tags and checked against pinned hashes. Not shipped: the notices of
the C libraries CPython links in (zlib, bzip2, libffi, expat, mpdecimal,
HACL\*, ...), which CPython lists in `Doc/license.rst`, not in `LICENSE`.

## Test output (2026-10-23, Chromium headless, load average ~4-5 on 4 cores)

"cold" is a fresh browser profile (all 20.5 MB downloaded raw from a local
server, wasm compiled); "warm" is a new worker on the same page with every
file from the HTTP cache (0 bytes served), which is what pressing Run again
costs.

```text
PASS  the page is cross-origin isolated
PASS  cold: the sample project prints the distance and the norm, exit 0  (2690 ms total, Running at 2677 ms) stdout="Point(x=0, y=0) to Point(x=3, y=4): 5.0\n0.0\n" stderr="" code=0
      cold downloads: 20.54 MB raw over http; progress: {"python_stdlib.zip":{"loaded":9665005,"total":9665005},"pyodide.asm.wasm":{"loaded":9598218,"total":9598218}}; phases: Loading Python@29ms, Running@2677ms
PASS  warm: the same run in a new worker, files from the HTTP cache  (2104 ms total, Running at 2083 ms) served 0 bytes
PASS  warm runs reach Running faster than the cold run  cold 2677 ms, warm 2083/2017/2035 ms (median 2035)
PASS  input() reads two lines through the SharedArrayBuffer and prints their sum  (2297 ms total, Running at 2234 ms) stdout="First number: Second number: 2 + 40 = 42\n" code=0
PASS  the prompt without a newline arrives before the runner asks for input  before first stdin: "First number: "
PASS  sys.stdin.readline() after print(end="") shows the prompt first; read() runs to Ctrl-D  (2547 ms total, Running at 2471 ms) before stdin "name? ", stdout="name? hello, Ada\nrest: 'more\\n'\n" stderr=""
PASS  Ctrl-D at input() raises EOFError: traceback on stderr, exit 1  stderr="Traceback (most recent call last):\n  File \"/workspace/main.py\", line 1, in <module>\n    x = input(\"? \")\nEOFError: EOF when reading a line\n"
PASS  a syntax error in an imported module is reported on stderr with its file and line, exit 1  (2120 ms total, Running at 2102 ms) stderr="Traceback (most recent call last):\n  File \"/workspace/main.py\", line 1, in <module>\n    from helper import f\n  File \"/workspace/helper.py\", line 1\n    def f(x)\n            ^\nSyntaxError: expected ':'\n"
PASS  the traceback starts at the project, not in the runner or runpy
PASS  a syntax error in the entry itself: stderr, exit 1, nothing runs  stderr="  File \"/workspace/main.py\", line 1\n    print(\"never\"\n         ^\nSyntaxError: '(' was never closed\n"
PASS  an uncaught exception: output so far, then a traceback through both files, exit 1  stderr="Traceback (most recent call last):\n  File \"/workspace/main.py\", line 3, in <module>\n    geometry.boom()\n    ~~~~~~~~~~~~~^^\n  File \"/workspace/geometry.py\", line 2, in boom\n    return 1 / 0\n           ~~^~~\nZeroDivisionError: division by zero\n"
PASS  sys.exit(3) exits with 3  code=3
PASS  SystemExit with a message prints it to stderr and exits 1  stderr="fatal: no input\n"
PASS  exit statuses wrap to 0-255 as the shell sees them: sys.exit(256) is 0, sys.exit(-1) is 255  codes=0,255
PASS  os._exit(7) exits with 7, no runner stack trace on stderr  code=7 stdout="x\n" stderr=""
PASS  a package in a subdirectory imports; __name__ is __main__; UTF-8 survives  stdout="__main__ 3.14159\ndone\n" stderr="ünïcödé ✓ 雪花\n"
PASS  stdout and stderr arrive in program order  oeo
PASS  output is streamed as printed (time.sleep blocks the worker in between)  stdout events at 1896, 2196, 2496 ms, exit at 2797 ms
PASS  100 000 printed lines all arrive  (2812 ms total, Running at 1821 ms), 100000 stdout messages
PASS  an infinite loop is stopped by terminating the worker; its output arrived first  (3057 ms total, Running at 2057 ms) stopped=true
PASS  known limit: a prompt without newline followed by a busy loop stays buffered, as in CPython on a terminal  stdout=""
PASS  after Stop, the page is responsive and a new run works  (1973 ms total, Running at 1952 ms)
PASS  with stdin null, input() raises EOFError
PASS  no page errors  []
all checks passed
```
