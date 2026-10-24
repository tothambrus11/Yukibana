# Haskell pack: GHC 9.14 in WebAssembly

**Server and runner:** GHC 9.14.1 itself, compiled to WebAssembly by GHC's
own wasm backend (ghc-wasm-meta), with every boot package and the packages
a course uses as wasm shared libraries, loaded in the browser by GHC's own
dynamic linker (`dyld.mjs`). A small GHC API program of ours,
`ghc/Yuki.hs` (built into `libyuki.so`), answers both workers:

* `server.js` speaks LSP over `postMessage`. Each check type checks the
  project as `ghc -fno-code -Wall` does (GHC2021, deferred type errors and
  holes, as HLS checks), and answers GHC's diagnostics as GHC's own JSON
  (`-fdiagnostics-as-json`) and every name GHC resolved, from the modules'
  `.hie` files (the files HLS reads). Diagnostics, hover, definition,
  references, highlights, rename, completion, symbols and quick fixes come
  from that. **hlint** 3.10 adds its hints, and **ormolu** 0.8.0.2 formats:
  each is its own WASI command (`ghc/build-tools.sh`), started only when
  wanted.
* `runner.js` loads the project into GHC's bytecode interpreter and runs
  `main`, as `runghc` and GHCi do. **Test** does the same with
  `tests/Spec.hs`, an hspec suite with QuickCheck. One runner runs program
  after program, as one GHCi session does: the second Run answers in about
  0.1 s.

Packages, all of them exposed to both workers as GHC's `-package` flags
(GHC's versions; the Hackage ones built in CI):
`base` 4.22.1, `containers` 0.8, `mtl` 2.3.1, `transformers` 0.6.3,
`text` 2.1.4, `bytestring` 0.12.2, `array`, `deepseq`, `directory`,
`filepath`, `time` 1.15, `stm`, `exceptions`, and from Hackage
**QuickCheck** 2.19.0.0, **hspec** 2.11.18 and **random** 1.3.1
(their dependencies as Hackage's index had them on 2026-10-24, `INDEX_STATE` in `ghc/build-rootfs.sh`).

## Why this engine

The task was desktop parity: GHC's errors, GHC's types, a real `base` and
the libraries courses use, QuickCheck, a GHCi-like Run, hints and a
formatter. Options compared (measured where marked):

| | What it type checks | Download (br) | Editor features | Verdict |
| --- | --- | --- | --- | --- |
| **GHC 9.14 wasm + GHC API (chosen)** | everything GHC does, all extensions, real `base` | **33.2 MB** once (measured) | ours on the GHC API and `.hie` files (HLS's sources of truth) | parity on diagnostics, types and libraries; 5 to 8 s cold start |
| MicroHs 0.16 (the previous engine) | Haskell 2010 and many extensions, its own `base` | 1.6 MB | ours on a patched type checker | one error per module, its own messages and types, no QuickCheck, mtl, text or bytestring |
| HLS / ghcide on wasm | everything | — | the real ones | needs processes, a real file system and Template Haskell; no wasm build exists or is near |
| ghc-in-browser (GHC's browser GHCi demo) | everything | ~49 MB zstd | none: a REPL | the same wasm GHC; we use its dyld.mjs and pieces of its approach, not its image |
| GHC's JavaScript backend | — | — | — | compiles Haskell to JS, does not run GHC in a browser |

* GHC's wasm backend ships GHC itself as wasm shared libraries
  (`libHSghc.so`) since 9.10, and its `dyld.mjs` links them in a browser.
  What was missing for an editor was a program on the GHC API and the
  plumbing: `Yuki.hs` is that program, about 900 lines, exporting two
  JSFFI functions (`yukiInit`, `yukiRequest`). Everything else is GHC's.
* **HLS cannot run**, but what HLS reads can: GHC's typechecked modules,
  its `.hie` files, its JSON diagnostics with their hints. The features
  are written against those, the way ghcide's are, so the answers are
  GHC's own (a hover shows the type GHC inferred at that place).
* The cost is the download and the start: 33 MB once, cached afterwards,
  and 5 to 8 s from worker start to GHC ready on this machine.

## What works (parity with a desktop GHC + HLS + hlint + ormolu)

| Feature | Desktop (GHC 9.14, HLS, hlint, ormolu) | Here | Evidence (`node test.mjs`) |
| --- | --- | --- | --- |
| Diagnostics | GHC's, every error of every module, -Wall warnings | the same: GHC's JSON diagnostics, codes (`GHC-83865`), hints, unused tags | type mismatch, String for Int, out-of-scope with "Perhaps use", parse error, an error in an imported module reported there |
| Hover | type at that place, declared type, Haddock, module | the same (`print :: Double -> IO ()` then `print :: Show a => a -> IO ()`, Haddock rendered as Markdown, "Defined in ‘GHC.Internal.System.IO’") | 6 hover checks |
| Definition, references, highlights | across the project | across the project; library names have no source in the pack | 4 checks |
| Rename | project-wide, refuses library names | the same, and refuses a name of the wrong kind | 3 checks |
| Completion | in-scope names with types, qualified, modules after `import` | the same, from GHC's renamer (270 items in the sample, 460 modules) | 3 checks |
| Document symbols | yes | yes | 1 check |
| Quick fixes | HLS: suggestions, signatures, unused, imports, holes, extensions | from GHC's hints: replace a misspelt name, add the inferred signature, prefix unused with `_`, remove a redundant import, hole fits, add a LANGUAGE pragma | 4 checks |
| hlint | hints as warnings, apply or ignore | hlint 3.10's hints (default rules) as `hlint` diagnostics; "Apply hint" and "Ignore hint in this module" | 2 checks |
| Formatting | ormolu or fourmolu | ormolu 0.8.0.2; a module that does not parse is refused with ormolu's message | 3 checks |
| Run | `runghc` / GHCi | GHC's bytecode interpreter: stdout unbuffered, stdin from the terminal (`getLine`, `getContents` to Ctrl-D), `exitWith`, uncaught exceptions with GHC's message and call stack, compile errors in colour, many runs in one session | 11 checks |
| Test | `cabal test` with hspec + QuickCheck | hspec 2.11's report, coloured, QuickCheck properties | 3 checks |
| Packages | whatever cabal installs | the list above; others are not there (no cabal in the browser) | |

Measured (Chromium, this machine, local server so download time is not
included; a script drives both workers, as test.mjs does):

| | cold | warm |
| --- | --- | --- |
| server ready (`initialize` answered: unpack 247 MB, link GHC) | 5.3 to 6.1 s | |
| first check of the three-file sample | 1.0 to 1.8 s | |
| edit to diagnostics (250 ms debounce included) | 1.2 s | 0.45 to 0.58 s |
| hover, definition, references | 6 ms | 1 to 2 ms |
| completion | 180 ms | 90 to 105 ms |
| hlint over the project | 2.2 s | 1.2 to 1.4 s |
| format (ormolu) | 0.5 s | 0.25 s |
| Run, runner started at the same moment | 7.1 to 7.7 s | 0.1 s (same runner) |
| Run, runner started ahead (the app's warm runner) | 0.25 s | 0.1 s |
| Test (hspec, 4 examples) | 0.2 s | 0.13 s |

## What is in `app/static/packs/haskell/`

| file | raw | gzip | brotli | what |
|---|---|---|---|---|
| `rootfs.tar` | 247.1 MB | 49.4 MB | 33.2 MB | GHC's libdir, the packages and libyuki.so, unpacked by each worker into memory |
| `dyld.mjs`, `prelude.mjs`, `post-link.mjs` | 57 KB | 19 KB | 17 KB | GHC's wasm dynamic linker (patched, `scripts/patch-dyld.mjs`) |
| `wasi.js` | 32 KB | 9 KB | 8 KB | browser_wasi_shim (the haskell-wasm fork), bundled |
| `ghc.js`, `server.js`, `runner.js`, `tools.js` | 57 KB | 20 KB | 18 KB | ours |
| `ormolu.wasm` | 15.9 MB | 4.7 MB | 3.3 MB | ormolu 0.8.0.2, a WASI command |
| `hlint.wasm`, `hlint-data.json` | 16.7 MB | 5.1 MB | 3.6 MB | hlint 3.10 and its hint files |
| `LICENSE-*.txt`, `manifest.json` | | | | licences; versions and sizes |

Downloads (brotli), by what the person does:

| | |
| --- | --- |
| open a Haskell project (editor) | **33.2 MB** (rootfs) + 0.04 MB |
| hints, after the first check | + 3.6 MB |
| first Format | + 3.3 MB |
| Run and Test | + 3 KB (`runner.js`): the runner fetches the same `rootfs.tar`, from the browser's cache or the service worker |

In memory each worker holds the unpacked file system and GHC: about
250 MB of JavaScript heap for the server (measured with
`performance.measureUserAgentSpecificMemory`), and as much for a runner.

## Building

```sh
./build.sh          # writes app/static/packs/haskell/
npm install && node test.mjs
```

GHC's wasm toolchain takes some 3 GB installed, so the two heavy parts are
built in CI and `build.sh` takes their artifacts, each pinned by its run
and by the sha256 of its `SHA256SUMS` (which holds every file's):

1. `ghc/build-rootfs.sh` (`.github/workflows/haskell-ghc.yml`): installs
   ghc-wasm-meta at a pinned commit (FLAVOUR 9.14), builds the Hackage
   packages with `wasm32-wasi-cabal` (at a pinned Hackage index state), builds
   `libyuki.so` from `ghc/Yuki.hs`, strips the shared libraries, drops what
   no program uses (Cabal, haddock, haskeline), writes `rootfs.tar` and its
   `.br`/`.gz`, and smoke-tests check, hover and run in Node
   (`ghc/smoke.mjs`). About 12 minutes with its cache.
2. `ghc/build-tools.sh` (`.github/workflows/haskell-ghc-tools.yml`):
   ormolu and hlint from their Hackage tarballs (sha256-checked), with
   GHC 9.12's wasm toolchain, because hlint 3.10 (and its master) parses
   with ghc-lib-parser 9.12, whose `base` stops before 9.14's; ormolu is
   taken at its last release on the same parser so one ghc-lib-parser
   serves both. Smoke-tested with wasmtime.

Download an artifact (`haskell-ghc-rootfs`, `haskell-ghc-tools`) of the
pinned run and pass it as `HASKELL_GHC_ROOTFS=…zip` / `HASKELL_GHC_TOOLS=…zip`;
the release workflow does that itself. Artifacts are kept 90 days, so a
pin older than that needs the workflow run again (and the pins updated).
`HASKELL_GHC_ROOTFS=build` builds the root file system locally with the
toolchain installed.

### What we patch

* `dyld.mjs` (`scripts/patch-dyld.mjs`): imports the pack's `wasi.js` instead
  of esm.sh; takes the runner's stdin/stdout/stderr as WASI fds; resolves
  `..` in paths in the browser's file system (GHC loads boot libraries as
  `lib/../lib/…`); keeps fds 0 to 2 open when a program closes them (one
  runner runs many programs).
* ormolu's and hlint's `.cabal` files: `-threaded` and `-with-rtsopts=-N`
  removed (the wasm RTS is not threaded).

## Limits

* **The download**: 33 MB the first time, then cached. MicroHs was 1.6 MB.
* **The start**: 5 to 8 s from opening a project to the first diagnostics;
  a Run pressed in the first seconds waits for its own GHC (the app starts
  the runner ahead, once the server is up).
* **Packages are fixed**: the list above. A `build-depends` on anything else
  is not there; Download's cabal project builds it on a desktop.
* **No Template Haskell**: `template-haskell` is not among the packages
  (an import of `Language.Haskell.TH` says it is hidden), and splices would
  need GHC's interpreter in the editor's session, which does not start it.
* **hlint and ormolu parse as GHC 9.12**: syntax new in 9.14 is not
  understood by them (GHC's own diagnostics are unaffected).
* **Runtime errors' call stacks** point into the project's files and into
  `ghc-internal`'s, as on a desktop.
* **Memory**: two workers of about 250 MB each.
* **A browser stops compiling wasm for new workers after a few in a row**
  while the server's GHC is alive (Chromium: the fourth new runner in a row
  stalled for tens of seconds). The runner is therefore reused across runs;
  only Stop starts a new one.

## Licences

GHC and its libraries (BSD-3-Clause and others: `LICENSE-ghc-and-libraries.txt`
collects every package's), QuickCheck, hspec and random (BSD/MIT), ormolu
(BSD-3-Clause), hlint (BSD-3-Clause, built without its GPL `hscolour`
option), browser_wasi_shim (MIT/Apache-2.0) are redistributed in compiled
form with their licences next to the pack's files.
