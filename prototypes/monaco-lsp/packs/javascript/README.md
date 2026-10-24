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
| `server.js` (adapter, with the types of the runner's Node modules) | 33.4 KiB | 10.6 KiB | 9.4 KiB |
| `typescript-6.0.3.js` (minified ESM) | 3520.1 KiB | 1005.5 KiB | 781.0 KiB |
| `libs-6.0.3.json` (64 lib files) | 2538.8 KiB | 387.0 KiB | 279.3 KiB |
| `packages-fast-check-4.10.2.json` (fast-check's declarations, see "Packages") | 186.0 KiB | 38.0 KiB | 31.2 KiB |
| **total** | **6278.3 KiB** | **1441.1 KiB** | **1100.9 KiB** |
| `packages-p5-2.3.4.json` (p5.js's declarations, only for a project that imports p5, see "Packages") | 793.8 KiB | 170.3 KiB | 115.9 KiB |

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
  checked files). The exception is fast-check, which the runner ships (see
  "Packages").
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
  * Typechecks the adapter, then builds the server's three files, `runner.js` and `strip.js` into
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
* `tools/package-types.mjs`: the declarations of the packages the pack
  ships (fast-check, p5.js), as TypeScript resolves them (see "Packages").
* `tools/stryker.mjs` and `src/stryker/index.ts`: StrykerJS's bundle for
  Mutate; `src/mutate.ts`: the loop around it (see "Mutation testing").
* `src/node/`: the runner's `node:test` (`test.ts`), `node:assert`
  (`assert.ts`, with `inspect.ts` for its messages), `process` and
  `node:readline` (`process.ts`), and their types for the server
  (`builtins.d.ts`).
* `src/strip.ts` and `src/typescript-global.ts`: `strip.js`, which is
  ts-blank-space bundled against the runner's copy of TypeScript.
* `test-run.mjs` (`node test-run.mjs` after `./build.sh`): the runner in
  Chromium with COOP/COEP: the sample and a program reading two lines with
  `prompt()`, then test mode: the sample's tests, a failing one, the
  comparison with `node --test`, a test file that does not load, no test
  files, an uncaught error during a test, `test/` files and `console.log` in
  tests, and `node:test` in a plain run; TypeScript (a run, a stack trace
  at the `.ts` line, an `enum` refused, tests in `*.test.ts`, a failure
  located in the `.ts` file); fast-check (fetched only when imported, a
  passing and a failing property with its shrunk counterexample and cause,
  a TypeScript program using it, another bare import still failing);
  Mutate (the sample's report and table, NoCoverage for `main.js`, the
  bundle's instrumenter against the npm package's, a survivor, a hit-limit
  and a wall-clock timeout, a failing dry run, no test files, TypeScript,
  and Stop ending the test workers);
  `process.argv`/`exit`/`exitCode`/
  `stdout.write` and `node:readline` (`question`, `readline/promises`,
  `for await`, `'line'` events); the environment; and `preview` (the page
  built, run in a sandboxed `srcdoc` iframe under COEP, a missing import;
  p5.js: no import map and no fetch for a page without it, one import map
  and one copy for two modules importing it, fetched once per worker, and
  a sketch whose canvas fills the iframe and whose circle follows the
  mouse, read back pixel by pixel).
* `test.mjs` also checks that a `.ts` CLI using `process` and
  `node:readline` type-checks and that what they lack is an error.
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
    * a TypeScript test importing fast-check: no errors, the type of an
      arbitrary, hover and completion from fast-check's declarations, a
      type error in a property, no definition into the package
    * p5.js: its declarations not downloaded until a file imports `p5`,
      then once, with no "cannot find module" on the way; a sketch in
      instance mode with no errors, hover with p5.js's documentation,
      completion on `p.`, and a type error in a call
    * a second `initialize` refused, and a non-JSON-RPC message ignored

## Running

`runner.js` (54.6 KiB raw, 22.6 KiB gzip, 19.8 KiB brotli, of which
2.2 KiB brotli is Mutate's loop; 14.2 KiB brotli before TypeScript,
`process` and `readline`, 8.9 KiB before test mode) runs the project in its own module worker, as
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
packages but fast-check (see "Packages"); the program runs in a worker, so
there is no DOM.

## Optimization: not offered

JavaScript and TypeScript have no optimisation level to choose: TypeScript
is only stripped of its types, and the browser's engine (V8 in Chromium)
decides by itself which functions to optimise, as it runs. The app's
Optimization select is not shown for JavaScript, TypeScript or web
projects.

## Environment

What a program run with **Run** (or **Test**) has, checked by
`test-run.mjs` ("environment"):

* **A module Web Worker of the app's page**, in the browser's own engine
  (V8 in Chrome, SpiderMonkey in Firefox, JavaScriptCore in Safari), at the
  language level of that browser. It is not Node and not Deno.
* **Worker globals:** `fetch` (with `Request`, `Response`, `Headers`,
  `AbortController`), `WebSocket`, `WebAssembly`, `crypto`
  (`getRandomValues`, `randomUUID`, `subtle`), `TextEncoder`/`TextDecoder`,
  `structuredClone`, `Intl`, `URL`, `Blob`, `atob`/`btoa`, `performance`,
  timers (`setTimeout`, `setInterval`, `queueMicrotask`), `indexedDB`,
  `OffscreenCanvas` (2D and WebGL contexts), `SharedArrayBuffer` and
  `Atomics` (the page is cross-origin isolated).
* **Added by the runner:** `console` (to the terminal), `prompt()`, the
  `process` global, and the modules `node:test`, `node:assert`,
  `node:assert/strict`, `node:process`, `node:readline` and
  `node:readline/promises` (each also without `node:`).
* **No DOM** in Run: `document`, `window`, `localStorage` and `alert` do
  not exist. The editor still loads the `lib.dom` types (they hold the
  declarations of `console`, `fetch` and the rest that the worker shares),
  so `document` type-checks and then fails at run time. A web project
  (see "Preview") is where the DOM is.
* **No other Node:** no `fs`, `path`, `os`, `child_process`, `http`,
  `Buffer`, `require`, `__dirname` or `global`, and `process.env` is empty.
  An import of another `node:` module fails with the browser's "Failed to
  resolve module specifier".
* **The network is the browser's:** `fetch` reaches any server that allows
  it with CORS. The page is isolated with COEP `require-corp`, so a
  cross-origin response without CORS is refused. This is the user's
  program talking to the network; the app's own code still loads nothing
  from a third party.
* **No packages** but fast-check: no npm and no `node_modules`. See
  "Packages".

## Command-line programs

Run already works as a command-line program's terminal: output appears as
it is printed, ANSI colours are rendered, and input is typed when the
program asks for it. On top of `prompt()`, `src/node/process.ts` provides
the Node API a CLI is written with, over the same stdin protocol:

* **`process`:** `process.argv` is `['node', '/workspace/main.js']`. The
  app's message may carry `args` (an array) to append, but the app does
  not offer a field for them yet. `process.exit(code)` ends the run at
  once with that status (it throws to unwind the stack, and nothing
  printed after it is shown). `process.exitCode` is the status when the
  program ends by itself. `process.stdout.write` and
  `process.stderr.write` print without a newline. `process.env` is `{}`,
  `process.platform` is `'browser'`, `process.cwd()` is `/workspace`, and
  `process.nextTick` queues a microtask.
* **`node:readline`:** `createInterface({ input: process.stdin, output:
  process.stdout })`, `rl.question(query, callback)`, `'line'` and
  `'close'` events, `for await (const line of rl)`, `setPrompt`/`prompt`
  and `close`. `node:readline/promises` has `await rl.question(query)`. As
  in Node, a question takes the next line before `'line'` listeners do.
  Each line is read in a timer of its own, so the program's callbacks run
  between lines and an interface waiting for input keeps the run alive.
  End of input (Ctrl+D) closes it.
* **Typed in the editor** (`src/node/builtins.d.ts`) with only what exists,
  so `process.hrtime()` or `rl.history` is an error before it can crash.
* **Not there:** `process.stdin` as a stream (`on('data')`, `read()`), raw
  mode and key events, `readline.emitKeypressEvents`, the cursor movement
  functions, and signals (`process.on('SIGINT')`): Stop terminates the
  worker.

## TypeScript

The `typescript` project kind (app/src/lib/languages.ts) uses this pack's
server and runner as they are. The server was already the TypeScript
language service, and the sample's `tsconfig.json` turns `strict` on.

* **Run and Test strip the types, as Node 22.18 and later do** (`node
  main.ts`). `src/strip.ts` is
  [ts-blank-space](https://github.com/bloomberg/ts-blank-space) 0.9.0
  (Bloomberg, Apache-2.0), which uses TypeScript's own parser to replace
  each type annotation with whitespace. Every line and column of the output
  is the same as in the source. Stack traces, `node:test`'s `test at
  file:line:col` and `assert.ok`'s quoted expression therefore point into
  the `.ts` file without a source map (a worker's `Error.stack` would not
  apply one anyway).
* **TypeScript comes from the server's file.** For a project with a `.ts`
  or `.mts` file, the runner fetches `typescript-6.0.3.js` from the same
  URL the server uses, so the browser and the service worker keep one
  copy. It then imports `strip.js` (9.5 KiB raw, 2.8 KiB brotli), which is
  ts-blank-space bundled against that copy. Loading and evaluating the
  3.5 MB file takes about 215 ms in a worker on the test machine (from
  cache), once per Run. A JavaScript project does not load it. A separate
  stripper would not have been smaller: amaro (Node's own, SWC compiled to
  WebAssembly) is 6 MB unpacked, and sucrase is about 1 MB with its
  dependencies, while the TypeScript download is already being made.
* **Syntax that is more than types** (`enum`, `namespace` with values,
  constructor parameter properties, `import x = require()`) is refused with
  Node's reason (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) and its position. The
  sample's `tsconfig.json` sets `erasableSyntaxOnly`, so the editor marks
  such syntax first. It also sets `allowImportingTsExtensions` and
  `verbatimModuleSyntax`, because Node needs `./geometry.ts` spelled out
  and keeps value imports as written.
* **Test** finds `*.test.ts` and Node's other patterns with `.ts` and
  `.mts`, as `node --test` does with type stripping.
* **Not supported:** `.tsx` and `.cts`. Types are not checked at Run, only
  in the editor, as with Node.

## Preview (web projects)

The `web` project kind (`index.html`, `style.css`, `main.ts`) uses the
same server. Monaco highlights HTML and CSS with its own grammars but has
no HTML or CSS language service here (Monaco's are 0.7 MB and 1.0 MB). Run
shows the page in the app's **Preview** panel (app/src/lib/preview.ts),
and this runner builds it: `{ type: 'preview', id, files, entry:
'index.html' }` is answered with `{ type: 'page', id, html, styles, errors
}`. The worker stays alive for the next request, so TypeScript is loaded
once per preview.

* **One self-contained document.** A `<link rel="stylesheet">` to a
  project file becomes `<style data-yukibana-href="style.css">`. A
  `<script src>` to a project file, and any inline module script, becomes a
  `data:` URL whose imports are linked the way Vite resolves them
  (`./counter`, `./counter.js` and `./counter.ts` all find `counter.ts`,
  and `/main.ts` is at the project root). TypeScript is stripped as for
  Run, or compiled with `ts.transpileModule` when it has an `enum` (as Vite
  would). A bridge script goes first in `<head>`.
* **The iframe** is `sandbox="allow-scripts allow-forms allow-modals"`
  without `allow-same-origin`, and gets the document as `srcdoc`. The page
  has an opaque origin, so it cannot read the app's storage or DOM. That is
  also why the document is self-contained: a service worker does not serve
  a document with an opaque origin, and `blob:` URLs belong to the app's
  origin. An `about:srcdoc` document inherits the app's COEP
  `require-corp`, and meets it because it loads nothing. A page that
  fetches or embeds from another origin needs CORS or CORP headers from
  that origin.
* **Console:** the bridge posts `console.log/info/debug` (as stdout),
  `warn/error` (as stderr), and uncaught errors and rejections to the app,
  which prints them in the terminal. The app accepts these messages only
  from that iframe's window.
* **Live reload:** edits are gathered for 300 ms. If every changed file is
  a stylesheet of the page, the app posts the new text and the bridge
  replaces that `<style>`, so the page reloads nothing and keeps its state.
  Any other change rebuilds the page and reloads the iframe. This is live
  reload, not hot module replacement. A build error (a missing import)
  goes to the terminal, and the last page stays.
* **Packages:** `import p5 from 'p5'` works in a page (see "Packages"):
  the page gets an import map, right after the bridge, that maps `p5` to
  p5.js as one `data:` URL. Every module keeps the bare specifier, so the
  library is in the document once, however many modules import it.
* **Limits:** relative URLs other than stylesheets and scripts (images,
  `fetch('./data.json')`, CSS `url()` and `@import`) do not resolve,
  because the document has no folder of its own. Project files are text,
  so there are no images to serve anyway. There are no other bare imports
  (`'lit'`), no CSS modules and no `import.meta.env`. **Download** gives a
  Vite 8 project (`npm run dev` with real HMR, `npm run build`), which
  `app/tests/export.mjs` builds.

## Packages

Bare imports (`import _ from 'lodash'`) are not implemented, with one
exception, below. These are the options, and choosing one is a product
decision rather than a technical one:

1. **An import map to a CDN** (esm.sh, jsDelivr) inside the run. It is
   simple, but the program's code then comes from a third party at run
   time, which the pack contract rules out for the app's own code. It also
   works only online, and the editor gets no types unless the `.d.ts`
   files are fetched too.
2. **Packages fetched from the npm registry in the browser** (tarballs,
   unpacked and cached by the service worker), with types from the
   packages' `.d.ts` files. This raises the same third-party question, and
   also needs a module resolver and CommonJS interop.
3. **A curated set shipped in the pack**: a few packages, pre-bundled as
   ES modules with their types. This works offline and fits the contract,
   but each package is a decision about size and maintenance.
4. **None**: the platform's standard library and the Node built-ins
   listed above.

What the pack does is the third, for two packages so far. The first is **fast-check
4.10.2** (MIT), the property-based testing library, with its one
dependency, pure-rand 8.4.2 (MIT). Both are pinned in `package-lock.json`
with their npm integrity hashes; nothing in them is changed.

* **Run and Test.** `import fc from 'fast-check'` (or `import * as fc`, or
  named imports) in a program or a test resolves to
  `fast-check-4.10.2.js` next to `runner.js`: fast-check's published ES
  module (`lib/fast-check.js`) bundled by esbuild with the pure-rand modules
  it imports, minified (167 KiB raw, 57 KiB gzip, 48 KiB brotli). The
  browser fetches it only when a module imports it, once per worker: the
  test files of one Test share one copy, so `fc.configureGlobal` in one
  applies to the next (with `node --test` each file has a process of its
  own). A web project's Preview does not have it (a page gets only the
  packages built for pages, p5.js). Any other bare import still fails.
* **The editor.** `packages-fast-check-4.10.2.json` holds fast-check's
  declarations as installed, `/node_modules/fast-check/package.json` and
  `lib/fast-check.d.ts`, plus the pure-rand declarations they import:
  exactly the files TypeScript reads to resolve the import with the
  server's settings (`tools/package-types.mjs` asks TypeScript which). The
  server puts them in its virtual file system at `/node_modules/`, so the
  import resolves by TypeScript's own rules, in JavaScript and TypeScript
  alike: types (`fc.record({ x: fc.integer() })` is
  `Arbitrary<{ x: number }>`), completion, hover with fast-check's
  documentation, and type errors such as a predicate that does not take
  what the arbitraries make. Results that point into these files
  (definitions, references) are dropped, as for the libs. It is downloaded
  with the libs when the server starts (31 KiB brotli), for every
  JavaScript and TypeScript session: adding files after the first program
  is built means a new language service (as p5.js's do, below), and 31 KiB
  did not seem worth one.
* **Download** adds `"fast-check": "^4.10.2"` to `devDependencies` when a
  `.js` or `.ts` file imports it, and the README says `npm install` first;
  `app/tests/export.mjs` runs the samples' tests with real Node and the
  real fast-check from npm.

The second is for web pages: **p5.js 2.3.4** (LGPL-2.1, its licence is
`LICENSE-p5.txt` next to it), the creative-coding library, pinned in
`package-lock.json` with its integrity hash. The app's **Web: p5.js
sketch** project starts with it (a canvas that fills the page, a circle
that follows the mouse), and any web project can import it.

* **Preview.** `p5-2.3.4.js` is p5.js's own `lib/p5.esm.min.js`, copied
  unchanged: it is already one minified ES module with its dependencies
  (1076 KiB raw, 307 KiB gzip, 250 KiB brotli). When a module the page
  reaches imports `p5`, the preview worker fetches it, once for as long as
  it lives (rebuilds reuse it), and the page gets an import map from `p5`
  to it as a `data:` URL (see "Preview"). A page that does not import p5
  gets no import map and fetches nothing. Run and Test do not have p5,
  since it needs a document: there the import fails as any unknown package
  does.
* **The editor.** `packages-p5-2.3.4.json` is p5.js's `package.json` and
  `types/p5.d.ts`, collected by `tools/package-types.mjs` as for
  fast-check (with `lib.dom`, which the declarations name). It is 116 KiB
  brotli, four times fast-check's, so it is not downloaded when the server
  starts: the server fetches it the first time an open file imports `p5`
  (`import`, `export … from`, `import()`, `require()` or `/// <reference
  types>`, also of a subpath), with progress, and holds that file's
  diagnostics back until it has arrived, so `'p5'` is never reported
  missing on the way. Then it replaces its language service with a new one
  over the same document registry (TypeScript keeps a file's failed module
  resolutions while its imports do not change; a new service resolves them
  again, and reuses the parsed libs). Instance mode (`new p5((p: p5) =>
  …)`) is fully typed: completion on `p.`, hover with p5.js's
  documentation, and type errors such as `p.circle('x', 1, 2)`. Global
  mode's `p5/global` declarations (1.2 MB more) are not shipped.
* **Download** adds `"p5": "^2.3.4"` to `dependencies` of the Vite
  project when a file imports it; Vite bundles it and `tsc` checks the
  sketch against the same declarations (`app/tests/export.mjs`).

## Testing

`{ type: 'test' }` (the app's **Test** button) does what `node --test`
does with no arguments, in the browser:

* **Which files.** Node 22's default patterns: `*.test.js`, `*-test.js`,
  `*_test.js`, `test-*.js`, `test.js` in any directory and every file
  under a `test/` directory (`.mjs`, `.ts` and `.mts` too), outside `node_modules`, in path
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
  timeout counts as cancelled, a skipped suite is one line. It is in
  colour, with the escapes Node's reporter prints when stdout is a TTY
  (green ✔, red ✖, grey skips and durations, blue `ℹ`), and `node:assert`
  colours its diffs (`+` green, `-` red) as Node does on a colour stderr:
  the app's terminal renders ANSI colours.
* **Exit status** 0 only when no test failed or was cancelled.
* **Checked against Node.** `test-run.mjs` runs
  `test-fixtures/behaviour.test.js` (hooks, subtests, skip/todo, timeouts,
  assertion messages and diffs, legacy vs strict, top-level await) both in
  the browser and under the local `node --test` (22.22.0, with
  `FORCE_COLOR=1`), and requires the two reports to agree line for line,
  escape sequences included, durations and Node's internal stack frames
  aside.
* **Property-based tests** with fast-check (see "Packages"): `fc.assert(
  fc.property(arb, ..., predicate))` inside a test. A failing property
  throws fast-check's own error, which the report prints as Node's does:
  `Property failed after N tests`, the seed and path to replay it,
  `Counterexample: [100]` after `Shrunk 8 time(s)`, and, as the error's
  `[cause]`, the assertion that failed for that counterexample (Node's
  reporter prints an error's `cause`; this one does too, without the
  error's other own properties). The samples' "distance is symmetric" is a
  property over two random points.
* **Limits.** Tests run one at a time. An uncaught error or unhandled
  rejection fails the test running at the time (Node tracks the async
  context and blames the test that caused it; a worker cannot). A
  `describe` callback that registers tests after an `await` is not
  supported. A test that never settles needs Stop, unless it has a
  `timeout`.

## Mutation testing

`{ type: 'mutate' }` (the app's **Mutate** button, for JavaScript and
TypeScript) is mutation testing with **StrykerJS 10.1.1**: Stryker's own
instrumenter makes the mutants, Stryker's own clear-text reporter prints the
report and the score, and the loop between them is the one Stryker's core
runs with its tap runner (`@stryker-mutator/tap-runner`, its runner for
`node --test`), with a Web Worker where Stryker starts a `node` process
(`src/mutate.ts`).

**Why this is Stryker and not an imitation of it.** Stryker's instrumenter
is a library: it compiles every mutant into the code at once, each behind a
check of `globalThis.__stryker__.activeMutant` ("mutant switching"), and
counts in `__stryker__.mutantCoverage` which mutants a test reaches. Its
test runners are what selects a mutant: the mocha runner sets
`activeMutant` on that global before running the tests again in the same
process; the tap runner starts `node` for each test file with the id in an
environment variable that the instrumented code copies into the global, and
reads the file's coverage back when it ends. Mutate does what the tap runner
does, with a fresh worker (this runner, given `type: 'mutant'`) in place of
the process, and sets the global before the project's modules load. Checked
against the real thing: `test-run.mjs` requires the bundle's instrumented
code and mutants to equal the npm package's under Node byte for byte, and
`app/tests/export.mjs` runs the downloaded samples with the real Stryker
(`npm run mutate`) and gets the same table as Mutate: for the JavaScript
sample, 7 killed, 2 without coverage, 77.78 %; for the TypeScript sample,
7 killed, 4 survived, 9 without coverage, 35.00 % (63.64 % of covered code).

* **What is mutated:** every `.js`, `.mjs`, `.ts` and `.mts` file that
  `node --test` would not run as a test file (`*.d.ts` aside). Stryker's
  default `mutate` looks under `src/` and `lib/`, which these flat projects
  do not have; Download's `stryker.config.json` says the same as Mutate.
  Every mutator of Stryker's default set, no `// Stryker disable` needed
  for anything (it is honoured: the instrumenter reads it).
* **Dry run.** Each test file runs once over the instrumented project, in a
  fresh worker. A failing test file ends Mutate with exit 1, its report and
  Stryker's "There were failed tests in the initial test run."; no test
  files at all is exit 1 with Test's message.
* **Plan**, as Stryker's MutantTestPlanner makes it: a mutant no test file
  reaches is **NoCoverage** and is not run; any other runs only the test
  files that reach it, in a new worker each, until one fails (bail).
* **Statuses.** A failing test file **kills** the mutant; none failing,
  it **survived**. A mutant still running after `1.5 × (net time of its
  test files) + 5000 ms + overhead` (Stryker's `timeoutFactor` and
  `timeoutMS`; the overhead is the dry run's time outside the tests, worker
  start-up included) has its worker terminated and is a **Timeout**, as
  Stryker kills its child process. One that reaches the switch more than
  100 times as often as the dry run did (Stryker's hit limit, which catches
  loops without waiting for the timer) is a Timeout too.
* **Parallel.** Mutants run in as many workers at a time as Stryker starts
  processes: `navigator.hardwareConcurrency - 1` above 4, else all.
* **The report** is Stryker's ClearTextReporter with its default options:
  the tests and how many mutants each killed or covered, each mutant
  (`[Survived] EqualityOperator`, `file:line:column`, the original lines
  after `-` and the mutated ones after `+`, which test files ran, or which
  killed it), "Ran N tests per mutant on average", and the score table
  (total and covered score, killed, timeout, survived, no coverage,
  errors), coloured by Stryker's thresholds (80 and 60). Killed and timed
  out mutants, which Stryker prints only at log level debug, are printed
  too. Then one line, `Mutation score: 77.78% (0.2 seconds)`. Progress is
  shown as the phase, `Mutation testing 3/9 (0 survived, 0 timed out)`.
* **Exit status** 0 when mutation testing ran, whatever the score
  (Stryker's default, without `thresholds.break`).
* **Stop** terminates the worker, and with it every test worker it
  started (`test-run.mjs` checks that they fall silent).

**Download** writes `stryker.config.json` (tap runner, the same files to
mutate and to test) and an `npm run mutate` script that runs Stryker 10.1.1
with its tap runner through `npx` (TypeScript too for a TypeScript project,
whose `tsconfig.json` Stryker rewrites in its sandbox), so the same report
can be had with Node.

**Size.** `stryker-10.1.1.js` is 2137 KiB raw, 565 KiB gzip, 435 KiB
brotli, downloaded only when Mutate runs, once per Mutate (it is the
instrumenter with Babel 8's parser, traverse, generator and its TypeScript
and React presets; weapon-regex, the regular-expression mutator, is 753 KiB
of it raw). `runner.js` grew by 6.4 KiB raw (2.2 KiB brotli) for the loop.

**How it is bundled** (`tools/stryker.mjs`, which says the same at more
length). Nothing in the packages is changed; Node's modules get browser
stand-ins at bundle time: `path` is path-browserify; `createRequire` from
`module` returns the Babel presets and plugins themselves where the
TypeScript parser asks for their paths (Babel takes either); `node:assert`
is this runner's own; `os.EOL` is `"\n"`; `fs`, `url`, `util` and
`child_process`, which only modules of Stryker's utility packages that
Mutate never calls import, throw if called; Stryker's option schema, which
its module reads from disk on load, is empty (options are validated by
Stryker's CLI, not here). The reporter is imported from
`@stryker-mutator/core`'s `dist/` by path, as the package exports only its
CLI.

**Limits.** No `stryker.config.json` is read in the browser: the options
are Stryker's defaults (no `thresholds.break`, no `ignoreStatic`, no
incremental mode, no HTML report). Coverage is per test file, as with the
tap runner (Stryker's mocha or jest runners know individual tests). Mutants
that make code fail to type check are not filtered out (Stryker's
TypeScript checker plugin is not here), as with Stryker without that
plugin.

