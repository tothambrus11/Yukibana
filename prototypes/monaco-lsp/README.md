# Yukibana Light

A prototype IDE that runs entirely in the browser: Monaco, a small LSP
client, and a language server and a compiler per language, each compiled
to WebAssembly or JavaScript and downloaded only when its language is
selected. It is a static site with no backend: any web server can host it.
It is an installable PWA: the app is cached when it installs, and a
language's files the first time they are used or when Download everything
asks for them, so a language used once works offline ("Offline and
installing").

```text
app/                  SvelteKit 3 (Svelte 5, Vite 8, adapter-static), Monaco 0.57, dockview
packs/CONTRACT.md     what a language pack is: a language server worker and a runner worker
packs/<language>/     one pack per language, each with build.sh, test.mjs and a README
serve.py              a static server that sends the headers the app wants
```

## Trying it

```sh
for p in javascript python scala swift cpp; do (cd packs/$p && ./build.sh); done
cd app && npm ci && npm run build
python3 ../serve.py build        # http://localhost:8000
```

Each `build.sh` caches what it downloads and compiles in
`~/.cache/yukibana-packs`. The C++ and Swift builds compile LLVM and take a
long time the first time; the others take minutes. A pack that is not built
is reported in the app as not installed, and the rest still work.

`serve.py` sends `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy`, and the `.br` or `.gz` sibling of a file
when the browser accepts it. A host that cannot send these headers still
works: the service worker adds the isolation headers after one reload, and
uncompressed files are only slower to download.

## What it does

Projects have several files and folders, are kept in `localStorage`, and the
language selector switches between one project per language. The editor has
diagnostics, completion, hover, go to definition (Alt+Left and Alt+Right
to go back and forward), references, rename (F2), quick fixes, signature help,
formatting and semantic highlighting, as far as each language server offers
them. Run (Ctrl+Enter) compiles and runs the project in a worker, with a
terminal that can read input. Test (Ctrl+Shift+Enter) runs the project's
tests in `tests/` (`Tests/` for Swift): pytest (with Hypothesis for
property-based tests), `node:test` (with fast-check), Rust's `#[test]`
(with quickcheck), GoogleTest,
doctest or Catch2 (chosen next to Test), XCTest, or JUnit Jupiter (Java, in
`src/test/java/`); Scala has no Test yet, and Kotlin neither Run nor Test.
Mutate, for JavaScript and TypeScript, is mutation testing with StrykerJS
(its instrumenter and reporter, each test file run once per mutant in a
worker; packs/javascript/README.md, "Mutation testing"). Download saves the project as
`<language>-project.zip` for an IDE: its files as they are, at the same
paths, plus the build files it lacks (CMakeLists.txt, Package.swift,
pyproject.toml, package.json (with stryker.config.json), build.sbt, pom.xml (Java) or
build.gradle.kts (Kotlin), set up for the flat layout), a
README.md with the commands and a .gitignore.

A web project's Run opens a Preview panel with its `index.html` in a
sandboxed iframe: a stylesheet edit is applied in place, any other edit
reloads the page, and its console goes to the terminal. JavaScript and
TypeScript programs run in a module worker with the browser's worker
globals plus `process`, `node:readline`, `node:test` and `node:assert`, but
no DOM and no npm packages except fast-check, for property-based tests
(packs/javascript/README.md, "Environment" and "Packages").

| Language | Language server | Runs with | Download to edit | More to run |
| --- | --- | --- | --- | --- |
| JavaScript | TypeScript 6.0 language service | the browser, as ES modules | 1.1 MB | none; fast-check 48 KB when imported; StrykerJS 0.44 MB for Mutate |
| TypeScript | the JavaScript pack's server, `strict` | the same, types stripped as `node main.ts` does | (JavaScript's) | 3 KB (strip.js; TypeScript is the server's file) |
| Web (HTML, CSS, TypeScript) | the JavaScript pack's server for TypeScript; Monaco's own HTML and CSS (SCSS, Less) services: completion, hover, validation, formatting, colours | a live-reloading Preview panel (sandboxed iframe) | (JavaScript's), plus the CSS worker 0.2 MB and, once an HTML file is open, the HTML worker 0.15 MB | as TypeScript |
| Python | basedpyright 1.40 | Pyodide 314.0.7 (Python 3.14) | 1.1 MB | 4.5 MB |
| Scala 3 | the Scala 3.7.4 compiler's interactive API, compiled with Scala.js | the same compiler and the Scala.js linker; ScalaCheck 1.18.1 | 2.6 MB; ScalaCheck 0.25 MB when a source names it | 3.7 MB; ScalaCheck 0.34 MB more when a source names it |
| C and C++ | clangd 21 (Emscripten, threads) | clang 21 and wasm-ld, WASI | 8.0 MB | 12.2 MB; Test 0.06 to 0.28 MB (the framework's libraries) |
| Swift | sourcekitd 6.3.3 through sourcekit-lsp-lite, in one module with the compiler; swift-syntax for formatting | that module's swift-frontend, and wasm-ld | 31.2 MB | 8.2 MB |
| Rust | rust-analyzer's IDE crates (ra_ap_ide 0.0.358) with our LSP layer, std 1.98 sources | Miri 1.78 (rustc's MIR interpreter, not a compiler), quickcheck 1.0.3 | 4.2 MB; quickcheck sources 0.47 MB when Cargo.toml names it | 29.8 MB; quickcheck 1.6 MB when Cargo.toml names it |
| PHP | Phpactor 2026.10.07 on PHP 8.4 (php-wasm) | PHP 8.4.25's CLI (php-wasm), PHPUnit 12.5, Eris 1.3 | 7.6 MB | 2 KB (the same php.wasm); Test 0.6 MB, Eris 45 KB when used |
| Java | javac (OpenJDK 25u) compiled to WebAssembly GC by TeaVM 0.16.0 (teavm-javac), with our language service on its trees | the same javac, then TeaVM linking the program to WebAssembly GC in the browser; JUnit Jupiter 5.14 | 2.0 MB | 2.3 MB (TeaVM's class library) |
| Kotlin | ours, syntax only, on tree-sitter-kotlin 1.1.0 (web-tree-sitter 0.25) | none: no Kotlin compiler runs in a browser | 0.26 MB | none |
| Haskell | MicroHs 0.16 (its type checker, patched to remember what it resolved) with our LSP layer | the same MicroHs, compiling and running in the worker; hspec-style Test | 1.6 MB | 2 KB (the same files) |

Sizes are brotli transfer sizes. The app itself is 1.2 MB, icons included.
Each pack's README has the details: what was patched and why, what is
measured, and what does not work.

## Offline and installing

The app is a PWA that Chromium-based browsers offer to install (the
manifest has maskable icons and the window colour of each theme). Its
service worker (`app/src/service-worker/index.ts`) does three things:

* **Precaches the app shell when it installs**: the files the app needs to
  start, 1.2 MB, and nothing else. Until now it also precached every file of
  `static/`, which means every pack and its `.br` and `.gz` copies: a first
  visit downloaded some 400 MB in the background.
* **Caches everything else on first use**: a pack's files in the `packs`
  cache, the app's lazy files (Monaco's HTML, CSS and JSON services and
  their workers, grammars, schemas; 0.5 MB in all) in the build's app
  cache. Those are fetched only when a model of their language exists:
  a Python session loads no HTML or CSS code at all.
* **Adds the COOP/COEP isolation headers** to every response, for hosts that
  cannot send them (one reload on the first visit).

The cloud button in the top bar opens the Offline dialog: which languages
are available offline (also marked in the language list), a button per
language to make it so, and **Download everything**, with its size shown
before it starts and progress in megabytes while it runs. A build lists
every file it can serve, with sizes and, for pack files, a content hash, in
`offline.json`, written by `app/scripts/offline-manifest.mjs` at the end of
`npm run build`. The page downloads into the same caches the service worker
serves from, and asks the browser for persistent storage first.

| Download | Transfer | Stored |
| --- | --- | --- |
| The app (precached) | 1.2 MB | 4.9 MB |
| The app's lazy files | 0.5 MB | 2.8 MB |
| Every pack (Python 5.9, JavaScript 1.6, C++ 19.9, Swift 39.5, Scala 6.0, Rust 32.5, PHP 7.9, Java 4.4, Kotlin 0.3) | 117 MB | 540 MB |

A new build installs in the background and the top bar offers "New
version: reload"; until then the tab keeps the build it runs. Its app cache
replaces the old one, and pack files stay cached across builds unless their
hash changed, so an update does not download every language again.

Limits: the dialog's sizes per language include the 0.5 MB of lazy app
files every language shares. A pack file that a pack fetches under another
URL (with a query string, say) is not covered by `offline.json`; none does
today. Safari may evict the caches of a site not added to the home screen
after weeks without a visit, persistent storage or not.

## Limits

* **Swift**: sourcekitd itself, the one SourceKit-LSP drives, through
  sourcekit-lsp-lite (SourceKit-LSP cannot run here): diagnostics
  (including the mandatory SIL passes: missing return, use before
  initialisation) with fix-its as quick fixes, completion, hover,
  definition, references, rename (base names only), signature help, inlay
  hints. Formatting is swift-syntax's BasicFormat. No macros, so no
  swift-testing: tests use our XCTest, a checked subset of
  swift-corelibs-xctest. Foundation is not in the sysroot.
* **C++**: no threads, a fixed stack. Exceptions work (WebAssembly
  exception handling, so a browser from 2025: Chrome 137, Firefox 131,
  Safari 18.4). Tests in `tests/` are GoogleTest (without gMock or death
  tests), doctest or Catch2 v3, whichever they include (one per project;
  the top bar's choice converts the sample's tests); only that framework's
  libraries are downloaded. Container indexing is checked (libc++ hardening, fast mode); other
  out-of-bounds accesses are not.
* **Scala**: not Metals, which cannot run in a browser. The LSP layer is
  ours; what it answers comes from the compiler. No libraries but
  ScalaCheck (for a project that names `org.scalacheck`; properties run
  from a `main` with `.check()`, as there is no Test yet). No mutation
  testing: Stryker4s runs sbt on the JVM (packs/scala/README.md).
* **Python**: the standard library only, plus pytest and Hypothesis
  (property-based tests, fetched only for a project that imports it); no
  other packages from PyPI. No mutation testing: mutmut and Cosmic Ray need
  processes (packs/python/README.md).
* **PHP**: the real Phpactor, run by PHP in the browser, with its own
  checks (unknown classes and methods, types) plus PHP's parser for syntax
  errors; no `php -l` compile errors, no PHPStan or Psalm, no formatting.
  PHP has the extensions of WordPress Playground's build (no Composer
  packages but Eris, for property-based tests; no `readline()`: read input
  with `fgets(STDIN)`). No mutation testing: Infection needs a coverage
  driver and child processes (packs/php/README.md).
* **Rust**: not the rust-analyzer program but its analysis crates, with a
  crate graph built from `Cargo.toml` and `src/`; no crates.io
  dependencies but quickcheck (declared in `Cargo.toml`, for
  property-based tests whose properties return `bool`: a panic cannot be
  caught, so a panicking property is not shrunk), no proc macros, no
  formatting, and no `cargo check`, so
  borrow-check errors appear only on Run. Run interprets the program with
  Miri (rustc 1.78, edition 2021 at most): compile errors are rustc's, but
  it is slow, a panic cannot be caught (`catch_unwind`), there are no
  program arguments, and std APIs newer than 1.78 type check in the editor
  and fail on Run. Tests run like `cargo test` through our own harness.
  No mutation testing: cargo-mutants runs Cargo as child processes
  (packs/rust/README.md).
* **Java**: the real javac (Java 25 language level) for diagnostics and
  every editor feature, but programs link against TeaVM's class library,
  a subset of the JDK's: no files, networking, threads or reflection.
  Traces have no stack frames, and an array index out of bounds ends the
  run instead of being catchable. Tests are JUnit Jupiter's `@Test` with
  lifecycle methods and assertions; parameterized, repeated and dynamic
  tests are skipped. Run takes 2 s or more (TeaVM links each time). No
  property-based or mutation testing: jqwik and PIT need reflection, the
  JUnit Platform and JVMs, and QuickTheories does not link (it calls
  `ServiceLoader`) (packs/java/README.md).
* **Kotlin**: syntax only. kotlinc runs only on a JVM, so there are no
  type errors, no library members in completion, no Run and no Test;
  completion, hover and definition cover the project's own declarations.
  Download's Gradle build runs and tests it with the real compiler.
* **Haskell**: MicroHs, not GHC: one error per module, its own messages
  (type mismatches in GHC's words), string literals always overloaded, and
  `base` plus containers and a subset of hspec as the only libraries.
  Download's cabal build runs it with GHC.
* **All**: one browser tab is one machine. A program that never ends needs
  Stop, and memory is the tab's.

## Tests

Each pack has `test.mjs`, which drives its server headlessly in Chromium.
`app/tests/e2e.mjs` drives the built app for every built pack: a server
starts, an error is reported, completion, hover, definition, Run prints the
expected output, project switching keeps edits, and Download saves a valid
zip; for web projects, HTML and CSS completion, CSS validation and colours;
that the HTML and CSS workers load only when needed; that Chromium finds
the app installable; and that, once Python is made available offline, a
reload without a network starts the app and runs an edited program. `app/tests/export.mjs` downloads each sample as the app does and builds,
runs and tests it with CMake and CTest, SwiftPM, Node, pytest, sbt and Cargo,
skipping (and saying so) any tool the machine lacks.
