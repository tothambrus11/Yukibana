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
and doctest **2.5.3** (`/usr/include/doctest/doctest.h`), and RapidCheck
(commit `2c3c436`, `/usr/include/rapidcheck.h`, `/usr/include/rapidcheck/`
with its GoogleTest and Catch2 integrations), so
`#include <gtest/gtest.h>`, `<catch2/catch_test_macros.hpp>`,
`<doctest/doctest.h>` or `<rapidcheck/gtest.h>` in a test resolves in the
editor (see "Running", Tests and Properties).

## Files (served at `/packs/cpp/`)

| file | what | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `server.js` | the worker: transport, file mirroring, loader, a Linux target's `bits/` headers on demand (esbuild-bundled and minified, with `targets.js`) | 6.6 KB | 3.1 KB | 2.8 KB |
| `clangd.js` | Emscripten glue, ES module | 76 KB | 20 KB | 18 KB |
| `clangd.wasm` | clangd 21.1.8, `-Oz` | 24.0 MB | 8.5 MB | 6.0 MB |
| `sysroot.tar.gz` | 2264 headers: musl, libc++, clang freestanding, GoogleTest, Catch2, doctest, RapidCheck | 2.18 MB (gzip, unpacked in the worker) | | |

First load is about **8.2 MB** with brotli (10.8 MB with gzip); the test
frameworks' headers are 0.37 MB of it (GoogleTest 0.13 MB, Catch2's 183
headers 0.12 MB, doctest's one 0.06 MB; Catch2 and doctest grew the archive
from 1,938,546 to 2,119,426 bytes; RapidCheck's 135 headers, 275 KB
unpacked, grew it to 2,177,109, +58 KB). The `LICENSE-*.txt` files are not
fetched.

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
  beyond musl's headers. Only `X86` is built, which parsing does not need:
  a project on a Linux target (see Targets) parses for that target. Nothing is
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
* **RapidCheck** (property-based testing; upstream
  <https://github.com/emil-e/rapidcheck>), built by the same script with the
  same compiler and flags, by its own unpatched CMake build (C++11, RTTI).
  RapidCheck has no releases or tags, so it is pinned by a commit of its
  master branch, `2c3c4365aca2` (2026-10-05), fetched alone and checked
  against that commit and against the SHA-256 of its tree (every file's
  SHA-256, sorted by path), without its submodules (they serve only its own
  tests). `librapidcheck.a` is `rapidcheck.tar`; the headers, with its
  GoogleTest and Catch2 integrations (`rapidcheck/gtest.h`,
  `rapidcheck/catch.h`), are in `sysroot.tar.gz`. See Properties below.
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
| `runner.js` | the worker, with `wasi.js` and `toolchain.js` (esbuild-minified) | 14.0 KB | 6.3 KB | 5.8 KB |
| `cc.js` | Emscripten glue, ES module | 74 KB | 20 KB | 18 KB |
| `cc.wasm` | clang + wasm-ld 21.1.8, `-Oz` | 42.4 MB | 15.7 MB | 11.3 MB |
| `wasi-sysroot.tar.gz` | 234 files: wasi-libc headers, libs (libc++ with exceptions), crt1, builtins | 0.99 MB (gzip, unpacked in the worker) | | |
| `sysroot.tar.gz` | shared with `server.js` (see above) | 2.1 MB | | |
| `gtest.tar` | `libgtest.a`, `libgtest_main.a`; fetched only for GoogleTest tests | 563 KB | 152 KB | 110 KB |
| `catch2.tar` | `libCatch2.a`, `libCatch2Main.a`; fetched only for Catch2 tests | 1.63 MB | 424 KB | 279 KB |
| `doctest.tar` | `libdoctest_main.a` (implementation and main); fetched only for doctest tests | 297 KB | 87 KB | 64 KB |
| `rapidcheck.tar` | `librapidcheck.a`; fetched only for a project that includes RapidCheck | 840 KB | 160 KB | 105 KB |

The first Run downloads **14.4 MB** (with brotli for the files that have
`.br` siblings; the test below measures exactly this). That drops to
**12.3 MB** when the language server has already fetched
`sysroot.tar.gz`. The first Test adds the framework's archive: 110 KB for
GoogleTest, 64 KB for doctest, 279 KB for Catch2, and RapidCheck 105 KB
more. Later runs download nothing. Exceptions cost 41 KB of that (`wasi-sysroot.tar.gz`), the test
frameworks' headers 0.31 MB (`sysroot.tar.gz`).

**Test** (`node test-run.mjs`): headless Chromium 1194, app/static served
with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (the page is
`crossOriginIsolated`), `.br` siblings served, persistent profile so there
is a disk cache. The machine was shared with other builds.

```text
PASS  the page is crossOriginIsolated
PASS  the default target fetches exactly the files it always did  /packs/cpp/cc.js /packs/cpp/cc.wasm /packs/cpp/runner.js /packs/cpp/sysroot.tar.gz /packs/cpp/wasi-sysroot.tar.gz
PASS  sample project (cold): prints the distance and the norm, exits 0  "5.000000\n5.000000\n" code=0 in 4723 ms, 14.5 MB transferred; Loading the compiler@14, Compiling geometry.cpp (1/2)@431, Compiling main.cpp (2/2)@1501, Linking@4487, Running@4697
PASS  sample project (warm): same output from the browser cache  code=0 in 2678 ms, 0 bytes transferred; Loading the compiler@21, Compiling geometry.cpp (1/2)@495, Compiling main.cpp (2/2)@825, Linking@2434, Running@2667
PASS  loading messages for each download  wasi-sysroot.tar.gz 987401/987401, sysroot.tar.gz 2177109/2177109, cc.wasm 42410950/42410950
PASS  C++ (cin): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 2317 ms
PASS  C (scanf): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 890 ms
PASS  end of file on stdin (Ctrl-D) ends scanf  code=2 "first number: "
PASS  compile error: clang diagnostics on stderr, non-zero exit  code=1
PASS  4 MB of locals work; deep recursion ends in a stack-overflow message, exit 134  deepest completed: 4000 calls; "The program crashed: Maximum call stack size exceeded (stack overflow: the browser allows only a few thousand nested calls)"
PASS  long double prints: C++ (cout)  "0.333333\n" code=0 ""
PASS  long double prints: C (printf %Lf)  "0.333333\n" code=0 ""
PASS  vector index out of bounds: the program is stopped, exit 134, nothing after it runs  code=134 "The program crashed: unreachable (abort(), or a failed check: in C++, for example, an index out of range on a vector, string, array or span)"
PASS  C++ exceptions: thrown and caught (own type, std::stoi, vector::at), destructors run while unwinding  "caught custom\nstoi: invalid_argument\nat: out_of_range\ndestructor ran\nint 42\n" code=0 ""
PASS  uncaught C++ exception: terminate message with type and what(), exit 134  code=134 "libc++abi: terminating due to uncaught exception of type std::logic_error: boom"
PASS  sample's GoogleTest tests: all pass, exit 0, main.cpp left out  code=0 in 4149 ms, 110 kB transferred (gtest.tar [563200,563200]); Loading the compiler@24, Compiling geometry.cpp (1/2)@521, Compiling tests/geometry_test.cpp (2/2)@859, Linking@3860, Running the tests@4113
PASS  GoogleTest's report is in its terminal colours: green [ RUN ]/[ OK ]/[ PASSED ], nothing else escaped  "Running main() from googletest/src/gtest_main.cc\n\u001b[0;32m[==========] \u001b[mRunning 3 tests from 1 test suite.\n\u001b[0;32m[-----"
PASS  a failing test: reported on stdout with file and line, exit non-zero  code=1 in 7090 ms
PASS  a failing test is in red  "(6 ms total)\n\u001b[0;32m[  PASSED  ] \u001b[m3 tests.\n\u001b[0;31m[  FAILED  ] \u001b[m2 tests, listed below:\n\u001b[0;31m[  FAILED  ] \u001b[mBroken.NormIsWrong\n\u001b[0;31m[  FAILED  ] \u001b[mBroken.ThrowsSomethingElse\n\n 2 FAILED TESTS\n"
PASS  doctest: the sample's tests pass, exit 0, only doctest.tar fetched  code=0 in 2980 ms (doctest.tar [296960,296960]; archives: doctest.tar); Loading the compiler@19, Compiling geometry.cpp (1/2)@561, Compiling tests/geometry_test.cpp (2/2)@855, Linking@2803, Running the tests@2968
PASS  doctest: the report is in colour (--force-colors)  "\u001b[0;36m[doctest] \u001b[0mdoctest version is \"2.5.3\"\n\u001b[0;36m[doctest] \u001b[0mrun with \"--help\" for options\n\u001b[0m\u001b[0m\u001b[0m\u001b[0;33m=="
PASS  doctest: failing tests are reported with file and line, exit non-zero  code=1 in 5157 ms
PASS  catch2: the sample's tests pass, exit 0, only catch2.tar fetched  code=0 in 3226 ms (catch2.tar [1628160,1628160]; archives: catch2.tar); Loading the compiler@16, Compiling geometry.cpp (1/2)@526, Compiling tests/geometry_test.cpp (2/2)@756, Linking@2990, Running the tests@3206
PASS  catch2: the report is in colour (--colour-mode ansi)  "Randomness seeded to: 1483059422\n\u001b[1;31m\u001b[1;33m\u001b[0m\u001b[0m\u001b[1;32m=========================================================="
PASS  catch2: failing tests are reported with file and line, exit non-zero  code=42 in 5684 ms
PASS  doctest with DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN in a test: links once, passes  code=0 ""
PASS  tests that mix GoogleTest and Catch2: a message naming both files, exit 1, nothing compiled  "The tests mix test frameworks: tests/geometry_test.cpp includes <gtest/...> (GoogleTest), tests/other_test.cpp includes <catch2/...> (Catch2). A test program links one of them; convert or remove the others."
PASS  RapidCheck with GoogleTest: a property that holds passes, exit 0, rapidcheck.tar fetched  code=0 in 9540 ms (rapidcheck.tar [839680,839680]; archives: gtest.tar,rapidcheck.tar); Loading the compiler@13, Compiling geometry.cpp (1/3)@609, Compiling tests/geometry_test.cpp (2/3)@860, Compiling tests/properties_test.cpp (3/3)@3761, Linking@9318, Running the tests@9495
PASS  RapidCheck with GoogleTest: a property that fails is shrunk to (1, 1), reported with file and line, exit non-zero  code=1 in 9390 ms; Falsifiable after 7 tests and 3 shrinks std::tuple<int, int>: (1, 1)
PASS  RapidCheck with doctest: a property that holds passes, exit 0, rapidcheck.tar fetched  code=0 in 8041 ms (rapidcheck.tar [839680,839680]; archives: doctest.tar,rapidcheck.tar); Loading the compiler@14, Compiling geometry.cpp (1/3)@585, Compiling tests/geometry_test.cpp (2/3)@869, Compiling tests/properties_test.cpp (3/3)@2798, Linking@7850, Running the tests@8011
PASS  RapidCheck with doctest: a property that fails is shrunk to (1, 1), reported with file and line, exit non-zero  code=1 in 7613 ms; Falsifiable after 8 tests and 4 shrinks std::tuple<int, int>: (1, 1)
PASS  RapidCheck with Catch2: a property that holds passes, exit 0, rapidcheck.tar fetched  code=0 in 8768 ms (rapidcheck.tar [839680,839680]; archives: catch2.tar,rapidcheck.tar); Loading the compiler@14, Compiling geometry.cpp (1/3)@546, Compiling tests/geometry_test.cpp (2/3)@794, Compiling tests/properties_test.cpp (3/3)@3073, Linking@8548, Running the tests@8742
PASS  RapidCheck with Catch2: a property that fails is shrunk to (1, 1), reported with file and line, exit non-zero  code=42 in 9065 ms; Falsifiable after 6 tests and 3 shrinks std::tuple<int, int>: (1, 1)
PASS  RapidCheck from a main of its own (rc::check), no framework: the holding property passes, the false one is shrunk, exit 1  code=1 in 6096 ms
PASS  test mode without tests/: says so, exit 1  "No tests to run: put test files (GoogleTest, doctest or Catch2) in tests/, for example tests/geometry_test.cpp."
PASS  duplicate main: the link error names main.cpp and lib/other.cpp, non-zero exit  code=1
PASS  compiler cannot be instantiated: error on stderr and an exit message  code=1 "clang could not start: WebAssembly.Memory(): could not allocate memory" 559 ms
PASS  an unsupported --target: the message lists the supported triples, exit 1, nothing downloaded  "Unsupported target \"armv7-linux-musleabihf\" in compile_flags.txt; supported: wasm32-wasip1, x86_64-linux-musl, aarch64-linux-musl, riscv64-linux-musl (or no --target).\n"
PASS  Catch2 tests on a Linux target: refused, naming why and what works there, exit 1, nothing downloaded  "Catch2 runs on the WebAssembly target only, for now: on AArch64 Linux the tests can use GoogleTest (and RapidCheck).\n"
PASS  Linux target without vm.js: compiled for x86_64-linux-musl, linked, then "not installed", exit 1  "Running on x86-64 Linux is not installed (packs/cpp/vm.js)\n" Loading the compiler@8, Compiling geometry.cpp (1/2) for x86_64-linux-musl@591, Compiling main.cpp (2/2) for x86_64-linux-musl@1940, Linking@5026
PASS  a Linux target fetches cc-cross and its own arch only, never cc.wasm or wasi-sysroot  /packs/cpp/cc-cross.js /packs/cpp/cc-cross.wasm /packs/cpp/runner-linux.js /packs/cpp/targets/x86_64/include.tar /packs/cpp/targets/x86_64/lib.tar /packs/cpp/vm.js
PASS  endless loop: terminated by the page, which stays responsive  stopped after 1791 ms; Loading the compiler@11, Compiling main.cpp (1/1)@472, Linking@652, Running@780
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

**Properties** (RapidCheck): a project that includes `<rapidcheck.h>` or
`<rapidcheck/...>` (in a compiled file, or a header under `tests/`) is linked
with `librapidcheck.a`, whose `rapidcheck.tar` is then fetched once; a
project that does not fetches nothing more (tested). RapidCheck is a library
beside a test framework, not one of its own, so it goes with any of the
three, and with a plain Run:

* **GoogleTest**: `#include <gtest/gtest.h>`, then `<rapidcheck/gtest.h>`,
  and `RC_GTEST_PROP(Suite, Name, (int x, int y)) { RC_ASSERT(...); }`
  (also `RC_GTEST_FIXTURE_PROP`). Each property is one GoogleTest test.
* **Catch2**: `#include <catch2/catch_test_macros.hpp>`, then
  `<rapidcheck/catch.h>`, and `rc::prop("name", [](int x) { ... })` inside a
  `TEST_CASE` (it opens a `SECTION`).
* **doctest**: `const bool holds = rc::check("name", [](int x) { ... });
  CHECK(holds);` with `#include <rapidcheck.h>`. RapidCheck's own doctest
  integration (`rapidcheck/doctest.h`, `rc::doctest::check`) is **not
  shipped: it does not compile** at this commit with any compiler, because
  inside its namespace `rc::doctest` the name `doctest::detail` means
  `rc::doctest::detail` (clang 21: "no namespace named 'detail' in
  namespace 'rc::doctest'"; GCC 13: "'detail' is not a namespace-name").
  Fixing it would be a patch to RapidCheck, so it is left out; its report
  then goes to stderr rather than into doctest's.
* **No framework**: `rc::check("name", property)` from the program's own
  `main` returns whether the property held; the report is on stderr.

What works as natively: random generation (`std::random_device`, which is
WASI's `random_get`), the 100 cases per property, shrinking, the report with
the counterexample, the file and line of the failed `RC_ASSERT` and its
expansion, and the `RC_PARAMS="reproduce=..."` line RapidCheck prints for a
failure. RapidCheck needs no threads, signals, files or clocks; only its
`std::chrono` generators (`gen/Chrono.h`) generate durations, which need no
clock either. `RC_PARAMS` itself is an environment variable, and the runner
gives a program no way to set one, so a seed, `max_success` or a `reproduce`
string can be used in the Download's build, not in the browser.

A failing property in GoogleTest, shrunk from a random pair to the smallest
counterexample, as the Test prints it (`test-run.mjs`; colours removed):

```text
[ RUN      ] GeometryProperties.NormIsAWholeNumber
/wasi/include/rapidcheck/gtest.h:29: Failure
Failed
Falsifiable after 3 tests and 2 shrinks

std::tuple<int, int>:
(1, 1)

tests/properties_test.cpp:15:
RC_ASSERT(p.norm() == std::floor(p.norm()))

Expands to:
1.41421 == 1


[  FAILED  ] GeometryProperties.NormIsAWholeNumber (7 ms)
...
[  PASSED  ] 4 tests.
[  FAILED  ] 1 test, listed below:
[  FAILED  ] GeometryProperties.NormIsAWholeNumber
```

and on stderr `Using configuration: seed=...` and `Some of your RapidCheck
properties had failures. To reproduce these, run with: RC_PARAMS="reproduce=..."`.
The framework's failure line is where its integration header fails the test
(`rapidcheck/gtest.h:29`, `rapidcheck/catch.h:52`), under `/wasi/include`
where the runner's compiler finds the headers (`/usr/include` natively);
the line that matters, the `RC_ASSERT`, is the project's. Including
`<rapidcheck.h>` costs compile time: the properties file takes about 3 s to
compile and the link about 5 s more than the sample's tests alone, in the
runs below.

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
  refused with a message naming a file of each. Properties are RapidCheck,
  with GoogleTest's or Catch2's integration or `rc::check`; not with
  RapidCheck's doctest integration, which does not compile (Properties), and
  not with `RC_PARAMS` (no environment). No signal handling in
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
(called the same way, cached in `$PACK_CACHE/cpp/testfw`) builds Catch2,
doctest and RapidCheck with that toolchain: about 1.5 minutes at `-j3`.
Time on this machine (4 cores shared with another agent's clangd build,
`-j3`, `nice`): **102 minutes** for the LLVM step, about 3 minutes for the
rest (mostly brotli on `cc.wasm`). The build tree `build-wasm-cc` is
449 MB.

## Targets

A project runs on **WebAssembly (WASI)** unless its `compile_flags.txt`
names a Linux target with clang's own flag. The table is
`src/targets.json`; `src/targets.js` reads the flag, for clangd
(`server.js`), Run (`runner.js`) and the compiler output views
(`explorer.js`) alike, so the three agree on the target.

| target | `compile_flags.txt` | runs on | compiler |
| --- | --- | --- | --- |
| WebAssembly (WASI), the default | no target flag, or `--target=wasm32-wasip1` | the runner's WASI host | `cc.wasm` |
| x86-64 Linux | `--target=x86_64-linux-musl` | QEMU-Wasm (`vm.js`) | `cc-cross.wasm` |
| AArch64 Linux | `--target=aarch64-linux-musl` | QEMU-Wasm | `cc-cross.wasm` |
| RISC-V 64 Linux | `--target=riscv64-linux-musl` | QEMU-Wasm | `cc-cross.wasm` |

**The flag** is read as clang reads it: `--target=X`, or `-target` with X
on the next line; the last one wins. `-target=X` and `--target X` are not
target flags, because clang refuses both ("unknown argument"), so such a
project fails to compile on the default target with clang's message. A
triple that is not in the table (`armv7-linux-musleabihf`, a different
case, a glibc triple) is refused before anything is downloaded:
`Unsupported target "armv7-linux-musleabihf" in compile_flags.txt;
supported: wasm32-wasip1, x86_64-linux-musl, aarch64-linux-musl,
riscv64-linux-musl (or no --target).` The cases are
`tests/fixtures/target-cases.json`, which the app's copy of the rule must
pass too.

**What a Linux target is.** A static musl 1.2.5 program, linked with LLVM's
runtimes (libc++, libc++abi, libunwind, compiler-rt) by ld.lld, exactly as
`clang --target=<triple> -static` links on a Linux machine with those
runtimes installed. Nothing in the triple, the include paths or the link
line is ours: clang's Linux driver picks them.

* **One compiler for the three, `cc-cross.wasm`** (`build-cross.sh`):
  clang 21.1.8 and ld.lld from the same LLVM tarball and the same cmake
  arguments as `cc.wasm`, except `LLVM_TARGETS_TO_BUILD=X86;AArch64;RISCV`,
  `LLVM_DEFAULT_TARGET_TRIPLE=x86_64-linux-musl` and the LLVM runtimes as
  clang's defaults (`CLANG_DEFAULT_CXX_STDLIB=libc++`, `RTLIB=compiler-rt`,
  `UNWINDLIB=libunwind`, `LINKER=lld`, the configuration Alpine's clang
  has). `cc.wasm` is not touched: a project on the default target
  downloads exactly what it did before (`test-run.mjs` checks the URL set).
  One compiler for the three targets rather than three compilers is the
  bundle-size choice: it is 4.4 MB (brotli) more than `cc.wasm`, where a
  compiler per target would cost about 12 MB each, and a student switching
  between Linux targets downloads only the new target's files.
* **Patch `patches/elf-ld-only.patch`**: lld's tool links only its ELF
  flavour (`ld.lld`), as `wasm-ld-only.patch` does for `cc.wasm`. The
  patched copy of `lld/` is `$CACHE/lld-elf-21.1.8`; `cc`'s copy is never
  touched.
* **Headers.** `sysroot.tar.gz`, the language server's archive, already has
  musl's headers for x86-64, libc++'s and clang's. Each target adds
  `targets/<arch>/include.tar`, the arch's musl `bits/` headers in
  `/usr/include/<multiarch>` (`x86_64-linux-gnu`, `aarch64-linux-gnu`,
  `riscv64-linux-gnu`: clang's Linux driver uses the Debian multiarch names
  for musl triples too), which clang searches before `/usr/include`
  (checked with `-v` for each target in `test-targets.mjs`). The other
  musl headers are the same for the three arches (`build-targets.sh`
  checks it). About 10 KB each with brotli. clangd (`server.js`) fetches a target's
  `include.tar` when `compile_flags.txt` first names it, holding its LSP
  messages meanwhile, for at most 30 s. If that fetch fails or times out,
  clangd goes on with the default x86-64 `bits/`, says so in the Output
  panel (`window/showMessage`), and tries again on the next change to
  `compile_flags.txt`.
* **Libraries**, `targets/<arch>/lib.tar`, fetched only to link (Run):
  musl's `crt1.o`, `crti.o`, `crtn.o`, `libc.a` and its empty stubs, libc++
  (with libc++abi merged in, so the driver's `-lc++` brings both),
  libunwind and compiler-rt's builtins and `crtbegin`/`crtend`. They are
  **Alpine v3.23's packages**, pinned by SHA-256, stripped of debug info.
  `build-targets.sh` checks that their libc++ is configured as our headers
  are (Alpine's `__config_site` is byte-identical to ours, ABI version 1),
  that musl is 1.2.5, that x86-64's `bits/` match `sysroot.tar.gz`'s, and
  that libc++abi's objects are in the merged `libc++.a`.

**What does not match, and what does not work**

* Alpine's runtimes are LLVM **21.1.2**, the headers 21.1.8. libc++
  guarantees ABI stability within a major version with the same
  `__config_site`, which is checked; a patch release can still add an
  inline function whose out-of-line copy only the newer library has (none
  of the tests found one). Building the runtimes from our own tarball is
  phase 2.
* Alpine's musl headers carry Alpine's patches (`dirent.h`, `elf.h` differ
  from upstream 1.2.5; `libintl.h` is only in ours). The headers used are
  ours, the libraries Alpine's.
* **Test** on a Linux target runs **GoogleTest** tests, with **RapidCheck**
  properties, under QEMU like a Run (Run options apply): the two are built
  for each Linux target (below), and the full GoogleTest at that, with
  pthreads, stream redirection and death tests, which Linux has. **Catch2
  and doctest are not built for Linux** (yet; the same build would do it,
  with Catch2's hundred translation units): their tests are refused before
  anything is fetched, "Catch2 runs on the WebAssembly target only, for
  now: on AArch64 Linux the tests can use GoogleTest (and RapidCheck)."
  (`test-run.mjs`).
* No 32-bit targets (armv7, i386, riscv32): none was asked for, and each
  costs a backend in `cc-cross.wasm`, a `lib.tar` and the emulator's
  kernel. They are refused by name.
* Without a target flag clangd still parses as `x86_64-linux-musl`
  (Running, "Execution target vs. editor target"); with one, the editor and
  the program agree exactly (same triple, same headers).

**Running** is `vm.js`'s (the emulator, built by `build-vm.sh` from `vm/`): `runner.js`
compiles each source with `cc-cross` (`clang --target=<triple> -c`), then
`runner-linux.js`, loaded only for a Linux target, links with
`toolchain.js`'s `linkLinux`: `clang -### --target=<triple> -static
<objects> -o a.out` prints the `ld.lld` command line clang's driver builds,
and `ld.lld` runs with exactly those arguments (a browser cannot spawn the
linker from clang). The ELF goes to `vm.js` `runLinux`, which runs it under
QEMU-Wasm. Without `vm.js` the runner says so: "Running on x86-64 Linux is
not installed (packs/cpp/vm.js)".

**Files** (fetched only for a project on that target):

| file | what | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `cc-cross.js` | Emscripten glue, ES module (also loads in Node, for the tests) | 75 KB | 20 KB | 18 KB |
| `cc-cross.wasm` | clang + ld.lld 21.1.8 for x86-64, AArch64, RISC-V 64, `-Oz` | 67.2 MB | 22.1 MB | 15.7 MB |
| `runner-linux.js` | the runner's link-and-run step for a Linux target, loaded only for one | 1.6 KB | 1.0 KB | 0.9 KB |
| `targets/x86_64/include.tar` | musl `bits/` for x86-64 (35 headers) | 92 KB | 14 KB | 10.6 KB |
| `targets/x86_64/lib.tar` | crt files, libc, libc++ (+abi), libunwind, compiler-rt | 6.15 MB | 1.31 MB | 0.94 MB |
| `targets/aarch64/include.tar` | musl `bits/` for AArch64 | 82 KB | 13 KB | 9.5 KB |
| `targets/aarch64/lib.tar` | as for x86-64 | 6.46 MB | 1.31 MB | 0.91 MB |
| `targets/riscv64/include.tar` | musl `bits/` for RISC-V 64 | 82 KB | 12 KB | 8.9 KB |
| `targets/riscv64/lib.tar` | as for x86-64 | 9.39 MB | 1.81 MB | 1.26 MB |
| `targets/x86_64/gtest.tar` | `libgtest.a`, `libgtest_main.a` for x86-64 Linux; fetched only for GoogleTest tests | 963 KB | 218 KB | 164 KB |
| `targets/x86_64/rapidcheck.tar` | `librapidcheck.a` for x86-64 Linux; fetched only for a project that includes RapidCheck | 1.21 MB | 228 KB | 140 KB |
| `targets/aarch64/gtest.tar` | as for x86-64 | 983 KB | 219 KB | 156 KB |
| `targets/aarch64/rapidcheck.tar` | as for x86-64 | 1.25 MB | 234 KB | 139 KB |
| `targets/riscv64/gtest.tar` | as for x86-64 | 2.09 MB | 357 KB | 263 KB |
| `targets/riscv64/rapidcheck.tar` | as for x86-64 | 1.88 MB | 328 KB | 205 KB |

A first Run on a Linux target downloads `cc-cross.wasm`, `sysroot.tar.gz`
and the target's two tars, plus the emulator's files:
18.75 MB with brotli for x86-64 (18.72 MB AArch64, 19.07 MB RISC-V 64) for compiling and linking, of which `sysroot.tar.gz` (2.1 MB) is shared with the language server and `cc-cross.wasm` (15.7 MB) with every other Linux target, so switching between Linux targets costs about 1 MB. The editor fetches only `include.tar` (about 10 KB), the
first time `compile_flags.txt` names the target; `server.js` holds clangd's
messages until it is unpacked, so the first parse already sees the target's
headers.

**Build.** `build.sh` runs `build-cross.sh`, `build-targets.sh` and
`build-demangle.sh` before `build-runner.sh` (whose `pack-runner.sh` copies
both compilers and bundles the three workers). `pack-runner.sh` also runs
`build-test-frameworks-linux.sh`, which compiles GoogleTest 1.18.0 and
RapidCheck (the same pinned sources as the WebAssembly libraries; the pins
are read from `build-cxx-runtime.sh` and `build-test-frameworks.sh`) for
each Linux target with **`cc-cross.wasm` itself**, in Node
(`build-test-libs-linux.mjs`, through `toolchain.js` as the runner drives
it, with Run's flags), archives them with wasi-sdk's `llvm-ar`, and writes
`targets/<arch>/gtest.tar` and `rapidcheck.tar` with the libraries in
`/usr/lib/<multiarch>`, where clang's Linux driver finds `-lgtest` and
`-lrapidcheck`. 108 compiles, one after another: about 3.5 minutes,
skipped while its stamp (the two scripts, `cc-cross.wasm`, the three
`include.tar`) matches. For a Test, `runner-linux.js` links with
`-lgtest_main -lrapidcheck -lgtest` (as needed) after the objects, through
the same `clang -###` and `ld.lld` (`linkLinux`'s `libs` and `archives`),
and the guest gets `GTEST_COLOR=yes` in its environment. Both compilers are kept in
`$CACHE/artifacts/{cc,cc-cross}` with a `STAMP`, the SHA-256 of the LLVM
and Emscripten versions, the cmake arguments and the patch
(`PRINT_STAMP=1 ./build-runner.sh` prints `cc`'s); each LLVM step is skipped
while its stamp matches, and `pack-runner.sh` copies compilers only from
there, so building one never changes the other (`cc.wasm` is
byte-identical to before targets existed). `build-cross.sh` can reuse any
LLVM tree (`CROSS_BUILD_DIR`), but switching a tree between the two
configurations is a **full rebuild**, not a relink: the default triple and
the native target are in `llvm-config.h`, which 2,274 of the 2,531 objects
include. Here it reused `build-wasm-cc` (with `JOBS=4`, `nice`, 4 cores
shared with two other agents' builds): **51 minutes** (137 CPU-minutes),
then 3 minutes of brotli in `pack-runner.sh`; a later `./build-runner.sh`
for `cc` then rebuilds that tree too (about 100 minutes), so a machine that
builds both often should give each a tree (`build-wasm-cross`, about
450 MB). `build-targets.sh` takes about 70 s (downloads cached in
`$CACHE/targets/dl`), `build-demangle.sh` about 20 s.

**Where the Alpine packages come from.** Alpine replaces a package in place
when it publishes a new revision (a musl fix would turn `musl-dev-1.2.5-r24`
into `-r25`), so a pinned revision can disappear from its CDN and the pin
alone would only make the build fail safely. `build-targets.sh` therefore
tries `$ALPINE_MIRROR/<arch>/<package>.apk` first when that is set (a
directory or a URL), then Alpine's CDN, and the SHA-256 pin decides either
way. A copy of all 15 pinned packages is on the project share,
`/mnt/project-files/monaco-lsp/alpine-v3.23/` (72 MB); building with
`ALPINE_MIRROR` set to it and the network cut off gives byte-identical
`targets/` files. The same build also leaves
`$CACHE/targets/sysroot/<arch>`, the musl sysroot `vm/cc.sh` builds the
VM's strace and test programs with, so the guest's tools and users'
programs link the same pinned musl.

**How the toolchain is driven.** Nothing is re-decided in JavaScript:
`compileArgs` adds `--target=<triple> -resource-dir=/usr/lib/clang/21` and
the defaults Run always had; clang's Linux driver finds the multiarch
headers and libraries itself. For the link, `linkLinux` asks the driver
(`clang -### -no-canonical-prefixes --target=<triple> -static ...`) and
runs the `ld.lld` line it prints. Two things make the driver in a wasm
module behave as an installed one: `-no-canonical-prefixes`, so its
InstalledDir is `argv[0]`'s directory (`/usr/bin`) rather than the
executable's own path, which a wasm module does not have; and empty
executables `/usr/bin/{clang,clang++,ld.lld}` in the instance's file
system, so that it finds `ld.lld` there (otherwise it prints plain `ld`).

**On QEMU-Wasm** (`test-run-linux.mjs`, the emulator's test, all 24 checks
passing with this compiler): the sample takes 11.1 s cold on x86-64 (14.7 s
AArch64, 10.1 s RISC-V 64): about 5 s to compile and link in the browser,
0.2 s to load the VM, about 5 s to boot the guest (system mode), then the
program. User mode (one CPU, no kernel) runs `hello` 4.1 to 5.0 s after
Run, nearly all of it compiling.

**Tested** (`node --test test-targets.mjs`, `node test.mjs` session 3,
`node test-run.mjs`). The aarch64 and riscv64 programs run under the host's
QEMU user mode as an oracle (`qemu-aarch64-static`, `qemu-riscv64-static`
from Debian/Ubuntu's `qemu-user-static`, found in `PATH` or
`QEMU_USER_DIR`); without them those tests fail, naming what to install,
unless `ALLOW_SKIP=1`, which skips them instead:

```text
ok 1 - compile_flags.txt names the target the way clang reads it: every case of target-cases.json
ok 2 - a target nobody built is refused by name, with the list of those there are
ok 3 - every target row is complete, and the triples are the ones clang normalises to the multiarch names
ok 4 - the default target compiles exactly as it did before targets existed
ok 5 - a Linux target compiles with its triple, the same optimisation and hardening, and the views only add line tables
ok 6 - x86-64 Linux: clang searches libc++'s headers, then the target's bits/, musl's, and clang's own
ok 7 - x86-64 Linux: the sample links into a static ELF for the right machine, which prints the distances
ok 8 - x86-64 Linux: a C program links with clang, not clang++, and reads stdin
ok 9 - x86-64 Linux: an exception is caught by its handler, and an uncaught one aborts with libc++abi's message
ok 10 - x86-64 Linux: four threads count to 400000
ok 11 - x86-64 Linux: the views' flags change no byte of the code or data clang emits, at -O0 and -O2
ok 12 - x86-64 Linux: libc++'s hardening stops an out-of-range vector index
ok 13 - AArch64 Linux: clang searches libc++'s headers, then the target's bits/, musl's, and clang's own
ok 14 - AArch64 Linux: the sample links into a static ELF for the right machine, which prints the distances
ok 15 - AArch64 Linux: a C program links with clang, not clang++, and reads stdin
ok 16 - AArch64 Linux: an exception is caught by its handler, and an uncaught one aborts with libc++abi's message
ok 17 - AArch64 Linux: four threads count to 400000
ok 18 - AArch64 Linux: the views' flags change no byte of the code or data clang emits, at -O0 and -O2
ok 19 - AArch64 Linux: libc++'s hardening stops an out-of-range vector index
ok 20 - RISC-V 64 Linux: clang searches libc++'s headers, then the target's bits/, musl's, and clang's own
ok 21 - RISC-V 64 Linux: the sample links into a static ELF for the right machine, which prints the distances
ok 22 - RISC-V 64 Linux: a C program links with clang, not clang++, and reads stdin
ok 23 - RISC-V 64 Linux: an exception is caught by its handler, and an uncaught one aborts with libc++abi's message
ok 24 - RISC-V 64 Linux: four threads count to 400000
ok 25 - RISC-V 64 Linux: the views' flags change no byte of the code or data clang emits, at -O0 and -O2
ok 26 - RISC-V 64 Linux: libc++'s hardening stops an out-of-range vector index
ok 27 - WebAssembly: the views' flags change none of the code or data clang emits, at -O0 and -O2
ok 28 - the explorer shows IR and assembly for every target, demangled, and only answers the newest request
# pass 28
# fail 0
# skipped 0

-- session 3: compile_flags.txt names a Linux target
PASS  sessions 1 and 2 (the default target) fetched no targets/ file  []
PASS  an aarch64 project parses with the aarch64 headers (__aarch64__, LP64, no error)  []
PASS  targets/aarch64/include.tar is fetched once, and no library  ["/packs/cpp/targets/aarch64/include.tar"]
PASS  a change of target to riscv64 reparses with its headers (__riscv, xlen 64)  []
PASS  and fetches targets/riscv64/include.tar, once  ["/packs/cpp/targets/aarch64/include.tar","/packs/cpp/targets/riscv64/include.tar"]
PASS  and without a target flag the same file does not compile  ["4: \"not compiled for riscv64\""]
PASS  session 3: shutdown answers  ""
PASS  session 3: the worker raised no errors  []

PASS  the default target fetches exactly the files it always did  /packs/cpp/cc.js /packs/cpp/cc.wasm /packs/cpp/runner.js /packs/cpp/sysroot.tar.gz /packs/cpp/wasi-sysroot.tar.gz
PASS  an unsupported --target: the message lists the supported triples, exit 1, nothing downloaded  "Unsupported target \"armv7-linux-musleabihf\" in compile_flags.txt; supported: wasm32-wasip1, x86_64-linux-musl, aarch64-linux-musl, riscv6
PASS  Catch2 tests on a Linux target: refused, naming why and what works there, exit 1, nothing downloaded  "Catch2 runs on the WebAssembly target only, for now: on AArch64 Linux the tests can use GoogleTest (and RapidCheck).\n"
PASS  Linux target without vm.js: compiled for x86_64-linux-musl, linked, then "not installed", exit 1  "Running on x86-64 Linux is not installed (packs/cpp/vm.js)\n" Loading the compiler@6, Compiling geometry.cpp (1/2) for x86_64-linux-mus
PASS  a Linux target fetches cc-cross and its own arch only, never cc.wasm or wasi-sysroot  /packs/cpp/cc-cross.js /packs/cpp/cc-cross.wasm /packs/cpp/runner-linux.js /packs/cpp/targets/x86_64/include.tar /packs/cpp/targets/x86_64/lib.tar /
```

**Tests on a Linux target** (`test-targets.mjs`, which links GoogleTest
and RapidCheck from `targets/<arch>/` and runs the program natively on
x86-64, and `test-run-linux.mjs`, which runs a Test through `runner.js` under
QEMU-Wasm in Chromium on all three targets):

```text
ok 1 - x86-64 Linux: GoogleTest and RapidCheck from targets/x86_64/ link, a property holds and a false one is shrunk to (1, 1)
ok 2 - AArch64 Linux: ... # SKIP no way to run aarch64 programs on this host (no qemu-user-static here)
ok 3 - RISC-V 64 Linux: ... # SKIP the same

# x86_64 GoogleTest + RapidCheck, failing, cold: 28556 ms; Falsifiable after 4 tests and 2 shrinks std::tuple<int, int>: (1, 1)
ok 8 - x86_64: Test with GoogleTest and RapidCheck: the sample's tests and a property pass; a false property is shrunk to (1, 1), exit 1
ok 9 - x86_64: Test with Catch2 is refused by name (Catch2 is built for WebAssembly only)
ok 8 - aarch64: Test with GoogleTest and RapidCheck: the sample's tests and a property pass; a false property is shrunk to (1, 1), exit 1
ok 9 - aarch64: Test with Catch2 is refused by name (Catch2 is built for WebAssembly only)
# riscv64 GoogleTest + RapidCheck, failing, cold: 18947 ms; Falsifiable after 4 tests and 2 shrinks std::tuple<int, int>: (1, 1)
ok 8 - riscv64: Test with GoogleTest and RapidCheck: the sample's tests and a property pass; a false property is shrunk to (1, 1), exit 1
ok 9 - riscv64: Test with Catch2 is refused by name (Catch2 is built for WebAssembly only)
```

The rest of `test-run-linux.mjs` passed on all three targets in the same
runs. Once, in a run of both aarch64 and riscv64 one after the other, the
riscv64 failing-property case exited 1 with no output on stdout; it did
not happen again in two more runs (the test now prints stderr and the
guest's kernel log if it does).

## Compiler output views

The app's **LLVM IR** and **Assembly** views come from a third worker,
`explorer.js` (protocol: `../CONTRACT.md`, "Showing compiler output"). It
compiles the active source with exactly the arguments Run uses
(`toolchain.js` `compileArgs`, shared by both), plus
`-gline-tables-only -fno-discard-value-names`, and `-S` or
`-S -emit-llvm`; for x86-64 `-masm=intel` on request. Compile only: a Linux
target fetches its `include.tar`, not its libraries. Each target's compiler
is the one Run uses, so the views show what runs, on every target,
WebAssembly included. The views' flags do not change the code, checked
twice: `test-targets.mjs` compiles every sample file live with and without
them, for every target at `-O0` and `-O2`, and every allocated ELF section
(code, data, read-only data, exception tables) and every relocation
against one is byte-for-byte the same (for WebAssembly, every line of
every function and data section of the assembly, once what line tables
add around them is taken out); and `test-emit.mjs` compares the filtered
outputs of the checked-in fixtures.

**Filtering** (`src/emit-filter.js`, pure functions, as Compiler Explorer
filters):

* Assembly: `.loc`/`.file` give each instruction its source line; then
  `.loc`, `.file`, `.cfi_*`, `.addrsig*`, `.ident`, comment-only lines,
  whole `.debug_*` sections, and local labels nothing refers to
  (`.Ltmp3`, `.Lfunc_begin0`, an unused `.LBB0_2`) go. With **directives**
  off (the default) every other directive goes too, except the data
  (`.asciz`, `.quad`, ...) under a label something refers to: each data line
  belongs to the label above it, and the labels referred to are a fixpoint
  (a string literal main loads stays; an exception table nothing shown uses
  goes).
* IR: every `!dbg` attachment, `#dbg_*` record, `DI*` node, `!llvm.dbg.cu`
  and the two debug module flags go, and then every metadata node,
  attribute group and comdat nothing shown refers to any more.
* **Library functions** (off by default): a function none of whose lines
  maps to a project file (`std::swap<int>` at `-O0`, a `std::vector`
  member) is hidden, with its `; Function Attrs:` comment.
* **Mapping**: code inlined from a header maps to the innermost place in the
  project it was inlined into (the `.loc` comment's inline chain, the IR's
  `inlinedAt`), so `std::vector`'s construction inlined into `main` maps to
  the line of `main` that constructs the vector: the line the cursor is on.
* **Demangling** (on by default for assembly): LLVM's own Itanium
  demangler, `llvm::itaniumDemangle` from the same 21.1.8 tarball (the code
  `llvm::demangle`, and so `llvm-cxxfilt`, runs for a `_Z` name, chosen by
  the same test), compiled alone to `demangle.wasm` (`build-demangle.sh`,
  `-Oz`, 27 KB brotli) and called once per view with every distinct name.
  The Microsoft, Rust and D demanglers are left out: the views' targets
  only produce Itanium names, and leaving them out makes the file 37%
  smaller (44 KB brotli with them). `test-demangle.mjs` checks it on cases
  checked against `llvm-cxxfilt`, and builds the same source natively with
  `-Wall -Wextra -Wpedantic -Werror`, AddressSanitizer and
  UndefinedBehaviorSanitizer, and runs clang-tidy on it.

Only the newest request of each kind is answered: one that a newer request
replaced while it waited or compiled gets no answer, so typing never queues
compiles. One compile per view: IR and assembly are two compiles when both
views are open (a single `-save-temps` compile could give both; not done,
since each view is usually open alone).

**Files** (fetched the first time a view opens):

| file | what | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
| `explorer.js` | the worker, with `toolchain.js` and `emit-filter.js` (esbuild-minified) | 13.3 KB | 6.1 KB | 5.6 KB |
| `demangle.js` | Emscripten glue for the demangler | 10.3 KB | 3.5 KB | 3.2 KB |
| `demangle.wasm` | `llvm::itaniumDemangle` (LLVMDemangle 21.1.8, `ItaniumDemangle.cpp` only), `-Oz`, emmalloc | 82 KB | 33 KB | 28 KB |

The views use the target's compiler and headers, the same files Run uses:
the first view of a project downloads `cc.wasm` and the two sysroots
(14.4 MB) on the default target, or `cc-cross.wasm`, `sysroot.tar.gz` and
the target's `include.tar` (17.9 MB) on a Linux one, plus the 37 KB above;
after a Run, only those 37 KB. On the default target that includes all of
`wasi-sysroot.tar.gz` (0.99 MB gzip), libraries too, although a view never
links: about 0.85 MB of it is `lib/`. That is accepted rather than
splitting the archive: the views are mostly opened after a Run, which has
fetched it anyway, and a separate headers archive would be a second copy
of the same headers to download then.

**Memory and failures.** The worker holds the compiled compiler of the
current target only: when the target moves between WebAssembly and Linux
it drops the other one and its files (`toolchain.release()`), and the app
stops the worker when the last view closes, so neither compiler stays in
memory beside a Linux Run's. A download that fails (a network blip, an
HTTP error) is not remembered: the next request tries it again, and a
demangler that fails to start gives an error result rather than a view
stuck on "Updating".

**Tested** (`node --test test-emit.mjs`, on the fixtures in
`tests/fixtures/`, which `tests/fixtures/gen.mjs` compiles with the shipped
compilers; `node test-demangle.mjs`; the explorer section of
`test-targets.mjs` in headless Chromium):

```text
ok 1 - every output line has exactly one mapping, a project line, a header line or none
ok 2 - the views do not change the code: with line tables and without, the filtered output is the same
ok 3 - the call to distance in main maps to main.cpp line 8, in the assembly and the IR of every target
ok 4 - a function maps to its own lines: Point::norm to geometry.cpp 5, distance to geometry.cpp 8
ok 5 - debug info, line directives and call frame information never show
ok 6 - directives show only when asked, and data under a used label always shows
ok 7 - the IR keeps the module flags that are not debug info, and drops metadata only debug info used
ok 8 - a function from a library header is hidden, unless library functions are asked for
ok 9 - the wasm target ends functions with end_function and the x86-64 one can show Intel syntax
ok 10 - names in the output demangle to the C++ a student wrote
ok 11 - paths clang prints become project paths, and other files stay absolute
ok 12 - the filters never throw, on empty input and on garbage
# pass 12
# fail 0
# skipped 0

PASS  demangle.wasm instantiates  3 ms
PASS  wasm: _Z8distanceRK5PointS1_  distance(Point const&, Point const&)
PASS  wasm: _ZNK5Point4normEv  Point::norm() const
PASS  wasm: _Znwm  operator new(unsigned long)
PASS  wasm: _ZdlPvm  operator delete(void*, unsigned long)
PASS  wasm: _ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em  std::__1::vector<Point, std::__1::allocator<Point>>::operator[][abi:fe210108](unsigned long)
PASS  wasm: _ZNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC2B8fe210108ILi0EEEPKc  std::__1::basic_string<char, std::__1::char_traits<char>, std::__1::allocator<char>>::basic_string[abi:fe210108]<0>(char const*)
PASS  wasm: _ZTVSt12length_error  vtable for std::length_error
PASS  wasm: _ZTISt9exception  typeinfo for std::exception
PASS  wasm: _ZN3foo3barIiEEvT_  void foo::bar<int>(int)
PASS  wasm: _ZZ4mainENK3$_0clEv  main::$_0::operator()() const
PASS  wasm: _ZL6squarei  square(int)
PASS  wasm: __Z8distanceRK5PointS1_  distance(Point const&, Point const&)
PASS  wasm: _RNvC6_123foo3bar  _RNvC6_123foo3bar
PASS  wasm: main  main
PASS  wasm: printf  printf
PASS  wasm: hypot  hypot
PASS  wasm: every case in one batch, in order  16 names in 0.1 ms
PASS  demangleLines: names in assembly demangled, line count kept, .L labels left alone  "\tcallq\tdistance(Point const&, Point const&)@PLT\nPoint::norm() const:  # @Point::norm() const\n\tcall\tprintf\n\tbl .L_Znot_a_name"
PASS  demangleLines: one batched call for every distinct name
PASS  native build with clang++-18, -Wall -Wextra -Wpedantic -Werror, ASan + UBSan
PASS  native test-native.cpp on the same cases, no sanitizer report  25 checks; all passed
PASS  clang-tidy is clean (src/demangle/.clang-tidy)
all passed
PASS  clang-tidy is clean (src/demangle/.clang-tidy)
all passed
```

## Prior art

* github.com/Guyutongxue/clangd-in-browser: clangd with Emscripten, pthreads
  (needs cross-origin isolation) and Asyncify for stdin; this pack also
  uses pthreads but reads stdin from a queue on clangd's own thread, so no
  Asyncify and a smaller binary.
* This project's browser-clang experiment (LLVM 21.1.8 clang/lld with
  Emscripten).
