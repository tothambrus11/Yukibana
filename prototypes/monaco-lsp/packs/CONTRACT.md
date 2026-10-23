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
