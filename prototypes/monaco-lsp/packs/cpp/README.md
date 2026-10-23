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
`#include <stdio.h>`, `<vector>`, `<string>`, `<cmath>` resolve. The test
frameworks' headers are there too: GoogleTest **1.18.0** (`/usr/include/gtest`,
with libc++abi's `cxxabi.h`, which they include), Catch2 **3.16.1**
(`/usr/include/catch2`, with the `catch_user_config.hpp` of the wasm build)
and doctest **2.5.3** (`/usr/include/doctest/doctest.h`), so
`#include <gtest/gtest.h>`, `<catch2/catch_test_macros.hpp>` or
`<doctest/doctest.h>` in a test resolves in the editor (see "Running",
Tests).

## Files (served at `/packs/cpp/`)

| file | what | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `server.js` | the worker: transport, file mirroring, loader (esbuild-minified) | 5.4 KB | 2.7 KB | 2.4 KB |
| `clangd.js` | Emscripten glue, ES module | 76 KB | 20 KB | 18 KB |
| `clangd.wasm` | clangd 21.1.8, `-Oz` | 24.0 MB | 8.5 MB | 6.0 MB |
| `sysroot.tar.gz` | 2139 headers: musl, libc++, clang freestanding, GoogleTest, Catch2, doctest | 2.1 MB (gzip, unpacked in the worker) | | |

First load is about **8.1 MB** with brotli (10.7 MB with gzip); the test
frameworks' headers are 0.31 MB of it (GoogleTest 0.13 MB, Catch2's 183
headers 0.12 MB, doctest's one 0.06 MB; Catch2 and doctest grew the archive
from 1,938,546 to 2,119,426 bytes). The `LICENSE-*.txt` files are not fetched.

`server.js` downloads `clangd.wasm` and `sysroot.tar.gz` in parallel when
the worker starts, reporting each with `yukibana/loading`, compiles the wasm
while it streams, unpacks the headers into Emscripten's in-memory file
system and then answers `initialize`.

## Browser requirements

* **Cross-origin isolation is required.** clangd runs with threads, which
  are Web Workers sharing one `SharedArrayBuffer` memory, so the page must
  be `crossOriginIsolated` (COOP/COEP; the app sets it, through its service
  worker where the host cannot send the headers). Without it the worker
  answers `initialize` with an error saying so. Any browser with
  `SharedArrayBuffer` works; nothing else (no JSPI, no Asyncify) is needed.
* **Threads:** clangd's `main` runs on a thread of its own
  (`-sPROXY_TO_PTHREAD`), so the worker that runs `server.js` stays free to
  receive messages and serve the threads' file system calls. Four threads
  are started with the module (`-sPTHREAD_POOL_SIZE=4`) and more on demand;
  each file's AST and preamble are built on threads of their own, as in
  native clangd.

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
* Input: `server.js` frames each message and hands it to clangd with an
  exported C function, `clangd_input`, which copies it into a queue;
  clangd's transport reads stdin through `fopencookie` from that queue and
  waits on a condition variable when it is empty. Nothing spins and nothing
  needs to suspend the JavaScript stack.
* Build configuration: clangd looks for `compile_flags.txt`,
  `compile_commands.json` and `.clangd` on every parse (patch 2 and 3;
  upstream caches the answer for 5 s, or 30 s for a missing file). The app
  sends a project's `didOpen`s in one go, with `compile_flags.txt` after the
  sources, and `server.js` mirrors each into the file system as it
  arrives, before clangd's threads get to parse. Whatever the timing, when
  one of those files is opened, changed or closed after clangd has read a
  document, `server.js` sends clangd a `didSave`, which reparses every open
  file whose compile command changed. Before this fix the app's own sample
  was parsed as `gnu++17` with its `-std=c++20 -Wall -Wextra` ignored until
  an edit at least 30 s later.
* Stale results while a preamble builds: as in native clangd, an edit is
  answered at once from the preamble (the PCH of the leading `#include`s)
  clangd already has, patched for new includes, while the new one builds
  on another thread. Here a preamble of `<vector>`/`<concepts>` takes 4 to
  5 s rather than native clangd's fraction of a second, so for those
  seconds after an edit to the includes or to `compile_flags.txt` the
  diagnostics can be the old preamble's (even the old flags'); they are
  replaced when the new preamble is ready.
* Flags: without a `compile_flags.txt`, clangd's fallback command applies:
  clang 21's defaults (`gnu++17` for C++, `gnu17` for C, headers parsed as
  C++). A project can add a `compile_flags.txt` (for example `-std=c++20`)
  as an ordinary file.
* Command line: `--background-index=false --use-dirty-headers
  --pch-storage=memory --resource-dir=/usr/lib/clang/21 --log=error`.

## Patches (`patches/clangd-browser.patch`)

Three small changes, all under `__EMSCRIPTEN__`:

1. `ClangdMain.cpp`: stdin is a queue that `server.js` fills through the
   exported `clangd_input(const char *, size_t)`, read by the transport
   through `fopencookie` (above). Emscripten's own stdin would make every
   read a call to the main thread that cannot wait for a message.
2. `ClangdLSPServer.cpp`: the directory-based compilation database
   revalidates `compile_flags.txt` / `compile_commands.json` on every
   lookup (`RevalidateAfter` and `RevalidateMissingAfter` 0 instead of 5 s
   and 30 s). The file system is in memory, so a lookup is a few map reads.
3. `ClangdServer.cpp`: the same for `.clangd` (config `FreshTime` now
   instead of 5 s ago).

An earlier version had no threads and ran with `--sync`, which took six
more patches (configuring clangd without threads, the shutdown watchdog,
detached fallback threads, the compile-database broadcast, a missing
`llvm::set_thread_priority`) and JSPI to suspend clangd while it waited
for stdin, limiting it to Chrome 137+. With threads, upstream needs only
the three above.

## What works, what does not

`node test.mjs` (headless Chromium 1194, page cross-origin isolated), on the shared 4-core build machine. Session 1 is a project of
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
the files (each file's preamble, i.e. `<vector>`/`<string>`/`<cmath>`,
is built on a thread of its own); after that, requests
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

* **Stale diagnostics for a few seconds** after an edit to the includes or
  flags, while a preamble builds (above).
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
  goes from 7.5 MB to 1.4 MB). wasi-sdk's libc++ and libc++abi are built
  without exceptions, so they are **replaced** (next point).
* **C++ runtime with exceptions** (`build-cxx-runtime.sh`): libc++ and
  libc++abi 21.1.8, from the same LLVM tarball, built with
  `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false` (WebAssembly
  exception handling in its standard form, exnref/`try_table`) and otherwise
  configured as wasi-sdk configures them; the build checks that their
  `__config_site` is wasi-sdk's. libunwind is only its `Unwind-wasm.c`
  (the engine unwinds; this file is `_Unwind_RaiseException` as a wasm
  `throw` plus the personality glue): the rest of libunwind walks native
  stacks and does not build for wasm. libc++abi's terminate handler is not
  silent (wasi-sdk's is), so an uncaught exception names its type. The
  compiler for these is wasi-sdk 30's native clang 21.1.4
  (`wasi-sdk-30.0-x86_64-linux.tar.gz`, pinned by SHA-256, 119 MB, cached),
  the only compiler here that targets wasm32 and is not newer than the
  wasm-ld that links the result. They replace wasi-sdk's libraries in
  `wasi-sysroot.tar.gz`, which grew by only 41 KB (0.95 to 0.99 MB).
* **GoogleTest 1.18.0** (release tarball pinned by SHA-256), built by the
  same script with the same flags (exceptions, libc++ fast hardening),
  without pthreads, gMock or stream redirection (`CaptureStdout` and death
  tests need `dup`/`dup2`, which WASI does not have). `libgtest.a` and
  `libgtest_main.a` are `gtest.tar`; the headers are in `sysroot.tar.gz`.
* **Catch2 3.16.1 and doctest 2.5.3**, built by `build-test-frameworks.sh`
  with the same compiler and flags (C++17). Catch2 is a shallow clone of its
  `v3.16.1` tag checked against the tag's commit (`0809213`; GitHub's source
  archives are not reachable from this build machine and Catch2 publishes no
  source tarball), configured with `CATCH_CONFIG_NO_POSIX_SIGNALS` (WASI has
  no signals); `libCatch2.a` and `libCatch2Main.a` are `catch2.tar`. doctest
  is one header, pinned by SHA-256 at its `v2.5.3` commit; its
  implementation and `main` (`DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN`, without
  POSIX signals) are compiled once into `libdoctest_main.a`, which is
  `doctest.tar`, so a Test does not compile doctest's implementation every
  time. One line of the shipped `doctest.h` is changed: doctest turns its
  exception support off for any `__wasi__` target, from before WASI had
  exceptions (`CHECK_THROWS_AS` would not compile); the copy here keeps it
  on when clang announces WebAssembly exception handling
  (`__wasm_exception_handling__`). The headers are in `sysroot.tar.gz`.
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
for C++, `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false` (exceptions,
below; a `-fno-exceptions` in `compile_flags.txt` comes later and wins).
Diagnostics go to stderr exactly as clang prints them
(`main.cpp:4:25: error: ...`), and a failed compile or link exits with
clang's status (1). A plain Run leaves out everything under `tests/`.

**Exceptions**: `throw`, `try`/`catch`, and library code that throws
(`std::stoi`, `vector::at`, `std::optional::value`, ...) work as natively,
destructors running while the stack unwinds (tested). The browser must
support WebAssembly exception handling with exnref: Chrome/Edge 137,
Firefox 131, Safari 18.4 or later. An exception nobody catches leaves the
program as a JavaScript `WebAssembly.Exception` (wasm has no search phase
that would call `std::terminate` first); the runner hands it back to the
program, whose `yukibana-uncaught.o` (`src/uncaught.cpp`, linked into every
C++ program) rethrows it into a `catch (...)` that calls `std::terminate`.
So stderr reads, as on Linux,
`libc++abi: terminating due to uncaught exception of type std::logic_error: boom`,
and the exit status is 134 (tested). The cost is in the program, not the
download: the terminate handler brings libc++abi's demangler, about 280 KB
of wasm in every C++ program (the sample goes from about 100 KB to 380 KB),
which adds roughly 0.1 to 0.3 s to linking. Exceptions stay the default
anyway; nothing in the downloads needed `-fno-exceptions`.

**Tests** (`{ type: 'test' }`, the app's Test button): the project's tests
are files under `tests/` (the sample has `tests/geometry_test.cpp`) written
for **GoogleTest, doctest or Catch2 v3**. The framework is the one they
include (`<gtest/...>`, `<doctest/...>`, `<catch2/...>`, comments left out),
as a real build would need it; nothing else records it, and there is no
other setting. Tests that include two frameworks are refused before anything
is compiled: "The tests mix test frameworks: tests/geometry_test.cpp
includes <gtest/...> (GoogleTest), tests/other_test.cpp includes
<catch2/...> (Catch2). A test program links one of them; convert or remove
the others." (exit 1). Tests that include none and define no `main` are
refused too. The runner compiles every `.c`/`.cpp` of the project except
the entry file and any other file that defines `main`, plus everything
under `tests/`, and links the framework's libraries (`-lgtest`,
`-lCatch2`, nothing for doctest) and, unless a test file defines its own
`main`, the framework's main with `-u __main_argc_argv` (`-lgtest_main`,
`-lCatch2Main`, `-ldoctest_main`; wasi-libc refers to `main(argc, argv)`
only weakly, which would not pull it from the archive). For doctest, a test
that defines `DOCTEST_CONFIG_IMPLEMENT` or `DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN`
itself gets no prebuilt implementation (tested: it links once). The report
is the program's stdout in the framework's own terminal colours, which each
gives only to a terminal it recognises, so they are asked for: GoogleTest
with `GTEST_COLOR=yes` in the environment, doctest with `--force-colors`,
Catch2 with `--colour-mode ansi` on the command line (the app's terminal
renders ANSI colours). The exit status is 0 only when every test passed
(GoogleTest and doctest exit 1 otherwise, Catch2 42, as natively). Each
framework's archive is fetched the first time its tests are built (or a Run
compiles a file that includes it), never for a plain Run, and a project
fetches only its own framework's. Including `<gtest/gtest.h>` makes a test
file slow to compile: about 3.5 s for the sample's three tests, against
0.4 s for `geometry.cpp`; the same tests take about 2.1 s with doctest and
2.5 s with Catch2 (`catch_test_macros.hpp` and its floating-point matchers),
in the runs below on a shared machine.

The app's top bar has a **Test framework** choice next to Test for C++
projects (`app/src/lib/cpp-tests.ts`). It shows the framework `tests/`
includes ("Mixed frameworks" or "Test framework" when that is not one).
Choosing one rewrites every test file that is still a sample test as the app
wrote it (the sample's three geometry tests exist in all three frameworks)
for the chosen framework; tests someone wrote or changed are left as they
are, and a sample test file of the chosen framework is added instead
(`tests/geometry_test.cpp`'s tests while `geometry.h` is the sample's, else
a test of `std::string` that needs nothing of the project), with a warning
in the output panel when the tests now mix frameworks. The Download's
CMakeLists.txt fetches the same framework (`app/src/lib/export.ts`).
`#include "geometry.h"` from `tests/` resolves through `-I.` in the
sample's `compile_flags.txt`, for clang and clangd alike (clangd resolves it
against the directory of `compile_flags.txt`).

**Files** (served at `/packs/cpp/`, fetched only when Run is pressed):

| file | what | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `runner.js` | the worker, with `wasi.js` (esbuild-minified) | 11.2 KB | 5.2 KB | 4.8 KB |
| `cc.js` | Emscripten glue, ES module | 74 KB | 20 KB | 18 KB |
| `cc.wasm` | clang + wasm-ld 21.1.8, `-Oz` | 42.4 MB | 15.7 MB | 11.3 MB |
| `wasi-sysroot.tar.gz` | 234 files: wasi-libc headers, libs (libc++ with exceptions), crt1, builtins | 0.99 MB (gzip, unpacked in the worker) | | |
| `sysroot.tar.gz` | shared with `server.js` (see above) | 2.1 MB | | |
| `gtest.tar` | `libgtest.a`, `libgtest_main.a`; fetched only for GoogleTest tests | 563 KB | 152 KB | 110 KB |
| `catch2.tar` | `libCatch2.a`, `libCatch2Main.a`; fetched only for Catch2 tests | 1.63 MB | 424 KB | 279 KB |
| `doctest.tar` | `libdoctest_main.a` (implementation and main); fetched only for doctest tests | 297 KB | 87 KB | 64 KB |

The first Run downloads **14.4 MB** (with brotli for the files that have
`.br` siblings; the test below measures exactly this). That drops to
**12.3 MB** when the language server has already fetched
`sysroot.tar.gz`. The first Test adds the framework's archive: 110 KB for
GoogleTest, 64 KB for doctest, 279 KB for Catch2. Later runs download
nothing. Exceptions cost 41 KB of that (`wasi-sysroot.tar.gz`), the test
frameworks' headers 0.31 MB (`sysroot.tar.gz`).

**Test** (`node test-run.mjs`): headless Chromium 1194, app/static served
with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (the page is
`crossOriginIsolated`), `.br` siblings served, persistent profile so there
is a disk cache. The machine was shared with other builds.

```text
PASS  the page is crossOriginIsolated
PASS  sample project (cold): prints the distance and the norm, exits 0  "5.000000\n5.000000\n" code=0 in 7301 ms, 14.4 MB transferred; Loading the compiler@27, Compiling geometry.cpp (1/2)@779, Compiling main.cpp (2/2)@2323, Linking@6784, Running@7221
PASS  sample project (warm): same output from the browser cache  code=0 in 4101 ms, 0 bytes transferred; Loading the compiler@71, Compiling geometry.cpp (1/2)@659, Compiling main.cpp (2/2)@1134, Linking@3448, Running@4020
PASS  loading messages for each download  wasi-sysroot.tar.gz 987401/987401, sysroot.tar.gz 2119442/2119442, cc.wasm 42410950/42410950
PASS  C++ (cin): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 3440 ms
PASS  C (scanf): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 1492 ms
PASS  end of file on stdin (Ctrl-D) ends scanf  code=2 "first number: "
PASS  compile error: clang diagnostics on stderr, non-zero exit  code=1
PASS  4 MB of locals work; deep recursion ends in a stack-overflow message, exit 134  deepest completed: 4000 calls; "The program crashed: Maximum call stack size exceeded (stack overflow: the browser allows only a few thousand nested calls)"
PASS  long double prints: C++ (cout)  "0.333333\n" code=0 ""
PASS  long double prints: C (printf %Lf)  "0.333333\n" code=0 ""
PASS  vector index out of bounds: the program is stopped, exit 134, nothing after it runs  code=134 "The program crashed: unreachable (abort(), or a failed check: in C++, for example, an index out of range on a vector, string, array or span)"
PASS  C++ exceptions: thrown and caught (own type, std::stoi, vector::at), destructors run while unwinding  "caught custom\nstoi: invalid_argument\nat: out_of_range\ndestructor ran\nint 42\n" code=0 ""
PASS  uncaught C++ exception: terminate message with type and what(), exit 134  code=134 "libc++abi: terminating due to uncaught exception of type std::logic_error: boom"
PASS  sample's GoogleTest tests: all pass, exit 0, main.cpp left out  code=0 in 4873 ms, 110 kB transferred (gtest.tar [563200,563200]); Loading the compiler@28, Compiling geometry.cpp (1/2)@582, Compiling tests/geometry_test.cpp (2/2)@944, Linking@4524, Running the tests@4837
PASS  GoogleTest's report is in its terminal colours: green [ RUN ]/[ OK ]/[ PASSED ], nothing else escaped  "Running main() from googletest/src/gtest_main.cc\n\u001b[0;32m[==========] \u001b[mRunning 3 tests from 1 test suite.\n\u001b[0;32m[-----"
PASS  a failing test: reported on stdout with file and line, exit non-zero  code=1 in 8723 ms
PASS  a failing test is in red  "13 ms total)\n\u001b[0;32m[  PASSED  ] \u001b[m3 tests.\n\u001b[0;31m[  FAILED  ] \u001b[m2 tests, listed below:\n\u001b[0;31m[  FAILED  ] \u001b[mBroken.NormIsWrong\n\u001b[0;31m[  FAILED  ] \u001b[mBroken.ThrowsSomethingElse\n\n 2 FAILED TESTS\n"
PASS  doctest: the sample's tests pass, exit 0, only doctest.tar fetched  code=0 in 3477 ms (doctest.tar [296960,296960]; archives: doctest.tar); Loading the compiler@17, Compiling geometry.cpp (1/2)@664, Compiling tests/geometry_test.cpp (2/2)@1106, Linking@3238, Running the tests@3448
PASS  doctest: the report is in colour (--force-colors)  "\u001b[0;36m[doctest] \u001b[0mdoctest version is \"2.5.3\"\n\u001b[0;36m[doctest] \u001b[0mrun with \"--help\" for options\n\u001b[0m\u001b[0m\u001b[0m\u001b[0;33m=="
PASS  doctest: failing tests are reported with file and line, exit non-zero  code=1 in 5914 ms
PASS  catch2: the sample's tests pass, exit 0, only catch2.tar fetched  code=0 in 3743 ms (catch2.tar [1628160,1628160]; archives: catch2.tar); Loading the compiler@31, Compiling geometry.cpp (1/2)@666, Compiling tests/geometry_test.cpp (2/2)@1006, Linking@3466, Running the tests@3720
PASS  catch2: the report is in colour (--colour-mode ansi)  "Randomness seeded to: 773790583\n\u001b[1;31m\u001b[1;33m\u001b[0m\u001b[0m\u001b[1;32m==========================================================="
PASS  catch2: failing tests are reported with file and line, exit non-zero  code=42 in 5887 ms
PASS  doctest with DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN in a test: links once, passes  code=0 ""
PASS  tests that mix GoogleTest and Catch2: a message naming both files, exit 1, nothing compiled  "The tests mix test frameworks: tests/geometry_test.cpp includes <gtest/...> (GoogleTest), tests/other_test.cpp includes <catch2/...> (Catch2). A test program links one of them; convert or remove the others."
PASS  test mode without tests/: says so, exit 1  "No tests to run: put test files (GoogleTest, doctest or Catch2) in tests/, for example tests/geometry_test.cpp."
PASS  duplicate main: the link error names main.cpp and lib/other.cpp, non-zero exit  code=1 (wasm-ld: error: duplicate symbol: main / >>> defined in lib/other.cpp / >>> defined in main.cpp, and the same for __original_main and __main_void)
PASS  compiler cannot be instantiated: error on stderr and an exit message  code=1 "clang could not start: WebAssembly.Memory(): could not allocate memory" 673 ms
PASS  endless loop: terminated by the page, which stays responsive  stopped after 2249 ms; Loading the compiler@27, Compiling main.cpp (1/1)@511, Linking@936, Running@1236
all passed
```

On a local server the cold run takes about 6 s (7 s in the run above, on a
machine shared with other builds). On a real network, add the time to
download 12 MB. The warm run takes about 3 s, nearly all of it compiling:
`<vector>` + `<cstdio>` at `-O2` takes about 2 s for `main.cpp`. Linking
takes about 0.2 s warm (0.5 s cold).

What the sample's Test prints (the failing case adds `tests/broken_test.cpp`
with a wrong `EXPECT_DOUBLE_EQ` and an `EXPECT_THROW` of the wrong type; both
are reported with file and line, and the exit status is 1):

```text
Running main() from googletest/src/gtest_main.cc
[==========] Running 3 tests from 1 test suite.
[----------] Global test environment set-up.
[----------] 3 tests from Geometry
[ RUN      ] Geometry.NormOfThreeFourIsFive
[       OK ] Geometry.NormOfThreeFourIsFive (0 ms)
[ RUN      ] Geometry.DistanceIsSymmetric
[       OK ] Geometry.DistanceIsSymmetric (0 ms)
[ RUN      ] Geometry.DistanceToItselfIsZero
[       OK ] Geometry.DistanceToItselfIsZero (0 ms)
[----------] 3 tests from Geometry (2 ms total)

[----------] Global test environment tear-down
[==========] 3 tests from 1 test suite ran. (3 ms total)
[  PASSED  ] 3 tests.
```

The same failing tests in doctest and in Catch2 (`tests/broken_test.cpp`
beside the sample's tests converted by the framework choice), as their own
reports print them, colours removed; exit status 1 and 42:

```text
[doctest] doctest version is "2.5.3"
[doctest] run with "--help" for options
===============================================================================
tests/broken_test.cpp:7:
TEST CASE:  norm is wrong

tests/broken_test.cpp:9: ERROR: CHECK( p.norm() == doctest::Approx(6.0) ) is NOT correct!
  values: CHECK( 5 == Approx( 6 ) )

===============================================================================
tests/broken_test.cpp:12:
TEST CASE:  throws something else

tests/broken_test.cpp:13: ERROR: CHECK_THROWS_AS( throw std::runtime_error("x"), std::logic_error ) threw a DIFFERENT exception: "x"

===============================================================================
[doctest] test cases: 5 | 3 passed | 2 failed | 0 skipped
[doctest] assertions: 6 | 4 passed | 2 failed |
[doctest] Status: FAILURE!
```

```text
Randomness seeded to: 527262531

~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
main is a Catch2 v3.16.1 host application.
Run with -? for options

-------------------------------------------------------------------------------
throws something else
-------------------------------------------------------------------------------
tests/broken_test.cpp:13
...............................................................................

tests/broken_test.cpp:14: FAILED:
  REQUIRE_THROWS_AS( throw std::runtime_error("x"), std::logic_error )
due to unexpected exception with message:
  x

-------------------------------------------------------------------------------
norm is wrong
-------------------------------------------------------------------------------
tests/broken_test.cpp:8
...............................................................................

tests/broken_test.cpp:10: FAILED:
  REQUIRE_THAT( p.norm(), Catch::Matchers::WithinULP(6.0, 4) )
with expansion:
  5.0 is within 4 ULPs of 6.0000000000000000e+00 ([5.9999999999999964e+00, 6.
  0000000000000036e+00])

===============================================================================
test cases: 5 | 3 passed | 2 failed
assertions: 6 | 4 passed | 2 failed
```

**Standard input**: when the program reads and has no input buffered, the
runner flushes, posts `{ type: 'stdin' }` and blocks in `Atomics.wait`.
C's stdio (musl-based) does not flush stdout before reading stdin; C++'s
`cin` does, through `tie()`. So the runner links the program with
`--export-if-defined=fflush,stdout` and calls `fflush(stdout)` itself before
waiting, as glibc's behaviour would. This was verified: without it,
`printf("a? "); scanf(...)` shows nothing until after the input. Without a
SharedArrayBuffer (a page that is not isolated), stdin is at end of file.

**Limits** (what does not work, plainly):

* **Exceptions need a recent browser** (WebAssembly exception handling
  with exnref; see Exceptions above). In an older one every C++ program
  fails at `WebAssembly.compile`: the runner prints the browser's
  `CompileError` on stderr and exits 1. C programs are unaffected.
* **Tests are GoogleTest without gMock** (`<gmock/gmock.h>` is not
  shipped) and without what needs `dup`/`dup2` (death tests,
  `EXPECT_DEATH`, and `testing::internal::CaptureStdout`), **doctest**, or
  **Catch2 v3**, one framework per project: tests that include two are
  refused with a message naming a file of each. No signal handling in
  doctest or Catch2 (WASI has none): a crash in a test ends the whole run
  with the runner's crash message instead of a report naming the test.
  Test files live
  under `tests/`; a Run ignores that directory, a Test leaves out the
  program's `main`. Whether a file "defines main" is a textual check
  (`int main(` or `auto main(` outside comments, or doctest's
  `DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN`), and so is the framework (its
  `#include` lines): a framework included only through a header outside
  `tests/` is not seen.
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
checks, strip, the libraries with exceptions laid over wasi-sdk's, pack),
`gtest.tar`, `catch2.tar`, `doctest.tar`, `runner.js` (esbuild), and
`.gz`/`.br` siblings.
`build-cxx-runtime.sh` (called by `build.sh` before the sysroot step, and
again by `pack-runner.sh`, a no-op once cached in `$PACK_CACHE/cpp/eh`)
fetches wasi-sdk 30's toolchain and GoogleTest, extracts `libunwind/` from
the LLVM tarball, and builds libc++, libc++abi, `Unwind-wasm.c`,
`src/uncaught.cpp` and GoogleTest: about 1.5 minutes at `-j3` on this
machine, plus the 119 MB download the first time. `build-test-frameworks.sh`
(called the same way, cached in `$PACK_CACHE/cpp/testfw`) builds Catch2 and
doctest with that toolchain: about 1.5 minutes at `-j3`.
Time on this machine (4 cores shared with another agent's clangd build,
`-j3`, `nice`): **102 minutes** for the LLVM step, about 3 minutes for the
rest (mostly brotli on `cc.wasm`). The build tree `build-wasm-cc` is
449 MB.

## Prior art

* github.com/Guyutongxue/clangd-in-browser: clangd with Emscripten, pthreads
  (needs cross-origin isolation) and Asyncify for stdin; this pack also
  uses pthreads but reads stdin from a queue on clangd's own thread, so no
  Asyncify and a smaller binary.
* This project's browser-clang experiment (LLVM 21.1.8 clang/lld with
  Emscripten).
