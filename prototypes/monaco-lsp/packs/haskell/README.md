# Haskell pack: MicroHs in WebAssembly

**Server and runner:** [MicroHs](https://github.com/augustss/MicroHs)
0.16.0.0, Lennart Augustsson's Haskell compiler, built once for the browser
with Emscripten 4.0.22 together with a small driver of ours
(`src/hs/Yuki.hs`). The same `yuki.wasm` is both workers:

* `server.js` speaks LSP over `postMessage`. Each check runs MicroHs's
  parser, renamer and **type checker** over the project's modules and
  answers with the error, if any, and every name the checker resolved: where
  it is used, where it is defined, and its type there. Diagnostics, hover,
  definition, references, highlights, rename and completion come from that.
* `runner.js` compiles the project with the same compiler and runs it in the
  same process (MicroHs's combinator evaluator), as `mhs -r Main` does.
  **Test** does the same with `tests/Spec.hs`, an hspec suite.

Libraries: MicroHs's own `base` (the Prelude, `Data.List`, `Data.Char`,
`Data.IORef`, `Control.Monad`, `Control.Exception`, `Text.Read`, `Data.Bits`,
`System.IO` and the rest), **containers 0.8.1** (`Data.Map`, `Data.Set`,
`Data.IntMap`, `Data.IntSet`; strict and lazy) and our **Test.Hspec**, all
three precompiled into MicroHs packages at build time.

## Why this compiler and server

What the editor needs, in order: real type-checker errors, then the type of
what is under the cursor, definition, references, completion. Everything
runs in the browser; a pack's download should stay in the single megabytes.

| | Language | Download | Check / run | Licence | Maintained |
| --- | --- | --- | --- | --- | --- |
| **MicroHs** (chosen) | Haskell 2010 and most common GHC extensions (multi-parameter classes, functional dependencies, GADTs, type families, rank-n, deriving strategies, `\case`, records with dots...) | **1.6 MB** (176 KB of it the wasm, br) | 1 s per edit, Run 2 s | Apache-2.0 (containers: BSD-3) | yes, regular Hackage releases |
| GHC's WebAssembly backend / ghc-in-browser | all of GHC 9.x | ~49 MB zstd root file system (GHC's libdir, `ghc` itself as wasm), prebuilt images only | GHC's speed in an interpreter: seconds per module | BSD-3 | the backend yes; running GHC itself in a browser is a demo and an unmerged MR |
| HLS / ghcide on wasm | everything GHC has | — | — | Apache-2.0 | needs the GHC API, a process per component and a real file system: not portable to a browser today |
| Hugs on wasm | Haskell 98 plus a few extensions | ~1 MB | fast | BSD-style | unmaintained since 2006, its libraries are 20 years old |
| tree-sitter-haskell only | syntax | ~0.5 MB | instant | MIT | yes |

* **MicroHs** is a complete Haskell compiler written in Haskell that
  compiles itself to a small C runtime plus a combinator program. That C
  builds with Emscripten unchanged; nothing of GHC is needed, at build time
  either. Its type checker is the real one that rejects ill-typed programs,
  so the editor's errors are the ones the program has, not guesses. It is
  small enough to start in a worker in well under a second and fast enough
  to recheck a project on every edit.
* **GHC in the browser** is the heavier, exact option and the **future
  work**: once a GHC that runs as wasm (the `ghc-in-browser` work on top of
  the wasm backend) is released as a reusable artefact, a pack could run
  GHC's own type checker and GHCi's interpreter, with GHC's messages. Today
  it means a 49 MB first download, minutes of setup per page on slower
  machines, and building GHC from an unmerged branch; the editor features
  would still have to be written against the GHC API, as HLS cannot run.
* **HLS and ghcide** would give the best editor, but they need the GHC API
  and spawn processes; no wasm build exists.
* **Hugs** would be small, but it is unmaintained and stops at Haskell 98:
  no modern `base`, no containers as people use them.
* A **tree-sitter-only** server (the Kotlin pack's approach) would give
  syntax errors and project-local names, and none of the types, which are
  the point of a Haskell editor.

So: MicroHs for everything, with a patch (below) that makes its type checker
remember what it resolved. The Monaco grammar is ours
(`app/src/lib/haskell-language.ts`), as Monaco has none for Haskell.

## What works

* **Diagnostics** from the type checker: type mismatches (shown in GHC's
  words, "Couldn't match type ‘Bool’ with ‘Int’"), missing instances, names
  not in scope, wrong number of arguments, parse errors and unknown
  imports, each at its line and column. An error in an imported module
  is reported in that module, not in every file importing it.
* **Hover**: the type of any variable, function, constructor or operator,
  as used at that place (`print :: Point -> IO ()` there, not
  `Show a => a -> IO ()`), the module it comes from, and the `-- |` comment
  above its definition. On a data type: its declaration.
* **Go to definition** across the project's files, for values, constructors,
  types and classes. Library names have no source in the pack.
* **References, highlights and rename** across the project: every use the
  checker resolved plus the signature, the equations, the export list and
  import lists. Rename refuses a library name and a new name of the wrong
  kind (a constructor that is not upper case, a keyword).
* **Completion**: names in scope with their types (the project's, the
  Prelude's and every imported module's), local binders, `Map.` after a
  qualified import, module names after `import`, keywords.
* **Document symbols**: data types, newtypes, synonyms, classes and the
  top-level functions.
* **Run**: the project from `Main.hs`, with a terminal: stdout as it is
  written (line buffered, and flushed before the program waits for input,
  so a prompt without a newline shows), `getLine`, `getContents` until
  Ctrl-D, `exitWith`. Compile errors in GHC's `file:line:col: error:`
  format; runtime errors (`head []`, `error`) as GHC prints them.
* **Test**: `tests/Spec.hs` (or `test/Spec.hs`) with hspec's `describe`,
  `context`, `it`, `xit`, `pending`, `shouldBe`, `shouldSatisfy`,
  `shouldContain`, `shouldReturn`, `shouldThrow` and the rest of the
  `should*` family, reported as hspec does, in colour: ✔ in green,
  failures in red with the expected and actual values, then
  `N examples, M failures`.
* **Download** writes `haskell-project.cabal` (an executable from
  `Main.hs`, a test suite from `tests/Spec.hs` on hspec, `GHC2021`, the
  modules listed) and `cabal.project`, so `cabal run` and `cabal test` work
  with GHC on the project as it is.

Measured (Chromium, this machine, `node test.mjs`): the server is ready
and has checked the sample 3.1 to 3.7 s after the worker starts, most of it
loading the three packages; after that an edit is checked in about 1 s.
Run takes 2.3 s cold and 1.7 s warm, Test about the same.

## What is in `app/static/packs/haskell/`

| file | raw | gzip | brotli | what |
|---|---|---|---|---|
| `yuki.wasm` | 533 KB | 198 KB | 176 KB | MicroHs's runtime and compiler, with our driver |
| `yuki.mjs` | 87 KB | 24 KB | 21 KB | its Emscripten loader |
| `base.pkg` | 806 KB | | | MicroHs's `base`, precompiled (already compressed) |
| `containers.pkg` | 385 KB | | | containers 0.8.1, precompiled |
| `hspec.pkg` | 187 KB | | | our Test.Hspec, precompiled |
| `server.js` | 32 KB | 10 KB | 9 KB | ours: the LSP worker |
| `runner.js`, `project.js` | 10 KB | 4 KB | 4 KB | ours: Run/Test, and what both workers share |
| `LICENSE-*.txt`, `manifest.json` | | | | licences; versions and sizes |

**1.6 MB to download** for the editor; Run and Test reuse the same files
(and the browser's cache) plus 2 KB. 2.5 MB stored.

## Building

```sh
./build.sh          # writes app/static/packs/haskell/
npm install && node test.mjs
```

`build.sh` fetches MicroHs 0.16.0.0 and containers 0.8.1 from Hackage, each
checked by sha256, and reuses the C++ pack's Emscripten (emsdk 4.0.22,
installed into the shared cache if it is not there). Everything is cached
in `~/.cache/yukibana-packs/haskell` (11 MB) with stamps, so a rebuild only
redoes what changed. Steps:

1. MicroHs's sources, with `patches/microhs-ide.patch` applied;
2. a native `mhs` from MicroHs's own generated C (`cc`, no GHC);
3. `base.pkg`, `containers.pkg` (through MicroHs's cpphs) and `hspec.pkg`
   from `src/hslib/`, compiled by that `mhs`;
4. `yuki.c`: MicroHs's compiler plus `src/hs/Yuki.hs`, compiled by `mhs` to
   C (76 s: without the compile cache, which would emit the foreign export
   twice);
5. `emcc -O3` to `yuki.wasm` and `yuki.mjs`, with `src/yuki-io.c`.

About 5.5 minutes cold on 2 cores, nearly all of it steps 3 and 4.

### The patch

MicroHs's type checker resolves every name and then forgets: its symbol
tables keep only the result. `patches/microhs-ide.patch` (3 files, about
55 added lines) adds a list to the checker's state and records, at the five places
where a name is looked up (a variable, the head of an application, a
pattern variable, a constructor pattern), the name as written, what it
resolved to, the definition's location and the type it has there. Two
details made it work:

* the lookup replaces the definition's location with the use's, so the
  record looks the name up again to keep the definition;
* the checker resets its unification variables before each top-level
  definition, so the record's types are substituted at each reset, not at
  the end of the module (otherwise every type was `_a123`).

`Yuki.hs` is the driver: `run`/`test` for the runner, and for the server a
`yuki_request` export that checks files against packages loaded once and
answers in JSON. It rewrites MicroHs's messages in GHC's words where they
differ only in wording ("Cannot satisfy constraint: Bool ~ Int").

## Limits

* **One error per module**: MicroHs stops at the first. Fixing it shows
  the next.
* **Messages are MicroHs's**, rewritten where that is safe. Types print as
  MicroHs has them: `[Char]`, not `String`.
* **String literals are overloaded** (MicroHs always has
  `OverloadedStrings`): `n = "x"` where an `Int` is expected says "No
  instance for (IsString Int)", with a hint that it is a string where an
  `Int` was expected, where GHC would say it cannot match `[Char]`.
* **Libraries**: `base` and containers without `Data.Sequence`,
  `Data.Graph` and `Data.Tree` (they need `array`, which MicroHs's base
  does not ship). No `text`, `bytestring`, `mtl`, `random` or QuickCheck;
  Test.Hspec is a subset (no `property`, `before`/`after` hooks or
  `parallel`).
* **No QuickCheck**, though QuickCheck 2.19.0.0 itself supports MicroHs
  (its cabal file has `impl(mhs)` options). It was tried and rejected,
  because what it depends on does not build with MicroHs 0.16.0.0 as
  released:
  * random 1.3.1, which QuickCheck needs (`random >= 1.2`), imports
    `GHC.Exts` with `MagicHash`, `UnboxedTuples` and `ByteArray#`.
    MicroHs has no such module, so it stops at `Module not found: GHC.Exts`.
  * splitmix 0.1.3.2, which QuickCheck needs on every compiler but Hugs,
    seeds itself from the `time` package on any compiler but GHC
    (`SPLITMIX_INIT_COMPAT`), and stops at `Module not found:
    Data.Time.Clock.POSIX`. `time` 1.15 does build with MicroHs, but it
    brings C sources and a configure-generated header. Its foreign calls
    would also have to be compiled into `yuki.wasm`'s runtime.

  Making it work would mean patching random, or rewriting it on top of
  MicroHs's primitives, and changing the runtime for `time`. That is a fork,
  not a library as released. transformers 0.6.3.0 does compile unchanged.
* **Heap**: a fixed 24 million cells; a program that needs more stops with
  "Out of memory".
* **Runtime error locations** point into MicroHs's library sources, not the
  project's.
* **Every check starts from the packages**: no incremental check across
  edits, so a project of many modules rechecks all of them on each edit
  (the sample's three take 1 s). Reusing the previous check's modules risked
  stale instances.
* **stdin** needs the page to be cross-origin isolated
  (`SharedArrayBuffer`), as every pack's runner does.
* No formatting, signature help, code actions or semantic tokens.

## Licences

MicroHs (Apache-2.0) and containers (BSD-3-Clause) are redistributed in
compiled form; their licences are copied next to the pack's files.
`src/hslib/Test/Hspec.hs` is ours, written against hspec's documented API,
and shares no code with hspec.
