# Rust pack: rust-analyzer's IDE crates for the editor, Miri (an interpreter, rustc 1.78) for Run and Test

| part | what it is | what it does |
|---|---|---|
| `server.js` + `rust-analyzer.wasm` | **rust-analyzer's IDE crates** (`ra_ap_ide` and friends, **0.0.358**, from crates.io) with a small LSP layer written for this pack (`server/src/lib.rs`), compiled to wasm32-wasip1 with Rust 1.98.0 | diagnostics, completion (with auto-import), hover, signature help, definition, type definition, implementations, references, highlights, outline, rename, quick fixes and assists, semantic tokens, inlay hints |
| `std-src.tar` | `core`, `alloc` and `std` sources from **rust-src 1.98.0** | what rust-analyzer reads for the standard library: types, completion, docs |
| `runner.js` + `miri.wasm` + `sysroot.tar` | **Miri**, rustc's MIR interpreter (rustc **1.78.0-dev**), compiled to wasm32-wasip1 by bjorn3 and published by [rubri](https://github.com/LyonSyonII/rubri), with its x86_64-unknown-linux-gnu sysroot | **Run** (stdout/stderr, interactive stdin) and **Test** (`#[test]` in `src/`, and `tests/*.rs`, reported like `cargo test`) |
| `quickcheck-1.0.3.tar` + `quickcheck-1.0.3-src.tar` | **[quickcheck](https://github.com/BurntSushi/quickcheck) 1.0.3** and its dependencies (rand, rand_core, getrandom, libc, cfg-if) from crates.io, compiled with that Miri, and their sources | **property-based tests**, for a project whose `Cargo.toml` names `quickcheck` (see "Property-based tests"); downloaded only then |

The status bar shows `rust-analyzer (ra_ap_ide, Yukibana) 0.0.358`. This is
**not the `rust-analyzer` binary**: that program needs threads, a file
watcher, and `cargo metadata` to find out what the project is. The pack uses
the same analysis crates the binary is built on, on one thread, and builds
the crate graph itself from the files in the editor (see "The crate graph").

**Run does not compile the program.** No rustc that produces a runnable
program works in a browser: rustc's code generators (LLVM and Cranelift) and
the linker have not been built for WebAssembly in any usable, published form
(see "Alternatives"). The runner uses rustc's front end (parsing, macro
expansion, name resolution, type and borrow checking: the compile errors are
rustc's own) and then **interprets** the program's MIR with Miri. That is
real Rust semantics, but it is slow (roughly 100 to 1000 times slower than a
compiled program) and the compiler is **1.78** (May 2024), edition 2021 at
most.

## The language server (server.js)

`rust-analyzer.wasm` is a library, not a program: `server.js` hands it each
JSON-RPC message (`yk_message`) and, after 250 ms with no message,
asks it to compute diagnostics (`yk_idle`). Both return the messages to
send. Diagnostics are published for every open `.rs` file whenever its list
changes, including the first, empty list.

At start it downloads `rust-analyzer.wasm` and `std-src.tar` (with
`yukibana/loading` progress), hands the standard library's 1,500-odd files
to the module, and only then answers. From the first message to the first
diagnostics of the sample takes about 3.5 s in Chromium on this machine
(salsa computing std's item tree); after that, completion takes 50 to 300
ms and diagnostics after an edit a few hundred ms.

A panic in rust-analyzer aborts the wasm instance (it is built with
`panic = "abort"`; wasm has no unwinding here). `server.js` then starts a
new instance, replays `initialize` and the open documents, and answers the
request that failed with an error, so one bad request does not end the
session. The log says so.

### The crate graph

Built from the open files after every change that adds, removes or renames
a file, or changes `Cargo.toml`, the way Cargo would:

- `src/lib.rs`, if present, is a library crate named after `[package] name`
  in `Cargo.toml` (dashes become underscores; `app` when there is no
  `Cargo.toml`).
- `src/main.rs` (or a root `main.rs`, in the flat layout), each
  `src/bin/*.rs` and each `tests/*.rs` is a crate that depends on that
  library.
- Every crate depends on `core`, `alloc` and `std` from `std-src.tar`, has
  edition 2021 (or the one `Cargo.toml` names), and has the cfgs `test` and
  `debug_assertions` set, so `#[cfg(test)]` modules are analysed.
- The target is x86_64-unknown-linux-gnu (cfgs and data layout, so hover
  shows real sizes), like the runner's.

- If `Cargo.toml` names `quickcheck` under `[dependencies]` or
  `[dev-dependencies]`, `server.js` downloads `quickcheck-1.0.3-src.tar`
  and restarts the server with it: quickcheck, rand, rand_core, getrandom,
  libc and cfg-if become library crates with the features, build-script
  cfgs and dependencies Cargo resolved for them (`crates.json`, written by
  `scripts/build-crates.mjs`), and every crate of the project depends on
  quickcheck (dev-dependencies too: the library is analysed with
  `cfg(test)`). Diagnostics wait for the download rather than flash an
  unresolved `use`.

Not read from `Cargo.toml`: other `[dependencies]` (there is no crates.io
here, see "What does not work"), features, `[[bin]]` paths, build scripts.

### Why std 1.98 for analysis and 1.78 for running

rust-analyzer 0.0.358 lowers `format_args!` only the way std 1.93 and later
define it. Given std 1.78's sources, every `write!`, `format!` and
`println!` with arguments was a false `E0308`. So the editor analyses
against std 1.98 while the program runs on std 1.78. A function added to
std after 1.78 (for example `<[T]>::get_disjoint_mut`, 1.86) completes and
type checks in the editor, then fails on Run with rustc's `E0599`.

### Diagnostics

rust-analyzer's own diagnostics only. **There is no `cargo check`**: in an
editor, the borrow checker's errors (`E0382` use after move, `E0499`,
`E0502`), trait-solving errors and lints come from rustc through
`cargo check`, and here they appear only when you press Run. rust-analyzer
reports syntax errors, type mismatches (`E0308`), wrong argument counts,
missing match arms, missing fields, unresolved imports and modules, missing
`unsafe`, mutability errors and more.

rust-analyzer's "experimental" diagnostics are **on**, unlike its defaults:
they include unresolved names (`E0425`) and methods (`E0599`), which
`cargo check` would otherwise report, and without them a typo would be
silent until Run. One of them, "type annotations needed" (`E0282`), is off:
it fired on correct code in testing (`HashMap::new()` with an annotated
`let`, in a body that also reads stdin). An experimental diagnostic can be
wrong where rust-analyzer's type inference gives up; rustc on Run has the
last word.

### What does not work in the editor

- **No formatting.** rustfmt is a separate program and is not in the pack.
- **No crates.io dependencies but quickcheck.** A `use serde::...` is
  unresolved in the editor and on Run.
- **No procedural macros**, so `#[derive(Serialize)]`-style macros from
  crates would expand to nothing (there are no such crates anyway). The
  standard library's built-in derives (`Debug`, `Clone`, `PartialEq`, ...)
  and `macro_rules!` macros work.
- `std::arch` and `core::simd` (`std_detect`, `stdarch`, `portable-simd`
  live outside `library/{core,alloc,std}`) are not in `std-src.tar`, so
  their items are unresolved in the editor.
- No `rust-analyzer` commands (Run lenses, expand macro, view HIR, ...), no
  workspace symbol search, no call hierarchy, no folding ranges from the
  server (Monaco folds by indentation).

## The runner (runner.js)

The contract's runner (`../CONTRACT.md`, "Running a program").

1. **Load**: download `miri.wasm` and `sysroot.tar` (`loading` messages)
   and compile the module once; the sysroot becomes an in-memory WASI file
   system (`@bjorn3/browser_wasi_shim` 0.4.2) with `/sysroot`, `/project`,
   `/out` and `/tmp`.
2. **Library**: if there is a `src/lib.rs`, Miri runs as rustc
   (`MIRI_BE_RUSTC=target`) and writes its metadata, MIR included
   (`--emit=metadata -Zalways-encode-mir`), under the package's name.
3. **Run**: Miri interprets `src/main.rs` (or `main.rs`) with that library
   as `--extern`. stdout and stderr are streamed; stdin follows the
   contract (stdout is flushed, the worker blocks on the SharedArrayBuffer;
   Ctrl-D is end of file). Compile errors are rustc's, with paths as the
   project names them, and exit 1. A panic prints Rust's own
   `thread 'main' panicked at ...` and exits 101; `process::exit(n)` exits
   n; Stop ends the worker (an endless loop is fine).

Each step is a fresh Miri instance (rustc keeps global state). A warm run
of the sample takes about 2.5 s; the first, with downloads, a few seconds
more.

### Tests

**Test** builds the library, then runs, as `cargo test` does: the unit
tests of the library, the unit tests of the binary, then each
`tests/*.rs`, and prints libtest's report (`running 3 tests`,
`test distance_is_symmetric ... ok`, `test result: ok. 3 passed; 0 failed;
...`), with failures' output and panic messages. The exit code is 101 if any
test failed.

This is not libtest's harness. Miri here cannot unwind (below), and libtest
catches each test's panic by unwinding. So `src/harness.rs` is compiled to a
small crate and injected as the test runner
(`#![feature(custom_test_frameworks)]`, `#![test_runner(...)]`, through
`-Zcrate-attr`). It runs the tests one at a time in name order, captures
their output, and reports each on control lines the runner reads; when a
test panics, the instance dies, and the runner starts a new one that skips
the tests already done. `#[ignore]` and `#[should_panic]` (with
`expected`) work; a `#[test]` returning `Result` fails on `Err`. Benchmarks,
doc tests, test filters and `--nocapture` are not supported. The sample's
four tests (one a quickcheck property) take about 9 s in `test-run.mjs`.

### What does not work on Run

- **Panics cannot be caught.** Miri's standard library was built for Linux,
  not for Miri, and a panic unwinds through `_Unwind_RaiseException`, which
  Miri does not implement. So a panic always ends the program (exit 101,
  with the right message): `std::panic::catch_unwind` and joining a thread
  that panicked do not return.
- **Rust 1.78, edition 2021 at most.** `edition = "2024"` in `Cargo.toml`
  runs as 2021, with a warning; newer std APIs are `E0599`.
- **No program arguments**: std on Linux reads them through `.init_array`,
  which this Miri does not run, so `std::env::args()` is just empty. The
  environment is empty too.
- **Slow**: an interpreter, with Miri's undefined-behaviour checks
  (Stacked Borrows, validation, alignment, data races) **off** to make it
  bearable. So this is not Miri as a UB checker; a program with UB runs
  as far as it gets.
- Threads run (Miri schedules them on one thread), but slowly. No network,
  no files outside `/tmp`, no processes.
- No crates.io dependencies but quickcheck (below), no build scripts, no
  proc macros.

### Property-based tests

[quickcheck](https://github.com/BurntSushi/quickcheck) 1.0.3, the
standard property-based testing crate without procedural macros, is the
one crates.io package here. A project asks for it as it would with Cargo,
and the sample does:

```toml
[dev-dependencies]
quickcheck = "1"
```

```rust
use quickcheck::quickcheck;

quickcheck! {
    fn distance_is_symmetric(ax: i32, ay: i32, bx: i32, by: i32) -> bool {
        let a = Point::new(ax as f64, ay as f64);
        let b = Point::new(bx as f64, by as f64);
        distance(a, b) == distance(b, a)
    }
}
```

`quickcheck!` (a `macro_rules!` macro) makes each property a `#[test]`
that tries 100 random inputs and, when one fails, shrinks it and fails
with the smallest it found:

```
running 2 tests
test distance_is_symmetric ... ok
test norm_stays_under_100 ... FAILED

failures:

---- norm_stays_under_100 stdout ----
thread 'norm_stays_under_100' panicked at quickcheck-1.0.3/src/tester.rs:165:28:
[quickcheck] TEST FAILED. Arguments: (100)
```

How it gets here: `crates/Cargo.toml` asks for `quickcheck = "=1.0.3"`
without default features (they add env_logger and regex, for
configuration through environment variables a program here does not have),
`crates/Cargo.lock` pins it and its dependencies by version and checksum,
and `scripts/build-crates.mjs` has Cargo resolve the graph and run libc's
build script (`cargo check --target x86_64-unknown-linux-gnu`), then
compiles each crate with the same Miri, editions, features and cfgs, to
metadata with MIR, as the runner compiles a project's library. The runner
passes `--extern quickcheck=...` to the crates Cargo would give it to:
`[dependencies]` to all of them, `[dev-dependencies]` to the test crates
only (so a Run of the sample downloads nothing more). A version
requirement 1.0.3 does not meet (`quickcheck = "0.9"`) is a warning, and
1.0.3 is used. Without the declaration `use quickcheck` is `E0432`, as with
Cargo.

Limits:

- **A property must return `bool` or `TestResult`.** quickcheck finds out
  that a property failed either from its result or by catching its panic,
  and panics cannot be caught here (above). A property that panics
  (`assert!`, an overflow, an index out of bounds) fails its test with that
  panic and the first failing input is not shrunk or printed.
- **No `#[quickcheck]` attribute**: it is the `quickcheck_macros` crate, a
  procedural macro. `quickcheck!` and `quickcheck(f as fn(...) -> bool)`
  do the same.
- **Slow**: every case is interpreted. In `test-run.mjs` the sample's
  Test (four tests, the property among them) takes about 9 s, and a file
  with a four-`f64` property and a failing one about 6 to 8 s.
  `QuickCheck::new().tests(20).quickcheck(...)` runs fewer cases; the
  environment variables quickcheck reads (`QUICKCHECK_TESTS`) are not set
  here.
- proptest, the other common crate, was not added. It would probably run
  (its `prop_assert!` returns an error rather than panicking), but it is
  three times the dependencies (regex-syntax, bitflags, num-traits,
  rand_chacha, rand_xorshift, unarray, and rusty-fork and wait-timeout for
  its default `fork` and `timeout` features, which spawn processes), and it
  saves failing cases to `proptest-regressions/` files by default. One
  property-testing crate is enough to have the technique.

### Mutation testing: not available

[cargo-mutants](https://mutants.rs) is the maintained mutation tester for
Rust. It is a Cargo subcommand that copies the source tree, edits one
function at a time and runs `cargo build` and `cargo test` as child
processes for each mutant, timing each against a baseline. None of that
exists here: there is no Cargo, no process to spawn and no file tree to
copy; each mutant would be a full compile and test under Miri (the
sample's tests take seconds, so a few hundred mutants would take tens of
minutes); and a mutant that panics ends the instance without unwinding.
[mutagen](https://github.com/llogiq/mutagen) inserts its mutations with
an attribute procedural macro (`#[mutate]`) and a nightly toolchain, and
there are no procedural macros here (and it is unmaintained since 2020).
Writing a mutation runner for this pack would be a new tool, not an
existing one, which this pack does not do.

## Optimization: not offered

Run never compiles to machine code: Miri interprets the program's MIR, so
there is no optimisation level in the sense of `cargo build --release`
(Cargo's `opt-level` is LLVM's, and Miri never runs LLVM). The only knob
left is rustc's MIR optimiser, `-Zmir-opt-level`, which Miri keeps at 0 on
purpose: MIR optimisations may remove undefined behaviour that Miri exists
to report. Measured anyway (a loop over a `Copy` struct, an iterator chain,
a sort of 50,000 numbers; Chromium, 4 cores): the default 59.9 s, level 1
60.7 s, level 2 54.5 s, level 3 48.7 s. Up to a fifth faster at the
price of detecting less undefined behaviour, and not what the same code
does at `--release` (where it would take milliseconds), so a level here
would mislead more than it helps. The app's Optimization select is not
shown for Rust.

## Alternatives considered

- **The `rust-analyzer` binary on WASI**: needs threads (its main loop,
  the VFS loader, the flycheck and proc-macro servers) and `cargo
  metadata`. The IDE crates, driven directly, need neither; the one
  thread salsa still wanted (dropping parse trees in the background) is
  turned off with `--cfg no_salsa_async_drops`.
- **rustc compiled to WASI** (bjorn3's `rustc` on wasm32-wasi experiments,
  2023-24): the front end runs, but code generation needs LLVM or
  Cranelift on wasm and a linker (wasm-ld or lld) on wasm, with a
  wasm32-wasip1 std. No published, pinned build of that exists; building
  one is days of work and many GB, well past this machine's disk. Miri
  avoids code generation entirely.
- **rubri** (chosen): Miri on wasm, from bjorn3's builds, with a sysroot,
  pinned to a commit and every file's sha256 checked by `build.sh`
  (`scripts/rubri.sha256`). rubri itself runs it in a web worker; this
  pack reuses only its artifacts, not its code.
- **Remote compilation (the Rust playground)**: excluded by the contract;
  nothing here leaves the browser.

## Files and sizes

What the browser downloads, from `/packs/rust/` (served brotli or gzip
where the server can):

| file | raw | gzip | brotli |
|---|---:|---:|---:|
| `server.js` | 3.9 KB | 1.9 KB | 1.7 KB |
| `rust-analyzer.wasm` | 12.2 MB | 4.0 MB | 2.6 MB |
| `std-src.tar` | 12.7 MB | 2.4 MB | 1.65 MB |
| **editor total** | **24.9 MB** | **6.4 MB** | **4.2 MB** |
| `runner.js` | 40 KB | 13 KB | 11.9 KB |
| `miri.wasm` | 47.2 MB | 15.1 MB | 9.4 MB |
| `sysroot.tar` | 83.0 MB | 29.7 MB | 20.4 MB |
| **runner total** | **130 MB** | **44.8 MB** | **29.8 MB** |
| `quickcheck-1.0.3.tar` (runner, when `Cargo.toml` names quickcheck) | 6.9 MB | 2.6 MB | 1.64 MB |
| `quickcheck-1.0.3-src.tar` (editor, when `Cargo.toml` names quickcheck) | 5.3 MB | 0.94 MB | 0.47 MB |

The runner's parts are downloaded on the first Run or Test only; the
quickcheck archives only for a project that declares it (the runner's for
Test when it is a dev-dependency). Most of both is libc (4.9 MB of the
metadata, 4.4 MB of the sources), which getrandom needs on Linux.
`sysroot.tar` is the rubri sysroot's rlibs reduced to their `lib.rmeta`
member (the object code is never used by an interpreter), without
`proc_macro` and the compiler-internal crates. `std-src.tar` leaves out
std's tests, benches and the platform layers of operating systems other
than Linux (`scripts/make-sysroot-src.py`).

## Versions and licences

| what | version | from | licence |
|---|---|---|---|
| rust-analyzer IDE crates (`ra_ap_*`) | 0.0.358 | crates.io, locked in `server/Cargo.lock` | MIT OR Apache-2.0 |
| Rust toolchain that builds the server | 1.98.0 | rustup | MIT OR Apache-2.0 |
| rust-src (std sources for analysis) | 1.98.0, sha256 `0e977492...870f2bf` | static.rust-lang.org | MIT OR Apache-2.0 |
| Miri / rustc and its sysroot | 1.78.0-dev (`miri.opt.1718474653.wasm`) | rubri at `00de75bcec3d8cf5156aef2382c738cbfe069986` | MIT OR Apache-2.0 (rubri: MIT) |
| browser_wasi_shim | 0.4.2 | npm | MIT OR Apache-2.0 |
| quickcheck | 1.0.3 | crates.io, locked in `crates/Cargo.lock` | Unlicense OR MIT |
| rand, rand_core, getrandom, libc, cfg-if | 0.8.8, 0.6.4, 0.2.17, 0.2.191, 1.0.5 | crates.io, locked in `crates/Cargo.lock` | MIT OR Apache-2.0 |

Full notices: `LICENSES.txt`, shipped next to the pack's files.

## Building and testing

```sh
cd packs/rust
npm install
./build.sh        # writes ../../app/static/packs/rust/
node test.mjs     # the language server in headless Chromium
node test-run.mjs # the runner in headless Chromium
```

`build.sh` installs Rust 1.98.0 (minimal profile, wasm32-wasip1) with
rustup if needed, caches everything under `$PACK_CACHE/rust` (default
`~/.cache/yukibana-packs/rust`): the cargo target directory (about 1 GB),
rust-src, and rubri's files. A first build takes about 10 minutes on 4
cores: 4 for rust-analyzer's crates, most of the rest compressing the
sysroot with brotli. A rebuild with a warm cache is a few minutes.

`test.mjs` serves the static directory with cross-origin isolation and
drives the server through the sample from `app/src/lib/languages.ts`: clean
diagnostics, errors and their clearing, completion (members, std,
auto-import), hover (with std docs and layout), definition, references,
symbols, signature help, highlights, rename, semantic tokens, inlay hints, a
quick fix, a new module file and its deletion; then the brotli-served files
and a renamed package; quickcheck's sources loading because `Cargo.toml`
names it, hover and completion from it, and `use quickcheck` unresolved
without the declaration. `test-run.mjs` runs and tests the sample, a failing
test, a passing and a failing quickcheck property (with its shrunk
counterexample), quickcheck loaded only when declared, a `[dependencies]`
entry with a version 1.0.3 does not meet, stdin (a prompt, then end of file), compile errors (`E0308`, the
borrow checker's `E0382`), a panic, `process::exit`, a project without
`Cargo.toml`, and an endless loop that is stopped.
