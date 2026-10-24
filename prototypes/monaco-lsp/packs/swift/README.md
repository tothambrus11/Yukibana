# Swift pack: sourcekitd 6.3.3 and the Swift 6.3.3 compiler, in one wasm module

The language server is **sourcekitd**, the same one SourceKit-LSP drives,
running in the browser. It answers through **sourcekit-lsp-lite**, a small
LSP server over sourcekitd's C API, and both are linked with the Swift
compiler into **one** WebAssembly module, `swift-frontend-lsp.wasm`, which
the language server and the runner share. The pieces:

| part | what it is | what it does |
|---|---|---|
| `server.js` + `swift-frontend-lsp.wasm` (its `lsp_*` exports, `src/lite.js`) | **sourcekit-lsp-lite over sourcekitd 6.3.3**, from Ambrus Tóth's [swift-toolchain-wasm](https://github.com/tothambrus11/swift-toolchain-wasm) (`tools/sourcekit-lsp-lite`) | diagnostics (type checking and the mandatory SIL passes) with fix-its as quick fixes, completion (members, implicit members such as `.sad()`, plain names, keywords, with snippets and doc comments), hover, definition, references, document highlight, rename (base names), signature help, document symbols, inlay type hints |
| `server.js` + `swift-ls.wasm` | a small stateless module on Apple's [swift-syntax](https://github.com/swiftlang/swift-syntax) 604.0.0 | **formatting** and **semantic tokens**, which sourcekitd does not give |
| `runner.js` | `swift_frontend_main` of the same module, then **wasm-ld**; the program runs under WASI in the worker | **Run**: stdout/stderr streamed, interactive `readLine()`, compiler errors on stderr; **Test** with the browser's XCTest and with swift-testing |
| `SwiftMacroPlugins.wasm` | Observation's, swift-testing's and the example `StringifyMacros` macro plugins, built for WASI by swift-toolchain-wasm | **macros** (`@Observable`, `@Test`, `#expect`, `#stringify`), expanded for the editor and the runner alike; fetched only by projects that use one |

`swift-frontend-lsp.wasm`, `wasm-ld.wasm` and the sysroot come from
swift-toolchain-wasm: the Swift 6.3.3 compiler frontend, sourcekitd and
LLVM's lld, cross-compiled to run *on* a wasm32-wasip1 host, with the
patches in that repository's `patches/`. This pack does not rebuild them.
`build.sh` takes them from a release (SHA-256 pinned) or from a local
directory (`SWIFT_TOOLCHAIN_DIR`), strips custom sections and trims the
sysroot (see "Sizes" and "Building"). Since release `swift-6.3.3-wasm-3` the
compiler expands **macros**, in the editor and in Run and Test alike (see
"Macros").

The status bar shows `sourcekit-lsp-lite (sourcekitd 6.3.3) + swift-syntax
formatting`. **SourceKit-LSP itself does not run** (see "SourceKit-LSP and
sourcekit-lsp-lite"): it is a Swift program that spawns processes and
`dlopen`s sourcekitd. sourcekit-lsp-lite replaces it with the requests an
editor needs, mapped the way SourceKit-LSP maps them; what it maps and what
it leaves out is swift-toolchain-wasm's `docs/status.md`,
"sourcekit-lsp-lite".

## Running (runner.js)

The contract's runner (`../CONTRACT.md`, "Running a program"). Everything
happens in the runner's worker, with no driver, because WASI cannot spawn
processes. The worker replays what `swiftc -v` would do:

1. **Load**: fetch `swift-frontend-lsp.wasm` and `wasm-ld.wasm` with
   `WebAssembly.compileStreaming`, so they compile while they download and
   the browser can cache the compiled code. It is the module the language
   server already downloaded, so after editing, Run fetches only
   `wasm-ld.wasm` (the URLs are the same, and the app's service worker
   caches `/packs/**`). Fetch `swift-sysroot.tar` too
   and unpack it into an in-memory file system (as views into the archive,
   with no copies). All three start at once, with `loading` messages.
2. **Compiling**: one whole-module invocation,
   `swift-frontend -frontend -c <every .swift file, entry first> -target wasm32-unknown-wasip1 ... -module-name main -o /build/main.o`,
   as the module's `swift_frontend_main(argc, argv)` export in a fresh
   instance (`runFrontend` in `src/toolchain.js`: the compiler shuts LLVM
   down when it returns, so an instance compiles once).
   On errors, the frontend's diagnostics go to stderr (paths relative to the
   project) and the run exits with the frontend's code (1).
3. **Linking**: `wasm-ld` with the argument vector captured from `swiftc -v`
   (yukibana-swift's `pipeline.ts`). Libraries the program's imports need
   come from the object's `.swift1_autolink_entries` section, which is what
   `swift-autolink-extract` reads, and from those of the archives they name,
   transitively, as far as the sysroot has them (`linkLibraries`). So
   `import Synchronization`, `RegexBuilder`, `WASILibc`, `Observation` and
   `Testing` link. `--export-if-defined=fflush` lets the
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

**Tests**: `{ type: 'test' }` instead of `run` compiles the project's XCTest
tests with a generated main and runs them (see "Tests with XCTest").

**Interactive stdin requires `crossOriginIsolated`.** Without it, the app
passes no SharedArrayBuffer and `readLine()` returns nil. Compiling and
running work either way.

Whole-module or one invocation per file: measured with `tools/bench.mjs`
(Node 22, the same code, the app's two-file sample, warm, with the
separate `swift-frontend.wasm` of before). Whole-module took **644 ms**; two
`-primary-file` invocations took **1,083 ms**. Each invocation reloads the
16 MB `Swift.swiftmodule`, so whole-module wins at this size. It also gives
one object and one link input. With `swift-frontend-lsp.wasm` a warm
whole-module compile of the sample is 1.5-1.7 s under Node on this machine
while other builds ran.

Timings in Chromium (headless, 4 shared cores under load, test-run.mjs):

| | cold (empty cache, 37.9 MB over the wire) | warm (Cache Storage) |
|---|---|---|
| load (download + compileStreaming) | 2.8 s | 1.2-1.5 s |
| compile (sample, 2 files) | 2.3 s | 0.9-1.8 s |
| link | 1.4 s | 0.7-0.9 s |
| run | <0.1 s | <0.1 s |
| total | 6.6 s | 2.9-4.2 s |

A type error is reported 1.5 s after Run (warm). Each Run is a new worker,
as the app does it, so the 136 MB module is compiled again every time. Only
the downloads are cached, and the browser's wasm code cache helps "load".
The app's service worker caches `/packs/**`, and the test uses a service
worker that does the same.

## Macros

Swift runs a macro by sending its syntax to a *plugin*, a program or
library built on swift-syntax, and splicing in what comes back. On a WASI
host there is nothing to spawn or `dlopen`, so swift-toolchain-wasm's
compiler (patch `0003`, its `docs/status.md` "Macros") hands every plugin
message to its embedder, through two imports, `swift_plugin_host.handle_message`
and `take_response`, and its plugins are wasm modules of their own. This
pack is that embedder:

* **Every instance of `swift-frontend-lsp.wasm`** (each compile, each
  sourcekitd) is instantiated with a `SwiftPluginHost`
  (`src/vendor/swift-plugin-host.mjs`, the release's file, checked by
  SHA-256 in `build.sh`) next to the WASI imports, and the host is given
  the instance's memory (`pluginHost` in `src/toolchain.js`). The module
  imports them whether or not the code uses a macro.
* **One plugin module, `SwiftMacroPlugins.wasm`**: Observation's
  `ObservationMacros` (`@Observable`, `@ObservationTracked`,
  `@ObservationIgnored`), swift-testing's `TestingMacros` (`@Test`,
  `@Suite`, `#expect`, `#require`, ...) and the example `StringifyMacros`
  (`#stringify`, and `DiagnoseMacro`, which reports an error), sharing one
  swift-syntax. Every compile and sourcekitd get
  `-load-resolved-plugin /sysroot/plugins/SwiftMacroPlugins.wasm##StringifyMacros,ObservationMacros,TestingMacros`.
  The compiler asks for the plugin when it first expands one of its macros;
  the host compiles the module it finds at that path in the worker's file
  system (once per worker, ahead of time when it is fetched) and runs it.
* **Fetched only when a macro can be used** (`usesMacroPlugins`): a file
  that imports `Observation` or `Testing`, or declares a macro with
  `#externalMacro(module: "StringifyMacros" | ...)`. The language server
  fetches it before such a file reaches sourcekitd, the runner before it
  compiles. Projects without macros download nothing more. Without the file
  a macro use is the compiler's own error ("external macro implementation
  type ... could not be found ...; No such file or directory").
* **In the editor** a macro's use type-checks like any code: no
  diagnostics on correct code, hover on `@Observable` or `#stringify` shows
  the macro and its documentation, hover and completion inside a macro's
  arguments and on what it generates work (`counter.` offers `count` and the
  generated `access(keyPath:)`). **Diagnostics** of a macro are reported at
  its use: an error a plugin reports ("'@Observable' cannot be applied to
  struct type 'NotAClass' (from macro 'Observable')"), and an error in the
  generated code ("invalid redeclaration of '_x'" on the property whose
  generated storage it clashes with). A related note that points *into* an
  expansion (a buffer such as `@__swiftmacro_4main5ClashC1x18ObservationTrackedfMp_.swift`,
  which SourceKit-LSP shows as a document of its own and this editor
  cannot open) is kept at the diagnostic's range, its message ending "(in
  a macro expansion)" (`inExpansion` in `src/server.js`). There is no
  "expand macro" refactoring: sourcekit-lsp-lite does not map refactoring
  actions.
* **Run** links what the expansions use: `@Observable` code links
  `libswiftObservation.a`, which the trimmed sysroot keeps (0.2 MB).
* **Test** runs swift-testing too (below, "swift-testing").

**One fix in this pack was needed for it**: `@bjorn3/browser_wasi_shim`
0.4.2 answers `path_readlink` with ENOTSUP, and the compiler resolves a
plugin's path with `realpath()`, so every macro failed with "...; Not
supported". The pack's root preopen answers as POSIX does (EINVAL: not a
link) instead (`preopenRoot` in `src/toolchain.js`).

### swift-testing

swift-testing runs, not only type-checks. A file that imports `Testing` is a
test file (left out of Run, like an XCTest file), and **Test** runs its
`@Test` functions after the project's XCTest tests, in a second run of the
same program with `--testing-library swift-testing`, as `swift test` does;
the exit code is non-zero if either fails. The generated `main.swift` calls
`Testing.__swiftPMEntryPoint()` for that run, which is what SwiftPM's
generated test runner calls; swift-testing finds the tests itself (the
`@Test` macro registers them). Its report is swift-testing's own
(`✔ Test norm() passed`, `✘ Test wrong() recorded an issue at
CounterTests.swift:17:5: Expectation failed: (counter.count → 1) == 2`, `Test
run with 3 tests in 0 suites failed`), on stderr as in a terminal.

It needs `swift-testing.tar`, fetched only by projects that import
`Testing` (the language server needs it too, for the module): Testing's
module from the Swift 6.3.3 Wasm SDK (its `.swiftinterface`; the SDK ships
no binary module, so the compiler builds it into the module cache on first
use, about 2.5 s once per worker) and the archives a test program links.
**What it costs**: 21.9 MB raw, **3.3 MB brotli** (5.3 MB gzip), and a test
program of about 19 MB. The toolchain's own smoke test links 62 MB (20.5 MB
gzipped) because it follows `libTesting.a`'s autolink entries to Foundation,
FoundationInternationalization, CoreFoundation and ICU (`lib_FoundationICU.a`
alone is 41.7 MB). None of their symbols is reached without `import
Foundation`, which this sysroot does not offer, so the pack ships only
`libTesting.a`, `_TestDiscovery`, `_TestingInternals`, `_TestingInterop`,
`FoundationEssentials` (JSON coding), `_FoundationCShims` and
`_FoundationCollections`, and links what the sysroot has (`linkLibraries`);
a library that were really needed and missing would fail the link with its
symbols named. That made running swift-testing worth shipping as a lazy
download rather than type-checking only.

## Tests with XCTest (xctest/, src/xctest.js)

The sysroot has no XCTest. The real one (swift-corelibs-xctest) does run on
WASI, but it imports Foundation: a trivial test binary is 53.7 MB. So the
pack has its own **`XCTest` module, written for this pack, with no Foundation**
(`xctest/XCTest/*.swift`, about 700 lines). Students write
`import XCTest`, and the same file compiles unchanged against the real
XCTest on a grading server.

**Its public API is a subset of swift-corelibs-xctest's** (tag
`swift-6.4.1-RELEASE`; the public API of `swift-6.3.3-RELEASE` is the same).
Every declaration has the same signature, defaults included (`file:
StaticString = #file`, not `#filePath`). `tools/xctest-subset.mjs` checks
this mechanically (below). The 56 declarations:

* `XCTestCase`, a subclass of `XCTest`: `name`, `testCaseCount`,
  `setUp()`, `tearDown()`, `setUpWithError()`, `tearDownWithError()`,
  `setUp() async throws`, `tearDown() async throws`, `class func setUp()`,
  `class func tearDown()`, `addTeardownBlock(_:)` (sync and async),
  `continueAfterFailure`,
  `recordFailure(withDescription:inFile:atLine:expected:)`,
  `required init(name:testClosure:)`. `XCTest` has `init()`.
* Assertions: `XCTAssert`, `XCTAssertTrue`, `XCTAssertFalse`,
  `XCTAssertEqual` and `XCTAssertNotEqual` (Equatable, plus the
  `accuracy:` overloads for FloatingPoint and Numeric), the deprecated
  `XCTAssertEqualWithAccuracy` and `XCTAssertNotEqualWithAccuracy`,
  `XCTAssertGreaterThan`, `XCTAssertGreaterThanOrEqual`, `XCTAssertLessThan`,
  `XCTAssertLessThanOrEqual`, `XCTAssertNil`, `XCTAssertNotNil`,
  `XCTAssertIdentical`, `XCTAssertNotIdentical`, `XCTAssertThrowsError` (both
  overloads, one of them `rethrows`), `XCTAssertNoThrow`, `XCTUnwrap`,
  `XCTFail`.
* Skips: `XCTSkip` (`init(_:file:line:)`, `message`), `XCTSkipIf`,
  `XCTSkipUnless`.
* Running: `XCTMain(_:)`, `XCTMain(_:arguments:)`, `testCase(_:)` (throwing
  and non-throwing lists), `asyncTest(_:)`, `XCTestCaseEntry`,
  `XCTestCaseClosure`.

**Left out**, because the signature needs a type this module cannot have:
expectations and waiting (`XCTestExpectation`, `wait(for:timeout:)`,
`XCTWaiter`: Foundation's `TimeInterval`, `NSPredicate`, `Notification`),
`measure` (`XCTPerformanceMetric`), `XCTestRun` and its subclasses,
`XCTestSuite`, observation (`XCTestObservation`, which takes `Bundle`),
`XCTestError`, and `XCTest.run()`, `perform(_:)`, `testRun`, `testRunClass`
and `invokeTest()`, which hand out `XCTestRun`. Also left out is the
`XCTMain(_:arguments:observers:)` pair. A test that uses any of these does
not compile here, but it still compiles on the grader.

**What it prints** is corelibs' `PrintObserver` format: `Test Suite 'All
tests' started at …`, `Test Case 'CalcTests.testAdd' started at …`,
`file:line: error: CalcTests.testAdd : XCTAssertEqual failed: ("4") is
not equal to ("5") - message`, `… passed (0.001 seconds)`, and the
`Executed N tests, with M failures (K unexpected) in …` summaries. The
process exits 1 if anything failed and 0 otherwise. A thrown error is
`<EXPR>:0: error: … : threw error "…"`. The order of setUp, the test,
teardown blocks (last first), tearDown and the async variants is also
corelibs'. `xctest/conformance/Behaviour.swift`
(failing and passing assertions, throwing expressions, XCTUnwrap, skips,
lifecycle order, async, a failing and a skipping setUp) prints the same 74
lines as the real XCTest, apart from dates and times. That is checked twice:
natively against the real library, and in Chromium against the stored
`Behaviour.expected`.

**Differences from corelibs on Linux**:

* Tests run inside a `Task`. `XCTMain` is synchronous and returns `Never`,
  as it is on Linux. It starts the run in a Task and hands the thread to the
  concurrency runtime (`swift_task_asyncMainDrainQueue`, which an `async`
  main also uses). So async setUp/tearDown, async teardown blocks and
  `asyncTest` work on one thread without XCTWaiter. That is what corelibs'
  WASI build does, but its `XCTMain` is `async` there, and this module
  follows Linux, where tests are graded.
* Timestamps are UTC, because WASI has no time zone. The bundle suite is
  `main.xctest`, and the runner passes no arguments.
* The module imports no libc. Three C functions are declared with
  `@_extern(c)` (`exit`, `fflush`, `gettimeofday`), and the date is computed
  by hand. With `import WASILibc` in the module, every `import XCTest` loaded
  WASILibc and parsed wasi-libc's headers. Measured under Node with the
  pack's frontend, a warm compile of `import XCTest; print(1)` took 983 ms
  that way. Now it takes 219 ms, against 271 ms for `print(1)`, so importing
  XCTest costs nothing measurable.

### Running tests: the `test` message

This is the smallest change to the contract (`../CONTRACT.md`). The runner
also accepts **`{ type: 'test', files, entry, stdin }`**, which has the same
fields as `run`, and answers with the same messages (`loading`, `phase`,
`stdout`, `stderr`, `exit`). The phase says `Testing` instead of `Running`.
The report goes to stdout, and the exit code is 0 only if every test
passed. What it compiles:

* every `.swift` file of the project except files named `main.swift` (the
  program's entry point would be a second one), plus a generated
  `main.swift` that calls `XCTMain([...])`. If a `main.swift` calls `XCTMain`
  itself (a LinuxMain-style list), that file is used instead.
  If a file imports `Testing`, the generated `main.swift` also runs
  swift-testing, in a second run of the program ("Macros", "swift-testing").
* **Discovery** (`src/xctest.js`) scans the source text. It strips comments
  (nested ones too) and string literals (multi-line, raw, interpolated), and
  follows braces. It finds subclasses of `XCTestCase` (transitively, nested
  as `Outer.Name`, with extensions) and their `func test…()` methods: no
  parameters, returning nothing, not static, class or private, async or
  throws allowed (`asyncTest(...)` is generated for async ones), inherited
  ones included. Generic and private classes are skipped. A class that
  declares its own `static var allTests` gets `testCase(Name.allTests)`, so
  that list runs exactly as it does on Linux. The generated list is typed
  `as [(String, (Name) -> () throws -> Void)]`, so the type checker never
  has to search the overloads.
* **Module name.** Tests written for SwiftPM say `@testable import App`.
  Here the project and its tests are one module, so if the project's files
  `@testable import` exactly one name that is not a known module, the
  project is compiled as that module. The import then refers to the module
  being compiled, which the compiler accepts with a warning ("is part of
  module 'App'; ignoring import"). The runner and the type checker drop that
  warning. The file stays unchanged for the grader.
* Failure locations are `#file`, the absolute path the frontend was given.
  A test run shows them relative to the project (`Tests/CalcTests.swift:5:
  error: …`), as diagnostics are.
* A plain **`run`** leaves out every file that imports XCTest except the
  entry, the way SwiftPM leaves the test target out of the executable. A
  project with tests still runs its program, and does not download XCTest.

The language server loads XCTest too, into sourcekitd's sysroot and the SIL
check's, the first time an open file imports it, and sourcekit-lsp-lite
names the module the same way (its `moduleName` rule is
`projectModuleName`'s). So `import XCTest` and `@testable import App` are
not errors in the editor, and the compiler's warning that a file "is part of
module 'App'; ignoring import" is dropped from both.

### How it ships

`swift-xctest.tar` (230 KB, **63 KB brotli**) holds the module's binary
`XCTest.swiftmodule` and `libXCTest.a`. It is unpacked over the sysroot
only when the project imports XCTest. It is a file of its own, so a change
to it does not invalidate the 44 MB sysroot in caches. `build.sh` builds it
with **the pack's own `swift-frontend-lsp.wasm` under Node**
(`tools/build-xctest.mjs`: one whole-module `-c -O` with
`-emit-module-path`, about 13-17 s), because a binary module loads only in
the compiler that wrote it. `-module-link-name XCTest` makes `import XCTest`
add `-lXCTest` to the object's autolink entries, so the runner links it with
no special case. `libXCTest.a` is made by `llvm-ar` from the native
toolchain, because wasm-ld wants an archive index.

A `.swiftinterface` that 6.3.3 builds itself was measured and rejected.
Building it fails: `open class XCTest` shadows the module `XCTest`
(swift#56573: the interface says `XCTest.XCTestCase`, which resolves to the
class), and corelibs does not ship one for the same reason. It would also
cost 0.5-0.7 s per new worker, and it would still need a prebuilt object.
With the binary module, a client type-checks `import XCTest` in 170-200 ms
from a fresh module cache.

Times in Chromium (test-run.mjs, warm, 4 shared cores under load): the
student project (3 files, 5 tests) runs in 3.9 s (compile 1.7 s, link
0.6 s; 5.2 s with the machine busier), about as long as Run on the sample. The 140-line behaviour
corpus takes 6.5 s, of which 4.2 s is compiling its many generic assertions.

### The subset check

`npm run test:xctest` (`node tools/xctest-subset.mjs`, after `./build.sh`)
needs the Swift 6.4.1 Linux toolchain that `build.sh` already downloads. That
toolchain ships the real XCTest. The check fetches swift-corelibs-xctest at
`swift-6.4.1-RELEASE` with git into the pack cache. It runs in about 6 s,
and each check can fail on its own:

1. **swift-api-digester** dumps our module (built natively) and the
   toolchain's XCTest, then runs `-diagnose-sdk` with ours as the baseline.
   A declaration of ours that is missing or changed in the real one (type,
   generic signature, rethrows, static, open, superclass, conformance) is a
   breaking change.
2. **Symbols**: every declaration in our dump needs one in the real dump
   with the same USR (the mangled name, which covers `@autoclosure`,
   `@escaping` and `@Sendable`, things the digester's diagnosis does not
   compare), the same parameter types, the same default-argument flags and
   the same attributes.
3. **Source**: the header text of every public declaration of ours
   (attributes, labels, types, default values) must equal, whitespace aside,
   a declaration in corelibs' `Sources/XCTest`, counting both `#if`
   branches. This is the check that catches `#filePath` for `#file`.
4. **Conformance corpus** `xctest/conformance/API.swift` binds every
   function to its exact type (`let _: (@autoclosure () throws -> Int,
   @autoclosure () -> String, StaticString, UInt) throws -> Int =
   XCTUnwrap`), overrides every open member and calls everything with all
   arguments and with only the required ones. It must type-check
   (`-warnings-as-errors`) against ours natively, against the real XCTest,
   and against ours as the browser has it (swift-frontend-lsp.wasm 6.3.3 and
   swift-xctest.tar). It must also mention every public name of ours.
5. **Behaviour**: `Behaviour.swift` is built and run natively against both
   libraries, and the two reports must match line for line. The real report
   must also equal `Behaviour.expected`, which test-run.mjs holds the
   browser to. `UPDATE=1` rewrites it.

Each check was tested by mutation. Dropping `@autoclosure` from
`XCTAssertNil` fails 2, 3 and 4 (but not 1). `#filePath` instead of `#file`
fails only 3. An extra `public func` fails 1, 2, 3 and the corpus coverage.
A changed failure text fails 5. Output of the last run:

```text
PASS  api-digester: no declaration of ours is removed or changed in the real XCTest
PASS  symbols: all 56 declarations of ours have the same USR and shape in the real XCTest
PASS  source: all 56 public declarations of ours are written exactly so in swift-corelibs-xctest swift-6.4.1-RELEASE
PASS  corpus: API.swift type-checks against ours (native Swift 6.4.1)
PASS  corpus: API.swift type-checks against the real XCTest (native Swift 6.4.1)
PASS  corpus: API.swift type-checks against ours as the browser has it (swift-frontend-lsp.wasm 6.3.3, swift-xctest.tar)
PASS  corpus: API.swift uses all 39 public names of ours
PASS  behaviour: Behaviour.swift prints the same 74 lines and exits the same with both
PASS  behaviour: the real XCTest's report is xctest/conformance/Behaviour.expected (which test-run.mjs checks the browser against)
```

## The language server (sourcekitd)

`server.js` answers `initialize` as soon as `swift-ls.wasm` is loaded
(about 0.15 s), advertising what sourcekit-lsp-lite serves plus formatting
and semantic tokens. It then fetches `swift-frontend-lsp.wasm` (compiled
while it downloads) and `swift-sysroot.tar`, reported as `yukibana/loading`,
and starts one instance of the module (`src/lite.js`):

* **One instance, a message at a time.** The module is a WASI reactor:
  `lsp_handle(message)` takes one JSON-RPC message and returns what the
  server sends back; sourcekitd runs inside it, single-threaded, on
  cooperative queues. `server.js` queues every request and document change
  for it in arrival order behind the download; a request cancelled before
  its turn (`$/cancelRequest`, which Monaco sends when the user keeps typing)
  is answered as cancelled and not run.
* **Diagnostics as idle work.** sourcekit-lsp-lite diagnoses open files in
  `lsp_idle`, one file per call. `server.js` calls it 250 ms after the last
  message, one file per turn of the queue, so a request that arrives
  meanwhile goes first. Each diagnostic carries its fix-its as quick fixes
  (`codeActions`, the way clangd sends them; `textDocument/codeAction` hands
  them back): the diagnostic's own fix-its as one preferred action ("Insert
  ','"), each note's as an action titled by the note ("Add stubs for
  conformance"), editor placeholders (`<#code#>`) as their plain name.
* **Files.** sourcekitd and the compiler read the project from an in-memory
  file system: the sysroot at `/sysroot`, every open document mirrored at
  `/workspace` (where sourcekit-lsp-lite finds the module's other files),
  scratch space in `/tmp`. Open documents' unsaved text also reaches
  sourcekitd through a `-vfsoverlay` sourcekit-lsp-lite writes. The compiler
  arguments are `src/toolchain.js` `sourceKitArgs()`; the module is named
  `main`, or by a test file's `@testable import`, as the runner names it.
* **XCTest.** The first time a document imports XCTest, `swift-xctest.tar`
  is fetched and unpacked over sourcekitd's sysroot before that document
  reaches it.
* **Crashes.** A trap in sourcekitd (an assertion, the browser's native
  stack running out in deeply recursive code) kills the instance. The
  document changed last is blamed: it is left out of `/workspace` and of the
  server with one warning saying so, a fresh instance is started with the
  other documents, and the request that crashed is asked once more of it. A
  document that is left out answers nothing from sourcekitd until its text
  changes; formatting and semantic tokens still work.
* **Files too deep to parse.** The compiler's parser takes time exponential
  in how deep `[` nests (see "Limits: deep and pathological code"); a
  document deeper than 16 is left out the same way, before sourcekitd sees
  it, because a parse that takes minutes would hold up every other request.

What answers what:

| LSP request | from | notes |
|---|---|---|
| diagnostics | sourcekitd | the compiler's own errors, warnings and fix-its, from type checking and the mandatory SIL passes (see below) |
| completion | sourcekitd's code completion | members (`xs.` on `[Int]`, `$0.` in an unclosed closure, `xs.first.` with `?.` edits for the wrapped type's members), implicit members (`.sad()` where an `Int` is expected, enum cases in `let m: Mood = .` and `feel(.)`), names in scope, keywords; filtered by what is typed; methods as snippets; the doc comment's summary on the item |
| hover | sourcekitd's cursor info | the declaration (inferred types: `let total: Int`) and the full doc comment, standard library included |
| definition | cursor info | project declarations in any file; a standard-library declaration has no source here, so the answer is empty |
| references, document highlight | cursor info + related identifiers in every project file | resolved by the type checker, so two unrelated `x` are told apart |
| rename, prepare rename | the same occurrences | base names only, see "Limits" |
| signature help | sourcekitd's signature help | every overload, with the active parameter |
| document symbols | sourcekitd's document structure | `norm()`, `moved(by:_:)`, as SourceKit-LSP names them |
| inlay hints | sourcekitd's variable types | `: Type` after a declaration without one |
| code actions | the diagnostics' fix-its | quick fixes |
| formatting | swift-ls.wasm (swift-syntax `BasicFormat`) | sourcekitd has no formatter; see "swift-ls.wasm" |
| semantic tokens | swift-ls.wasm (swift-syntax's classifier) | sourcekitd's semantic highlighting is not mapped by sourcekit-lsp-lite |

Latencies, warm, under Node 22 on a shared 4-core machine with other builds
running (`tools/bench.mjs`, the two-file sample; one instance, as the
browser has it): diagnostics of a file 305 ms (1,074 ms the first time,
which loads the standard library), completion after `b.` 225-372 ms,
hover 251 ms, definition 62 ms, references 605 ms (every file is searched),
document highlight 1 ms, rename 9 ms, signature help 394 ms, document
symbols 3 ms, inlay hints 6 ms. In Chromium (test.mjs) see "Tests".

## Diagnostics include the SIL passes

sourcekitd 6.3.3's diagnostics request runs the mandatory SIL passes as
well as the type checker, so what only those passes find is reported while
typing: a missing return, a value used before it is initialised, a `let`
assigned twice, code after `return`, overlapping `inout` accesses, a
non-exhaustive `switch`, an initializer that returns before setting every
stored property, and the constant folding of mandatory inlining (`1 / 0`,
`Int8(127) + 1`). Compared on one file against the compiler's own
`-emit-sil`, sourcekitd reported everything it did, and the two folding
errors besides. An earlier version of this pack assumed it stopped after
type checking and ran `-emit-sil` in a second worker when sourcekitd found
no error; that worker (`typecheck.js`) never added a diagnostic and is
gone.

## Limits

* **Rename edits base names only.** `moved(by:_:)` can be renamed to
  `shifted(by:_:)`, not to `shifted(to:_:)`: argument labels are found by
  sourcekitd's syntactic rename, which needs swift-syntax, and this
  toolchain is built without it (swift-toolchain-wasm `docs/status.md`).
  sourcekit-lsp-lite refuses a new name with labels, standard-library
  symbols, initializers, subscripts and operators, with a reason.
* **The compiler's parser, not swift-syntax's.** sourcekitd's syntax errors
  are the C++ parser's. Some come without a fix-it where swift-syntax had
  one ("expected ')' in expression list" has none; "expected ',' separator"
  has "Insert ','"). Native SourceKit-LSP shows the same.
* **Macros are the ones `SwiftMacroPlugins.wasm` has**: Observation's,
  swift-testing's and `StringifyMacros`. A project cannot build a macro of
  its own (that needs a plugin compiled from its source), and SwiftUI's
  `#Preview` and the like have no module here.
* **`-O` traps in the macro-enabled compiler** for some modules (an
  out-of-bounds `free` after a Swift-implemented SIL optimizer pass, found
  building XCTest; reported to swift-toolchain-wasm), so the browser's
  XCTest is built at `-Onone`. Programs compile at `-Onone` anyway.
* **No Foundation**: the core sysroot has no Foundation module, so `import
  Foundation` is an error ("no such module"). The standard library,
  `_Concurrency`, `_StringProcessing` (Regex), `Synchronization`,
  `RegexBuilder` and `WASILibc` work.
* **4 GiB address space** (wasm32), no threads (`Task`s run on the
  cooperative executor).
* **Not mapped by sourcekit-lsp-lite**: workspace symbols, call and type
  hierarchy, folding ranges, semantic tokens from sourcekitd, refactoring
  actions beyond fix-its (see its `docs/status.md`).

## What the language server no longer guesses

Before sourcekitd ran here, the pack answered from the compiler as a batch
tool and from swift-syntax. All of that is gone, because sourcekitd answers
the same questions from the type checker itself:

* `src/ast.js` and the `-dump-ast` checks: the typed syntax tree read from
  the compiler's text dump, for types and resolved declarations.
* `src/semantic.js`: member completion from those types, the
  "probe" that re-checked the project with the text after a dot removed,
  implicit-member completion from a probe member's error message, textual
  generic substitution, hover rendering, position mapping between a checked
  snapshot and the current text.
* `swift-stdlib-index.json` and `tools/stdlib-index.mjs`: an index of the
  standard library's members and doc comments built from its symbol graph
  (sourcekitd reads the real modules and `.swiftdoc` files instead).
* `src/dia.js`: the serialized-diagnostics reader for fix-its the text
  output dropped (sourcekitd returns them).
* swift-syntax-ls's name resolution, expression typer, scope-based
  completion, references, rename and signature help, and its syntax
  diagnostics (`server/Sources/YKSwift/Workspace.swift`).

## Sizes

What the browser downloads for Swift, raw, gzip -9 and brotli -q11
(lgwin 24, as `compress.mjs` writes them):

| file | asset (raw / gz / br) | shipped (raw / gz / br) | what was done |
|---|---|---|---|
| `swift-frontend-lsp.wasm` | 186.8 / 44.8 / – MB | **136.0 / 39.2 / 24.1 MB** | `llvm-objcopy --strip-all`: drops `name`, DWARF, `producers` |
| `wasm-ld.wasm` | 59.5 / 15.2 / 9.8 MB | **41.8 / 13.0 / 8.2 MB** | same |
| `swift-sysroot.tar` (was `swift-sysroot-core.tar`) | 107.6 / 22.6 / – MB | **49.9 / 14.4 / 9.0 MB** | trimmed to 327 files from 3,008 (`tools/trim-sysroot.mjs`), the stdlib's `.swiftdoc` kept for sourcekitd's docs |
| `SwiftMacroPlugins.wasm` | 13.3 / 3.4 / – MB | **13.3 / 3.5 / 2.2 MB** | as released (it has no custom sections); fetched only by projects that use a macro |
| `swift-testing.tar` | (Swift 6.3.3 Wasm SDK) | **21.9 / 5.3 / 3.3 MB** | Testing and the archives a test links (see "swift-testing"); fetched only by projects that import Testing |
| `swift-ls.wasm` | | 6.38 MB / 2.33 MB / 1.53 MB | formatting and semantic tokens only |
| `server.js` | | 51 KB / 16.5 KB / 14.6 KB | includes `lite.js` and the plugin host |
| `runner.js` | | 51 KB / 16.8 KB / 15.0 KB | includes test discovery (src/xctest.js) and the plugin host |
| `swift-xctest.tar` | | 354 KB / 138 KB / 104 KB | fetched only by projects that import XCTest; built at `-Onone` (see "Limits") |

**What macro support cost** (`swift-6.3.3-wasm-2`, the same compiler
without macros, against `swift-6.3.3-wasm-3`, both stripped): the module
grew from 115.7 to 136.0 MB raw (+20.3 MB, +18%), 33.8 to 39.2 MB gzip
(+5.4 MB) and **20.7 to 24.1 MB brotli (+3.4 MB, +16%)**. It is in every
download of the editor and of Run, macros used or not: ASTGen, the
compiler's swift-syntax and SwiftCompilerSources are linked in. The
plugins (2.2 MB brotli) and swift-testing (3.3 MB) are paid only by the
projects that need them; Observation adds 0.2 MB raw to the sysroot.

* **The editor, first load**: `server.js`, `swift-ls.wasm`,
  `swift-frontend-lsp.wasm` and `swift-sysroot.tar`: **34.6 MB brotli,
  55.9 MB gzip** (31.2 MB and 50.4 MB without macro support). Before
  sourcekitd (the batch compiler, the stdlib index and the heuristics):
  30.3 MB brotli, 48.7 MB gzip. sourcekitd costs
  0.6 MB of brotli in the module (20.7 MB against `swift-frontend.wasm`'s
  20.1 MB) and the stdlib's doc comments 0.65 MB in the sysroot (they
  replace the 108 KB stdlib index); swift-ls.wasm lost 0.23 MB.
* **Run** adds `wasm-ld.wasm` (8.2 MB brotli) and `runner.js`: the compiler
  is the module the editor already has. A cold Run without the editor
  downloads 41.3 MB brotli (37.9 MB without macro support).
* **One module instead of two.** swift-toolchain-wasm's CI links the three
  side by side (run 19): `swift-frontend.wasm` 145 MiB, the language server
  alone (`sourcekit-lsp-lite-reactor.wasm`) 146 MiB, the combined
  `swift-frontend-lsp.wasm` 148 MiB, unstripped. Shipping the server and the
  compiler separately would have meant two 20 MB brotli downloads and two
  compilations of a 115 MB module; combined it is one, and 3% larger than
  the compiler alone.
* **Hosting**: `swift-frontend-lsp.wasm` is 136 MB even stripped, over
  Cloudflare's 25 MiB per-asset limit for static assets and GitHub Pages'
  100 MB per-file limit. `serve.py` and any host without a per-file cap
  serve it as is; elsewhere it has to come from object storage (same origin
  or with CORS) or be split. Nothing here splits it.
* **Stripping** removes only custom sections: the code and data are
  byte-for-byte the same. Panics lose function names in stack traces.
* **wasm-opt** (binaryen version_133, not applied): `-O2` on the stripped
  `wasm-ld.wasm` took 8 min 41 s on 2 cores and gave 34.7 MB raw (-17%), but
  **8.18 MB brotli versus 8.22 MB** (-0.5%). The code is LLVM `-O3` output
  already, and brotli removes most of what binaryen saves. On the 136 MB
  module it would take well over half an hour for a similar ~0.1 MB of
  brotli, so `build.sh` does not run it.
* **The sysroot trim** comes from a trace. `tools/bench.mjs` wraps the
  shim's `path_open`/`path_filestat_get` while compiling the sample, a
  program importing WASILibc/Synchronization/RegexBuilder, and checks. The
  trim keeps the binary `.swiftmodule` and `.swiftdoc` of Swift,
  SwiftOnoneSupport, _Concurrency, _StringProcessing, _RegexParser, WASILibc,
  _Builtin_float, Synchronization, RegexBuilder, _Volatile and Observation, with their
  archives. It also keeps the two `.private.swiftinterface` files the
  frontend opens on every compile (_Concurrency, _StringProcessing), the
  shims, wasi-libc's headers and libraries, and clang's portable builtin
  headers. It drops Foundation's C modules (CoreFoundation,
  _FoundationCShims and _foundation_unicode, whose module maps clang found
  and stat'ed 200+ headers of on *every* compile), libCoreFoundation,
  libxml2, the libc++ headers (1,772 files; C++ interop is off), clang's
  x86/ARM/PowerPC/... intrinsic headers (their modules `require` another
  target), public `.swiftinterface` files, swift-testing (its own
  download), Distributed, _Differentiation, Cxx and the embedded
  modules. With either sysroot, the sample links to a program of the same
  size (7,325,605 bytes) and prints the same output.
* A prebuilt clang module cache (SwiftShims `.pcm`) was considered: it
  saves 80-300 ms on the first compile only (measured), so it is not shipped.

### Unicode data (measured)

* The compiler: LLVM's Unicode name-to-code-point table
  (`UnicodeNameToCodepointGenerated.cpp`, for clang's `\N{...}`) is
  **303 KB** raw: a 60.9 KB dictionary string and a 242 KB index. Brotli
  brings them to **185 KB**, and the index is nearly incompressible (242 ->
  160 KB), because it is already a compressed trie. The printable/width
  range tables are 9.4 KB (2.7 KB brotli). Unicode code is about 120 KB,
  mostly cmark's `utf8proc` case folding (72 KB of switch code) and Swift's
  grapheme-break lookup (14 KB). In all, under 0.5 MB of the module, or
  about 1% of its brotli download. (Measured on `swift-frontend.wasm`; the
  combined module links the same libraries.)
* `wasm-ld.wasm`: no name tables. Only the 9.4 KB of ranges and
  `foldCharSimple` (4 KB of code).
* The stdlib's Unicode data is in `libswiftCore.a` inside the sysroot tar:
  UnicodeScalarProps 685 KB (names 230 KB, name scalars 166 KB, words 84 KB,
  ...), UnicodeNormalization 43 KB, Word 6 KB, Grapheme 4.4 KB and Emoji
  2.3 KB. That is **741 KB raw, 259 KB brotli**, about 3% of the sysroot.
  These tables are already compact: bit arrays with rank tables, looked up
  through a minimal perfect hash.
* In a linked program, **all 710 KB** of the stdlib's Unicode tables are
  kept, `--gc-sections` notwithstanding: 9.7% of the sample's 7.32 MB
  `main.wasm`. Swift.o's metadata reaches every property accessor. The
  program is built in the tab, never downloaded, so this costs a little
  compile and instantiate time, not bandwidth.

## SourceKit-LSP and sourcekit-lsp-lite

SourceKit-LSP is a front end: every semantic answer comes from
**sourcekitd**, which is the Swift compiler behind an XPC/in-process API.
SourceKit-LSP itself still cannot run in a browser:

1. **It does not build for WASI.** With the 6.4.1 toolchain and Wasm SDK,
   `swift build --swift-sdk swift-6.4.1-RELEASE_wasm` on sourcekit-lsp
   `release/6.4.x` (commit `1c9871b`) fails in its dependency
   swift-tools-support-core, which spawns processes:

   ```text
   swift-tools-support-core/Sources/TSCclibc/include/process.h:3:10: fatal error: 'spawn.h' file not found
   ```

   SourceKit-LSP runs `swift build`, the build server and the indexer as
   subprocesses, and uses Dispatch and threads throughout.
2. **It loads sourcekitd with `dlopen`**
   (`Sources/SourceKitD/SourceKitD.swift`). WASI has no dynamic loading.

What swift-toolchain-wasm does instead: it builds **sourcekitd** itself for
wasm32-wasip1, statically linked and in-process, with its dispatch queues
made cooperative (no threads), and **sourcekit-lsp-lite**, a C++ LSP server
over sourcekitd's C API that maps the requests above the way SourceKit-LSP
maps them (its unit tests and LSP scenarios run natively and, under
wasmtime and Node, against the wasm build in that repository's CI). The
reactor exports `lsp_handle`, `lsp_idle` and `swift_frontend_main`, so one
module is both the language server and the compiler. Earlier versions of
this README said that neither a wasm-hosted frontend nor a wasm sourcekitd
existed; both were wrong by the time this pack used them.

## swift-ls.wasm (formatting and semantic tokens)

`server/` is a small Swift package on swift-syntax 604.0.0, compiled to
wasm32-wasip1 with the swift.org 6.4.1 Wasm SDK, stripped
(`llvm-objcopy --strip-all`) and optimised with `wasm-opt -Oz` (binaryen
132 from npm). It is a WASI reactor exporting `yk_alloc`, `yk_call`,
`yk_output`; each request is `cmd\noptions\n<text>` with JSON back, and it
keeps no state. It links no Foundation (JSON is written by hand), which
keeps it at a few MB. Offsets are UTF-8 bytes; `server.js` converts to
LSP's UTF-16 positions with a per-document table.

* **formatting**: swift-syntax `BasicFormat`, run after each line's leading
  indentation is stripped. It inserts missing whitespace (`let a=Point(x:1)`
  -> `let a = Point(x: 1)`) and re-indents every line by nesting with the
  editor's tab size, or with tabs. It also splits one-line blocks: `if
  a==1{print(a)}` becomes three lines. It does not wrap long lines, and
  continuation lines get BasicFormat's own fixed indentation. The lines of a
  multi-line string literal are shifted along with the block. Basic, not
  swift-format (see "Tried and left out").
* **semantic tokens**: swift-syntax's `SwiftIDEUtils` classifier (keywords,
  types, literals, comments, attributes, `#if`) plus the names declarations
  introduce. Syntactic: a use of a name is coloured by its token kind, not
  by what it resolves to.
* **nesting**: how deep `[` nests outside comments and strings, for the
  guard in "The language server".

A trap (deep code exhausting a stack) costs only that answer: the next call
gets a fresh instance.

## Limits: deep and pathological code

sourcekitd and swift-syntax both recurse once per syntax-tree level, inside
a browser worker whose native stack is about 1 MB. What happens with
pathological code, checked by `test.mjs` in Chromium each run:

| input | sourcekitd | swift-ls.wasm |
|---|---|---|
| a 2,000-link member chain `a.b().b()...` | the type checker overflows the browser's stack: the file is left out with a warning ("crashed analysing this file"), the other files keep working | not analysed (tree deeper than 700 levels) |
| `[` nested 30 deep (`let t: [[[...Int]]]`) | not given to sourcekitd: deeper than 16 (`MAX_SQUARE_NESTING` in `server.js`). The C++ parser takes time exponential in that depth: natively 0.45 s at 20 and 1.4 s at 22; in wasm 1.6 s at 16, 2.7 s at 18, and 30 deep did not finish in 3 minutes | not parsed (deeper than 12; swift-syntax's parser has the same problem) |
| a 2,000-branch `else if` chain | analysed, slowly (8.7 s in the last run); it is close to the stack limit, and when it overflows (it did in earlier runs, about 13 s in) the file is left out with a warning like the chain, the other files keep working. `test.mjs` accepts either | not analysed |
| 300 nested closures | the parser stops at its own limit: "structure nesting level exceeded maximum of 256" | the parser stops at 128 |

After each, hover and definition in the other files still answer.

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
Circle: Shape` with a `Point`; `main.swift` using both). It checks
diagnostics (type errors, fix-its as quick fixes, a missing return from the SIL passes, XCTest
and swift-testing files, superseded edits), macros (`#stringify` and
`@Observable` clean, the plugins fetched only then, hover and completion
on and inside macro uses, a plugin's error and an error in generated code
as diagnostics), completion (members across files, the user's
probe file: `xs.`, `ps.`, `name.`, `dict.`, `total.`, `makePoints().`,
`ps[0].`, `$0.`, `xs.first.`, implicit members such as `.sad()`), hover with
inferred types and stdlib docs, definition, references, signature help,
document symbols, rename, inlay hints, formatting, semantic tokens, CRLF,
the pathological files, and latencies. Output of the last run (after a full
`./build.sh`, on a machine busy with other builds):

```text
crossOriginIsolated: false
PASS  initialize answers, and the server says what it is  sourcekit-lsp-lite (sourcekitd 6.3.3) + swift-syntax formatting sourcekitd and swift-frontend 6.3.3 from swift-toolchain-wasm (swift-frontend-lsp.wasm); formatting and semantic tokens from swift-syntax 604.0.0 after 167 ms
PASS  yukibana/loading reports swift-ls.wasm  17 progress notifications
PASS  Shapes.swift is clean  [] after 2792 ms
PASS  Circle.swift is clean  [] after 2808 ms
PASS  main.swift is clean  [] after 2819 ms
PASS  `let x: Int = "no"` yields a type-error diagnostic from sourcekitd  ["1: cannot convert value of type 'String' to specified type 'Int'"] {"start":{"line":0,"character":13},"end":{"line":0,"character":17}} after 577 ms
PASS  yukibana/loading reports swift-frontend-lsp.wasm, downloaded once  66 progress notifications, 1 complete
PASS  Shapes.swift stays clean after type checking  []
PASS  Circle.swift stays clean after type checking  []
PASS  main.swift stays clean after type checking  []
PASS  after an edit the type checker runs again (warm)  ["2: cannot convert value of type 'Int' to specified type 'String'"] 690 ms
PASS  superseded edits are not checked: diagnostics only for the last text  ["1: cannot convert value of type 'String' to specified type 'Int64'"]; target types seen: Int64
PASS  "add stubs for conformance" from sourcekitd is a quick fix that inserts the missing method  [["Add stubs for conformance",{"changes":{"file:///workspace/Typed.swift":[{"range":{"start":{"line":4,"character":14},"end":{"line":4,"character":14}},"newText":"\n    func a() -> Int {\n        code\n    }\n"}]}}]]
PASS  a missing return (a SIL diagnostic) is reported while editing  ["5: missing return in global function expected to return 'Int'"]
PASS  a test file: XCTest is found, `@testable import Shapes` is quiet, the type error in it is reported  ["6: conflicting arguments to generic parameter 'T' ('String' vs. 'Int')"] after 489 ms, 2 swift-xctest.tar progress notifications
PASS  #stringify and @Observable type-check with no diagnostics (the plugins are fetched for them)  [] after 1340 ms, 10 SwiftMacroPlugins.wasm progress notifications
PASS  the plugins are not fetched for a project without macros  0 notifications before
PASS  hover on a property of an @Observable class  {"kind":"markdown","value":"```swift\nvar count: Int { get set }\n```"}
PASS  hover on @Observable shows the macro and its documentation  {"kind":"markdown","value":"```swift\n@attached(member, names: named(_$observationRegistrar), named(access), named(withMutation), named(shouldNotifyObservers)) 
PASS  hover on #stringify shows the macro  {"kind":"markdown","value":"```swift\n@freestanding(expression) macro stringify<T>(_ value: T) -> (T, String) = #externalMacro(module: \"StringifyMacros\", type
PASS  completion inside a macro's argument lists the @Observable class's members, the generated ones too  ["self","count","access","withMutation"]
PASS  an error reported by a macro plugin is a diagnostic at the macro's use  ["7: reported by the plugin (from macro 'diagnose')","10: '@Observable' cannot be applied to struct type 'NotAClass' (from macro 'Observable')","12: expansion of macro 'ObservationTracked()' did not produce a non-observing accessor (such as 'get') as expected","18: invalid redeclaration of '_x'"]
PASS  an error against code a macro generated is reported in the file, its note in the expansion kept at the error  [{"location":{"uri":"file:///workspace/Macros.swift","range":{"start":{"line":17,"character":8},"end":{"line":17,"character":10}}},"message":"'_x' previously declared here (in a macro expansion)"}]
PASS  a swift-testing file: Testing is found, @Test and #expect expand, the type error in it is reported  ["9: binary operator '==' cannot be applied to operands of type 'Int' and 'String'"] after 2726 ms
PASS  an introduced error is a diagnostic, reported once  ["5: expected ')' in expression list"]
PASS  a syntax error with a fix-it comes with a quick fix  ["4: expected ',' separator"] [["Insert ','",{"changes":{"file:///workspace/main.swift":[{"range":{"start":{"line":3,"character":16},"end":{"line":3,"character":16}},"newText":","}]}}]]
PASS  completion after "c.centre." lists Point's members (Circle.swift -> Shapes.swift)  ["self","x","y","norm","moved"] 97 ms
PASS  hover on far.norm() shows its signature and doc comment  {"kind":"markdown","value":"```swift\nfunc norm() -> Double\n```\n\n---\n\nDistance from the origin."} 73 ms
PASS  go to definition of Point lands in Shapes.swift  ["file:///workspace/Shapes.swift:2:8"]
PASS  go to definition of origin.moved lands on Point.moved  ["file:///workspace/Shapes.swift:11:10"]
PASS  go to definition of c.area() lands on Circle.area  ["file:///workspace/Circle.swift:11:10"]
PASS  go to definition of a property used in a method  ["file:///workspace/Circle.swift:4:9"]
PASS  references to Point span the three files  ["file:///workspace/Circle.swift:3:17","file:///workspace/Circle.swift:6:18","file:///workspace/Shapes.swift:2:8","file:///workspace/Shapes.swift:11:48","file:///workspace/Shapes.swift:12:16","file:///workspace/main.swift:1:14"]
PASS  signature help inside origin.moved(by: 2, |1)  {"signatures":[{"label":"moved(by: Double, _ dy: Double) -> Point","parameters":[{"label":[6,16]},{"label":[18,30]}],"activeParameter":1}],"activeSignature":0,"activeParameter":1}
PASS  document symbols outline Shapes.swift  Point[x,y,norm(),moved(by:_:)] Shape[area()]
PASS  rename norm edits its declaration and its use  Shapes.swiftx1 main.swiftx1
PASS  formatting inserts missing whitespace  "let a = Point(x: 1, y: 2)\n"
PASS  semantic tokens for Circle.swift  23 tokens
PASS  sourcekitd: completion after `xs.` ([Int]) lists Array's members  149 items in 258 ms: self, capacity, startIndex, endIndex, index, formIndex, index, formIndex, index, index, distance, count...
PASS  sourcekitd: `reduce` is shown for [Int], with Int filled in and a snippet  ["reduce(initialResult: Result, nextPartialResult: (Result, Int) throws -> Result) rethrows","reduce(${1:initialResult: Result}, ${2:nextPartialResult: (Result, Int) throws -> Result})"]
PASS  sourcekitd: completion after `ps.` ([Point]) offers sorted(by:) but not sorted(), since Point is not Comparable  117 items in 390 ms
PASS  sourcekitd: completion after `name.` (String)  189 items in 222 ms
PASS  sourcekitd: completion after `dict.` ([String : Int])  94 items in 124 ms
PASS  sourcekitd: completion after `total.` (Int, from reduce) lists Int's members, not Point's  30 items in 158 ms
PASS  sourcekitd: completion after `makePoints().` ([Point])  117 items in 149 ms
PASS  sourcekitd: completion after `ps[0].` (Point)  ["self","x","y","norm","moved"] in 113 ms
PASS  sourcekitd: completion after `$0.` in a map over [Int] (unclosed closure) lists Int's members  30 items in 161 ms
PASS  sourcekitd: after `xs.first.` (Int?) Optional's members, and Int's as `?.member` edits  39 items in 156 ms, {"range":{"start":{"line":9,"character":8},"end":{"line":9,"character":9}},"newText":"?.isMultiple(of: ${1:Int})"}
PASS  sourcekitd: implicit member `.s` in an if expression returning Int offers `sad`  11 items in 147 ms: subtractingReportingOverflow, signum, sad, Stride, SIMDMaskScalar, SIMD2Storage, SIMD4Storage, SIMD8Storage, SIMD16Storage, SIMD32Storage, SIMD64Storage
PASS  sourcekitd: implicit member `.` there offers Int's static members of type Int  61 items in 29 ms
PASS  sourcekitd: implicit member after `let m: Mood = .` offers the cases and `usual` first, `describe` (a String) after them  4 items in 128 ms: happy, grumpy, usual, describe
PASS  sourcekitd: implicit member in an argument `feel(.)` offers Mood's cases  4 items in 106 ms: happy, grumpy, usual, describe
PASS  sourcekitd: a dot starting a line after an expression continues it (instance members of [Int])  149 items in 218 ms
PASS  sourcekitd: the completion item carries the stdlib doc comment  Returns the result of combining the elements of the sequence
PASS  sourcekitd: hover shows the inferred types  ["```swift\nlet total: Int\n```","```swift\nlet ps: [Point]\n```","```swift\nlet first: Point\n```","```swift\nvar dict: [String : Int]\n```","```swift\nlet p: Point\n```"]
PASS  sourcekitd: hover on reduce shows the stdlib declaration, Element as Int, and its doc  ```swift
@inlinable func reduce<Result>(_ initialResult: Result, _ nextPartialResult: (Result, Int) throws -> Result) rethrows -> Result
```

---

Returns the r
PASS  sourcekitd: hover on print shows its declaration and doc  ```swift
func print(_ items: Any..., separator: String = " ", terminator: String = "\n")
```

---

W
PASS  sourcekitd: hover on squareRoot (in Shapes.swift) shows FloatingPoint's doc  ```swift
func squareRoot() -> Double
```

---

Returns the square root of the value, rounded to a re
PASS  sourcekitd: hover on p.norm() (declared in another file) shows its declaration and doc  ```swift
func norm() -> Double
```

---

Distance from the origin.
PASS  sourcekitd: definition of makePoints, p.norm and ps lands on their declarations; reduce (stdlib) has no location, not a wrong one  {"makePoints":["file:///workspace/main.swift:1:6"],"norm":["file:///workspace/Shapes.swift:7:10"],"ps":["file:///workspace/main.swift:4:5"],"reduce":[]}
PASS  sourcekitd: references to xs are its declaration and its use in reduce  ["file:///workspace/main.swift:3:5","file:///workspace/main.swift:8:13"]
PASS  sourcekitd: signature help for print(  ["print(_ items: Any..., separator: String = \" \", terminator: String = \"\\n\")","print(_ items: Any..., separator: String = \" \", terminator: String = \"\\n\", to: inout TextOutputStream)"]
PASS  sourcekitd: inlay hints give the inferred types of unannotated declarations  ["3:: [Int]","4:: [Point]","5:: Point","6:: String","8:: Int","9:: Point"]
PASS  sourcekitd: a type error is reported quickly when warm  428 ms
(latency: completion 29-390 ms, median 156 ms; type error 428 ms after the edit)
PASS  an edit to Shapes.swift reaches completion in main.swift  ["self","x","y","z","norm","moved"]
PASS  formatting re-indents mixed indentation consistently  "struct A {\n    var x = 1\n    func f() {\n        return\n    }\n}\n"
PASS  rename accepts Unicode and backticked identifiers and refuses non-identifiers  [1,1,"'not a name' is not a Swift identifier."]
PASS  CRLF: a comment token stops before \r, and a column past a line end stays on that line  [0,0,4,4,0,1,0,5,4,0] hover past end: null
PASS  a 2000-link member chain: the server answers (crashed, recovered) and the other files still work  825 ms sourcekitd crashed analysing this file (Maximum call stack size exceeded) and leaves it ou
PASS  arrays nested 30 deep (exponential in the parser): the server answers (skipped) and the other files still work  171 ms sourcekitd leaves this file out: its `[` brackets nest 30 deep, and the Swift parser takes
PASS  a 2000-branch else-if chain: the server answers (analysed) and the other files still work  10729 ms 
PASS  300 nested closures: the server answers (parser nesting limit) and the other files still work  944 ms structure nesting level exceeded maximum of 256
(2 sourcekitd crash(es) recovered from in the cases above)
PASS  shutdown answers  ""
[log 3] swift-ls.wasm (formatting, semantic tokens): 6.4 MB in 113 ms
[log 3] swift-frontend-lsp.wasm: sourcekitd ready in 1307 ms
[log 1] sourcekitd crashed (Maximum call stack size exceeded); leaving file:///workspace/Deep.swift out until it changes; restarting it
[log 1] sourcekitd crashed (Maximum call stack size exceeded); leaving file:///workspace/Deep.swift out until it changes; restarting it
PASS  the worker raised no errors  []
all passed
```swift\nfunc norm() -> Double\n```\n\n---\n\nDistance from the origin."} 184 ms
PASS  go to definition of Point lands in Shapes.swift  ["file:///workspace/Shapes.swift:2:8"]
PASS  go to definition of origin.moved lands on Point.moved  ["file:///workspace/Shapes.swift:11:10"]
PASS  go to definition of c.area() lands on Circle.area  ["file:///workspace/Circle.swift:11:10"]
PASS  go to definition of a property used in a method  ["file:///workspace/Circle.swift:4:9"]
PASS  references to Point span the three files  ["file:///workspace/Circle.swift:3:17","file:///workspace/Circle.swift:6:18","file:///workspace/Shapes.swift:2:8","file:///workspace/Shapes.swift:11:48","file:///workspace/Shapes.swift:12:16","file:///workspace/main.swift:1:14"]
PASS  signature help inside origin.moved(by: 2, |1)  {"signatures":[{"label":"moved(by: Double, _ dy: Double) -> Point","parameters":[{"label":[6,16]},{"label":[18,30]}],"activeParameter":1}],"activeSignature":0,"activeParameter":1}
PASS  document symbols outline Shapes.swift  Point[x,y,norm(),moved(by:_:)] Shape[area()]
PASS  rename norm edits its declaration and its use  Shapes.swiftx1 main.swiftx1
PASS  formatting inserts missing whitespace  "let a = Point(x: 1, y: 2)\n"
PASS  semantic tokens for Circle.swift  23 tokens
PASS  sourcekitd: completion after `xs.` ([Int]) lists Array's members  149 items in 280 ms: self, capacity, startIndex, endIndex, index, formIndex, index, formIndex, index, index, distance, count...
PASS  sourcekitd: `reduce` is shown for [Int], with Int filled in and a snippet  ["reduce(initialResult: Result, nextPartialResult: (Result, Int) throws -> Result) rethrows","reduce(${1:initialResult: Result}, ${2:nextPartialResult: (Result, Int) throws -> Result})"]
PASS  sourcekitd: completion after `ps.` ([Point]) offers sorted(by:) but not sorted(), since Point is not Comparable  117 items in 305 ms
PASS  sourcekitd: completion after `name.` (String)  189 items in 176 ms
PASS  sourcekitd: completion after `dict.` ([String : Int])  94 items in 128 ms
PASS  sourcekitd: completion after `total.` (Int, from reduce) lists Int's members, not Point's  30 items in 134 ms
PASS  sourcekitd: completion after `makePoints().` ([Point])  117 items in 133 ms
PASS  sourcekitd: completion after `ps[0].` (Point)  ["self","x","y","norm","moved"] in 80 ms
PASS  sourcekitd: completion after `$0.` in a map over [Int] (unclosed closure) lists Int's members  30 items in 103 ms
PASS  sourcekitd: after `xs.first.` (Int?) Optional's members, and Int's as `?.member` edits  39 items in 104 ms, {"range":{"start":{"line":9,"character":8},"end":{"line":9,"character":9}},"newText":"?.isMultiple(of: ${1:Int})"}
PASS  sourcekitd: implicit member `.s` in an if expression returning Int offers `sad`  11 items in 109 ms: subtractingReportingOverflow, signum, sad, Stride, SIMDMaskScalar, SIMD2Storage, SIMD4Storage, SIMD8Storage, SIMD16Storage, SIMD32Storage, SIMD64Storage
PASS  sourcekitd: implicit member `.` there offers Int's static members of type Int  61 items in 18 ms
PASS  sourcekitd: implicit member after `let m: Mood = .` offers the cases and `usual` first, `describe` (a String) after them  4 items in 97 ms: happy, grumpy, usual, describe
PASS  sourcekitd: implicit member in an argument `feel(.)` offers Mood's cases  4 items in 91 ms: happy, grumpy, usual, describe
PASS  sourcekitd: a dot starting a line after an expression continues it (instance members of [Int])  149 items in 176 ms
PASS  sourcekitd: the completion item carries the stdlib doc comment  Returns the result of combining the elements of the sequence
PASS  sourcekitd: hover shows the inferred types  ["```swift\nlet total: Int\n```","```swift\nlet ps: [Point]\n```","```swift\nlet first: Point\n```","```swift\nvar dict: [String : Int]\n```","```swift\nlet p: Point\n```"]
PASS  sourcekitd: hover on reduce shows the stdlib declaration, Element as Int, and its doc  ```swift
@inlinable func reduce<Result>(_ initialResult: Result, _ nextPartialResult: (Result, Int) throws -> Result) rethrows -> Result
```

---

Returns the r
PASS  sourcekitd: hover on print shows its declaration and doc  ```swift
func print(_ items: Any..., separator: String = " ", terminator: String = "\n")
```

---

W
PASS  sourcekitd: hover on squareRoot (in Shapes.swift) shows FloatingPoint's doc  ```swift
func squareRoot() -> Double
```

---

Returns the square root of the value, rounded to a re
PASS  sourcekitd: hover on p.norm() (declared in another file) shows its declaration and doc  ```swift
func norm() -> Double
```

---

Distance from the origin.
PASS  sourcekitd: definition of makePoints, p.norm and ps lands on their declarations; reduce (stdlib) has no location, not a wrong one  {"makePoints":["file:///workspace/main.swift:1:6"],"norm":["file:///workspace/Shapes.swift:7:10"],"ps":["file:///workspace/main.swift:4:5"],"reduce":[]}
PASS  sourcekitd: references to xs are its declaration and its use in reduce  ["file:///workspace/main.swift:3:5","file:///workspace/main.swift:8:13"]
PASS  sourcekitd: signature help for print(  ["print(_ items: Any..., separator: String = \" \", terminator: String = \"\\n\")","print(_ items: Any..., separator: String = \" \", terminator: String = \"\\n\", to: inout TextOutputStream)"]
PASS  sourcekitd: inlay hints give the inferred types of unannotated declarations  ["3:: [Int]","4:: [Point]","5:: Point","6:: String","8:: Int","9:: Point"]
PASS  sourcekitd: a type error is reported quickly when warm  394 ms
(latency: completion 18-305 ms, median 128 ms; type error 394 ms after the edit)
PASS  an edit to Shapes.swift reaches completion in main.swift  ["self","x","y","z","norm","moved"]
PASS  formatting re-indents mixed indentation consistently  "struct A {\n    var x = 1\n    func f() {\n        return\n    }\n}\n"
PASS  rename accepts Unicode and backticked identifiers and refuses non-identifiers  [1,1,"'not a name' is not a Swift identifier."]
PASS  CRLF: a comment token stops before \r, and a column past a line end stays on that line  [0,0,4,4,0,1,0,5,4,0] hover past end: null
PASS  a 2000-link member chain: the server answers (crashed, recovered) and the other files still work  640 ms sourcekitd crashed analysing this file (Maximum call stack size exceeded) and leaves it ou
PASS  arrays nested 30 deep (exponential in the parser): the server answers (skipped) and the other files still work  30 ms sourcekitd leaves this file out: its `[` brackets nest 30 deep, and the Swift parser takes
PASS  a 2000-branch else-if chain: the server answers (analysed) and the other files still work  8682 ms 
PASS  300 nested closures: the server answers (parser nesting limit) and the other files still work  731 ms structure nesting level exceeded maximum of 256
(2 sourcekitd crash(es) recovered from in the cases above)
PASS  shutdown answers  ""
[log 3] swift-ls.wasm (formatting, semantic tokens): 6.4 MB in 73 ms
[log 3] swift-frontend-lsp.wasm: sourcekitd ready in 904 ms
[log 1] sourcekitd crashed (Maximum call stack size exceeded); leaving file:///workspace/Deep.swift out until it changes; restarting it
[log 1] sourcekitd crashed (Maximum call stack size exceeded); leaving file:///workspace/Deep.swift out until it changes; restarting it
PASS  the worker raised no errors  []
all passed
```

`node test-run.mjs` serves `app/static` with COOP/COEP (so the page is
`crossOriginIsolated`) and the `.br` siblings, as the app's host does. A
service worker caches `/packs/` the way the app's does. The test runs the
runner as the app does and drives stdin through the SharedArrayBuffer from
the page. The XCTest cases send `{ type: 'test' }`: the behaviour corpus
against the real XCTest's report, a SwiftPM-style project with
`@testable import Calc` (passing, failing, and `run` of the same project),
discovery through comments, strings, inheritance, extensions and nesting,
a class with its own `allTests`, a hand-written `XCTMain` (tested and run),
and a type error. Then macros (`#stringify` and `@Observable` compiled,
linked and run; a plugin's error as a compiler error) and swift-testing
(`@Test`/`#expect` with a failing expectation, alongside XCTest, and Run
leaving its files out). This run was on a machine busy with other builds:

```text
PASS  the page is crossOriginIsolated and controlled by a service worker that caches /packs/
PASS  sample project (cold): main.swift + Geometry.swift print the distance and the norm, exit 0  "(0.0, 0.0) to (3.0, 4.0): 5.0\n5.0\n" code=0 in 4370 ms, 41.3 MB transferred; Loading the Swift compiler@23, Compiling@2165, Linking@3822, Running@4346
PASS  loading messages for each download  wasm-ld.wasm 41774304/41774304, swift-sysroot.tar 49916416/49916416, swift-frontend-lsp.wasm 136024237/136024237
PASS  sample project (warm #1): same output from the browser cache  code=0 in 3281 ms, 0 bytes transferred; Loading the Swift compiler@26, Compiling@1264, Linking@2796, Running@3260
PASS  sample project (warm #2): same output from the browser cache  code=0 in 2511 ms, 0 bytes transferred; Loading the Swift compiler@23, Compiling@1319, Linking@1984, Running@2488
PASS  readLine(): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 2298 ms; Loading the Swift compiler@19, Compiling@1379, Linking@1866, Running@2277
PASS  end of input (Ctrl-D) makes readLine() return nil  code=0 "got one\ngot two\nend of input after 2 lines\n" requests=3
PASS  type error: swift-frontend diagnostics on stderr, non-zero exit, not run  code=1 1805 ms
main.swift:1:14: error: cannot convert value of type 'String' to specified type 'Int'
1 | let x: Int = "no"
  |              `- error: cannot convert value of type 'String' to specified type 'Int'
2 | print(x)
3 |
PASS  runtime error: index out of range is reported and exits non-zero  code=134 "before\n"
Swift/ContiguousArrayBuffer.swift:692: Fatal error: Index out of range

Program crashed: unreachable
PASS  endless loop: terminated by the page, which stays responsive  stopped after 3297 ms; Loading the Swift compiler@21, Compiling@1347, Linking@1819, Running@2271
PASS  XCTest: the behaviour corpus prints exactly what swift-corelibs-xctest prints (assertion texts, skips, setUp/tearDown order, async, summaries) and exits 1  74 lines, code=1 in 4663 ms, swift-xctest.tar [353792,353792]; Loading the Swift compiler@18, Compiling@1413, Linking@4251, Testing@4594
      Behaviour.swift:28: error: Assertions.testFailing : XCTAssertTrue failed - 
      Behaviour.swift:29: error: Assertions.testFailing : XCTAssertTrue failed - true
      Behaviour.swift:30: error: Assertions.testFailing : XCTAssertFalse failed - 
      Behaviour.swift:31: error: Assertions.testFailing : XCTAssertEqual failed: ("2") is not equal to ("3") - two and three
      Behaviour.swift:32: error: Assertions.testFailing : XCTAssertEqual failed: ("a") is not equal to ("b") - 
      Behaviour.swift:33: error: Assertions.testFailing : XCTAssertNotEqual failed: ("1") is equal to ("1") - 
      Behaviour.swift:34: error: Assertions.testFailing : XCTAssertEqual failed: ("1.0") is not equal to ("1.5") +/- ("0.1") - 
      Behaviour.swift:35: error: Assertions.testFailing : XCTAssertNotEqual failed: ("1.0") is equal to ("1.05") +/- ("0.1") - 
PASS  XCTest: discovered tests pass (`@testable import Calc` names the module), setUp/tearDown around each, exit 0, nothing on stderr  code=0 in 3190 ms; Loading the Swift compiler@17, Compiling@1432, Linking@2580, Testing@3121
      CalculatorTests.testAdd: ["setUp", "test", "tearDown"]
      	 Executed 5 tests, with 0 failures (0 unexpected) in 0.01 (0.014) seconds
PASS  XCTest: 'run' of the same project runs the program, without its tests  "5\n" code=0
PASS  XCTest: failures as file:line: error: Class.test : message, project-relative; a thrown error is unexpected; exit 1  code=1
      Tests/CalculatorTests.swift:5: error: CalculatorTests.testAdd : XCTAssertEqual failed: ("4") is not equal to ("5") - two and two
      Tests/CalculatorTests.swift:6: error: CalculatorTests.testDivide : XCTAssertEqual failed: ("0.3333333333333333") is not equal to ("0.3") +/- ("0.001") - 
      <EXPR>:0: error: CalculatorTests.testThrows : threw error "divisionByZero"
      Tests/CalculatorTests.swift:8: error: CalculatorTests.testUnwrap : XCTUnwrap failed: expected non-nil value of type "Int" - 
      	 Executed 5 tests, with 4 failures (1 unexpected) in 0.008 (0.012) seconds
      	 Executed 5 tests, with 4 failures (1 unexpected) in 0.008 (0.022) seconds
PASS  XCTest discovery: own, inherited, extension, backticked, nested and async tests; nothing from comments, strings, helpers, arguments, static, private, generic  code=0 ["BaseTests.testFromBase passed","DerivedTests.testOwn passed","DerivedTests.testBackticked passed","DerivedTests.testInExtension passed","DerivedTests.testFromBase passed","NestedTests.testNested passed"]

PASS  XCTest: a class with its own allTests runs exactly that list  code=0

PASS  XCTest: a main.swift that calls XCTMain itself (LinuxMain style) is used instead of a generated one  code=0 "hand-written main\nTest Suite 'All tests' started at 2026-10-"

PASS  XCTest: 'run' of that project runs its main.swift with the tests it names  code=0

PASS  XCTest: a type error in a test is reported like any other, and nothing runs  code=1
Tests/BrokenTests.swift:3:20: error: conflicting arguments to generic parameter 'T' ('String' vs. 'Int')
PASS  macros: #stringify and @Observable expand, link (with Observation) and run  code=0 in 3064 ms, 2.2 MB transferred; Loading the Swift compiler@22, Compiling@1707, Linking@2494, Running@3036
stringify: 5 from 2 + 3
observed: count is changing
count: 1

PASS  macros: a project without macros does not download the plugins  wasm-ld.wasm, swift-sysroot.tar, swift-frontend-lsp.wasm
PASS  macros: an error a macro's plugin reports is a compiler error at the macro's use, and nothing runs  code=1
main.swift:5:1: error: reported by the plugin (from macro 'diagnose')
   | `- error: reported by the plugin (from macro 'diagnose')
main.swift:7:1: error: '@Observable' cannot be applied to struct type 'NotAClass' (from macro 'Observable')
   | `- error: '@Observable' cannot be applied to struct type 'NotAClass' (from macro 'Observable')
main.swift:9:9: error: expansion of macro 'ObservationTracked()' did not produce a non-observing accessor (such as 'get') as expected
   |         `- error: expansion of macro 'ObservationTracked()' did not produce a non-observing accessor (such as 'get') as expected
PASS  swift-testing: @Test and #expect run on Test; a failing expectation is reported with its values and the run fails  code=1 in 6901 ms; Loading the Swift compiler@23, Compiling@1709, Linking@5998, Testing@6794
      ◇ Test run started.
      ◇ Test wrong() started.
      ◇ Test norm() started.
      ◇ Test "counts up" started.
      ✘ Test wrong() recorded an issue at CounterTests.swift:17:5: Expectation failed: (counter.count → 1) == 2
      ✘ Test wrong() failed after 0.010 seconds with 1 issue.
      ✔ Test "counts up" passed after 0.010 seconds.
      ✔ Test norm() passed after 0.011 seconds.
      ✘ Test run with 3 tests in 0 suites failed after 0.018 seconds with 1 issue.
PASS  swift-testing and XCTest in one project: XCTest runs first, then swift-testing, and the run fails if either does  code=1
      	 Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.006) seconds
      	 Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.015) seconds
      	 Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.017) seconds
      ✘ Test run with 3 tests in 0 suites failed after 0.013 seconds with 1 issue.
PASS  swift-testing: 'run' leaves the test files out, as SwiftPM leaves out the test target  code=0 "counter at 0\n"

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
  Downloaded only when the unpacked toolchain is missing, and deleted once
  unpacked; the same for the Wasm SDK below once installed.
* `swift-6.4.1-RELEASE_wasm.artifactbundle.tar.gz` (official Wasm SDK).
* from swift-toolchain-wasm release `swift-6.3.3-wasm-3` (the first with
  macros; published 2026-10-24 by CI run 30 of `build-toolchain.yml`):
  `swift-frontend-lsp.wasm`, `wasm-ld.wasm`, `swift-sysroot-core.tar` and
  `SwiftMacroPlugins.wasm`, as `.gz` release assets whose SHA-256, and that
  of each decompressed file, the script pins. A tag can be rebuilt in place
  upstream, so a changed asset fails the build loudly instead of changing
  the bytes. Its `wasm-ld.wasm` is byte for byte the one of
  `swift-6.3.3-wasm`. The release's `swift-plugin-host.mjs` is not
  downloaded: the pack keeps it in `src/vendor/`, and the script checks it
  against the release's SHA-256.
* `swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz` (72 MB, the official
  Wasm SDK that release is built with, SHA-256 pinned), for
  `swift-testing.tar`; deleted once that is made.

To try an unreleased toolchain, unpack the `swift-toolchain-wasm-6.3.3`
artifact of a `build-toolchain.yml` run somewhere and build with

```sh
SWIFT_TOOLCHAIN_DIR=/path/to/unpacked/artifact ./build.sh
```

Any of the four files found there is used instead of the release, without
a checksum. A new release gets a new tag (`release_tag`), so the assets
pinned here stay as they are; then put its name and the two SHA-256 values
in `TC_ARTIFACTS`.

Then `npm ci` (binaryen 132.0.0 for swift-ls.wasm's `wasm-opt`, esbuild,
playwright-core, `@bjorn3/browser_wasi_shim` 0.4.2), `swift build` of
`server/`, strip and `wasm-opt -Oz` of swift-ls.wasm, `llvm-objcopy
--strip-all` of the module, the linker and the plugins,
`tools/trim-sysroot.mjs`, `swift-testing.tar` (GNU tar, ustar),
`tools/build-xctest.mjs`, esbuild (`server.js` and `runner.js` are bundled
with `src/toolchain.js` and the WASI shim, and the decoded artifact sizes
are injected for the progress bars), and `.gz`/`.br`.

Times on this shared 4-core machine: a full run with swift-syntax already
built and the downloads cached takes about **12 min** (swift-ls.wasm's
`wasm-opt -Oz` about 3 min; brotli -q11 of the toolchain about 8 min, most
of it `swift-frontend-lsp.wasm`). Stripping takes under 1 s and trimming
about 1 s. A first build from nothing also needs the 1.2 GB Swift download
and about 8 min of swift-syntax. Compressed siblings that are newer than
their source are reused, so a build with nothing to do takes about 1 min.

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
* `swift-frontend-lsp.wasm` (with sourcekitd and sourcekit-lsp-lite),
  `wasm-ld.wasm` and the sysroot are swift-toolchain-wasm's build outputs,
  stripped and trimmed. Their source and patches are in that repository.

## Files

* `src/server.js`: the LSP worker: documents, the queue in front of
  sourcekitd, idle diagnostics, crash recovery and the nesting guard,
  formatting and semantic tokens from swift-ls.wasm.
* `src/lite.js`: one instance of swift-frontend-lsp.wasm's language server
  (`lsp_handle`, `lsp_idle`).
* `src/runner.js`: the runner.
* `src/toolchain.js`: the shared pipeline (arguments, `runFrontend`, file
  system, tar, WASI, downloads, autolink and the libraries to link, the
  macro plugin host).
* `src/vendor/swift-plugin-host.mjs`: swift-toolchain-wasm's plugin host,
  as released with `swift-6.3.3-wasm-3` (checked by `build.sh`).
* `src/xctest.js`: test discovery, the generated test main (XCTest and
  swift-testing), the module-name
  rule for `@testable import`, the warning it causes.
* `server/Sources/YKSwift/Server.swift`: swift-ls.wasm's requests (format,
  tokens, nesting), JSON output, wasm exports; `Source.swift`: the guarded
  parse and the declaration names for tokens.
* `xctest/XCTest/*.swift`: the browser's XCTest. `xctest/conformance/`:
  `API.swift` (the conformance corpus), `Behaviour.swift` and
  `Behaviour.expected` (the report of the real XCTest).
* `tools/build-xctest.mjs` (builds swift-xctest.tar with
  swift-frontend-lsp.wasm), `tools/xctest-subset.mjs` (the subset check,
  `npm run test:xctest`).
* `tools/trim-sysroot.mjs`, `tools/bench.mjs` (timings of the language
  server, the compiler and the linker under Node).
* `build.sh`, `compress.mjs`, `test.mjs`, `test-run.mjs`.
