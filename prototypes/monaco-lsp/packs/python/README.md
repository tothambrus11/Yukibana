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
| `typeshed-stdlib.tar.gz` | 4.9 MB tar | 803 KB | (is gzip) | typeshed stdlib stubs + docstrings, and pytest's and Hypothesis's stubs (below) |
| `LICENSE-*.txt` | 32 KB | | | basedpyright (MIT), typeshed (Apache-2.0), pytest (MIT), Hypothesis (MPL-2.0); the runner's are listed under Running |

A first load transfers about **1.24 MB** where the host serves `server.js.br`,
**1.36 MB** where it serves `.gz`, and 3.1 MB from a host that serves raw
files only (the stubs archive is gzip either way). pytest's stubs are 96 KB
of that (gzip), Hypothesis's 99 KB. For comparison, the npm
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
* **pytest is known, as if it were part of the standard library.** Test
  mode (see Testing, under Running) has pytest installed, so `import pytest`
  in `tests/test_*.py` must resolve. `build.sh` generates stubs of `pytest`
  and `_pytest` with mypy's `stubgen` 1.18.2 (`--include-docstrings`, so
  hover shows pytest's own documentation) from the same PyPI wheels the
  runner installs, and `scripts/make-stubs-tar.py` adds them under `stdlib/`
  with `pytest: 3.10-` and `_pytest: 3.10-` in typeshed's `VERSIONS`. As
  third-party stubs (typeshed's `stubs/`) every `import pytest` would carry
  a `reportMissingModuleSource` warning ("stub file found, source not
  found"), for a module the browser does run. 72 stub files, 377 KB raw,
  96 KB gzip in the archive. Consequence: pyright never reports
  `import pytest` as missing, also in a plain Run, where pytest is not
  installed (`import pytest` then fails at run time with
  `ModuleNotFoundError`).
* **Hypothesis is known the same way.** `build.sh` makes stubs of the
  `hypothesis` package from the wheel the runner installs
  (`scripts/hypothesis-wheels.txt`), with stubgen's `--no-import`:
  Hypothesis is annotated inline, so reading its sources gives its types
  (`st.integers()` is `SearchStrategy[int]`, `st.builds(Point, ...)`
  `SearchStrategy[Point]`) and docstrings, and its compiled part,
  `hypothesis._native` (built for Pyodide, not for the build machine), has
  nothing typed to add. Left out: `hypothesis/extra/`, its integrations with
  numpy, pandas, Django, lark, pytz, dateutil, redis, black and click, none
  of which a project here can import. 82 stub files, 99 KB gzip in the
  archive, which every Python session downloads (the archive is one file;
  the runtime half is lazy, see Property-based testing).
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

## Test output (2026-10-23, Chromium 141 headless; the Hypothesis checks 2026-10-24)

```text
PASS  initialize answers after the stubs download, with progress notifications  (262 ms, 8 progress messages, last {"label":"typeshed-stdlib.tar.gz","loaded":703881,"total":703881}, server basedpyright 1.40.2)
PASS  an import of a file the project does not have is reported, as a warning because pyproject.toml says so  (716 ms) ["Import \"helpers\" could not be resolved","Type of \"double\" is unknown","Argument type is unknown\n  Argument corresponds to parameter \"x\" in function \"sqrt\""]
PASS  adding that file resolves the import, and the project has no errors  []
PASS  assigning a str to an int is an error on that line  "Type \"Literal['five']\" is not assignable to declared type \"int\"\n  \"Literal['five']\" is not assignable to \"int\""
PASS  completion after `p.` offers the members of Point from models.py  ["__doc__","__module__","__init__","norm","x","y","__dict__","__annotations__","__class__","__new__","__setattr__","__delattr__"]
PASS  hover on `norm` shows its signature and docstring  "```python\n(method) def norm() -> float\n```\n---\nDistance from the origin."
PASS  hover on `math.sqrt` shows the stdlib stub and its documentation  "```python\n(function) def sqrt(\n    x: _SupportsFloatOrIndex,\n    /\n) -> float\n```\n---\nReturn the square root of x."
PASS  go to definition of `Point` lands in models.py on its class line  [{"uri":"file:///workspace/models.py","range":{"start":{"line":0,"character":6},"end":{"line":0,"character":11}}}]
PASS  deleting that file makes its import unresolved again  ["Import \"helpers\" could not be resolved","Type of \"double\" is unknown","Argument type is unknown\n  Argument corresponds to parameter \"x\" in function \"sqrt\"","Type \"Literal['five']\" is not assignable to declared type \"int\"\n  \"Literal['five']\" is not assignable to \"int\""]
PASS  a non-Python project file is not analysed as Python
PASS  a pytest test file in tests/ has no diagnostics at all: pytest and the project module both resolve  []
PASS  hover on `pytest.approx` shows its signature and pytest's docstring  "```python\n(function) def approx(\n    expected: Unknown,\n    rel: Unknown | None = None,\n    abs: Unknown | None = None,\n    nan_ok: bool = False\n) -> ApproxBase"
PASS  `with pytest.raises(E) as info` types `info` as ExceptionInfo[E]  "```python\n(variable) info: ExceptionInfo[ZeroDivisionError]\n```"
PASS  a Hypothesis test file has no diagnostics: hypothesis and hypothesis.strategies resolve  []
PASS  hover on `st.integers` shows its signature and Hypothesis's docstring  "```python\n(function) def integers(\n    min_value: int | None = None,\n    max_value: int | None = None\n) -> SearchStrategy[int]\n```\n---\nReturns a strategy which generates integers.\n\nIf min\\_value is no"
PASS  `st.integers()` is typed SearchStrategy[int]  "```python\n(variable) nums: SearchStrategy[int]\n```"
PASS  `st.builds(Point, ...)` is typed SearchStrategy[Point]  "```python\n(variable) points: SearchStrategy[Point]\n```"
PASS  completion after `st.` offers the strategies  ["__name__","__loader__","__package__","__spec__","__path__","__file__","__cached__","__annotations__","__dict__","__builtins__","__doc__","SearchStrategy"]
PASS  shutdown answers
PASS  the worker reported no errors  []
all checks passed
```python\n(method) def norm() -> float\n```\n---\nDistance from the origin."
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
| `runner.js` | 15.6 KB | 5.8 KB | 5.1 KB | the worker (hand-written, not minified) |
| `pyodide.mjs` | 17.9 KB | 7.2 KB | 6.4 KB | Pyodide's loader |
| `pyodide.asm.mjs` | 1.25 MB | 261 KB | 207 KB | the Emscripten JS glue |
| `pyodide.asm.wasm` | 9.60 MB | 3.59 MB | 2.74 MB | CPython 3.14.2 |
| `python_stdlib.zip` | 9.67 MB | 2.21 MB | 1.59 MB | the standard library, re-stored (see below) |
| lock file | not shipped | | | upstream's is 119 KB |
| `LICENSE-pyodide.txt`, `LICENSE-cpython.txt` | 17 KB, 14 KB | | | Pyodide (MPL-2.0); CPython 3.14.2 (PSF licence), both pinned by sha256 |
| **total** (one Run, licences excluded) | **20.5 MB** | **6.08 MB** | **4.55 MB** | |
| `pytest-9.0.2.zip` | 2.18 MB | 541 KB | 413 KB | pytest and its dependencies, fetched by Test only (see Testing) |
| **total** (one Test) | **22.7 MB** | **6.62 MB** | **4.96 MB** | |
| `hypothesis-6.170.9.zip` | 2.17 MB | 580 KB | 442 KB | Hypothesis and sortedcontainers, fetched only for a project that imports hypothesis (see Property-based testing) |

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

## Testing

`{ type: 'test' }` (the app's **Test** button) runs the project's tests with
**pytest 9.0.2**, the real one, as `python -m pytest` would in the project
directory:

* **What is downloaded.** `pytest-9.0.2.zip`, fetched only in test mode
  (while Pyodide loads, reported as a `loading` message) and unpacked with
  `pyodide.unpackArchive` into site-packages. It is built by
  `build-runner.sh` from five PyPI wheels pinned by sha256 in
  `scripts/pytest-wheels.txt` (pytest 9.0.2, pluggy 1.6.0, iniconfig 2.3.0,
  packaging 26.1, pygments 2.21.0; exceptiongroup, tomli and colorama are
  dependencies only before Python 3.11 or on Windows) and cached in
  `$PACK_CACHE/python/wheels`. `scripts/make-pytest-zip.py` merges them,
  byte-for-byte, into one stored (uncompressed) zip so brotli compresses
  across files, minus each `RECORD` and minus most of pygments: pytest
  imports pygments at module level but uses only the Python and diff lexers
  and the terminal formatter; the other ~580 lexers, formatters and styles
  are 90 % of pygments. The zip is reproducible (same wheels, same bytes).
  Licences travel inside it (each wheel's `dist-info/licenses`).
* **What runs.** The project is written to `/workspace` as for Run, the
  cwd is put on `sys.path` (what `-m` does), and `pytest.main(["-p",
  "no:cacheprovider"])` runs with no path arguments, so pytest's own
  discovery applies: `testpaths` from `pyproject.toml`/`pytest.ini` when set,
  else every `test_*.py`/`*_test.py` under the project, `tests/` included.
  `tests/test_geometry.py` can `from geometry import Point` with no
  `conftest.py` and no `tests/__init__.py`. Fixtures, `conftest.py`,
  parametrize, `pytest.raises`, `approx`, `capsys`, assertion rewriting
  (the `assert 5.0 == 6` + `where` explanation) all work, and so do
  `unittest.TestCase` classes in those files (pytest collects them; plain
  `python -m unittest discover` would need `tests/__init__.py`, see below).
* **The report** is pytest's own terminal report, on stdout, in its
  terminal colours (`--color=yes`, with the failing source highlighted by
  pygments), which the app's terminal renders. stdout is not a tty in test
  mode, so pytest does not redraw its "collecting ..." line with carriage
  returns. The interpreter's own tracebacks (Run, and a crash outside
  pytest) stay uncoloured (`PYTHON_COLORS=0`, `NO_COLOR`).
* **Exit status** is pytest's: 0 only when every collected test passed;
  1 when a test failed, 2 for a collection error (a syntax or import error
  in a test file), 5 when there were no tests at all.
* **Cost.** The interpreter's start-up as for Run, plus ~0.4 MB (brotli)
  the first time; unpacking and importing pytest add about 1-1.5 s, so the
  sample's six tests report after about 3.4-4 s in the test below (warm
  cache, 4-core container under load).
* **Options** come only from the project's configuration (the app passes
  no arguments): `[tool.pytest.ini_options]` in `pyproject.toml` or a
  `pytest.ini`, e.g. `addopts = "-v --doctest-modules"` for verbose output
  and doctests.
* **Not available:** plugins beyond pytest's built-in ones (no
  pytest-xdist, -cov, -asyncio...: nothing can be installed), `--pdb`
  (no interactive stdin in pytest's capture), anything needing threads or
  subprocesses (see Limits). `python -m unittest discover` itself is not
  what Test runs: with pytest's collection, `tests/__init__.py` is not
  needed, and it would be with unittest's (its discovery imports
  `tests.test_x` as a package module).

## Property-based testing

**Hypothesis 6.170.9** (MPL-2.0), the real one, for a project that imports
it, in Test (with pytest, whose Hypothesis plugin it registers) and in Run
alike: `@given(st.integers(), st.lists(st.floats()))`, `st.builds`,
`@composite`, `assume`, `@example`, `settings`, stateful tests. The sample's
`test_distance_is_symmetric` is a property over two `st.builds(Point, ...)`.

* **What is downloaded.** `hypothesis-6.170.9.zip`, made by
  `build-runner.sh` like the pytest bundle from two PyPI wheels pinned by
  sha256 in `scripts/hypothesis-wheels.txt`: Hypothesis's own wheel for
  Pyodide's platform, `cp314-cp314-pyemscripten_2026_0_wasm32` (PEP 783;
  Pyodide 314's `abi_version` is `2026_0`), and sortedcontainers 2.4.0
  (Apache-2.0), its one dependency. Hypothesis has a compiled part,
  `hypothesis._native` (Rust through PyO3, imported unconditionally), and
  upstream builds it for Pyodide itself: nothing is rebuilt or patched here,
  and Pyodide loads the 126 KB extension module from site-packages when
  `hypothesis` imports it. Licences travel inside the zip (each wheel's
  `dist-info`, with Hypothesis's SBOM of the Rust crates in its native part)
  and as `LICENSE-hypothesis.txt`.
* **When.** The runner fetches the zip, while Pyodide loads, only when a
  `.py` file of the project imports hypothesis at the start of a line
  (`import hypothesis`, `from hypothesis import given`, `from
  hypothesis.strategies import ...`; `IMPORTS_HYPOTHESIS` in `runner.js`). A
  project that does not pays nothing. An import the pattern cannot see
  (`importlib.import_module("hypothesis")`, or one in a string passed to
  `exec`) fails with `ModuleNotFoundError`, as for any package that is not
  installed.
* **Report.** pytest's, with Hypothesis's additions: `plugins:
  hypothesis-6.170.9` in the header, and for a failing property the
  shrunk counterexample under the assertion, as `Failing test case:
  test_norm_is_positive(x=0, y=0)` (the test below). Hypothesis's example
  database is written to `/workspace/.hypothesis/` and vanishes with the
  worker, so a failure is not replayed first on the next Test; the shrunk
  example is found again by the search.
* **Cost.** 442 KB (brotli) the first time; importing Hypothesis adds about
  1.5-2 s to a Test (the sample: 5.6 s without, 7.8 s with, in the test
  below under load). Its default `deadline` of 200 ms per example applies:
  WebAssembly CPython is slower than a native one, so a heavy property may
  need `@settings(deadline=None)`, as on a slow CI machine.
* **Download** adds `hypothesis>=6.170` to the dev dependencies in
  `pyproject.toml` and to the README's `pip install` when the project
  imports it.

## Mutation testing: not available

No mutation testing tool for Python can run in this runtime without being
rewritten, and none is faked:

* **mutmut 3.8** forks a process per mutant (`set_start_method("fork")`,
  `run_in_fork_with_result`, a `multiprocessing.Pool`), runs `git` through
  `subprocess`, and needs libcst (a Rust parser) and setproctitle (C), for
  which PyPI has no Pyodide wheel. In this runtime `os.fork()` raises
  `OSError: [Errno 52] Function not implemented`,
  `multiprocessing.Pool(1)` raises `ModuleNotFoundError: No module named
  '_multiprocessing'`, and `subprocess.run` raises `OSError: [Errno 138]
  emscripten does not support processes.` (checked with this pack's
  Pyodide, 2026-10-24).
* **Cosmic Ray 8.7** runs each mutant in a worker started with
  `subprocess` (or over HTTP with aiohttp): the same wall.
* **MutPy** runs in-process, but supports Python 3.3-3.7 and is
  last released in 2019; its operators build `ast.Num`/`ast.Str` nodes, which
  Python 3.14 has removed.

A tool that mutated the AST and re-ran pytest in the same interpreter would
be a new tool, not one of these.

## Optimization: not offered

CPython's `-O` (and `-OO`) does not make code faster: it removes `assert`
statements and `if __debug__:` blocks (and `-OO` docstrings), which would
silently turn off the assertions students' tests and programs rely on.
Pyodide has no JIT. The app's Optimization select is not shown for Python.

## Limits

* **`crossOriginIsolated` is needed for stdin.** Without it the app passes
  `stdin: null` and every read is end of file (`input()` raises `EOFError`).
  Everything else works without isolation.
* **Standard library only**, plus pytest in Test and Hypothesis for a
  project that imports it. No numpy etc.: not shipped, and the runner
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
./build-runner.sh   # ~50 s on an idle machine, ~2.5 min under load: almost all of it
                    # brotli quality 11 over the two ~10 MB files
node test-run.mjs   # Chromium, app/static over http with COOP/COEP
```

Caches `$PACK_CACHE/python/pyodide-314.0.7.tgz` (6.5 MB, sha512-pinned),
the two licence texts and the five pytest wheels (1.7 MB, all sha256-pinned),
so a build with a warm cache makes no network request. `build.sh` also caches
pytest's stubs (`pytest-stubs-mypy1.18.2-<hash of the wheel list>`, made with
a fixed `PYTHONHASHSEED`, since stubgen's member order otherwise varies, so
the stubs archive stays byte-for-byte reproducible).

Licences: the npm tarball carries none, so the build ships Pyodide's
`LICENSE` (MPL-2.0) and CPython 3.14.2's `LICENSE` (PSF), fetched from the
upstream tags and checked against pinned hashes. Not shipped: the notices of
the C libraries CPython links in (zlib, bzip2, libffi, expat, mpdecimal,
HACL\*, ...), which CPython lists in `Doc/license.rst`, not in `LICENSE`.

## Test output (2026-10-23, Chromium headless, load average ~4-5 on 4 cores; the Hypothesis checks 2026-10-24)

"cold" is a fresh browser profile (all 20.5 MB downloaded raw from a local
server, wasm compiled); "warm" is a new worker on the same page with every
file from the HTTP cache (0 bytes served), which is what pressing Run again
costs.

```text
PASS  the page is cross-origin isolated
PASS  cold: the sample project prints the distance and the norm, exit 0  (2412 ms total, Running at 2397 ms) stdout="Point(x=0, y=0) to Point(x=3, y=4): 5.0\n0.0\n" stderr="" code=0
      cold downloads: 20.54 MB raw over http; progress: {"pyodide.asm.wasm":{"loaded":9598218,"total":9598218},"python_stdlib.zip":{"loaded":9665005,"total":9665005}}; phases: Loading Python@20ms, Running@2397ms
PASS  warm: the same run in a new worker, files from the HTTP cache  (2079 ms total, Running at 2064 ms) served 0 bytes
PASS  warm runs reach Running faster than the cold run  cold 2397 ms, warm 2064/2003/2040 ms (median 2040)
PASS  input() reads two lines through the SharedArrayBuffer and prints their sum  (1982 ms total, Running at 1928 ms) stdout="First number: Second number: 2 + 40 = 42\n" code=0
PASS  the prompt without a newline arrives before the runner asks for input  before first stdin: "First number: "
PASS  sys.stdin.readline() after print(end="") shows the prompt first; read() runs to Ctrl-D  (2043 ms total, Running at 1971 ms) before stdin "name? ", stdout="name? hello, Ada\nrest: 'more\\n'\n" stderr=""
PASS  Ctrl-D at input() raises EOFError: traceback on stderr, exit 1  stderr="Traceback (most recent call last):\n  File \"/workspace/main.py\", line 1, in <module>\n    x = input(\"? \")\nEOFError: EOF when reading a line\n"
PASS  a syntax error in an imported module is reported on stderr with its file and line, exit 1  (1878 ms total, Running at 1863 ms) stderr="Traceback (most recent call last):\n  File \"/workspace/main.py\", line 1, in <module>\n    from helper import f\n  File \"/workspace/helper.py\", line 1\n    def f(x)\n            ^\nSyntaxError: expected ':'\n"
PASS  the traceback starts at the project, not in the runner or runpy
PASS  a syntax error in the entry itself: stderr, exit 1, nothing runs  stderr="  File \"/workspace/main.py\", line 1\n    print(\"never\"\n         ^\nSyntaxError: '(' was never closed\n"
PASS  an uncaught exception: output so far, then a traceback through both files, exit 1  stderr="Traceback (most recent call last):\n  File \"/workspace/main.py\", line 3, in <module>\n    geometry.boom()\n    ~~~~~~~~~~~~~^^\n  File \"/workspace/geometry.py\", line 2, in boom\n    return 1 / 0\n           ~~^~~\nZeroDivisionError: division by zero\n"
PASS  sys.exit(3) exits with 3  code=3
PASS  SystemExit with a message prints it to stderr and exits 1  stderr="fatal: no input\n"
PASS  exit statuses wrap to 0-255 as the shell sees them: sys.exit(256) is 0, sys.exit(-1) is 255  codes=0,255
PASS  os._exit(7) exits with 7, no runner stack trace on stderr  code=7 stdout="x\n" stderr=""
PASS  a package in a subdirectory imports; __name__ is __main__; UTF-8 survives  stdout="__main__ 3.14159\ndone\n" stderr="ünïcödé ✓ 雪花\n"
PASS  stdout and stderr arrive in program order  oeo
PASS  output is streamed as printed (time.sleep blocks the worker in between)  stdout events at 1768, 2068, 2368 ms, exit at 2669 ms
PASS  100 000 printed lines all arrive  (2945 ms total, Running at 2064 ms), 100000 stdout messages
PASS  an infinite loop is stopped by terminating the worker; its output arrived first  (2952 ms total, Running at 1951 ms) stopped=true
PASS  known limit: a prompt without newline followed by a busy loop stays buffered, as in CPython on a terminal  stdout=""
PASS  after Stop, the page is responsive and a new run works  (2244 ms total, Running at 2234 ms)
PASS  with stdin null, input() raises EOFError
PASS  test: the sample tests pass under pytest, exit 0, the report on stdout (no carriage-return redraws)  (3396 ms total, Running at - ms) phases: Loading Python@21ms, Loading Python and pytest@25ms, Testing@2017ms; loading: {"loaded":2184628,"total":2184628}
      | ============================= test session starts ==============================
      | platform emscripten -- Python 3.14.2, pytest-9.0.2, pluggy-1.6.0
      | rootdir: /workspace
      | collected 6 items
      | 
      | tests/test_geometry.py ......                                            [100%]
      | 
      | ============================== 6 passed in 0.03s ===============================
PASS  test: pytest is fetched only in test mode
PASS  test: a failing assertion exits 1 and the report shows the test, the values and the line  (3473 ms total, Running at - ms)
      | ============================= test session starts ==============================
      | platform emscripten -- Python 3.14.2, pytest-9.0.2, pluggy-1.6.0
      | rootdir: /workspace
      | collected 6 items
      | 
      | tests/test_geometry.py F.....                                            [100%]
      | 
      | =================================== FAILURES ===================================
      | ____________________________ test_norm_of_3_4_is_5 _____________________________
      | 
      |     def test_norm_of_3_4_is_5() -> None:
      | >       assert Point(3, 4).norm() == 6
      | E       assert 5.0 == 6
      | E        +  where 5.0 = norm()
      | E        +    where norm = Point(x=3, y=4).norm
      | E        +      where Point(x=3, y=4) = Point(3, 4)
      | 
      | tests/test_geometry.py:10: AssertionError
      | =========================== short test summary info ============================
      | FAILED tests/test_geometry.py::test_norm_of_3_4_is_5 - assert 5.0 == 6
      | ========================= 1 failed, 5 passed in 0.05s ==========================
PASS  test: a collection error (an import that fails) exits non-zero and names the file and the error  code=2 "ERRORS ====================================\n___________________ ERROR collecting tests/test_geometry.py ____________________\nImportError while importing test module '/workspace/tests/test_geometry.py'..."
PASS  test: unittest.TestCase classes are collected too (no tests/__init__.py needed); a failure exits 1  "short test summary info ============================\nFAILED tests/test_unit.py::PointTest::test_wrong - AssertionError: 1.41421356...\n========================= 1 failed, 1 passed in 0.04s ============..."
PASS  test: a project without tests exits 5 ("no tests ran"), not 0  code=5
PASS  test: output is captured per test (capsys works) and shown for a failing test  "Captured stdout call -----------------------------\ncaptured line\n=========================== short test summary info ===..."
PASS  test: Hypothesis runs under pytest: a passing property passes, a failing one fails with its shrunk counterexample  (7802 ms total, Running at - ms) phases: Loading Python@48ms, Loading Python and pytest and Hypothesis@53ms, Testing@3377ms; loading: {"loaded":2167507,"total":2167507}
      | ============================= test session starts ==============================
      | platform emscripten -- Python 3.14.2, pytest-9.0.2, pluggy-1.6.0
      | rootdir: /workspace
      | plugins: hypothesis-6.170.9
      | collected 8 items
      | 
      | tests/test_geometry.py ......                                            [ 75%]
      | tests/test_properties.py .F                                              [100%]
      | 
      | =================================== FAILURES ===================================
      | ____________________________ test_norm_is_positive _____________________________
      | 
      |     @given(st.integers(), st.integers())
      | >   def test_norm_is_positive(x: int, y: int) -> None:
      |                    ^^^
      | 
      | tests/test_properties.py:18: 
      | _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ 
      | 
      | x = 0, y = 0
      | 
      |     @given(st.integers(), st.integers())
      |     def test_norm_is_positive(x: int, y: int) -> None:
      | >       assert Point(x, y).norm() > 0
      | E       assert 0.0 > 0
      | E        +  where 0.0 = norm()
      | E        +    where norm = Point(x=0, y=0).norm
      | E        +      where Point(x=0, y=0) = Point(0, 0)
      | E       Failing test case: test_norm_is_positive(
      | E           x=0,
      | E           y=0,
      | E       )
      | 
      | tests/test_properties.py:19: AssertionError
      | =========================== short test summary info ============================
      | FAILED tests/test_properties.py::test_norm_is_positive - assert 0.0 > 0
      | ========================= 1 failed, 7 passed in 2.10s ==========================
PASS  test: Hypothesis is fetched only for a project that imports it
PASS  run: a program can use Hypothesis too (no pytest needed)  (4980 ms total, Running at 3013 ms) stdout="ok\n" stderr=""
PASS  no page errors  []
all checks passed
```
