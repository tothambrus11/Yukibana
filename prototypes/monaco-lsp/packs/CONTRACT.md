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
A pack may also send it later in the session, for something it downloads
only when a project needs it (the JavaScript pack, p5.js's declarations
once a file imports `p5`); the bar shows until `loaded` reaches `total`.

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

For a language with `warmRunner` (`app/src/lib/languages.ts`), the app
starts the runner before Run is pressed (once the language server is up,
and again after each run ends), and posts the message below whenever Run
comes, which may be minutes later. Such a runner starts its slow part (the
Haskell runner loads GHC) as soon as it starts, and must not depend on the
message arriving soon. Whatever it posts before the message, but for
`loading`, the app shows when the run begins.

A runner that can run again after its program ends says so with
`reusable: true` on its `exit`, and must then accept another `run` or
`test` message, with new files and a new stdin buffer, as if it had just
started; a run it has not finished must not be disturbed by one that
arrives. The app keeps such a worker as the next run's (for a language
with `warmRunner`) instead of starting another, and terminates it on Stop
as any other. The Haskell runner does: GHC, linked and warm, then answers
in a fraction of a second, and Chromium compiles the wasm of only a few
new workers in a row while the language server's GHC is alive.

## Protocol

Every message is a plain object with a `type`.

App to runner, once:

```ts
{ type: 'run',
  files: Record<string, string>,  // the project: relative path -> text
  entry: string,                  // the entry file, e.g. "main.py"
  stdin: SharedArrayBuffer | null,
  options?: { emulation: 'system' | 'user'; cpus: 1 | 2 | 4; strace: boolean }
          | { optimization: string } }
```

`options` are how a program is emulated, for a runner that runs it in an
emulator. The app sends them for C and C++ projects only (the project's
Run options, saved with it; `app/src/lib/cpp-targets.ts`), and the C++
runner uses them only for a Linux target (`--target=` in
`compile_flags.txt`, packs/cpp/README.md): `system` runs the program in
Linux under QEMU's system emulation with `cpus` CPUs, `user` under QEMU's
user mode (one CPU), and `strace` traces its system calls. Absent, they
are `system`, 1, `false`. A runner with no use for them ignores them.

`{ optimization }` is the project's optimisation level, for a language
whose level no project file holds (`app/src/lib/optimization.ts`): the app
sends it with Run and Test for Swift (`-Onone`, `-O`, `-Osize`) and Scala
(`off`, `on`: the Scala.js optimizer), each pack's README "Optimization"
says what it does. Absent, the runner's default. A runner refuses a level
it does not have (stderr naming the levels, exit 1) rather than guess. A C
or C++ project's level is the `-O` line of its `compile_flags.txt`, which
the runner reads anyway, so none is sent.

A runner that can also run the project's tests takes the same message with
`type: 'test'` (the app offers Test for languages with `tests: true` in
`app/src/lib/languages.ts`). It builds the tests instead of the program and
runs them, with the same messages back: the report on stdout, exit 0 only
when every test passed.

A runner that can also mutation-test the project takes it with
`type: 'mutate'` (the app offers Mutate for languages with `mutates: true`):
it changes the code in small ways, one mutant at a time, runs the tests
against each, and prints the report (which mutants the tests killed, which
survived, which no test reached, which timed out, with file and line and the
mutated code) and the mutation score on stdout, with the same messages as a
run. How it runs each mutant is the pack's business (the JavaScript pack
starts workers of its own); Stop must end all of it, which terminating the
runner's worker does for workers it started.

A language may use another language's pack (`pack` in
`app/src/lib/languages.ts`): TypeScript, web and p5.js sketch projects use
the `javascript` pack's server and runner. That runner also takes
`{ type: 'preview', id, files, entry }` for a web project's Preview panel
and answers it with a page rather than a run (packs/javascript/README.md,
"Preview"); this is the JavaScript pack's own addition, not something
other runners need.

Runner to app, any number of times:

```ts
{ type: 'loading', label: string, loaded: number, total: number } // a download, as yukibana/loading
{ type: 'phase', text: string }        // "Compiling", "Linking", "Running": shown in the status bar
{ type: 'stdout', text: string }       // program output, as it is produced (not buffered to the end)
{ type: 'stderr', text: string }       // program errors, and compiler diagnostics
{ type: 'exit', code: number, reusable?: boolean }
                                       // last message; 0 = success. Compile errors exit non-zero
                                       // after printing them to stderr. reusable: the worker
                                       // takes another run (see above).
```

And, optionally (an app ignores message types it does not know, so a
runner may send these to an app that does not show them):

```ts
{ type: 'trace', text: string }              // the program's system calls (strace), shown dimmed
                                             // in the terminal, between its output
{ type: 'kernel', text: string }             // an emulated machine's console: the guest kernel's
                                             // log and the emulator's own messages; the app writes
                                             // it to the Output panel a line at a time, as
                                             // "[kernel] <line>"
{ type: 'mark', name: string, ms: number }   // a timing, ms since the run message arrived; the app
                                             // writes "timing: <name> <seconds> s" to the Output
                                             // panel. The C++ runner's names: compiled, linked,
                                             // vm-loaded, exec, first-stdout, exit
```

A program that ends by a signal exits with 128 + the signal's number (139
for SIGSEGV), after "Terminated by signal 11 (SIGSEGV)" on stderr; an
emulated machine that fails exits 1, after saying on stderr that the
guest kernel's log is in the Output panel. The app adds no note of its
own to a non-zero code: the guest kernel may print messages
while a program that exits 5 on purpose runs fine.

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

A runner that cannot see when its program reads (the C++ runner on a Linux
target: the guest kernel takes input whenever it arrives and holds it until
the program reads) streams input instead. It posts
`{ type: 'stdin', streaming: true }`, waits without blocking its thread
(`Atomics.waitAsync`, or polling), and after each answer stores 1 and asks
again, for the whole run. The app answers it exactly as above, with the
next line typed as soon as there is one, but does not show the program as
waiting for input or move the focus to the input line: it may be busy, not
reading. A phase message does not cancel an outstanding request of either
kind.

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
  worker, so a runner must not depend on finishing cleanly. Workers the
  runner starts (an emulator's threads) end with it.

# Showing compiler output (optional)

A pack whose language compiles to something worth reading may show it, as
Compiler Explorer does: the app's **IR** and **Asm** buttons (and the
editor's "Show LLVM IR" and "Show Assembly" commands) open read-only
panels with the LLVM IR or the assembly of the active source file, next
to the editors. The app offers them for languages with `explores` in
`app/src/lib/languages.ts` (`explores: ['llvm-ir', 'asm']` for C and
C++), and starts the pack's third worker, `app/static/packs/<id>/explorer.js`
(a module worker), the first time a panel opens; it is stopped when the
language changes or the project is reset. Nothing of it is downloaded
before.

App to explorer, any number of times:

```ts
{ type: 'emit', id: number,           // increases with every request
  emit: 'llvm-ir' | 'asm',
  files: Record<string, string>,      // the project, as for a run
  path: string,                       // the source to compile: a project path
  options: { demangle: boolean;       // demangled symbols
             intel: boolean;          // x86-64 assembly in Intel syntax
             directives: boolean;     // assembler directives and unused labels kept
             library: boolean } }     // functions only from headers outside the project kept
```

The app asks when a panel opens, when the active editor shows another
source (a header keeps the source shown before), when an option changes,
and 500 ms after the last edit of any project file, and only for a panel
that is in front: a panel behind another tab asks when it comes back. The
options start as `{demangle: true, intel: false, directives: false,
library: false}` for assembly and with `demangle: false` for IR.

Explorer to app:

```ts
{ type: 'loading', label, loaded, total }           // a download, as for a runner
{ type: 'result', id, emit, ok: true,
  text: string,                                     // the output, filtered
  lines: ({ file: string; line: number;             // per line of text: its source line,
            column: number } | null)[],             //   and the column there (1-based; 0: none)
  target: string,                                   // the target's id (C/C++: cpp-targets.ts)
  triple: string, flags: string[],                  // what the toolbar shows: the triple, clang's arguments
  ms: number }                                      // how long the compile took
{ type: 'result', id, emit, ok: false,
  error: string,                                    // the compiler's messages, project-relative paths
  target: string | null, ms: number }
```

Guarantees: `lines.length` is the number of lines of `text`; a `file` is
a project path, or the path the compiler printed for a header outside the
project; `column` is where on the line the code's expression starts, as the
compiler's line tables record it (C and C++: the `.loc` and `DILocation`
column, the operator of a binary expression), or 0 when they record
none; a request that a newer one of the same `emit` replaced may get no
answer, and the app keeps only the answer to the newest `id` of each. The
app maps the caret both ways with `lines` (the source line's output lines
are highlighted, and the output line's source line), tells the parts of a
line apart with `column` (the language server's selection ranges at that
column), and Ctrl/Cmd+click on an output line opens its source line.
