# Swift pack: swift-syntax-ls, the real Swift 6.3.3 compiler for type errors and running, NOT SourceKit-LSP

This pack has three parts, and they are named for what they are:

| part | what it is | what it does |
|---|---|---|
| `server.js` + `swift-ls.wasm` | **swift-syntax-ls**, a small language server written for this pack on Apple's [swift-syntax](https://github.com/swiftlang/swift-syntax) 604.0.0, compiled to wasm32-wasip1 with the swift.org Swift 6.4.1 Wasm SDK | syntax diagnostics with fix-its, outline, semantic tokens, formatting, and **heuristic** completion, hover, definition, references, rename and signature help |
| `typecheck.js` | a nested worker of `server.js` that runs **swift-frontend 6.3.3** (`swift-frontend.wasm`) with `-emit-sil` (type checking plus the mandatory SIL passes) | **semantic diagnostics** from the real compiler (type errors, unknown names, warnings), merged with the syntax ones |
| `runner.js` | **swift-frontend 6.3.3 + wasm-ld** compile and link the project, then the program runs under WASI in the worker | **Run**: stdout/stderr streamed, interactive `readLine()`, compiler errors on stderr |

`swift-frontend.wasm`, `wasm-ld.wasm` and the sysroot come from Ambrus Tóth's
[swift-toolchain-wasm](https://github.com/tothambrus11/swift-toolchain-wasm),
release **`swift-6.3.3-wasm`**. It is the Swift 6.3.3 compiler frontend and
LLVM's lld, cross-compiled to run *on* a wasm32-wasip1 host, with the
patches in that repository's `patches/`. This pack does not rebuild them.
`build.sh` downloads the release assets, checks their pinned SHA-256, strips
custom sections and trims the sysroot (see "Sizes").

The status bar shows `swift-syntax-ls + swift-frontend 6.3.3 type checker`.
**SourceKit-LSP does not run** (see "Why not SourceKit-LSP"). Completion,
hover and go-to-definition are still swift-syntax-ls's syntactic guesses,
not sourcekitd's answers.

## Running (runner.js)

The contract's runner (`../CONTRACT.md`, "Running a program"). Everything
happens in the runner's worker, with no driver, because WASI cannot spawn
processes. The worker replays what `swiftc -v` would do:

1. **Load**: fetch `swift-frontend.wasm` and `wasm-ld.wasm` with
   `WebAssembly.compileStreaming`, so they compile while they download and
   the browser can cache the compiled code. Fetch `swift-sysroot.tar` too
   and unpack it into an in-memory file system (as views into the archive,
   with no copies). All three start at once, with `loading` messages.
2. **Compiling**: one whole-module invocation,
   `swift-frontend -frontend -c <every .swift file, entry first> -target wasm32-unknown-wasip1 ... -module-name main -o /build/main.o`.
   On errors, the frontend's diagnostics go to stderr (paths relative to the
   project) and the run exits with the frontend's code (1).
3. **Linking**: `wasm-ld` with the argument vector captured from `swiftc -v`
   (yukibana-swift's `pipeline.ts`). Libraries the program's imports need
   come from the object's `.swift1_autolink_entries` section, which is what
   `swift-autolink-extract` reads. So `import Synchronization`,
   `RegexBuilder` and `WASILibc` link. `--export-if-defined=fflush` lets the
   runner flush the program's stdout.
4. **Running**: the program runs as a WASI command under
   `@bjorn3/browser_wasi_shim` 0.4.2. stdout and stderr are posted as they
   are written (line-buffered by wasi-libc, as on a terminal). stdin follows
   the contract: the runner flushes stdout (`fflush(NULL)`, so a prompt
   printed with `terminator: ""` is visible), stores 1, posts `stdin` and
   blocks in `Atomics.wait`. Ctrl-D (state 3) makes `readLine()` return nil.
   A Swift runtime error (`fatalError`, index out of range, a failed `!`)
   prints Swift's own message, then traps; the runner reports
   `Program crashed: unreachable` and exits 134. The stack is 1 MiB.

**Interactive stdin requires `crossOriginIsolated`.** Without it, the app
passes no SharedArrayBuffer and `readLine()` returns nil. Compiling and
running work either way.

Whole-module or one invocation per file: measured with `tools/bench.mjs`
(Node 22, the same code, the app's two-file sample, warm). Whole-module
takes **644 ms**; two `-primary-file` invocations take **1,083 ms**. Each
invocation reloads the 16 MB `Swift.swiftmodule`, so whole-module wins at
this size. It also gives one object and one link input.

Timings in Chromium (headless, 4 shared cores under load, test-run.mjs):

| | cold (empty cache, 36.7 MB over the wire) | warm (Cache Storage) |
|---|---|---|
| load (download + compileStreaming) | 3.0 s | 1.3-1.7 s |
| compile (sample, 2 files) | 2.3 s | 1.4-2.1 s |
| link | 0.8 s | 1.0-1.4 s |
| run | <0.1 s | <0.1 s |
| total | 6.1 s | 4.2-4.5 s |

A type error is reported 2.5 s after Run (warm). Each Run is a new worker,
as the app does it, so the 113 MB module is compiled again every time. Only
the downloads are cached, and the browser's wasm code cache helps "load".
The app's service worker caches `/packs/**`, and the test uses a service
worker that does the same.

`app/src/lib/languages.ts` still says `runs: false` with the old
`cannotRun` text ("no build of the Swift compiler runs in WebAssembly"). That
file belongs to the app (this pack does not edit `app/src`), so it has to be
switched to `runs: true` there.

## Type checking (semantic diagnostics)

`server.js` answers `initialize` as soon as `swift-ls.wasm` is loaded
(about 0.2 s), as before. On the first `didOpen` it starts
`typecheck.js`, a module worker nested in the server's worker. That worker
downloads `swift-frontend.wasm` and `swift-sysroot.tar` from the same URLs as
the runner (one cached copy for both) and reports the download as
`yukibana/loading`. Then:

* 350 ms after the last edit, the server sends every open `.swift` file. The
  worker writes them under `/workspace` and runs
  `swift-frontend -frontend -emit-sil <files> ... -serialize-diagnostics-path
  /tmp/typecheck.dia` (same flags as the runner's compile; the SIL is
  discarded). `-emit-sil` rather than `-typecheck`, because the mandatory SIL
  passes find errors type checking does not: a missing return, use before
  initialisation, unreachable code. It costs about 200 ms warm instead of
  110 ms.
* Fix-its: the frontend's text output drops any fix-it that spans lines
  (`add stubs for conformance`), so the worker also returns the serialized
  diagnostics file, which `src/dia.js` reads (an LLVM bitstream reader, about
  150 lines). Each fix-it becomes a quick fix on its diagnostic, titled by
  the note it belongs to; editor placeholders (`<#code#>`) become their
  plain name, as SourceKit-LSP does for clients that apply edits.
* A result is used only if no document changed since its snapshot, so a
  superseded check is discarded. When edits arrive during a check, the
  worker runs only the newest one next. In the test, six edits inside the
  debounce produce one check, for the last text.
* The output is parsed as the frontend's LLVM-style text: `file:line:col:
  severity: message`, then the source line and a `~~~^~~` caret line, which
  gives the range. Columns are UTF-8 bytes and are converted with the
  server's position tables. Notes in project files become
  `relatedInformation`. Notes in the stdlib's generated interface (e.g.
  `Swift.Float80:2:23`) are appended to the message.
* The results are merged with swift-syntax's diagnostics (`source:
  'swift-syntax'` and `source: 'swiftc'`). The frontend's own parse errors
  are dropped when swift-syntax already reports an error in that file,
  because the two parsers recover differently and would show one missing
  `)` twice. swift-syntax's version is kept because it has the quick fix.

Measured in Chromium (test.mjs): the first type error appears **3.1 s** after
`didOpen` from a local server. That includes downloading and compiling the
frontend (the type checker was ready after 1.2 s; the first check took
1.35 s). Later checks take **0.15-0.7 s**. Under Node the same `-typecheck`
takes 80-300 ms.

If the frontend cannot load or crashes, the server logs it and the
diagnostics stay syntax-only. Every other feature is unaffected. Completion,
hover, definition, references, rename and signature help stay
swift-syntax-ls's (see the table below). Answering them from the compiler
would need sourcekitd's IDE requests (code completion, cursor info), which
`swift-frontend` cannot serve as a batch tool.

## Limits of the real compiler here

From swift-toolchain-wasm's `docs/status.md`, plus what this pack adds:

* **No macros** (`@Observable`, `#Preview`, `#expect`, any `@attached`):
  Swift runs macros as plugin executables, and WASI cannot spawn any. Such
  code fails to compile with the compiler's own error. The `Observation`
  module is therefore not shipped.
* **No Swift-in-Swift SIL passes**: the toolchain is built with
  `SWIFT_ENABLE_SWIFT_IN_SWIFT=OFF`. The compiler's Swift-written modules need
  C++ interop, and C++ interop with the wasm32-wasip1 SDK fails with a Clang
  module cycle (`SwiftWASILibc -> std_inttypes_h -> SwiftWASILibc`). I
  reproduced that cycle with the **official Swift 6.4.1 Wasm SDK** too:
  `import CxxStdlib` in a package with `.interoperabilityMode(.Cxx)` fails
  with exactly that error. Its `wasi-libc.modulemap` still reads
  `module SwiftWASILibc [system]` with `complex.h` at the top level, so the
  upstream Emscripten fix (swift#90332) has not reached WASI in 6.4.1. Programs
  compile at `-Onone`, which does not use those passes.
* **4 GiB address space** (wasm32). Single small modules fit easily.
* **No Foundation**: the release's core sysroot has no Foundation module,
  so `import Foundation` is an error ("no such module"). The standard
  library, `_Concurrency`, `_StringProcessing` (Regex), `Synchronization`,
  `RegexBuilder` and `WASILibc` work.
* No threads: `--threads=1`, and `Task`s run on the cooperative
  single-threaded executor.
* The frontend sees every open file, including ones swift-syntax-ls skips as
  too deep (see "Limits: deep and pathological code"). If the frontend
  traps on one, that check fails and the diagnostics stay syntax-only until
  the next edit.

## Sizes

What the browser downloads for Swift, raw, gzip -9 and brotli -q11
(lgwin 24, as `compress.mjs` writes them):

| file | release asset (raw / gz / br) | shipped (raw / gz / br) | what was done |
|---|---|---|---|
| `swift-frontend.wasm` | 152.7 / 37.4 / 23.0 MB | **113.1 / 32.9 / 20.1 MB** | `llvm-objcopy --strip-all`: drops `name` (35.9 MB), DWARF (4.0 MB), `producers` |
| `wasm-ld.wasm` | 59.5 / 15.3 / 9.8 MB | **41.8 / 13.0 / 8.2 MB** | same: `name` 14.1 MB, DWARF 3.7 MB |
| `swift-sysroot.tar` (was `swift-sysroot-core.tar`) | 103.4 / 21.7 / 13.5 MB | **44.3 / 13.0 / 8.4 MB** | trimmed to 314 files from 2,997 (`tools/trim-sysroot.mjs`) |
| total for Run | 315.6 / 74.3 / 46.3 MB | **199.2 / 58.9 / 36.7 MB** | -37% raw, -21% brotli |
| `runner.js` | | 34 KB / 11 KB / 9.5 KB | |
| `typecheck.js` | | 26 KB / 7.3 KB / 6.7 KB | |
| `server.js` | | 14 KB / 5.6 KB / 5.1 KB | |
| `swift-ls.wasm` | | 7.28 MB / 2.65 MB / 1.76 MB | |

* The language server alone is still 1.77 MB (brotli) before its first
  answer. Type checking adds `swift-frontend.wasm` + `swift-sysroot.tar`
  (28.5 MB brotli) in the background. Run adds `wasm-ld.wasm` (8.2 MB). The
  test measured 36.7 MB over the wire for a cold Run.
* **Hosting**: `swift-frontend.wasm` is 113 MB even stripped. That is
  over Cloudflare's 25 MiB per-asset limit for static assets, which is why
  yukibana-swift proxies the release through a Worker, and over GitHub
  Pages' 100 MB per-file limit. `serve.py` and any host without a per-file cap
  serve it as is. On such a host it would have to come from object storage
  (same origin or with CORS) or be split. Nothing here splits it.
* **Stripping** removes only custom sections: the code and data are
  byte-for-byte the same, and it takes under a second. Panics lose function
  names in stack traces. That is acceptable for a compiler that reports its
  errors as diagnostics.
* **wasm-opt** (binaryen version_133, the pinned GitHub release, not
  applied): `-O2` on the stripped `wasm-ld.wasm` took 8 min 41 s on 2 cores
  and gave 34.7 MB raw (-17%), but **8.18 MB brotli versus 8.22 MB** (-0.5%).
  It still linked and ran the sample. The code is LLVM `-O3` output already,
  and brotli removes most of what binaryen saves. On the 113 MB frontend it
  would take well over half an hour and a lot of memory for a similar ~0.1 MB
  of brotli. So `build.sh` does not run it.
* **The sysroot trim** comes from a trace. `tools/bench.mjs` wraps the
  shim's `path_open`/`path_filestat_get` while compiling the sample, a
  program importing WASILibc/Synchronization/RegexBuilder, and `-typecheck`
  runs. The trim keeps the binary `.swiftmodule` of Swift,
  SwiftOnoneSupport, _Concurrency, _StringProcessing, _RegexParser, WASILibc,
  _Builtin_float, Synchronization, RegexBuilder and _Volatile, with their
  archives. It also keeps the two `.private.swiftinterface` files the
  frontend opens on every compile (_Concurrency, _StringProcessing), the
  shims, wasi-libc's headers and libraries, and clang's portable builtin
  headers. It drops Foundation's C modules (CoreFoundation,
  _FoundationCShims and _foundation_unicode, whose module maps clang found
  and stat'ed 200+ headers of on *every* compile), libCoreFoundation,
  libxml2, the libc++ headers (1,772 files; C++ interop is off), clang's
  x86/ARM/PowerPC/... intrinsic headers (their modules `require` another
  target), `.swiftdoc` and public `.swiftinterface` files, swift-testing,
  Distributed, Observation (needs macros), _Differentiation, Cxx and the
  embedded modules. With either sysroot, the sample links to a program of
  the same size (7,325,605 bytes) and prints the same output. Compile times
  did not change measurably (warm whole-module about 0.65 s under Node
  either way), so the gain is the download.
* A prebuilt clang module cache (SwiftShims `.pcm`) was considered: it
  saves 80-300 ms on the first compile only (measured), so it is not shipped.

### Unicode data (measured)

* `swift-frontend.wasm`: LLVM's Unicode name-to-code-point table
  (`UnicodeNameToCodepointGenerated.cpp`, for clang's `\N{...}`) is
  **303 KB** raw: a 60.9 KB dictionary string and a 242 KB index. I found
  both byte-for-byte in the binary's data. Brotli brings them to **185 KB**,
  and the index is nearly incompressible (242 -> 160 KB), because it is
  already a compressed trie: LLVM's generator emits a dictionary-coded
  radix trie. The printable/width range tables are 9.4 KB (2.7 KB brotli).
  Unicode code is about 120 KB, mostly cmark's `utf8proc` case folding (72 KB
  of switch code) and Swift's grapheme-break lookup (14 KB). In all, under
  0.5 MB of 113 MB, or about 1% of the 20.1 MB brotli download.
* `wasm-ld.wasm`: no name tables (searched, not present). Only the 9.4 KB of
  ranges and `foldCharSimple` (4 KB of code).
* The stdlib's Unicode data is in `libswiftCore.a` inside the sysroot tar.
  Its objects are UnicodeScalarProps 685 KB (names 230 KB, name
  scalars 166 KB, words 84 KB, ...), UnicodeNormalization 43 KB, Word 6 KB,
  Grapheme 4.4 KB and Emoji 2.3 KB. That is **741 KB raw, 259 KB brotli**,
  or about 3% of the sysroot's 8.4 MB brotli. These tables are already
  compact: bit arrays with rank tables, looked up through a minimal perfect
  hash (`_swift_stdlib_getMphIdx`, `_swift_stdlib_getScalarBitArrayIdx`). A
  further trie rewrite would save at most part of that 259 KB, which is
  0.7% of a cold Run.
* In a linked program, **all 710 KB** of the stdlib's Unicode tables are
  kept, `--gc-sections` notwithstanding. That is 9.7% of the sample's
  7.32 MB `main.wasm`, identical (710,471 bytes, from wasm-ld's `-Map`) for
  the sample, a String-heavy program and one that reads
  `Unicode.Scalar.Properties`. Swift.o's metadata reaches every
  property accessor. Embedded Swift keeps that data in a separate
  `libswiftUnicodeDataTables.a` (present in the 6.4.1 Wasm SDK's `embedded/`
  directories), linked only on use, but this toolchain
  compiles full Swift. The program is never downloaded, though: it is built
  in the tab, so this costs a little compile and instantiate time, not
  bandwidth.

## Why not SourceKit-LSP (the evidence)


SourceKit-LSP is a front end. Every semantic answer (diagnostics beyond
syntax, completion, hover types, definition through modules) comes from
**sourcekitd**, which is the Swift compiler (C++ Swift frontend + LLVM +
an embedded Clang, plus the Swift-written parts of the compiler) behind an
XPC/in-process API. Each of these is a blocker on its own:

1. **SourceKit-LSP does not build for WASI.** With the 6.4.1 toolchain and
   Wasm SDK, `swift build --swift-sdk swift-6.4.1-RELEASE_wasm` on
   sourcekit-lsp `release/6.4.x` (commit `1c9871b`) fails in its dependency
   swift-tools-support-core, which spawns processes:

   ```text
   swift-tools-support-core/Sources/TSCclibc/include/process.h:3:10: fatal error: 'spawn.h' file not found
       3 | #include <spawn.h>
   error: Build failed
   ```

   WASI has no processes. SourceKit-LSP runs `swift build`, the build
   server and the indexer as subprocesses, and uses Dispatch and threads
   throughout (13 source files import Dispatch).
2. **It loads sourcekitd with `dlopen`** (`Sources/SourceKitD/SourceKitD.swift:191`,
   `let dlhandle = try dlopen(path.filePath, mode: dlopenModes)`). WASI has no
   dynamic loading; it would have to be relinked statically against a
   sourcekitd that does not exist for wasm.
3. **sourcekitd has no WebAssembly build.** *Corrected:* an earlier
   version of this README said that no wasm-hosted swift-frontend exists
   either. That was wrong. Ambrus Tóth's
   [swift-toolchain-wasm](https://github.com/tothambrus11/swift-toolchain-wasm)
   builds `swift-frontend` (Swift 6.3.3) and `wasm-ld` for a wasm32-wasip1
   host, and this pack now uses it, see below. Upstream is also working on an
   Emscripten-hosted toolchain (swiftlang/swift#90326, #90334 and others,
   July 2026). Neither of them builds sourcekitd or SourceKit-LSP. Points 1
   and 2 still hold for SourceKit-LSP, and so does the cost: the native
   `libsourcekitdInProc.so` of 6.4.1 is 215 MB. A sourcekitd on top of the
   wasm frontend would also need an in-process, non-XPC, non-dlopen
   embedding with no threads.

So SourceKit-LSP itself still does not run here. The real compiler does, as
a batch tool: the language server uses it for type-checking diagnostics, and
the runner uses it to compile.

## The syntax server (swift-ls.wasm)

```text
app/static/packs/swift/
  server.js            module Worker: LSP protocol, documents, UTF-16 <-> UTF-8
                       positions, a 14-function WASI shim; merges diagnostics
  swift-ls.wasm        packs/swift/server (Swift) + swift-syntax, wasm32-wasi reactor
  typecheck.js         nested worker: swift-frontend -emit-sil (diagnostics and fix-its)
  runner.js            the runner
  swift-frontend.wasm  swift-toolchain-wasm swift-6.3.3-wasm, stripped
  wasm-ld.wasm         idem
  swift-sysroot.tar    the release's swift-sysroot-core.tar, trimmed
  *.gz, *.br           compressed siblings written by build.sh
```

`swift-ls.wasm` is stripped (`llvm-objcopy --strip-all`) and optimised with
`wasm-opt -Oz` (binaryen 132 from npm). Unoptimised with debug info it is
40 MB. It loads and instantiates in about 150-200 ms. `server.js` does not
need `crossOriginIsolated`. Neither does the type checker: it has no
threads, no `SharedArrayBuffer` and no blocking reads.

How it is put together: the wasm is a WASI *reactor* exporting `yk_alloc`,
`yk_call`, `yk_output`. The worker sends `cmd\nuri\noffset\n<payload>` and
gets JSON back; the Swift side links no Foundation (JSON is written by hand),
which is what keeps it at a few MB. Offsets inside the wasm are UTF-8 bytes;
`server.js` converts to LSP's UTF-16 positions with a per-document table.
Traps are reachable with legal but pathological code (see "Limits" below).
When one happens the request fails, a fresh instance is started, and the open
documents are set into it again, each on its own. A document whose own text
traps is left out and gets one warning saying so, until it changes. The
other files keep working. An earlier version replayed the trapping document
too, outside any guard, and after that every request on every file failed.

### What works, and how far it goes

| LSP feature | what it does | real or heuristic |
|---|---|---|
| diagnostics, syntax | swift-syntax's `ParseDiagnosticsGenerator`: the compiler's own **syntax** errors and messages ("expected ')' to end function call"), on every keystroke | real |
| diagnostics, semantic | **swift-frontend 6.3.3 `-emit-sil`** (type checking + mandatory SIL passes; fix-its as quick fixes) over every open `.swift` file (see "Type checking") | real: the compiler's own errors and warnings |
| code actions | the parser's fix-its as quick fixes with edits ("insert ')'") | real |
| document symbols | outline of types, extensions, members, cases, top-level declarations | real (syntax) |
| semantic tokens | swift-syntax's `SwiftIDEUtils` classifier (keywords, types, literals, comments, attributes, `#if`) plus declaration names | real (syntax) |
| formatting | swift-syntax `BasicFormat`, run after each line's leading indentation is stripped. It inserts missing whitespace (`let a=Point(x:1)` -> `let a = Point(x: 1)`) and re-indents every line by nesting with the editor's tab size, or with tabs. It also splits one-line blocks: `if a==1{print(a)}` becomes three lines. It does not wrap long lines, and continuation lines get BasicFormat's own fixed indentation. The lines of a multi-line string literal are shifted along with the block (their indentation relative to the closing `"""`, which is what Swift strips, is kept) | real, but **basic**: not swift-format |
| definition, hover, references, highlight, rename, signature help | name resolution: local scopes by `SwiftLexicalLookup` (swift-syntax's own lexical lookup: parameters, locals, `if let`, closures, members of the enclosing type), then declarations in every open file. `a.b` resolves `b` in the type of `a`, inferred from annotations, `T(...)` initialisers, function return types, member chains, `self`, superclasses/protocols in inheritance clauses and extensions | **heuristic**: a syntactic resolver, not the type checker |
| completion | after `.`: members of the inferred type (falls back to every member in the project when the type is unknown); otherwise names in scope, every file's top-level declarations, keywords | **heuristic** |

What completion, hover and navigation do **not** do, because they would need sourcekitd:

* No standard library or SDK: `"abc".` offers nothing, `print` has no hover,
  `Int`, `String`, `Array` members are unknown; `import Foundation` is ignored.
* No type inference beyond the cases above: closures, generics, overloads,
  operators, `map { ... }` results, literals in collections other than the first
  element. Overloaded names resolve to every candidate.
* (Semantic *diagnostics* now come from the real compiler. The points
  above are about completion, hover and navigation, which are still
  answered by swift-syntax-ls alone.)
* No macros, no `#if` evaluation, no Swift packages or modules: the project is
  the open files.


## Limits: deep and pathological code

The wasm is linked with `--stack-first` and an 8 MB shadow stack
(`server/Package.swift`). Running off the end of that stack now traps at
address 0. Before, the stack was about 640 KB and sat directly above the
static data, so an overflow overwrote data and Swift metadata first, and
traps like "null function or function signature mismatch" could follow
silently wrong answers. In Chromium, though, the browser's own native stack
(about 1 MB for a worker) runs out first, because swift-syntax's parser and
its visitors (diagnostics, classifier, formatter) recurse once per tree
level. That is a `RangeError: Maximum call stack size exceeded` inside the
wasm, and the worker treats it as a trap. Three guards in the Swift code
keep files away from that edge, and the trap recovery above handles
whatever gets past them:

| input | what happens |
|---|---|
| `(`, `[` or `{` nested more than 128 deep | The parser stops at that point with its own error, "parsing has exceeded the maximum nesting level" (`Parser(maximumNestingLevel: 128)`; upstream's default is 256). |
| a syntax tree deeper than 700 levels, e.g. a member chain `a.b().b()...` of a few hundred links | The file is not analysed. It gets one warning saying why, and its queries answer nothing. The depth is measured iteratively after parsing. |
| `[` nested more than 12 deep, e.g. `[[[[...Int]]]]` | The file is not parsed: swift-syntax 604's parser is **exponential** in that depth. 16 deep takes 0.1 s, 20 takes 1.4 s, and 30 would hang the worker for about half an hour. A linear pre-scan that skips comments and strings counts the depth, and the file gets one warning. |
| an `else if` chain | Up to about 600 branches it is analysed. From about 1,000 to 2,000 branches it is skipped by the 700-level depth guard. At 5,000 and 20,000 branches the parser itself, which recurses once per branch, overflows the native stack before any guard can measure anything. That document traps and is left out with a warning ("crashed analysing this file"), and every other file keeps working. This is the one case where the trap recovery is the real guard. |

How these were measured, in Chromium 141 through the real Worker (sizes
100 to 5000 of each construct; 6 queries on the deep file, then a hover on
another file):

* Nested closures, nested `if`s and nested parens are handled up to 100
  levels. From 256 up to 5,000 the parser stops at its nesting limit.
* A long `+` chain (5,000 terms) and a long ternary chain (5,000) work.
  They are slow: 15 s and 50 s for the six queries at 5,000.
* Structs nested 128 deep are analysed. At 300 deep the parser stops at
  its nesting limit.
* With a 1,200 depth limit, a 1,000-branch `else if` chain failed one
  query, so the limit is 700.
* `test.mjs` checks four of these in the browser: a 2,000-link member
  chain, `[` nested 30 deep, a 2,000-branch `else if` chain and 300
  nested closures. It also checks that hover and definition in the other
  files still work after each one.

## Tried and left out

* **swift-format** (`swift-6.4.1-RELEASE` tag) *does* build for
  wasm32-wasi and formats correctly in the wasm (tested under Node's WASI).
  It was left out because of size: it imports all of Foundation, which links
  ICU's data (a 38.8 MB data segment); after strip + `wasm-opt -Oz` it is
  50.7 MB raw, 20.8 MB gzip, 13.3 MB brotli, i.e. 7.5 times the whole pack,
  for one feature. Switching its 42 `import Foundation` lines (and
  swift-markdown's) to `FoundationEssentials` fails to compile
  (`cannot find 'CharacterSet' in scope`), so dropping ICU would be a real
  port of two upstream packages. It could be added later as a second wasm
  fetched only on the first "Format Document"; it is not here now.
* `-Osize` instead of `-O`: 3% smaller (6.99 MB vs 7.24 MB raw, 1.72 vs
  1.76 MB brotli), not worth a second swift-syntax build configuration.

## Tests

`node test.mjs` (after `./build.sh`) serves `app/static` over plain http (no
COOP/COEP, raw files), starts `/packs/swift/server.js` as a module Worker in
Chromium (`/opt/pw-browsers/chromium`, playwright-core) and opens three files
(`Shapes.swift`: `struct Point`, `protocol Shape`; `Circle.swift`: `class
Circle: Shape` with a `Point`; `main.swift` using both). It checks the syntax
features, the deep-code guards and the type checker. Output of the last run
(after a full `./build.sh`):

```text
crossOriginIsolated: false
PASS  initialize answers, and the server says what it is  swift-syntax-ls + swift-frontend 6.3.3 type checker 0.2.0 (swift-syntax 604.0.0 on the Swift 6.4.1 Wasm SDK; diagnostics also from swift-frontend 6.3.3, swift-toolchain-wasm release swift-6.3.3-wasm) after 173 ms
PASS  yukibana/loading reports swift-ls.wasm  11 progress notifications
PASS  Shapes.swift is clean  []
PASS  Circle.swift is clean  []
PASS  main.swift is clean  []
PASS  `let x: Int = "no"` yields a type-error diagnostic from swift-frontend  ["1: cannot convert value of type 'String' to specified type 'Int'"] {"start":{"line":0,"character":13},"end":{"line":0,"character":17}} after 3052 ms (cold: downloads and compiles swift-frontend.wasm)
PASS  yukibana/loading reports swift-frontend.wasm  56 progress notifications
PASS  Shapes.swift stays clean after type checking  []
PASS  Circle.swift stays clean after type checking  []
PASS  main.swift stays clean after type checking  []
PASS  after an edit the type checker runs again (warm)  ["2: cannot convert value of type 'Int' to specified type 'String'"] 580 ms
PASS  superseded edits are not checked: diagnostics only for the last text  ["1: cannot convert value of type 'String' to specified type 'Int64'"]; target types seen: String, Int64
PASS  an introduced error is a diagnostic  ["4: expected ')' to end function call"]
PASS  the type checker's copy of the syntax error is not shown twice  ["4: expected ')' to end function call"]
PASS  it comes with a quick fix  ["insert ')'"]
PASS  completion after "c.centre." lists Point's members (Circle.swift -> Shapes.swift)  ["x","y","norm","moved"] 23 ms
PASS  hover on far.norm() shows its signature and doc comment  {"kind":"markdown","value":"```swift\n// in Point\nfunc norm() -> Double\n```\n\n---\n\nDistance from the origin."} 15 ms
PASS  go to definition of Point lands in Shapes.swift  ["file:///workspace/Shapes.swift:2:8"]
PASS  go to definition of origin.moved lands on Point.moved  ["file:///workspace/Shapes.swift:11:10"]
PASS  go to definition of c.area() lands on Circle.area  ["file:///workspace/Circle.swift:11:10"]
PASS  go to definition of a property used in a method  ["file:///workspace/Circle.swift:4:9"]
PASS  references to Point span the three files  ["file:///workspace/Shapes.swift:2:8","file:///workspace/Shapes.swift:11:48","file:///workspace/Shapes.swift:12:16","file:///workspace/Circle.swift:3:17","file:///workspace/Circle.swift:6:18","file:///workspace/main.swift:1:14"]
PASS  signature help inside origin.moved(by: 2, |1)  {"signatures":[{"label":"func moved(by dx: Double, _ dy: Double) -> Point","parameters":[{"label":"by dx: Double"},{"label":"_ dy: Double"}]}],"activeSignature":0,"activeParameter":1}
PASS  document symbols outline Shapes.swift  Point[x,y,norm,moved] Shape[area]
PASS  rename norm edits its declaration and its use  Shapes.swiftx1 main.swiftx1
PASS  formatting inserts missing whitespace  "let a = Point(x: 1, y: 2)\n"
PASS  semantic tokens for Circle.swift  23 tokens
PASS  an edit to Shapes.swift reaches completion in main.swift  ["x","y","z","norm","moved"]
PASS  formatting re-indents mixed indentation consistently  "struct A {\n    var x = 1\n    func f() {\n        return\n    }\n}\n"
PASS  rename accepts Unicode and backticked identifiers and refuses non-identifiers  [1,1,"\"not a name\" is not a Swift identifier"]
PASS  CRLF: a comment token stops before \r, and a column past a line end stays on that line  [0,0,4,4,0,1,0,5,4,0] hover past end: null
PASS  a 2000-link member chain: the server answers (skipped) and the other files still work  47 ms swift-syntax-ls does not analyse this file: its syntax tree is nested more than 700 levels
PASS  arrays nested 30 deep (exponential in the parser): the server answers (skipped) and the other files still work  32 ms swift-syntax-ls does not analyse this file: its `[` brackets nest 30 deep, and swift-synta
PASS  a 2000-branch else-if chain: the server answers (skipped) and the other files still work  156 ms swift-syntax-ls does not analyse this file: its syntax tree is nested more than 700 levels
PASS  300 nested closures: the server answers (parser nesting limit) and the other files still work  143 ms parsing has exceeded the maximum nesting level
(0 trap(s) recovered from in the cases above)
PASS  shutdown answers  ""
[log 3] swift-syntax-ls + swift-frontend 6.3.3 type checker 0.2.0 (swift-syntax 604.0.0 on the Swift 6.4.1 Wasm SDK; diagnostics also from swift-frontend 6.3.3, swift-toolchain-wasm release swift-6.3.3-wasm):
[log 3] swift-frontend 6.3.3 type checker loaded in 1220 ms
[log 4] swift-frontend -typecheck: 1 diagnostics in 1352 ms
[log 4] swift-frontend -typecheck: 1 diagnostics in 156 ms
[log 4] swift-frontend -typecheck: 1 diagnostics in 703 ms
[log 4] swift-frontend -typecheck: 1 diagnostics in 450 ms
PASS  the worker raised no errors  []
all passed
```

`node test-run.mjs` serves `app/static` with COOP/COEP (so the page is
`crossOriginIsolated`) and the `.br` siblings, as the app's host does. A
service worker caches `/packs/` the way the app's does. The test runs the
runner as the app does and drives stdin through the SharedArrayBuffer from
the page:

```text
PASS  the page is crossOriginIsolated and controlled by a service worker that caches /packs/
PASS  sample project (cold): main.swift + Geometry.swift print the distance and the norm, exit 0  "(0.0, 0.0) to (3.0, 4.0): 5.0\n5.0\n" code=0 in 6116 ms, 36.7 MB transferred; Loading the Swift compiler@22, Compiling@3008, Linking@5286, Running@6085
PASS  loading messages for each download  wasm-ld.wasm 41774304/41774304, swift-sysroot.tar 44339200/44339200, swift-frontend.wasm 113085926/113085926
PASS  sample project (warm #1): same output from the browser cache  code=0 in 4497 ms, 0 bytes transferred; Loading the Swift compiler@47, Compiling@1329, Linking@3424, Running@4470
PASS  sample project (warm #2): same output from the browser cache  code=0 in 4239 ms, 0 bytes transferred; Loading the Swift compiler@34, Compiling@1691, Linking@3075, Running@4193
PASS  readLine(): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 3452 ms; Loading the Swift compiler@41, Compiling@1523, Linking@2609, Running@3423
PASS  end of input (Ctrl-D) makes readLine() return nil  code=0 "got one\ngot two\nend of input after 2 lines\n" requests=3
PASS  type error: swift-frontend diagnostics on stderr, non-zero exit, not run  code=1 2520 ms
main.swift:1:14: error: cannot convert value of type 'String' to specified type 'Int'
let x: Int = "no"
             ^~~~
PASS  runtime error: index out of range is reported and exits non-zero  code=134 "before\n"
Swift/ContiguousArrayBuffer.swift:692: Fatal error: Index out of range

Program crashed: unreachable
PASS  endless loop: terminated by the page, which stays responsive  stopped after 4445 ms; Loading the Swift compiler@22, Compiling@1603, Linking@2761, Running@3424
all passed
```

`tools/bench.mjs` runs the same pipeline under Node to time it and to trace
file accesses (see "Sizes").

## Building

`./build.sh` (idempotent; `JOBS=3` by default, runs under `nice`). It
downloads, checksum-verifies (SHA-256 pinned in the script) and caches in
`~/.cache/yukibana-packs/swift`:

* `swift-6.4.1-RELEASE-ubuntu24.04.tar.gz` (official toolchain, unpacked
  ~3.5 GB, x86_64 Linux host): for swift-ls.wasm and for `llvm-objcopy`.
* `swift-6.4.1-RELEASE_wasm.artifactbundle.tar.gz` (official Wasm SDK).
* `swift-frontend.wasm.gz`, `wasm-ld.wasm.gz`, `swift-sysroot-core.tar.gz`
  from the swift-toolchain-wasm release **`swift-6.3.3-wasm`** (74 MB). That
  was what `releases/latest` resolved to on 2026-10-23. The tag is rebuilt
  in place upstream, so the script pins the SHA-256 of each `.gz` and of each
  decompressed file. A rebuilt release fails the build loudly instead of
  changing the bytes.

Then `npm ci` (binaryen 132.0.0 for swift-ls.wasm's `wasm-opt`, esbuild,
playwright-core, `@bjorn3/browser_wasi_shim` 0.4.2), `swift build` of
`server/`, strip and `wasm-opt -Oz` of swift-ls.wasm, `llvm-objcopy
--strip-all` of the two tools, `tools/trim-sysroot.mjs`, esbuild (`runner.js`
and `typecheck.js` are bundled with `src/toolchain.js` and the WASI shim, and
the decoded artifact sizes are injected for the progress bars), and `.gz`/`.br`.

Times on this shared 4-core machine: a full run with swift-syntax already
built and the downloads cached took **12 min** (swift-ls.wasm's
`wasm-opt -Oz` about 3 min; brotli -q11 of the 200 MB of toolchain about
8 min, most of it `swift-frontend.wasm`). Downloading the toolchain-wasm
assets takes seconds. Stripping takes under 1 s and trimming about 1 s. A
first build from nothing also needs the 1.2 GB Swift download and about 8 min
of swift-syntax. Compressed siblings that are newer than their source are
reused, so a build with nothing to do takes about 1 min.

No upstream code is patched by this pack. `server/Package.resolved` pins
swift-syntax.

## Where the code came from

* `src/toolchain.js` ports tothambrus11/yukibana-swift
  `packages/runtime/src` (same owner):
  * the frontend and `wasm-ld` argument vectors and the stdlib link list
    (`pipeline.ts`, captured from `swiftc -v`);
  * the tar reader (`tar.ts`; here zero-copy, with pax `path` support);
  * the "every tool is a WASI command over one in-memory file system"
    runner (`run.ts`, `vfs.ts`, `wasm-backend.ts`);
  * the same WASI library, `@bjorn3/browser_wasi_shim`.

  New here: whole-module compilation instead of one `-primary-file`
  invocation per file, the autolink-section reader, `-typecheck`, the trace
  and trim, and blocking stdin with stdout flushing.
* `test-run.mjs` is adapted from `../cpp/test-run.mjs`.
* `swift-frontend.wasm`, `wasm-ld.wasm` and the sysroot are
  swift-toolchain-wasm's release assets, stripped and trimmed. Their source
  and patches are in that repository.

## Files

* `server/Sources/YKSwift/Workspace.swift`: the index, the expression typer,
  name resolution (with `SwiftLexicalLookup`).
* `server/Sources/YKSwift/Server.swift`: the queries, JSON output, wasm exports.
* `src/server.js`: the LSP worker, including the type-check scheduling and
  the diagnostic merge.
* `src/typecheck.js`: the type checker's worker.
* `src/runner.js`: the runner.
* `src/toolchain.js`: the shared pipeline (arguments, file system, tar,
  WASI, downloads, autolink).
* `tools/trim-sysroot.mjs`, `tools/bench.mjs`.
* `build.sh`, `compress.mjs`, `test.mjs`, `test-run.mjs`.
