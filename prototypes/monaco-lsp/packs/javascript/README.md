# JavaScript pack (`javascript`)

The real TypeScript language service, the same one behind tsserver and VS
Code, runs in a module Web Worker. A small LSP adapter (`src/server.ts`, 18 KiB
minified) sits over it. It is not a fallback and not a lookalike. Every
answer comes from `ts.LanguageService` running over an in-memory file system
that holds the project's documents and the bundled `lib.*.d.ts` files.

* **Server:** TypeScript **6.0.3** (`typescript` on npm, the last JavaScript
  release line; `latest` is 7.x, which is the Go port and has no JavaScript
  LanguageService). Upstream: <https://github.com/microsoft/TypeScript>. The
  version is pinned in `package-lock.json` together with its npm integrity hash.
* **Adapter:** hand-written for this pack (`yukibana-typescript-ls` 0.1.0).
  It needs no runtime dependencies apart from TypeScript.
  `vscode-languageserver-protocol` is used only for types.
* **No patch to TypeScript.** `build.sh` adds one line, `export default ts;`,
  to the end of `typescript.js`, which makes the published script an ES
  module. It then minifies the result with esbuild.
* **No `SharedArrayBuffer` and no `crossOriginIsolated` needed.** Everything
  runs synchronously on the worker's thread.

## What the worker downloads

| file | raw | gzip -9 | brotli 11 |
|---|---:|---:|---:|
| `server.js` (adapter, with the node:test/node:assert types) | 28.3 KiB | 9.3 KiB | 8.3 KiB |
| `typescript-6.0.3.js` (minified ESM) | 3520.1 KiB | 1005.5 KiB | 781.0 KiB |
| `libs-6.0.3.json` (64 lib files) | 2538.8 KiB | 387.0 KiB | 279.3 KiB |
| **total** | **6087.2 KiB** | **1401.8 KiB** | **1068.6 KiB** |

`build.sh` writes `.gz` and `.br` siblings for each file. On a local
connection, `initialize` answers about 220 ms after the worker starts,
including both downloads. The first full check (three files, `lib.dom`
included) publishes diagnostics about 0.7–0.9 s after `didOpen`. Later checks
are incremental.

* **Libs:** the bundle holds the transitive closure of `es2023`, `dom`,
  `dom.iterable` and `dom.asynciterable`. In 6.x the last two are empty stubs
  that were merged into `dom`. `tools/libs.mjs` drops the licence headers,
  line comments, indentation and blank lines. It does this with TypeScript's
  own scanner and then checks that the token stream did not change.
* **Kept on purpose: the JSDoc.** Hover and completion documentation for
  built-ins such as `Array.prototype.map` and `fetch` comes from it.
  Stripping it would bring the bundle down to 94 KiB brotli, saving about
  185 KiB, but hover on anything built-in would then show a bare signature.
  Dropping only the MDN links saves 25 KiB.

## Loading and transport

* The worker downloads `typescript-6.0.3.js` and `libs-6.0.3.json` in
  parallel. It reports `yukibana/loading` with the uncompressed size as
  `total`; the build injects that size because `Content-Length` is the
  compressed size when a sibling is served.
* It imports TypeScript from a `blob:` URL made from the bytes it already
  fetched, so the 3.5 MB file is downloaded only once while the progress bar
  still shows real progress. A page CSP that forbids `blob:` in `script-src`
  would block that import; the app sets no CSP.
* Messages that arrive before loading finishes are queued, so `initialize`
  is answered once TypeScript is ready. If loading fails, every pending and
  later request gets an error response instead of hanging, and the reason is
  sent as `window/logMessage`.
* Incoming messages are drained in one task. A `$/cancelRequest` that arrives
  right behind its request (fast typing, stale completions) cancels the
  request before it runs. A request already running is not interrupted.
* A worker serves one session. A second `initialize` is refused with an
  error; the app starts a new worker instead. A message that is not a JSON-RPC
  2.0 object is logged and ignored.
* `workspace/didChangeWatchedFiles` is accepted and ignored: creations and
  deletions arrive as `didOpen`/`didClose`, which is what the project follows.

## What works

`test.mjs` exercises every feature listed here (see "Files" below for the
list of checks). The one path it does not reach is a failed download of
TypeScript, which answers every request with an error.

* **Diagnostics:** syntactic, semantic and suggestion diagnostics, for the
  whole project, about 200 ms after the last edit. The worker yields between
  files so that requests are answered in between, drops a run that a newer
  edit made stale, and does not resend unchanged results. Each diagnostic
  carries its unnecessary or deprecated tags and any related information
  that points into the project.
* **When JavaScript is type-checked:** this follows TypeScript's own rules.
  A file is checked when it starts with `// @ts-check`, or when the project
  has a `jsconfig.json`/`tsconfig.json` with `"checkJs": true`.
  **A jsconfig.json alone does not turn checking on.** That is what
  TypeScript and VS Code do, and the pack does not invent a different rule.
  Without checking, JavaScript still gets completions, hover, definitions and
  so on, but no type errors.
* **TypeScript files** (`.ts`, `.tsx`, `.mts`, `.cts`) work too, including
  imports between `.ts` and `.js` files.
* **Completion:** includes auto-imports, member completion, optional-chain
  completion and snippets when the client supports them.
  `completionItem/resolve` adds the signature, the docs and any auto-import
  edit. Auto-imports always write the extension (`./math.js`), because the
  project runs as native ES modules, where `./math` does not resolve.
* **Navigation and editing:** hover, signature help, definition, type
  definition, implementation, references, document highlight, document
  symbols, workspace symbols, prepare rename and rename across files, and
  document and range formatting.
* **Code actions:** quick fixes for diagnostics, such as a spelling fix,
  declaring a missing member, or `@ts-ignore`, and `source.organizeImports`
  when that kind is requested and there is something to change.
* **Semantic tokens (full):** TypeScript's 2020 classification, with the same
  legend as VS Code.

## Project configuration

* `tsconfig.json`, or else `jsconfig.json`, at the workspace root is parsed
  by TypeScript itself (`parseJsonSourceFileConfigFileContent`), so a
  jsconfig gets jsconfig's defaults. Errors in it, including option errors
  such as a `lib` that is not bundled, are published on that file.
* Without a config file, the defaults are those of an editor for loose
  files: `allowJs`, ES2023 target, ESNext modules with `Bundler` resolution,
  and `strict` except `noImplicitAny` (untyped JavaScript parameters are
  normal).
* `noEmit` is always forced, because nothing is ever emitted here. Without it
  the worker would report TS5055 ("Cannot write file … would overwrite input
  file"), which is noise in an editor.
* `lib` defaults to the bundled set above.
* `types` defaults to `[]`, because there is no `node_modules/@types`.
* **`node:test`, `node:assert`, `node:assert/strict`** (and `assert`,
  `assert/strict`) are typed in every project: `src/node/builtins.d.ts`,
  embedded in `server.js` by `build.sh` and added as a root file next to
  the libs (so, like a lib, it never shows up in references, definitions or
  workspace symbols). It declares what the runner implements (see Testing),
  with @types/node's signatures, so `import { describe, it } from
  'node:test'` checks cleanly and `mock` or `assert.partialDeepStrictEqual`
  are errors, as they would fail at run time. One deliberate difference
  from @types/node: `t.assert.*` is typed without `asserts` clauses, since
  TypeScript refuses an assertion call through the unannotated `t` of
  `test('x', (t) => ...)` (TS2775), which @types/node users hit too.

## What does not work, and why

* **Libs outside the bundle**, such as `webworker`, `esnext` or the
  `es20xx.full` variants, are reported as missing on the config file. They
  are not silently ignored. Adding them means adding names to the
  `tools/libs.mjs` call in `build.sh`.
* **npm packages and `@types`:** there is no `node_modules` and no package
  download, so `import x from 'lodash'` is unresolved (an error only in
  checked files).
* **The project is the set of files the client opened.** The `include`,
  `exclude` and `files` keys of a config file are not applied. Project
  references and `extends` pointing outside the project are not supported.
* **Results point only into the project.** Definitions, references and
  related information that lead into `lib.*.d.ts` are dropped, because the
  client cannot open those files. Hover still shows lib docs.
* **Not implemented:** refactorings (extract function and so on), code lens,
  inlay hints, call hierarchy, on-type formatting and fix-all. TypeScript
  offers all of them, so each would be an adapter addition, not a blocker.
  Quick fixes that need a command (installing `@types`) are skipped.
* **English diagnostics only**, because the localized message files are not
  shipped.

## Why not Volar

I evaluated `@volar/language-server@2.4.30` (`browser` entry) with
`volar-service-typescript@0.0.71` as a ready-made, maintained browser LSP
server around the same TypeScript service. A minimal entry bundled with
esbuild came to **578 KiB minified (143 KiB gzip) before TypeScript**,
against 18.5 KiB (6.9 KiB gzip) for this adapter.

It would also have been more indirect here, for three reasons:

* Its browser server reads files through async URI-based file-system
  providers. By default these are HTTP providers aimed at CDN-hosted typings.
* It finds `tsconfig` files by `stat`-ing up the tree.
* Its `loadTsdkByUrl` loads TypeScript by assigning a global `module`.

Serving lib files to Volar from the worker would mean writing a custom
provider anyway. What Volar adds on top of the LanguageService is mostly the
virtual-code layer for Vue, Astro and MDX, which a JavaScript pack does not
use. The hand-written adapter is a direct, synchronous mapping of LSP
requests onto `LanguageService` methods.

The alternative named in the task, `@typescript/vfs`, was not needed: the
`LanguageServiceHost` over a `Map` is about 40 lines in `server.ts`.

## Files

* `build.sh`
  * Runs `npm ci` with its cache in `$PACK_CACHE/javascript/npm`, but only
    when the lock file changed.
  * Refuses a TypeScript version that is not 5.x or 6.x.
  * Typechecks the adapter, then builds the three files into
    `../../app/static/packs/javascript/` and writes `.gz` and `.br` siblings.
  * Incremental: big outputs are rebuilt only when their inputs change.
  * A clean build (npm install plus brotli 11 on 6 MB) takes about
    **1 min 50 s** on the shared 4-core machine; a rebuild that touches only
    the adapter takes about 2 s.
* `src/server.ts`: the adapter, written in TypeScript with strict settings
  (`npx tsc -p tsconfig.json`).
* `tools/libs.mjs`: collects and minifies the lib bundle and checks it.
* `tools/compress.mjs`: writes the compressed siblings and prints the size
  table.
* `src/node/`: the runner's `node:test` (`test.ts`), `node:assert`
  (`assert.ts`, with `inspect.ts` for its messages) and their types for the
  server (`builtins.d.ts`).
* `test-run.mjs` (`node test-run.mjs` after `./build.sh`): the runner in
  Chromium with COOP/COEP: the sample and a program reading two lines with
  `prompt()`, then test mode: the sample's tests, a failing one, the
  comparison with `node --test`, a test file that does not load, no test
  files, an uncaught error during a test, `test/` files and `console.log` in
  tests, and `node:test` in a plain run.
* `test.mjs` (`node test.mjs` after `./build.sh`)
  * Serves `app/static` over HTTP and serves the `.br` siblings like the
    app's host would.
  * Starts `server.js` as a module Worker in Chromium
    (`/opt/pw-browsers/chromium`, with playwright-core 1.56.1 from
    devDependencies) and speaks plain-object JSON-RPC to it.
  * Opens a three-file project (`math.js`, `main.js` importing it, and an
    unchecked `loose.js`), then checks the following:
    * the loading progress
    * clean diagnostics, and then an introduced error
    * member completion with resolve
    * hover and cross-file definition
    * type definition, implementation and document highlight
    * workspace symbols, prepare rename (and its refusal on a built-in)
    * auto-import completion and its import edit on resolve
    * organize imports, and no action when imports are already tidy
    * a position past the end of a line, which stays on that line
    * `$/cancelRequest` right behind its request
    * references, rename and signature help
    * symbols and semantic tokens
    * a quick fix, formatting and range formatting
    * a missing-lib error on `tsconfig.json`
    * checking turned on and off by `jsconfig.json` `checkJs`
    * a `.ts` file importing JavaScript
    * a checked test file using `node:test` and `node:assert(/strict)` with no
      errors, hover on `describe`, and errors for what the runner lacks
    * a second `initialize` refused, and a non-JSON-RPC message ignored

## Running

`runner.js` (38.7 KiB raw, 16.1 KiB gzip, 14.2 KiB brotli; 8.9 KiB brotli
before test mode) runs the project in its own module worker, as
`CONTRACT.md` ("Running a program") describes. Every project file is an ES
module; each becomes a `blob:` URL whose relative imports (static,
`export ... from`, and `import()` with a literal string) are rewritten to the
URLs of the files they name. Imports are found with
[es-module-lexer](https://github.com/guybedford/es-module-lexer) 3.0.3
(minimal build), so text that only looks like an import is left alone. The
browser then evaluates the module graph as usual; `.json` files can be
imported with `with { type: 'json' }`.

* `console.log/info/debug` go to stdout, `console.error/warn/trace` to
  stderr, formatted roughly as Node does.
* `prompt(message)` prints the message and blocks until a line is entered
  (the stdin protocol of the contract); it returns `null` at end of input.
* The program has ended when its modules are evaluated and no timer it
  started is pending. An interval runs until Stop. A promise that waits on
  something other than a timer is not tracked.
* Uncaught errors and rejections print their stack and exit with code 1.

* `node:test`, `node:assert` and `node:assert/strict` (also without the
  `node:` prefix for assert) import the pack's own implementations (see
  Testing). A program that defines tests with `node:test` runs them after
  its own code, with the report and exit status of a test run, as
  `node main.js` does.

Limits: circular imports between project files cannot be linked this way
and are reported; bare imports (`'lodash'`) fail, since there are no
packages; the program runs in a worker, so there is no DOM.

## Testing

`{ type: 'test' }` (the app's **Test** button) does what `node --test`
does with no arguments, in the browser:

* **Which files.** Node 22's default patterns: `*.test.js`, `*-test.js`,
  `*_test.js`, `test-*.js`, `test.js` in any directory and every file
  under a `test/` directory (`.mjs` too), outside `node_modules`, in path
  order. `tests/geometry.test.js` is one; `tests/helpers.js` is not. No
  test file at all is exit 1 with a message on stderr (Node would exit 0).
* **How.** Each file is imported like a program's entry, with its own
  fresh `blob:` URLs for every project module it reaches, so module state
  does not leak from one test file to the next (Node runs each file in a
  process of its own). Globals are shared: it is one worker.
* **`node:test`** (`src/node/test.ts`, written for this pack): `test`/`it`,
  `describe`/`suite` and their `.skip`/`.todo`/`.only`; options `skip`,
  `todo`, `timeout` (`only` and `concurrency` are accepted and, as in Node
  without `--test-only`, change nothing); `before`/`after`/`beforeEach`/
  `afterEach` at file level and in suites, outer `beforeEach` first and
  inner `afterEach` first; async tests and `(t, done)` callbacks; the
  context `t` with `name`, `fullName`, `signal`, `skip()`, `todo()`,
  `diagnostic()`, `test()` subtests (awaited or not), `before`/`after`/
  `beforeEach`/`afterEach` and `t.assert`; top-level `await test(...)`.
  Not available: `mock`, `snapshot`, `run()`, `t.plan`, `t.mock`; a call
  throws (and the types make it an error in the editor first).
* **`node:assert` / `node:assert/strict`** (`src/node/assert.ts`): `ok`,
  `equal`, `notEqual`, `strictEqual`, `notStrictEqual`, `deepEqual`,
  `notDeepEqual`, `deepStrictEqual`, `notDeepStrictEqual`, `throws`,
  `doesNotThrow`, `rejects`, `doesNotReject`, `match`, `doesNotMatch`,
  `ifError`, `fail`, `AssertionError`, `strict`, and `assert(value)` itself.
  `node:assert` is legacy mode (`equal` is `==`) and `node:assert/strict`
  strict mode, as in Node. `throws`/`rejects` take a class, a RegExp, a
  validation function, an object of expected properties or an error.
  Messages are Node's, diffs included, and `assert.ok(expr)` quotes the
  failing expression from the source as Node does. Not available:
  `partialDeepStrictEqual`, `CallTracker`; deep equality ignores symbol
  keys and non-index array properties.
* **The report** is laid out like Node 22's spec reporter: `▶ suite`,
  `✔`/`✖`/`﹣` lines with durations, `# SKIP`/`# TODO`, `ℹ` diagnostics,
  the `ℹ tests … duration_ms` summary, then `✖ failing tests:` with
  `test at file:line:col`, the error and its stack frames in project files
  only. Counting follows Node: a failing todo is ✖ but counts as todo, a
  timeout counts as cancelled, a skipped suite is one line.
* **Exit status** 0 only when no test failed or was cancelled.
* **Checked against Node.** `test-run.mjs` runs
  `test-fixtures/behaviour.test.js` (hooks, subtests, skip/todo, timeouts,
  assertion messages and diffs, legacy vs strict, top-level await) both in
  the browser and under the local `node --test` (22.22.0), and requires the
  two reports to agree line for line, durations and Node's internal stack
  frames aside.
* **Limits.** Tests run one at a time. An uncaught error or unhandled
  rejection fails the test running at the time (Node tracks the async
  context and blames the test that caused it; a worker cannot). A
  `describe` callback that registers tests after an `await` is not
  supported. A test that never settles needs Stop, unless it has a
  `timeout`.
