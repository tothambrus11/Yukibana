# C/C++ pack: clangd in a Web Worker

**Server:** clangd from LLVM **21.1.8** (upstream:
<https://github.com/llvm/llvm-project>, release tarball pinned by SHA-256),
compiled to WebAssembly by `build.sh` with Emscripten **4.0.22**. It is the
real clangd, built from source here; nothing is a third-party prebuilt.

**Headers:** musl **1.2.5** (`/usr/include`), libc++ from the same LLVM
21.1.8 tree configured for musl (`/usr/include/c++/v1`), and clang's own
freestanding headers (`stddef.h`, `stdarg.h`, `stdint.h`, ... in
`/usr/lib/clang/21/include`). clangd parses as `x86_64-linux-musl` with
`-stdlib=libc++` (the build's default triple and C++ library), so
`#include <stdio.h>`, `<vector>`, `<string>`, `<cmath>` resolve.

## Files (served at `/packs/cpp/`)

| file | what | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `server.js` | the worker: transport, file mirroring, loader (esbuild-minified) | 5.4 KB | 2.7 KB | 2.4 KB |
| `clangd.js` | Emscripten glue, ES module | 76 KB | 20 KB | 18 KB |
| `clangd.wasm` | clangd 21.1.8, `-Oz` | 24.0 MB | 8.5 MB | 6.0 MB |
| `sysroot.tar.gz` | 1929 headers: musl, libc++, clang freestanding | 1.8 MB (gzip, unpacked in the worker) | | |

First load is about **7.8 MB** with brotli (10.4 MB with gzip). The
`LICENSE-*.txt` files are not fetched.

`server.js` downloads `clangd.wasm` and `sysroot.tar.gz` in parallel when
the worker starts, reporting each with `yukibana/loading`, compiles the wasm
while it streams, unpacks the headers into Emscripten's in-memory file
system and then answers `initialize`.

## Browser requirements

* **Not crossOriginIsolated:** clangd is built without threads and runs
  with `--sync`, so there is no `SharedArrayBuffer`. The test page is
  deliberately not isolated.
* **JSPI (WebAssembly JavaScript Promise Integration) is required**:
  Chrome/Edge 137 and later. clangd reads stdin in a blocking loop; in a
  worker the next message can only arrive as an event, so before each
  message clangd suspends (JSPI) until one is queued. A browser without
  JSPI gets a clear error from the worker (a failed `initialize`)
  instead of a hang. Asyncify would work in every browser but makes
  a binary of this size much larger and slower, so it was not used.

## How it works

* Transport: `server.js` turns each posted JSON-RPC object into a
  `Content-Length` framed message on clangd's stdin, and parses clangd's
  stdout back into one object per `postMessage`. stderr lines become
  `window/logMessage`.
* Files: every `didOpen` / `didChange` (full or incremental) / `didClose`
  is mirrored into `/workspace/...` in the module's file system as soon as
  it arrives, before clangd reads it, so `#include "point.h"` resolves from
  disk and a project's own `compile_flags.txt` or `.clangd` is read. clangd
  also runs with `--use-dirty-headers`, so an unsaved header edit is seen by
  the files that include it.
* Only C-family files are documents to clangd: the app opens every project
  file, but `didOpen`/`didChange`/`didClose` reach clangd only for the
  language ids `c`, `cpp`, `objective-c`, `objective-cpp`, `cuda-cpp` or a
  C-family extension (`.h`, `.hpp`, `.cc`, ...). Other files
  (`compile_flags.txt`, `README.md`) are only mirrored; before this, clangd
  compiled `compile_flags.txt` as a translation unit and put an error on it.
* Build configuration: clangd looks for `compile_flags.txt`,
  `compile_commands.json` and `.clangd` on every parse (patch 7 and 8;
  upstream caches the answer for 5 s, or 30 s for a missing file). The app
  sends a project's `didOpen`s in one go, with `compile_flags.txt` after the
  sources; `server.js` wakes clangd for queued input in a task of its own,
  so the messages already posted are mirrored first and the first parse of
  `main.cpp` already sees the flags. Whatever the timing, when one of those
  files is opened, changed or closed after clangd has read a document,
  `server.js` sends clangd a `didSave`, which reparses every open file
  whose compile command changed. Before this fix the app's own sample was
  parsed as `gnu++17` with its `-std=c++20 -Wall -Wextra` ignored until an
  edit at least 30 s later.
* Flags: without a `compile_flags.txt`, clangd's fallback command applies:
  clang 21's defaults (`gnu++17` for C++, `gnu17` for C, headers parsed as
  C++). A project can add a `compile_flags.txt` (for example `-std=c++20`)
  as an ordinary file.
* Command line: `--sync --background-index=false --use-dirty-headers
  --pch-storage=memory --resource-dir=/usr/lib/clang/21 --log=error`.

## Patches (`patches/clangd-browser.patch`)

Upstream clangd refuses to configure without threads
(`CLANG_ENABLE_CLANGD` depends on `LLVM_ENABLE_THREADS`). With `--sync` it
does not need them, except in a few places that spawn one anyway; the patch:

1. lets `CLANG_ENABLE_CLANGD` be on without threads;
2. `Shutdown.cpp`: no watchdog thread after `exit` (nothing to watch);
3. `Threading.cpp`: does not `detach()` the synchronous fallback
   `llvm::thread` (it would abort);
4. `GlobalCompilationDatabase.cpp`: the compile-database broadcast runs on
   the caller instead of a thread of its own;
5. `JSONTransport.cpp`: before reading a message whose first byte is not
   already buffered, `await Module.waitForStdin()` through `EM_ASYNC_JS`
   (JSPI). Same idea as clangd-in-browser's `wait_stdin.patch`;
6. `llvm/lib/Support/Threading.cpp`: defines `llvm::set_thread_priority`
   (a no-op that reports failure) for builds without threads. Upstream
   declares it everywhere but defines it only in the Unix/Windows parts,
   so clangd without threads failed to link (`undefined symbol:
   llvm::set_thread_priority`, from clangd's `BackgroundQueue.cpp`).
7. `ClangdLSPServer.cpp` (under `__EMSCRIPTEN__`): the directory-based
   compilation database revalidates `compile_flags.txt` /
   `compile_commands.json` on every lookup (`RevalidateAfter` and
   `RevalidateMissingAfter` 0 instead of 5 s and 30 s). The file system is
   in memory, so a lookup is a few map reads.
8. `ClangdServer.cpp` (under `__EMSCRIPTEN__`): the same for `.clangd`
   (config `FreshTime` now instead of 5 s ago).

## What works, what does not

`node test.mjs` (headless Chromium 1194, page **not** cross-origin
isolated), on the shared 4-core build machine. Session 1 is a project of
four files (`point.h`, `point.cpp`, `main.cpp`, `util.c`) served raw by a
plain http server; session 2 is the app's own C++ sample (copied from
`app/src/lib/languages.ts`, `compile_flags.txt` included and opened last,
as the app does), served as the `.br` siblings with `Content-Encoding`:

```text
-- session 1: four files, served raw
crossOriginIsolated: false
PASS  initialize answers with clangd capabilities  clangd clangd version 21.1.8 unix-tidy wasm32-unknown-emscripten; target=x86_64-linux-musl after 474 ms
PASS  yukibana/loading reports clangd.wasm and sysroot.tar.gz  18 progress notifications
PASS  main.cpp is clean (standard headers and point.h resolve)  [] 9528 ms
PASS  point.cpp is clean (standard headers and point.h resolve)  [] 3 ms
PASS  util.c is clean (standard headers and point.h resolve)  [] 215 ms
PASS  an introduced error is a diagnostic  ["9: No member named 'nosuch' in 'Point'"]
PASS  completion after "p." lists Point's members  ["norm","x","y"] 119 ms
PASS  hover on p.norm() shows its signature and doc comment  {"kind":"markdown","value":"### instance-method `norm` ... Distance from the origin. ..."} 108 ms
PASS  go to definition of square() lands in point.cpp  ["file:///workspace/point.cpp:6"]
PASS  go to definition of Point lands in point.h  ["file:///workspace/point.h:5"]
PASS  an incremental edit to point.h reaches main.cpp  []
PASS  references to square() span the files  ["main.cpp","point.cpp","point.h"]
PASS  rename of Point edits every file that uses it  ["main.cpp","point.cpp","point.h"]
PASS  signature help inside square(...)  square(double side) -> std::vector<Point>
PASS  document symbols of point.h  ["Point","x","y","z","norm","square"]
PASS  formatting (clang-format) returns edits  2 edits
PASS  semantic tokens  95 ints
PASS  session 1: shutdown answers  ""
[log 3] clangd loaded in 431 ms, 1929 headers
[log 3] clangd exited with status 0
PASS  session 1: the worker raised no errors  []
-- session 2: the app's sample project, served with Content-Encoding
crossOriginIsolated: false
PASS  initialize answers when the host sends .br/.gz with Content-Encoding  encodings: {"/packs/cpp/server.js":"br","/packs/cpp/clangd.js":"br","/packs/cpp/clangd.wasm":"br"}
PASS  progress counts decoded bytes and ends at its total  {"label":"clangd.wasm","loaded":24021294,"total":24021294}
PASS  compile_flags.txt opened last applies to main.cpp (C++20, -Wall)  ["15: Unused variable 'unused'"] 9371 ms, on the first parse
PASS  geometry.cpp is clean  []
PASS  an edit to compile_flags.txt reparses the open files  ["6: Unknown type name 'requires'","6: No member named 'integral' in namespace 'std'","6: Expected ';' after top level declarator (fix available)","15: Use of u 1698 ms
PASS  and the change back to C++20 too  ["15: Unused variable 'unused'"]
PASS  compile_flags.txt is not compiled as a source file  []
PASS  a code action fixes the missing semicolon with an edit  ["insert ';'"]
PASS  document highlight marks every use of points  4 ranges
PASS  a new header resolves  ["16: Unused variable 'unused'"]
PASS  a deleted header is not found  ["10: 'extra.h' file not found"]
PASS  a ranged edit after a surrogate pair lands where the client meant  ["15: Use of undeclared identifier 'kSmile'"] then ["15: Unused variable 'unused'"] (insert at 3:40)
PASS  session 2: shutdown answers  ""
[log 3] clangd loaded in 537 ms, 1929 headers
[log 1] E[13:57:30.564] IncludeCleaner: Failed to get an entry for resolved path '' from include "extra.h" : No such file or directory
[log 3] clangd exited with status 0
PASS  session 2: the worker raised no errors  []
all passed
```

The 7 to 12 s (it varies with the machine's load) is the first parse of
the files one after another (with `--sync` every file's preamble, i.e.
`<vector>`/`<string>`/`<cmath>`, is built in turn); after that, requests
answer in tens of milliseconds, and a change to `compile_flags.txt`, which
rebuilds every preamble, in about 2 s.

Tested above: diagnostics, completion, hover, definition across files,
references, rename across files, signature help, document symbols,
formatting (clang-format is built in), semantic tokens, unsaved header
edits, a project's `compile_flags.txt` (from the first parse, and edited
later), no diagnostics on non-C files, code actions with edits, document
highlight, a new and a deleted header (`didOpen`/`didClose` with
`didChangeWatchedFiles`), a ranged edit after a UTF-16 surrogate pair, and
loading from a host that sends `Content-Encoding: br`. clangd's other
features (tweaks, inlay hints, completion resolve) are in the same binary
and need nothing the tested ones do not, but the test does not exercise
them. The `IncludeCleaner: Failed to get an entry` line in session 2 is
clangd logging the include of the header the test just deleted.

Does not, or differently from native clangd:

* **One thread.** Requests run in order; a long parse delays the next
  request rather than running beside it. No request is cancelled while it
  runs.
* **No background index** (`--background-index=false`): references and
  workspace symbols cover the open files (the app opens every project file,
  so for this app's small projects that is the whole project).
* **No clang-tidy checks** (`CLANGD_TIDY_CHECKS=OFF`, to keep the binary
  small); clang's own warnings and errors are all there.
* No x86 intrinsics headers (`immintrin.h` and friends, 8 MB), no POSIX
  beyond musl's headers, no other targets (only `X86` is built). Nothing is
  compiled or run by the language server; running is the runner's job (see Running).

## Build

`./build.sh` (idempotent; caches in `~/.cache/yukibana-packs/cpp`, about
4 GB while building). It fetches LLVM and musl (release tarballs pinned by
SHA-256) and emsdk (the `4.0.22` tag, checked against its commit; the
toolchain and node archives `emsdk install` uses are fetched first and
checked against pinned SHA-256s, since emsdk checks none), applies the
patch (the source tree records the patch's SHA-256 and is re-extracted
when the patch changes), builds the native
table generators, then clangd for wasm (MinSizeRel, X86 target only, no
tests, tools, static analyzer or tidy checks, linked with `-Oz` so wasm-opt
runs at `-Oz`; cmake is re-run every time, so a changed flag is not
shadowed by an old cache), installs the libc++ headers configured for musl, packs the
sysroot, minifies `server.js` with esbuild and writes `.gz`/`.br` siblings.

Time on this machine (4 cores shared with other builds, `-j3`, `nice`):
native table generators about 12 minutes, clangd for wasm (2267 steps)
about 55 minutes, the rest a minute; plus downloads (LLVM source 152 MB,
emsdk about 1.7 GB unpacked) on a first run.

A change to the patch's clangd parts rebuilds in about 7 minutes (two
files and the link). `npm ci && node test.mjs` serves `app/static` over
http, starts the worker in headless Chromium (`/opt/pw-browsers/chromium`)
exactly as the app does, in the two sessions above, and checks everything
listed under "Tested above".

## Running

The pack also **compiles and runs** the project, in a second worker,
`runner.js` (protocol: `../CONTRACT.md`, "Running a program"). Everything
is real and runs in the browser: clang compiles every `.c`/`.cpp` file of
the project to WebAssembly, wasm-ld links them against wasi-libc and libc++,
and the program runs in the same worker on a small WASI host. Nothing is
interpreted or simulated, and no server is involved.

**What runs**

* **clang 21.1.8 and wasm-ld (lld 21.1.8)**, built by `build-runner.sh`
  from the same LLVM tarball as clangd (pinned by SHA-256), with Emscripten
  4.0.22. Only the WebAssembly target (`LLVM_TARGETS_TO_BUILD=WebAssembly`).
  It is one binary, `cc.wasm`: LLVM's multi-call driver
  (`LLVM_TOOL_LLVM_DRIVER_BUILD`, limited to `clang` and `lld` with
  `LLVM_DISTRIBUTION_COMPONENTS`), and `argv[0]` picks the tool. No threads.
  clang's driver runs cc1 in-process. The link is a separate call, because a
  browser cannot spawn the linker. Each call gets a fresh instance of the
  compiled module, since clang and lld keep global state.
* **Patch `patches/wasm-ld-only.patch`**: lld's tool links only its wasm
  flavour. The ELF, COFF, Mach-O and MinGW linkers would add megabytes
  that cannot be used here.
* **Sysroot: wasi-sdk 30** (`wasi-sysroot-30.0.tar.gz` and
  `libclang_rt-30.0.tar.gz`, pinned by SHA-256). This is wasi-libc
  `ec0effd769df` plus libc++/libc++abi 21.1.4 for `wasm32-wasip1`, and
  compiler-rt builtins. It is the newest wasi-sdk whose libc++ is LLVM 21.
  Only static libraries are shipped, with debug info stripped (libc++.a
  goes from 7.5 MB to 1.4 MB).
* **Headers shared with the language server**: libc++'s headers and clang's
  own headers come from `sysroot.tar.gz`, the file `server.js` already
  downloads, so the browser and service worker fetch it once.
  `pack-runner.sh` checks that wasi-sdk's libc++ headers are byte-identical
  to that copy except for `__config` (only the version number: 21.1.4 vs
  21.1.8), `__config_site` (WASI's replaces musl's) and `cxxabi.h`. The
  build fails if anything else differs.
* **The program** is `wasm32-wasip1`, run by `src/wasi.js` (about 200
  lines, written here): `fd_write` to stdout/stderr messages as they are
  written, `fd_read` on stdin through the SharedArrayBuffer protocol, args,
  clocks, `random_get`, `poll_oneoff` for sleeping, and `proc_exit`. Every
  other WASI import answers `ENOSYS`.
* **Execution target vs. editor target**: clangd parses as
  `x86_64-linux-musl`, but programs are compiled for `wasm32-wasip1`. Both
  use clang 21 and libc++ 21. The differences are that `long` and pointers
  are 4 bytes when running (8 in the editor), and that POSIX headers clangd
  accepts may be missing from wasi-libc at compile time. In that case the
  compiler's error appears on stderr.

**Compiling**: `compile_flags.txt` applies, one flag per line, as in clangd.
A `-std=` for the other language is dropped, so `-std=c++20` does not break
a `.c` file. The defaults are `-O2` (unless the project gives a `-O`) and,
for C++, `-fno-exceptions` (see below). Diagnostics go to stderr exactly as
clang prints them (`main.cpp:4:25: error: ...`), and a failed compile or
link exits with clang's status (1).

**Files** (served at `/packs/cpp/`, fetched only when Run is pressed):

| file | what | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `runner.js` | the worker, with `wasi.js` (esbuild-minified) | 8.0 KB | 3.9 KB | 3.6 KB |
| `cc.js` | Emscripten glue, ES module | 74 KB | 20 KB | 18 KB |
| `cc.wasm` | clang + wasm-ld 21.1.8, `-Oz` | 42.4 MB | 15.7 MB | 11.3 MB |
| `wasi-sysroot.tar.gz` | 232 files: wasi-libc headers, libs, crt1, builtins | 0.95 MB (gzip, unpacked in the worker) | | |
| `sysroot.tar.gz` | shared with `server.js` (see above) | 1.8 MB | | |

The first Run downloads **14.1 MB** (with brotli for the three files that
have `.br` siblings; the test below measures exactly this). That drops to
**12.3 MB** when the language server has already fetched
`sysroot.tar.gz`. Later runs download nothing.

**Test** (`node test-run.mjs`): headless Chromium 1194, app/static served
with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (the page is
`crossOriginIsolated`), `.br` siblings served, persistent profile so there
is a disk cache. The machine was shared with another build.

```text
PASS  the page is crossOriginIsolated
PASS  sample project (cold): prints the distance and the norm, exits 0  "5.000000\n5.000000\n" code=0 in 5981 ms, 14.1 MB transferred; Loading the compiler@12, Compiling geometry.cpp (1/2)@454, Compiling main.cpp (2/2)@1813, Linking@5720, Running@5924
PASS  sample project (warm): same output from the browser cache  code=0 in 2929 ms, 0 bytes transferred; Loading the compiler@12, Compiling geometry.cpp (1/2)@594, Compiling main.cpp (2/2)@945, Linking@2625, Running@2914
PASS  loading messages for each download  wasi-sysroot.tar.gz 946391/946391, sysroot.tar.gz 1810589/1810589, cc.wasm 42410950/42410950
PASS  C++ (cin): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 2799 ms
PASS  C (scanf): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 1008 ms
PASS  end of file on stdin (Ctrl-D) ends scanf  code=2 "first number: "
PASS  compile error: clang diagnostics on stderr, non-zero exit  code=1
PASS  4 MB of locals work; deep recursion ends in a stack-overflow message, exit 134  deepest completed: 4000 calls; "The program crashed: Maximum call stack size exceeded (stack overflow: the browser allows only a few thousand nested calls)"
PASS  long double prints: C++ (cout)  "0.333333\n" code=0 ""
PASS  long double prints: C (printf %Lf)  "0.333333\n" code=0 ""
PASS  vector index out of bounds: the program is stopped, exit 134, nothing after it runs  code=134 "The program crashed: unreachable (abort(), or a failed check: in C++, for example, an index out of range on a vector, string, array or span)"
PASS  duplicate main: the link error names main.cpp and lib/other.cpp, non-zero exit  code=1 (wasm-ld: error: duplicate symbol: main / >>> defined in lib/other.cpp / >>> defined in main.cpp)
PASS  compiler cannot be instantiated: error on stderr and an exit message  code=1 "clang could not start: WebAssembly.Memory(): could not allocate memory" 479 ms
PASS  endless loop: terminated by the page, which stays responsive  stopped after 1807 ms; Loading the compiler@26, Compiling main.cpp (1/1)@482, Linking@672, Running@799
all passed
```

On a local server the cold run takes about 5 s. On a real network, add the
time to download 12 MB. The warm run takes about 3 s, nearly all of it
compiling: `<vector>` + `<cstdio>` at `-O2` takes about 2 s for `main.cpp`.
Linking takes about 0.2 s.

**Standard input**: when the program reads and has no input buffered, the
runner flushes, posts `{ type: 'stdin' }` and blocks in `Atomics.wait`.
C's stdio (musl-based) does not flush stdout before reading stdin; C++'s
`cin` does, through `tie()`. So the runner links the program with
`--export-if-defined=fflush,stdout` and calls `fflush(stdout)` itself before
waiting, as glibc's behaviour would. This was verified: without it,
`printf("a? "); scanf(...)` shows nothing until after the input. Without a
SharedArrayBuffer (a page that is not isolated), stdin is at end of file.

**Limits** (what does not work, plainly):

* **No C++ exceptions.** wasi-sdk's libc++/libc++abi are built without them
  (there is no `__cxa_throw` to link), so C++ is compiled with
  `-fno-exceptions`, and `throw`/`try` are compile errors ("cannot use
  'throw' with exceptions disabled"). Library code that would throw (for
  example `std::stoi` on bad input, or `vector::at` out of range) aborts the
  program instead. Supporting exceptions would mean building libc++,
  libc++abi and libunwind with `-fwasm-exceptions`; that is not done.
* **Call depth**: V8 runs wasm on the worker's native stack (about 1 MB).
  The test's small recursive function completes 4,000 nested calls but not
  8,000, far fewer than a native process allows. Running out is reported as
  a crash with "stack overflow" and exit status 134. Locals live in an
  8 MiB linear-memory stack (`-z stack-size`, `--stack-first`, so an
  overflow traps instead of corrupting globals). wasm-ld's default would
  have been 64 KiB.
* **No files**: no preopened directories, so `fopen` fails. Project files
  are not visible to the program.
* **No threads** (`std::thread`, pthreads), **no network**, **no signals**,
  no `system()`/`fork`.
* Memory is wasm32's: at most 4 GB, in practice what the browser grants a
  worker.
* Crashes (a trap, `abort()`, an access outside the program's whole linear
  memory) are reported as "The program crashed: ..." on stderr, with exit
  status 134. There is no core dump or backtrace.
* **Most out-of-bounds accesses are not detected**, as in native C/C++
  without sanitizers: `a[50]` on an `int a[4]`, a pointer past a malloc'd
  block or past a global reads or overwrites neighbouring memory and the
  program goes on, often exiting 0. Only an access beyond the end of all
  memory traps. The exception is libc++: C++ is compiled with
  `-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST`, so
  `std::vector`, `std::string`, `std::array`, `std::span` `operator[]`,
  `front()`, `back()` and the like check their index and stop the program
  with exit 134 (tested). The stop is a trap, so stderr says "The program
  crashed: unreachable (abort(), or a failed check: ... an index out of
  range ...)", not libc++'s own message, which needs libc++'s experimental
  assertion semantics. A `compile_flags.txt` that sets
  `_LIBCPP_HARDENING_MODE` itself wins.
* Link errors name the sources: objects are compiled to
  `.yukibana/obj/<source>.o` and that prefix and suffix are taken out of
  wasm-ld's messages, so a second `main` reads "defined in main.cpp /
  defined in lib/other.cpp" (tested).
* `long double` is wasm32's 128-bit IEEE quad, done in software (slow but
  exact). Printing it needs wasi-libc's `libc-printscan-long-double.a`,
  which the link includes (without it `printf("%Lf")` and `cout << 1.0L`
  abort; tested).
* An endless program is stopped by the app terminating the worker. The
  runner does not depend on finishing (tested).

**Build**: `build.sh` calls `build-runner.sh`, which can also run alone
after `build.sh`'s clangd steps, because it reuses their LLVM source,
native table generators and emsdk. It extracts `lld/` from the cached
tarball and applies the patch. It configures `build-wasm-cc` (MinSizeRel,
`-Oz`, no tests/docs/static analyzer/plugins) and builds `llvm-driver`
(2526 steps). It then calls `pack-runner.sh`: the WASI sysroot (download,
checks, strip, pack), `runner.js` (esbuild), and `.gz`/`.br` siblings.
Time on this machine (4 cores shared with another agent's clangd build,
`-j3`, `nice`): **102 minutes** for the LLVM step, about 3 minutes for the
rest (mostly brotli on `cc.wasm`). The build tree `build-wasm-cc` is
449 MB.

## Prior art

* github.com/Guyutongxue/clangd-in-browser: clangd with Emscripten, pthreads
  (needs cross-origin isolation) and Asyncify for stdin; this pack differs
  by having no threads and using JSPI, so no isolation and a smaller binary.
* This project's browser-clang experiment (LLVM 21.1.8 clang/lld with
  Emscripten).
