# Swift pack: swift-syntax-ls, the real Swift 6.3.3 compiler for types, completion, navigation and running, NOT SourceKit-LSP

This pack has three parts, and they are named for what they are:

| part | what it is | what it does |
|---|---|---|
| `server.js` + `swift-ls.wasm` | **swift-syntax-ls**, a small language server written for this pack on Apple's [swift-syntax](https://github.com/swiftlang/swift-syntax) 604.0.0, compiled to wasm32-wasip1 with the swift.org Swift 6.4.1 Wasm SDK | the LSP protocol; syntax diagnostics with fix-its, outline, semantic tokens, formatting; and the **heuristic fallback** for completion, hover, definition, references, rename and signature help when the compiler has not answered |
| `typecheck.js` | a nested worker of `server.js` that runs **swift-frontend 6.3.3** (`swift-frontend.wasm`): `-dump-ast`, then `-emit-sil` | **semantic diagnostics** from the real compiler (type errors, unknown names, warnings, missing return, ...), and the **typed syntax tree** |
| `semantic.js` (in `server.js`) + `swift-stdlib-index.json` | the compiler's types and declarations (from the tree) plus an index of the 6.3.3 standard library built from its symbol graph | **type-aware** member completion, hover with types and stdlib docs, definition, references, rename, inlay type hints, stdlib signature help (see "Answers from the compiler") |
| `runner.js` | **swift-frontend 6.3.3 + wasm-ld** compile and link the project, then the program runs under WASI in the worker | **Run**: stdout/stderr streamed, interactive `readLine()`, compiler errors on stderr |

`swift-frontend.wasm`, `wasm-ld.wasm` and the sysroot come from Ambrus Tóth's
[swift-toolchain-wasm](https://github.com/tothambrus11/swift-toolchain-wasm),
release **`swift-6.3.3-wasm`**. It is the Swift 6.3.3 compiler frontend and
LLVM's lld, cross-compiled to run *on* a wasm32-wasip1 host, with the
patches in that repository's `patches/`. This pack does not rebuild them.
`build.sh` downloads the release assets, checks their pinned SHA-256, strips
custom sections and trims the sysroot (see "Sizes").

The status bar shows `swift-syntax-ls + swift-frontend 6.3.3 type checker`.
**SourceKit-LSP does not run** (see "Why not SourceKit-LSP"), and neither
does sourcekitd. The compiler is used as a batch tool: its type checker's
output (`-dump-ast`) is read for types and declarations, and what follows a
dot is listed from those types, not by sourcekitd's code completion. What
that does and does not cover is in "Answers from the compiler".

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

**Tests**: `{ type: 'test' }` instead of `run` compiles the project's XCTest
tests with a generated main and runs them (see "Tests with XCTest").

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

## Tests with XCTest (xctest/, src/xctest.js)

The sysroot has no XCTest. The real one (swift-corelibs-xctest) does run on
WASI, but it imports Foundation: a trivial test binary is 53.7 MB. Tests use
macros in swift-testing, and macros cannot run here. So the pack has its
own **`XCTest` module, written for this pack, with no Foundation**
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

`typecheck.js` loads XCTest too, the first time an open file imports it,
and names the module the same way. So `import XCTest` and `@testable
import App` are not errors in the editor.

### How it ships

`swift-xctest.tar` (230 KB, **63 KB brotli**) holds the module's binary
`XCTest.swiftmodule` and `libXCTest.a`. It is unpacked over the sysroot
only when the project imports XCTest. It is a file of its own, so a change
to it does not invalidate the 44 MB sysroot in caches. `build.sh` builds it
with **the pack's own `swift-frontend.wasm` under Node**
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
   and against ours as the browser has it (swift-frontend.wasm 6.3.3 and
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
PASS  corpus: API.swift type-checks against ours as the browser has it (swift-frontend.wasm 6.3.3, swift-xctest.tar)
PASS  corpus: API.swift uses all 39 public names of ours
PASS  behaviour: Behaviour.swift prints the same 74 lines and exits the same with both
PASS  behaviour: the real XCTest's report is xctest/conformance/Behaviour.expected (which test-run.mjs checks the browser against)
```

## Type checking (semantic diagnostics)

`server.js` answers `initialize` as soon as `swift-ls.wasm` is loaded
(about 0.2 s), as before. On the first `didOpen` it starts
`typecheck.js`, a module worker nested in the server's worker. That worker
downloads `swift-frontend.wasm` and `swift-sysroot.tar` from the same URLs as
the runner (one cached copy for both) and reports the download as
`yukibana/loading`. Then, 350 ms after the last edit, the server sends every
open `.swift` file, the worker writes them under `/workspace` and runs the
frontend in two steps:

1. **`-dump-ast`**, with every file as a `-primary-file` (without primaries
   the frontend type-checks the whole module but dumps only the first
   file). This is type checking: its diagnostics are the type errors, and
   its stdout is the typed syntax tree, which `src/ast.js` reads in the
   worker (see "Answers from the compiler"). With one
   `-serialize-diagnostics-path` per primary file.
2. **`-emit-sil`**, only if step 1 found no error: the mandatory SIL passes
   find what type checking does not (missing return, use before
   initialisation, a `let` assigned twice, unreachable code, overlapping
   `inout` accesses). With type errors, `-emit-sil` stops after type
   checking and would print the same diagnostics again, so it is skipped.
   **Without mandatory inlining** (`-Xllvm
   -sil-disable-pass=mandatory-inlining`), see below.

Step 1's diagnostics are published as soon as it ends; step 2's replace them.

**Why a type error used to take 20 s.** The old check was `-emit-sil` alone.
One call of a `@_transparent` stdlib method such as `x.squareRoot()` (the
user's file and the test's `Shapes.swift` both have one) makes the
mandatory inliner deserialize Double's whole FloatingPoint witness table:
73 functions, 330 KB of SIL, and **4-10 s per check** in this wasm build
under load (measured under Node: 3.7-10.5 s with it, 0.24 s without; the
same file with `-typecheck` 0.25 s). The first check also downloads the
compiler. Mandatory inlining adds only constant folding through the inlined
operators to the diagnostics: of the SIL errors I tried (missing return,
use before init, `let` assigned twice, code after `return`, overlapping
`inout`, `1 / 0`), only "division by zero" is lost while typing; Run still
reports it. Arithmetic overflow such as `Int8(127) + 1` was not reported by
either variant.

* Fix-its: the frontend's text output drops any fix-it that spans lines
  (`add stubs for conformance`), so the worker also returns the serialized
  diagnostics files, which `src/dia.js` reads (an LLVM bitstream reader, about
  150 lines). Each fix-it becomes a quick fix on its diagnostic, titled by
  the note it belongs to; editor placeholders (`<#code#>`) become their
  plain name, as SourceKit-LSP does for clients that apply edits.
* Superseded work: a running frontend cannot be interrupted (the worker's
  thread is inside the wasm until it returns), so work is dropped before it
  starts. Diagnostics are used only if no document changed since their
  snapshot. When edits arrive during a check, only the newest one runs next;
  a check's SIL step is dropped when a newer check is waiting; completion
  probes (below) run before checks, and only the newest probe runs. In the
  test, six edits inside the debounce produce one check, for the last text.
* No warm instance: the frontend is a WASI *command*; `_start` runs `main`
  once, and its static constructors (LLVM's option registry among them)
  cannot run twice in one instance. Each step instantiates the compiled
  module again (the compiled `WebAssembly.Module`, the unpacked sysroot and
  clang's SwiftShims module cache are kept for the worker's lifetime). Most
  of a warm step is loading the 16 MB `Swift.swiftmodule`, about 0.15-0.3 s
  under Node, more in a loaded browser. Keeping it loaded would need a
  reactor build of the frontend that accepts several jobs, i.e. a change to
  swift-toolchain-wasm.
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

Measured in Chromium (test.mjs, headless, 4 shared cores with a clangd
build running): the first type error appears **3.1 s** after `didOpen` from
a local server, including downloading and compiling the frontend (ready
after about 1.1 s; the first check 1.3 s). Warm, a type error typed into the
user's probe file (which calls `squareRoot()` through `Shapes.swift`) appears
**1.1-1.4 s** after the edit (two runs), of which 350 ms is the debounce;
it was 20.8 s before. Steps take 0.15-0.6 s each.

If the frontend cannot load or crashes, the server logs it and the
diagnostics stay syntax-only, and every compiler-backed answer falls back
to swift-syntax-ls's.

## Answers from the compiler (types, completion, navigation)

There is no sourcekitd for wasm (yet), so there is no code completion or
cursor-info request to ask. What the batch compiler does give is
`-dump-ast`: every expression with its type (`type="[Int]"`), where it is
(`location=`, `range=`), and every name with the declaration the type
checker resolved it to (`decl="main.(file).total@/workspace/main.swift:3:5"`,
`decl="Swift.(file).Sequence extension.reduce [with (substitution_map ...
Self -> [Int] Result -> Int)]"`); declarations with their interface types,
members, parameters and conformances. It keeps resolved references even in
a file with errors, and its parser recovers well enough that `xs.map { $0`
with no closing brace still types `$0` as `Int`. 6.3.3 also has
`-dump-ast-format json`, but it prints types mangled; the text format is
used, read line by line (`src/ast.js`, ~250 lines; 20 ms for a 17-line file's
43 KB dump). Its layout is not a stable interface, which is acceptable
because the compiler is pinned.

What the tree answers (`src/semantic.js`, `src/server.js`):

| request | from the compiler | falls back to swift-syntax-ls when |
|---|---|---|
| completion after `base.` | the compiler's type of `base`, then that type's members: the project's own declarations (struct/class/enum/protocol members, extensions, superclasses, protocol extensions) and, for library types, the stdlib index, with generic arguments filled in (`append(_ newElement: Int)` on `[Int]`) and constraints checked (`sorted()` is offered on `[Int]` but not on `[Point]` unless Point is Comparable; `joined(separator:)` only on sequences of strings). `opt.` on an Optional offers Optional's members and the wrapped type's as `opt?.member` edits. Methods insert a snippet (`reduce(${1:Result}, ${2:...})`); documentation comes with `completionItem/resolve` | the type is unknown (frontend not loaded yet, probe timed out after 4 s) or has no known members |
| completion of a plain name | swift-syntax-ls's names in scope and keywords, **plus** the stdlib's free functions (`print`, `min`, `max`, `zip`, `stride`, `readLine`, ...) and type names | — |
| hover | variables, constants, parameters, closure parameters: `let total: Int` with the doc comment from the declaration; project functions and types: the declaration the compiler resolved the name to (overloads and other files included), rendered by swift-syntax-ls; stdlib: declaration, generic substitution (`Result` = `Int`) and the full doc comment from the index; a stdlib type name in an annotation: its declaration and doc | no tree yet, or the spot was edited since the last check |
| definition | the declaration the compiler resolved the name to, in any file. A **stdlib** declaration has no source here, so the answer is empty rather than a guess; its hover shows the declaration and documentation. (The app opens only workspace files, so a read-only interface document is not possible without changing `app/src`.) | as for hover |
| references, highlight, rename | every use the compiler resolved to the same declaration, so two unrelated `x` members are told apart; renaming a stdlib name is refused | the tree is not current (an edit may add uses), or the name is a type or an initialiser (a type name in an annotation, `let p: Point`, is not located in the dump) |
| signature help | swift-syntax-ls's for project functions; for stdlib functions and methods (`print(`, `xs.reduce(`), the index's overloads | — |
| inlay hints | `: Type` after every variable or constant declared without a type (new) | — |

**The type before the dot.** When the text up to the end of `base` is
unchanged since the last check (the user stopped, then typed `.`), the type
comes from the current tree in about **30 ms**. Otherwise the server sends a
*probe*: the project with this file's `.partial` (and `?`/`!`) removed, so
`xs.` is checked as `xs`; the worker runs `-dump-ast` on it ahead of any
check and returns the tree; the type is read off the expression whose range
is exactly the base. That takes **0.35-0.95 s** warm in test.mjs (median
0.8 s over 10 completions; the frontend's own run is 0.24-0.56 s, the rest is
waiting for a check that was already running when the dot was typed). The base is found by reading the postfix chain backwards
(`a.b(c)[0].d`, `makePoints()`, `xs.map { ... }`, `$0`, literals).
`$/cancelRequest` ends the wait: Monaco cancels a completion when the user
keeps typing.

**Positions after edits.** A tree describes the text it was computed on.
Every lookup maps between that snapshot and the current text through their
common prefix and suffix, and checks the identifier is still the same, so
hover and definition keep working while typing anywhere else in the file.

**The standard library index** (`tools/stdlib-index.mjs`,
`swift-stdlib-index.json`): built at build time from the symbol graph that
the native `swift-symbolgraph-extract` (6.4.1) writes for the **6.3.3**
stdlib's `.swiftinterface` (the release sysroot's; the 6.3.3 binary modules
are refused by the 6.4.1 tool, so it rebuilds them from the interfaces,
about 50 s), so completion offers what the in-browser compiler accepts.
Synthesized members (a protocol extension's method as a member of Array)
make each type's list complete; `_StringProcessing`'s extensions
(`contains(_:)`, `split(separator:)`, `replacing(_:with:)`, regex methods)
are added to the types that conform. It covers 36 types (Array,
ArraySlice, Dictionary and its Keys/Values, Set, String, Substring,
Character, Unicode.Scalar, the integer types, Double, Float, Bool,
Optional, Result, Range, ClosedRange, EnumeratedSequence, Zip2Sequence,
stride sequences, ...) and 36 protocols (Sequence, Collection, Equatable,
Hashable, Comparable, CustomStringConvertible, Numeric, ...) with 2,788
members, 30 free functions and 749 doc comments (one table, shared by every
type that inherits a member). Underscored, unsafe, `Span`, deprecated and
post-6.3 API is left out. 905 KB raw, **108 KB brotli**, fetched once,
when the type checker is ready.

**Still syntactic or missing:**

* Members of generic parameters (`func f<T: Comparable>(_ x: T) { x. }`),
  of function types, of `some`/`any` existentials beyond their protocol's
  index entry, and of library types outside the index (Regex, Task, ...)
  fall back to swift-syntax-ls's guess.
* Implicit member completion (`let d: Direction = .`, `return .sad()`,
  `f(.)`) knows the contextual type only from the compiler's error for a
  probe member (`type 'Int' has no member '__yukibana_implicit_member'`).
  Where the compiler cannot infer one (overloads it cannot pick between,
  `cannot infer contextual base`), it is swift-syntax-ls's guess (every
  enum case in the project). Members are filtered by their declared type
  being the contextual type or `Self`, so a static member reached through
  a chain (`.init().other`) is not offered.
* Generic substitution for display is textual (`Element` -> `Int`); a
  method's own generic parameters stay as declared (`map<T>`), and some
  nested associated types print unsimplified (`[Int].Element`).
* Constraints that name a method's own generic parameter (`C.Element ==
  Element`) are not decided and do not exclude a member; conditional
  conformances of library types are treated as unconditional.
* No completion inside a string interpolation's dot that the base scanner
  cannot read backwards (e.g. after a comment between base and dot).
* Operators are not in the index: hovering `+` shows nothing.
* References/rename for types and initialisers, and project symbols'
  doc comments, still come from swift-syntax-ls.

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
* `1 / 0` ("division by zero") is not reported while typing, because the
  editor's SIL step runs without mandatory inlining (see "Type checking").
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
| `swift-xctest.tar` | | 230 KB / 79 KB / 63 KB | the browser's XCTest, fetched only by projects that import it (see "Tests with XCTest") |
| `runner.js` | | 41 KB / 14 KB / 12 KB | includes test discovery (src/xctest.js) |
| `typecheck.js` | | 34 KB / 10.6 KB / 9.6 KB | includes `ast.js` |
| `server.js` | | 41 KB / 15.5 KB / 14.1 KB | includes `semantic.js` |
| `swift-stdlib-index.json` | | 905 KB / 155 KB / **108 KB** | fetched when the type checker is ready |
| `swift-ls.wasm` | | 7.28 MB / 2.65 MB / 1.76 MB | |

* The language server alone is still 1.77 MB (brotli) before its first
  answer (server.js 14 KB of it). The stdlib index adds 108 KB once the
  type checker is ready. Type checking adds `swift-frontend.wasm` + `swift-sysroot.tar`
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
  typecheck.js         nested worker: swift-frontend -dump-ast (diagnostics, fix-its, typed tree), then -emit-sil
  swift-stdlib-index.json  the 6.3.3 stdlib's members and docs (tools/stdlib-index.mjs)
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
| definition, hover, references, highlight, rename, signature help | name resolution: local scopes by `SwiftLexicalLookup` (swift-syntax's own lexical lookup: parameters, locals, `if let`, closures, members of the enclosing type), then declarations in every open file. `a.b` resolves `b` in the type of `a`, inferred from annotations, `T(...)` initialisers, function return types, member chains, `self`, superclasses/protocols in inheritance clauses and extensions | **heuristic**, now the fallback: the compiler answers first (see "Answers from the compiler") |
| completion | after `.`: members of the inferred type (falls back to every member in the project when the type is unknown); otherwise names in scope, every file's top-level declarations, keywords | **heuristic**; after `.` only the fallback, for plain names merged with the stdlib's |

What swift-syntax-ls's own answers do **not** do (they are what the editor
shows while the compiler has not answered, and where "Answers from the
compiler" lists a fallback):

* No standard library: `"abc".` offers nothing, `print` has no hover.
* No type inference beyond the cases above: closures, generics, overloads,
  operators, `map { ... }` results, literals in collections other than the
  first element. Overloaded names resolve to every candidate.
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
features, the deep-code guards, the type checker, and the answers from the
compiler on the user's probe file (completion after `xs.`, `ps.`, `name.`,
`dict.`, `total.`, `makePoints().`, `ps[0].`, `$0.`, `xs.first.`; hover
types; stdlib hover; definition; references; signature help; inlay hints;
latencies). Output of the last run
(after a full `./build.sh`):

```text
crossOriginIsolated: false
PASS  initialize answers, and the server says what it is  swift-syntax-ls + swift-frontend 6.3.3 type checker 0.3.0 (swift-syntax 604.0.0 on the Swift 6.4.1 Wasm SDK; diagnostics, types, hover, definition, references and member completion from swift-frontend 6.3.3 -dump-ast, swift-toolchain-wasm release swift-6.3.3-wasm) after 241 ms
PASS  yukibana/loading reports swift-ls.wasm  20 progress notifications
PASS  Shapes.swift is clean  []
PASS  Circle.swift is clean  []
PASS  main.swift is clean  []
PASS  `let x: Int = "no"` yields a type-error diagnostic from swift-frontend  ["1: cannot convert value of type 'String' to specified type 'Int'"] {"start":{"line":0,"character":13},"end":{"line":0,"character":17}} after 3124 ms (cold: downloads and compiles swift-frontend.wasm)
PASS  yukibana/loading reports swift-frontend.wasm  56 progress notifications
PASS  Shapes.swift stays clean after type checking  []
PASS  Circle.swift stays clean after type checking  []
PASS  main.swift stays clean after type checking  []
PASS  after an edit the type checker runs again (warm)  ["2: cannot convert value of type 'Int' to specified type 'String'"] 719 ms
PASS  superseded edits are not checked: diagnostics only for the last text  ["1: cannot convert value of type 'String' to specified type 'Int64'"]; target types seen: String, Int64
PASS  "add stubs for conformance" from swift-frontend is a quick fix that inserts the missing method  [["Add stubs for conformance",{"changes":{"file:///workspace/Typed.swift":[{"range":{"start":{"line":4,"character":14},"end":{"line":4,"character":14}},"newText":"\n    func a() -> Int {\n        code\n    }\n"}]}}]]
PASS  a missing return (a SIL diagnostic) is reported while editing  ["5: missing return in global function expected to return 'Int'"]
PASS  a test file: XCTest is found, `@testable import Shapes` is quiet, the type error in it is reported  ["6: conflicting arguments to generic parameter 'T' ('String' vs. 'Int')"] after 803 ms, 2 swift-xctest.tar progress notifications
PASS  an introduced error is a diagnostic  ["4: expected ')' to end function call"]
PASS  the type checker's copy of the syntax error is not shown twice  ["4: expected ')' to end function call"]
PASS  it comes with a quick fix  ["insert ')'"]
PASS  completion after "c.centre." lists Point's members (Circle.swift -> Shapes.swift)  ["x","y","norm","moved"] 572 ms
PASS  hover on far.norm() shows its signature and doc comment  {"kind":"markdown","value":"```swift\n// in Point\nfunc norm() -> Double\n```\n\n---\n\nDistance from the origin."} 7 ms
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
PASS  compiler: completion after `xs.` ([Int]) lists Array's members from the stdlib index  115 items in 633 ms: allSatisfy, append, append, applying, capacity, compactMap, contains, contains, contains, count, count, debugDescription...
PASS  compiler: `reduce` is shown for [Int], with Int filled in and a snippet  ["func reduce<Result>(_ initialResult: Result, _ nextPartialResult: (Result, Int) throws -> Result) rethrows -> Result","reduce(${1:Result}, ${2:(Result, Int) throws -> Result})"]
PASS  compiler: completion after `ps.` ([Point]) offers sorted(by:) but not sorted(), since Point is not Comparable  90 items in 948 ms
PASS  compiler: completion after `name.` (String)  144 items in 889 ms
PASS  compiler: completion after `dict.` ([String : Int])  75 items in 907 ms
PASS  compiler: completion after `total.` (Int, from reduce) lists Int's members, not Point's  26 items in 382 ms
PASS  compiler: completion after `makePoints().` ([Point])  90 items in 361 ms
PASS  compiler: completion after `ps[0].` (Point)  ["x","y","norm","moved"] in 796 ms
PASS  compiler: completion after `$0.` in a map over [Int] (unclosed closure) lists Int's members  26 items in 879 ms
PASS  compiler: after `xs.first.` (Int?) Optional's members, and Int's as `?.member` edits  32 items in 626 ms, {"range":{"start":{"line":9,"character":8},"end":{"line":9,"character":9}},"newText":"?.isMultiple(of: ${1:Int})"}
PASS  compiler: completionItem/resolve adds the stdlib doc comment  Returns the result of combining the elements of the sequence
PASS  compiler: hover shows the inferred types  ["```swift\nlet total: Int\n```","```swift\nlet ps: [Point]\n```","```swift\nlet first: Point\n```","```swift\nvar dict: [String : Int]\n```","```swift\nlet p: Point\n```"]
PASS  compiler: hover on reduce shows the stdlib declaration, its substitution and its doc  ```swift
// Sequence
func reduce<Result>(_ initialResult: Result, _ nextPartialResult: (Result, Int) throws -> Result) rethrows -> Result
```

`Result` = `Int`

PASS  compiler: hover on print shows its declaration and doc  ```swift
func print(_ items: Any..., separator: String = " ", terminator: String = "\n")
```

---

W
PASS  compiler: hover on squareRoot (in Shapes.swift) shows FloatingPoint's doc  ```swift
// FloatingPoint
func squareRoot() -> Double
```

---

Returns the square root of the value
PASS  compiler: hover on p.norm() (declared in another file) shows its declaration and doc  ```swift
// in Point
func norm() -> Double
```

---

Distance from the origin.
PASS  compiler: definition of makePoints, p.norm and ps lands on their declarations; reduce (stdlib) has no location, not a wrong one  {"makePoints":["file:///workspace/main.swift:1:6"],"norm":["file:///workspace/Shapes.swift:7:10"],"ps":["file:///workspace/main.swift:4:5"],"reduce":[]}
PASS  compiler: references to xs are its declaration and its use in reduce  ["file:///workspace/main.swift:3:5","file:///workspace/main.swift:8:13"]
PASS  compiler: signature help for print( comes from the stdlib index  ["func print(_ items: Any..., separator: String = \" \", terminator: String = \"\\n\")","func print<Target>(_ items: Any..., separator: String = \" \", terminator: String = \"\\n\", to output: inout Target) where Target : TextOutputStream"]
PASS  compiler: inlay hints give the inferred types of unannotated declarations  ["3:: [Int]","4:: [Point]","5:: Point","6:: String","8:: Int"]
PASS  compiler: completion after a dot in checked text answers from the tree, without running the compiler  28 ms
PASS  compiler: a type error is reported quickly when warm  1443 ms
(latency: completion with a probe 361-948 ms, median 796 ms; from the tree 28 ms; type error 1443 ms after the edit)
PASS  an edit to Shapes.swift reaches completion in main.swift  ["x","y","z","norm","moved"]
PASS  formatting re-indents mixed indentation consistently  "struct A {\n    var x = 1\n    func f() {\n        return\n    }\n}\n"
PASS  rename accepts Unicode and backticked identifiers and refuses non-identifiers  [1,1,"\"not a name\" is not a Swift identifier"]
PASS  CRLF: a comment token stops before \r, and a column past a line end stays on that line  [0,0,4,4,0,1,0,5,4,0] hover past end: null
PASS  a 2000-link member chain: the server answers (skipped) and the other files still work  162 ms swift-syntax-ls does not analyse this file: its syntax tree is nested more than 700 levels
PASS  arrays nested 30 deep (exponential in the parser): the server answers (skipped) and the other files still work  147 ms swift-syntax-ls does not analyse this file: its `[` brackets nest 30 deep, and swift-synta
PASS  a 2000-branch else-if chain: the server answers (skipped) and the other files still work  67 ms swift-syntax-ls does not analyse this file: its syntax tree is nested more than 700 levels
PASS  300 nested closures: the server answers (parser nesting limit) and the other files still work  160 ms parsing has exceeded the maximum nesting level
(0 trap(s) recovered from in the cases above)
PASS  shutdown answers  ""
[log 3] swift-syntax-ls + swift-frontend 6.3.3 type checker 0.3.0 (swift-syntax 604.0.0 on the Swift 6.4.1 Wasm SDK; diagnostics, types, hover, definition, references and member completion from swift-frontend
[log 3] swift-frontend 6.3.3 type checker loaded in 1487 ms
[log 4] swift-frontend check: 1 diagnostics in 1185 ms (-dump-ast)
[log 4] swift-frontend check: 1 diagnostics in 248 ms (-dump-ast)
[log 4] swift-frontend check: 1 diagnostics in 804 ms (-dump-ast)
[log 4] swift-frontend check: 1 diagnostics in 420 ms (-dump-ast)
[log 4] swift-frontend check: 0 diagnostics in 366 ms (-dump-ast)
[log 4] swift-frontend check: 1 diagnostics in 551 ms (-emit-sil)
[log 4] swift-frontend check: 1 diagnostics in 383 ms (-dump-ast)
[log 4] swift-frontend check: 1 diagnostics in 613 ms (-dump-ast)
[log 4] swift-frontend probe: typed in 555 ms (557 ms with waiting)
[log 4] completion: 4 members of Point (probe, 558 ms)
[log 4] swift-frontend probe: typed in 349 ms (600 ms with waiting)
[log 4] completion: 115 members of [Int] (probe, 600 ms)
[log 4] swift-frontend probe: typed in 443 ms (924 ms with waiting)
[log 4] completion: 90 members of [Point] (probe, 924 ms)
[log 4] swift-frontend probe: typed in 366 ms (808 ms with waiting)
[log 4] completion: 144 members of String (probe, 808 ms)
[log 4] swift-frontend probe: typed in 327 ms (881 ms with waiting)
[log 4] completion: 75 members of @lvalue [String : Int] (probe, 881 ms)
[log 4] swift-frontend probe: typed in 350 ms (364 ms with waiting)
[log 4] completion: 26 members of Int (probe, 364 ms)
[log 4] swift-frontend probe: typed in 333 ms (335 ms with waiting)
[log 4] completion: 90 members of [Point] (probe, 336 ms)
[log 4] swift-frontend probe: typed in 331 ms (778 ms with waiting)
[log 4] completion: 4 members of Point (probe, 779 ms)
[log 4] swift-frontend probe: typed in 407 ms (860 ms with waiting)
[log 4] completion: 26 members of Int (probe, 860 ms)
[log 4] swift-frontend probe: typed in 284 ms (612 ms with waiting)
[log 4] completion: 32 members of Int? (probe, 615 ms)
[log 4] swift-frontend check: 0 diagnostics in 267 ms (-dump-ast)
[log 4] swift-frontend check: 0 diagnostics in 327 ms (-dump-ast)
[log 4] completion: 144 members of String (tree)
[log 4] swift-frontend check: 1 diagnostics in 335 ms (-dump-ast)
[log 4] swift-frontend probe: typed in 241 ms (242 ms with waiting)
[log 1] textDocument/rename: Error: "not a name" is not a Swift identifier
    at je (http://127.0.0.1:46689/packs/swift/server.js:34:8567)
    at textDocument/rename (http://127.0.0.1:46689/packs/swift/serve
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
and a type error (this run was on a machine busy with another build):

```text
PASS  the page is crossOriginIsolated and controlled by a service worker that caches /packs/
PASS  sample project (cold): main.swift + Geometry.swift print the distance and the norm, exit 0  "(0.0, 0.0) to (3.0, 4.0): 5.0\n5.0\n" code=0 in 8246 ms, 36.7 MB transferred; Loading the Swift compiler@24, Compiling@4045, Linking@7325, Running@8226
PASS  loading messages for each download  wasm-ld.wasm 41774304/41774304, swift-sysroot.tar 44339200/44339200, swift-frontend.wasm 113085926/113085926
PASS  sample project (warm #1): same output from the browser cache  code=0 in 5850 ms, 0 bytes transferred; Loading the Swift compiler@34, Compiling@1956, Linking@4778, Running@5824
PASS  sample project (warm #2): same output from the browser cache  code=0 in 6706 ms, 0 bytes transferred; Loading the Swift compiler@34, Compiling@2208, Linking@4874, Running@6673
PASS  readLine(): prompt without newline, two lines of stdin, their sum  "first number: second number: sum: 42\n" requests=2 seen-before-input=["first number: ","first number: second number: "] code=0 4077 ms; Loading the Swift compiler@42, Compiling@1525, Linking@3073, Running@4061
PASS  end of input (Ctrl-D) makes readLine() return nil  code=0 "got one\ngot two\nend of input after 2 lines\n" requests=3
PASS  type error: swift-frontend diagnostics on stderr, non-zero exit, not run  code=1 3072 ms
main.swift:1:14: error: cannot convert value of type 'String' to specified type 'Int'
let x: Int = "no"
             ^~~~
PASS  runtime error: index out of range is reported and exits non-zero  code=134 "before\n"
Swift/ContiguousArrayBuffer.swift:692: Fatal error: Index out of range

Program crashed: unreachable
PASS  endless loop: terminated by the page, which stays responsive  stopped after 4270 ms; Loading the Swift compiler@20, Compiling@1464, Linking@2481, Running@3240
PASS  XCTest: the behaviour corpus prints exactly what swift-corelibs-xctest prints (assertion texts, skips, setUp/tearDown order, async, summaries) and exits 1  74 lines, code=1 in 6411 ms, swift-xctest.tar [229888,229888]; Loading the Swift compiler@63, Compiling@1442, Linking@5791, Testing@6341
      Behaviour.swift:28: error: Assertions.testFailing : XCTAssertTrue failed - 
      Behaviour.swift:29: error: Assertions.testFailing : XCTAssertTrue failed - true
      Behaviour.swift:30: error: Assertions.testFailing : XCTAssertFalse failed - 
      Behaviour.swift:31: error: Assertions.testFailing : XCTAssertEqual failed: ("2") is not equal to ("3") - two and three
      Behaviour.swift:32: error: Assertions.testFailing : XCTAssertEqual failed: ("a") is not equal to ("b") - 
      Behaviour.swift:33: error: Assertions.testFailing : XCTAssertNotEqual failed: ("1") is equal to ("1") - 
      Behaviour.swift:34: error: Assertions.testFailing : XCTAssertEqual failed: ("1.0") is not equal to ("1.5") +/- ("0.1") - 
      Behaviour.swift:35: error: Assertions.testFailing : XCTAssertNotEqual failed: ("1.0") is equal to ("1.05") +/- ("0.1") - 
PASS  XCTest: discovered tests pass (`@testable import Calc` names the module), setUp/tearDown around each, exit 0, nothing on stderr  code=0 in 5170 ms; Loading the Swift compiler@39, Compiling@1769, Linking@4140, Testing@5091
      CalculatorTests.testAdd: ["setUp", "test", "tearDown"]
      	 Executed 5 tests, with 0 failures (0 unexpected) in 0.012 (0.013) seconds
PASS  XCTest: 'run' of the same project runs the program, without its tests  "5\n" code=0
PASS  XCTest: failures as file:line: error: Class.test : message, project-relative; a thrown error is unexpected; exit 1  code=1
      Tests/CalculatorTests.swift:5: error: CalculatorTests.testAdd : XCTAssertEqual failed: ("4") is not equal to ("5") - two and two
      Tests/CalculatorTests.swift:6: error: CalculatorTests.testDivide : XCTAssertEqual failed: ("0.3333333333333333") is not equal to ("0.3") +/- ("0.001") - 
      <EXPR>:0: error: CalculatorTests.testThrows : threw error "divisionByZero"
      Tests/CalculatorTests.swift:8: error: CalculatorTests.testUnwrap : XCTUnwrap failed: expected non-nil value of type "Int" - 
      	 Executed 5 tests, with 4 failures (1 unexpected) in 0.003 (0.008) seconds
      	 Executed 5 tests, with 4 failures (1 unexpected) in 0.003 (0.021) seconds
PASS  XCTest discovery: own, inherited, extension, backticked, nested and async tests; nothing from comments, strings, helpers, arguments, static, private, generic  code=0 ["BaseTests.testFromBase passed","DerivedTests.testOwn passed","DerivedTests.testBackticked passed","DerivedTests.testInExtension passed","DerivedTests.testFromBase passed","NestedTests.testNested passed"]

PASS  XCTest: a class with its own allTests runs exactly that list  code=0

PASS  XCTest: a main.swift that calls XCTMain itself (LinuxMain style) is used instead of a generated one  code=0 "hand-written main\nTest Suite 'All tests' started at 2026-10-"

PASS  XCTest: 'run' of that project runs its main.swift with the tests it names  code=0

PASS  XCTest: a type error in a test is reported like any other, and nothing runs  code=1
Tests/BrokenTests.swift:3:20: error: conflicting arguments to generic parameter 'T' ('String' vs. 'Int')
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
* the 6.3.3 stdlib's symbol graph (`stdlib-index/sg`, 53 MB), written once
  by the native `swift-symbolgraph-extract` from the release sysroot's
  `.swiftinterface` files (about 50 s), then `tools/stdlib-index.mjs`
  (about 2 s).
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
* `src/server.js`: the LSP worker, including the type-check scheduling,
  the diagnostic merge, probes and the compiler-backed request handlers.
* `src/semantic.js`: the compiler's tree as lookups (with snapshot/current
  position mapping), types as the compiler prints them, member lists, the
  stdlib index, hover markdown, the text scanners for completion and
  signature help.
* `src/ast.js`: the `-dump-ast` reader (runs in the type checker's worker).
* `src/typecheck.js`: the type checker's worker.
* `tools/stdlib-index.mjs`: builds `swift-stdlib-index.json` from the
  symbol graph.
* `src/runner.js`: the runner.
* `src/toolchain.js`: the shared pipeline (arguments, file system, tar,
  WASI, downloads, autolink).
* `src/xctest.js`: test discovery, the generated test main, the module-name
  rule for `@testable import`.
* `xctest/XCTest/*.swift`: the browser's XCTest. `xctest/conformance/`:
  `API.swift` (the conformance corpus), `Behaviour.swift` and
  `Behaviour.expected` (the report of the real XCTest).
* `tools/build-xctest.mjs` (builds swift-xctest.tar with swift-frontend.wasm),
  `tools/xctest-subset.mjs` (the subset check, `npm run test:xctest`).
* `tools/trim-sysroot.mjs`, `tools/bench.mjs`.
* `build.sh`, `compress.mjs`, `test.mjs`, `test-run.mjs`.
