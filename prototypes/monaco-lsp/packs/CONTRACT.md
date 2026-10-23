# Language pack contract

The app (`prototypes/monaco-lsp/app/`, SvelteKit, static, PWA) is a Monaco
editor with a small hand-written LSP client. It knows nothing about any
language server. Each language is a **pack**: a directory of static files
that the app downloads only when the user selects that language.

## Layout

```text
packs/<id>/               source of the pack: its own package.json / build script,
                          never a dependency of the app
packs/<id>/build.sh       builds the pack into ../../app/static/packs/<id>/
                          (idempotent; downloads/compiles what it needs; caches in
                          $PACK_CACHE, default ~/.cache/yukibana-packs)
packs/<id>/test.mjs       headless test: drives server.js in Chromium (playwright,
                          executablePath /opt/pw-browsers/chromium) or Node and
                          checks diagnostics, completion, hover, definition
app/static/packs/<id>/    build output (git-ignored), served at /packs/<id>/
    server.js             entry: an ES module Web Worker
    ...                   anything else it fetches, relative to import.meta.url
```

Ids: `python`, `javascript`, `cpp`, `swift`, `scala`.

## Transport

The app starts `new Worker('/packs/<id>/server.js', { type: 'module' })`.
Each `postMessage` in either direction carries **one JSON-RPC 2.0 message as
a plain object** (no `Content-Length` framing, no strings). The worker is an
ordinary LSP server from `initialize` to `exit`.

Before it can answer `initialize`, a pack usually downloads its binaries. It
reports that with a notification the client shows as a progress bar:

```json
{ "jsonrpc": "2.0", "method": "yukibana/loading",
  "params": { "label": "clangd.wasm", "loaded": 1234, "total": 56789 } }
```

`total` may be 0 when unknown. The client queues requests until the
`initialize` response arrives, so a pack may simply delay answering it.

A pack sends `window/logMessage` for its own log lines and stderr; the app
shows them in an output panel.

## Files

The workspace root is `file:///workspace/` (`rootUri` and one
`workspaceFolders` entry). The client sends `textDocument/didOpen` for
**every** file of the project right after `initialized` (not only the one in
the editor), `didChange` (full text, `TextDocumentSyncKind.Full` is fine;
incremental if the server advertises it) on edits, and for a new or deleted
file `didOpen` / `didClose` plus `workspace/didChangeWatchedFiles`. A pack
whose server reads files from a file system must mirror every open document
into it, so that imports and `#include "other.h"` resolve.

Project files are plain text and few (a handful, under 1 MB together).

## What the client uses

Diagnostics (`publishDiagnostics`), completion (+ `completionItem/resolve`),
hover, signature help, definition, references, document highlight, document
symbols, rename, formatting, code actions (quick fixes with `edit`), semantic
tokens (full) when offered. Capabilities a server does not advertise are
simply not used. Positions are UTF-16 (the LSP default).

## Requirements

* Fully in the browser. No backend, no third-party CDN at run time: every
  byte comes from `/packs/<id>/`. The site is static.
* Small: ship stripped/optimised wasm, minified JS; the app's host serves
  `.gz`/`.br` siblings when present (`build.sh` writes them), otherwise the
  browser fetches the raw file. Report sizes raw and compressed.
* Cache: the app's service worker caches `/packs/**` after first download.
* Threads/`SharedArrayBuffer`: allowed when the server needs blocking reads.
  The app makes the page cross-origin isolated (COOP/COEP, via its service
  worker when the static host cannot send headers), so a pack may require
  `crossOriginIsolated`, but must say so in its README.
* `packs/<id>/README.md`: what the server is (name, version, upstream),
  what works and what does not, sizes, how long the build takes, any patch
  and why. If the real server named by the task cannot run in a browser,
  the README says so plainly and the pack does not pretend otherwise.

# Running a program

A pack may also run the project. It does so with a second, independent
module worker, `app/static/packs/<id>/runner.js`, which the app starts when
the user presses **Run** (and terminates on **Stop** or when the program
ends). A runner shares nothing with `server.js` at run time, so the language
server's download is never a prerequisite for running and vice versa; the
two may of course share files (a toolchain's wasm, headers) by URL so the
browser and service worker cache them once.

## Protocol

Every message is a plain object with a `type`.

App to runner, once:

```ts
{ type: 'run',
  files: Record<string, string>,  // the project: relative path -> text
  entry: string,                  // the entry file, e.g. "main.py"
  stdin: SharedArrayBuffer | null }
```

Runner to app, any number of times:

```ts
{ type: 'loading', label: string, loaded: number, total: number } // a download, as yukibana/loading
{ type: 'phase', text: string }        // "Compiling", "Linking", "Running": shown in the status bar
{ type: 'stdout', text: string }       // program output, as it is produced (not buffered to the end)
{ type: 'stderr', text: string }       // program errors, and compiler diagnostics
{ type: 'exit', code: number }         // last message; 0 = success. Compile errors exit non-zero
                                       // after printing them to stderr.
```

## Standard input

The page is cross-origin isolated, so the app passes a `SharedArrayBuffer`
(`stdin`, or `null` when the page is not isolated, in which case reading
stdin gives end of file) laid out as:

```text
Int32[0]  state: 0 = idle, 1 = runner waiting for input, 2 = input ready, 3 = end of file
Int32[1]  length in bytes of the input in the data area
bytes 8.. data area (64 KiB): UTF-8 input, normally one line including its "\n"
```

A runner that needs input (`input()`, `std::cin`, `readLine()`) and has no
buffered input left:

1. stores 1 in `state` and posts `{ type: 'stdin' }` (the app then shows an
   input line in the terminal),
2. blocks with `Atomics.wait(state, 0, 1)`,
3. on 2 reads `length` bytes of data, stores 0 in `state` and continues;
   on 3 treats it as end of file.

The app writes the data, then stores 2 (or 3 for Ctrl-D) in `state` and
calls `Atomics.notify`. A runner must flush its stdout before waiting, so a
prompt printed without a newline is visible.

## Requirements

* The same as for servers: everything from `/packs/<id>/`, small,
  compressed siblings, honest README section ("Running"), a test
  (`test-run.mjs` or a section of `test.mjs`) that runs the sample project
  and a program reading two lines of stdin.
* The sample projects in `app/src/lib/languages.ts` are what runs by
  default: entry `main.py`, `main.js`, `main.cpp` (with every `.cpp` of the
  project compiled and linked), `main.swift`, `Main.scala` (`@main` or
  `object Main { def main }`).
* A program that runs forever must be stoppable: the app terminates the
  worker, so a runner must not depend on finishing cleanly.
