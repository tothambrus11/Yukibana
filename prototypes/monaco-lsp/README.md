# Yukibana Light

A prototype IDE that runs entirely in the browser: Monaco, a small LSP
client, and a language server and a compiler per language, each compiled
to WebAssembly or JavaScript and downloaded only when its language is
selected. It is a static site with no backend: any web server can host it.
It is a PWA: the app is cached when it installs, and a language's files the
first time they are used, so a language used once works offline.

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
tests in `tests/` (`Tests/` for Swift): pytest, `node:test`, GoogleTest or
XCTest; Scala has no Test yet.

| Language | Language server | Runs with | Download to edit | More to run |
| --- | --- | --- | --- | --- |
| JavaScript | TypeScript 6.0 language service | the browser, as ES modules | 1.1 MB | none |
| Python | basedpyright 1.40 | Pyodide 314.0.7 (Python 3.14) | 1.1 MB | 4.5 MB |
| Scala 3 | the Scala 3.7.4 compiler's interactive API, compiled with Scala.js | the same compiler and the Scala.js linker | 2.6 MB | 3.7 MB |
| C and C++ | clangd 21 (Emscripten, threads) | clang 21 and wasm-ld, WASI | 7.8 MB | 12.2 MB |
| Swift | swift-syntax-ls (ours) plus swift-frontend 6.3.3 for types and errors | the same swift-frontend and wasm-ld | 30.2 MB | 8.2 MB |

Sizes are brotli transfer sizes. The app itself is 1.1 MB. Each pack's
README has the details: what was patched and why, what is measured, and
what does not work.

## Limits

* **Swift**: not SourceKit-LSP, which cannot run here. Diagnostics are the
  real compiler's (including the mandatory SIL passes: missing return, use
  before initialisation) and its fix-its are quick fixes; hover,
  definition, references, inlay hints and member completion come from the
  compiler's typed AST and a standard library index, with swift-syntax as
  the fallback. No macros, so no swift-testing: tests use our XCTest, a
  checked subset of swift-corelibs-xctest. Foundation is not in the sysroot.
* **C++**: no threads, a fixed stack. Exceptions work (WebAssembly
  exception handling, so a browser from 2025: Chrome 137, Firefox 131,
  Safari 18.4). Tests are GoogleTest in `tests/`, without gMock or death
  tests. Container indexing is checked (libc++ hardening, fast mode); other
  out-of-bounds accesses are not.
* **Scala**: not Metals, which cannot run in a browser. The LSP layer is
  ours; what it answers comes from the compiler.
* **Python**: the standard library only; no packages from PyPI.
* **All**: one browser tab is one machine. A program that never ends needs
  Stop, and memory is the tab's.

## Tests

Each pack has `test.mjs`, which drives its server headlessly in Chromium.
`app/tests/e2e.mjs` drives the built app for every built pack: a server
starts, an error is reported, completion, hover, definition, Run prints the
expected output, and project switching keeps edits.
