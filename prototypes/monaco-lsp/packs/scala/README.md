# Scala pack

**What runs:** the real Scala 3 compiler, **version 3.7.4**, built from
upstream source ([scala/scala3](https://github.com/scala/scala3) at tag `3.7.4`,
commit `40be7608a48477951218ae3a8ac8749fe02ba988`). It is compiled to one
JavaScript ES module with **Scala.js 1.19.0** and runs in a module Web Worker.
`ScalaService.scala` (about 650 lines) drives the compiler's own interactive
API (`dotty.tools.dotc.interactive`: `InteractiveCompiler`, `Completion`,
`Interactive`, plus `util.Signatures` and `ParsedComment`), the API that
upstream's former Dotty Language Server was built on. `src/server.js` speaks
LSP over `postMessage` as `CONTRACT.md` describes.

The pack also **runs programs** (`runner.js`): the same compiler compiles the
project with its full pipeline and its Scala.js back end, the Scala.js linker
(itself compiled with Scala.js) links it in the browser, and the linked
program runs in the worker. See [Running](#running).

**What this is not: Metals.** Metals cannot run in a browser (see
[Why not Metals](#why-not-metals)). So the LSP layer is written here. The
type checking, completion, hover, signature and definition logic is the
compiler's own code, unchanged except for the patch described below.

## What works

All of this was checked by `test.mjs` in headless Chromium (output below):

* **Diagnostics from the real type checker:** parser and typer errors with
  the compiler's own messages (`Found: ("five" : String) / Required: Int`,
  `Not found: Point - did you mean print?`). All open `.scala` documents are
  compiled together on each check, so the files see each other.
* **Completion:** project and standard library members (`p.` lists
  `norm, x, y, copy, ...`; `xs.` lists the 213 members of `List[Int]`, with
  signatures as `detail`). Ranked the way Metals ranks them, through
  `sortText` (label and filter text are the member's name): first what the
  receiver's class and its supertypes declare (`copy, norm, x, y`; `map`,
  `sum` for a `List`), then what every value or case class has (members of
  `Any`, `AnyRef`/`Object`, `Product`, `Equals`, `Serializable`, `Predef`,
  and the `canEqual`, `productArity`, `toString`, ... a case class
  synthesizes), and last symbolic names and plumbing (`==`, `##`, `->`, `_1`,
  `asInstanceOf`, `isInstanceOf`, `synchronized`, `ensuring`, ...). An
  earlier build ranked by owner only, so the IDE listed `!=, ##, ->, ==, _1,
  _2, asInstanceOf, canEqual` before `norm`; `test.mjs` now checks that
  `norm` is among the first three.
* **Completion where a name is typed** (not after a `.`) adds what the
  compiler's interactive API does not offer, as Metals does:
  * **keywords** (`whil` → `while`, `{ val n = 1; i` → `if`), filtered by
    the typed prefix and ranked after every symbol;
  * after `case` in a match, the **scrutinee's enum cases**, qualified
    (`c match` / `case Re` → `Color.Red`; inserted as `Color.Red`, filtered
    as `Red`), or the children of a sealed type;
  * **project definitions from other packages** (top-level classes, traits,
    objects, enums, defs and vals) with the import they need, as an
    additional text edit after the last import or the package clause
    (`Shou` → `Shouter`, `import tools.Shouter`).
* **Hover:** the declaration (`def norm: Double`,
  `override final def map[B](f: A => B): List[B]`, `val xs: List[Int]`) and
  Scaladoc rendered as Markdown. Classes, traits, objects, enums and enum
  cases are written out by `ScalaService` (`case class Point(x: Double, y:
  Double)`, `abstract class Base[+T](val t: T) extends Shape`, `enum Color`,
  `case Red: Color`): the compiler's `showDcl` prints a class with its tree,
  and hover once showed `case case class Point extends Object with Product
  with Serializable {} at (demo : demo.type)`.
* **Signature help**, **go to definition** (across files), **references**,
  **document highlight**, **rename** (across files) and **document symbols**
  (nested). References to a class or object are the occurrences rename
  edits: the class, its companion and a case class's synthetic
  `apply`/`unapply`, so `Point(0, 0)` in another file is a reference to the
  case class `Point` (the compiler's `namedTrees` skips the synthetic
  companion and found only the declaring file's uses).
* **Standard library:** the Scala 3 library is read from its TASTy, the Scala
  2.13.16 library from its class-file pickles. The JDK is the public API of
  `java.lang`, `java.io`, `java.math`, `java.nio`, `java.text`, `java.time`,
  `java.util` (and their subpackages) and `java.net.URI/URL`, taken from
  the `java.base` of a pinned JDK, Eclipse Temurin 21.0.8+9, which `build.sh`
  downloads with a sha256 (see `scripts/jdk-packages.txt`). It used to be
  whatever JDK ran the build, so the API student code saw changed with the
  build machine. `manifest.json` records the version (`classpath.jdk`).
* A request without a valid `textDocument`/`position` is answered with
  InvalidParams (-32602), and any request after `shutdown` with
  InvalidRequest (-32600); neither is logged as a server error. A position
  past the end of its line means the end of that line, as LSP says.
* Files that are not `.scala` (README.md and the like) are ignored. Deleting a
  file (`didClose`) makes its definitions disappear.

## What does not work, and why

* **Only parser and typer run.** These are the phases upstream's
  `InteractiveCompiler` runs, and Metals' presentation compiler runs the same
  ones. Errors that later phases report are therefore missing: a missing
  implementation of an abstract member (RefChecks), match exhaustivity
  (PatternMatcher), initialization checks, and some `PostTyper` checks. A
  program can pass here and still fail `scalac`.
* **Macros cannot expand, and usually say nothing.** A Scala 3 macro is
  compiled JVM bytecode that the compiler runs through a class loader, and
  there is no JVM here. An ordinary `inline def m(...) = ${ impl(...) }` is
  spliced in the Inlining phase, which the interactive compiler never runs
  (Metals' presentation compiler does not either), so a use of it
  type-checks against its declared type and **no diagnostic appears**; an
  error the macro itself would report is missing. Only a `transparent inline`
  macro, which expands during typing, reaches the patched Splicer and reports
  "macro expansion is not supported by the in-browser Scala compiler", on
  the `${ ... }` splice in the file that defines the macro (the position the
  expansion carries), not on the use. The
  test pins both behaviours. (An earlier version of this README claimed every
  macro reported that error; it does not.) `inline`, `compiletime`
  operations, and given/implicit resolution are not macros and work.
* **No dependencies.** The class path is the JDK subset plus the two Scala
  libraries. There is no build file, no coursier and no `//> using dep`.
* **Not offered by the server:** formatting (scalafmt is a separate
  JVM tool), code actions, type definition, semantic tokens, inlay hints,
  workspace symbols. They were left out for time.
* **Completion's additions are heuristics on the text**, not the parser's:
  * keywords are offered wherever a name is typed outside a `//` comment or
    a one-line string, whether or not the keyword fits there (`yield`
    outside a `for`); a keyword is never offered with nothing typed;
  * enum cases need `case` on the same line as the cursor, in a `match`
    whose scrutinee's type is an enum or a sealed type (a `catch` or a
    partial function `{ case ... }` gets nothing);
  * auto-import indexes the open project only, not the standard library or
    the JDK (`ListBuff` still offers nothing), and a project definition in the
    empty package cannot be imported. A symbol whose simple name the compiler
    already offers is not offered again, even if it is another one.
* **Hover** writes the types of values and parameters fully qualified when
  they are not in scope (`val c: demo.Color`), as the compiler shows them;
  only class names in a class's own declaration are shortened.
* `.sc` scripts and worksheets, and `.java` sources in the project, are not
  compiled.
* **Scala.js number semantics** show through in a few printed values: a
  `Double` constant `3.0` may be shown as `3` in a message. The serious case,
  `val x = 3` being inferred as `Byte`, is fixed by the patch (see below) and
  tested.
* Speed on this (shared, loaded) machine: the worker is ready about 1.1 s
  after start, with both files fetched from localhost. The first check takes
  about 0.9–1.4 s. A re-check after an edit takes 50–500 ms, or up to about
  3 s when the error makes the typer search implicit conversions over the
  standard library. Compiling is synchronous inside the worker, and requests
  wait for it.

## Running

**What runs:** the project is compiled by the same Scala 3.7.4 compiler
(`scalac.js`, the file the language server loads, so it is downloaded and
cached once), now through its **full pipeline**: parser, typer, the checks
after it (RefChecks, pattern-match compilation, initialization checks),
pickling, inlining, erasure, lambda lifting and the rest, up to its built-in
**Scala.js back end** (`-scalajs`, `GenSJSIR`), which writes Scala.js IR
(`.sjsir`) into memory. The **Scala.js 1.19.0 linker** then links that IR with
the IR of the Scala.js standard library into one ES module, as
`sbt fastLinkJS` would. The linker is upstream's own build of itself for
JavaScript (`org.scala-js:scalajs-linker_sjs1_2.13:1.19.0`, from Maven
Central), behind a 90-line wrapper (`compiler-js/linker`). The linked module is
imported in the worker and the program's `main` runs. Nothing is interpreted
and nothing pretends: it is what a Scala.js project built with sbt would run.

`runner.js` follows `CONTRACT.md` ("Running a program"): `loading` for each
download, `phase` `Compiling` / `Linking` / `Running`, `stdout` and `stderr`
as the program writes them, `exit` last. Diagnostics go to stderr as
`Main.scala:2:16: error: <the compiler's message>`, with the source line and a
caret, then `N errors found`, and the exit code is 1. Warnings are printed
too and do not stop the run. An uncaught exception prints
`Exception in thread "main" <its toString>` and a few frames (names of the
linked JavaScript functions) and exits 1.

The entry is `Main.scala` (any `.scala` file of the project works): an
`@main def` or an `object` with `def main(args: Array[String])`. Every
`.scala` file is compiled; the entry file's main is preferred when several
files have one.

**Standard input.** Scala.js has no blocking input, and its `System.in` and
`Console.in` are null. A small runtime helper, `compiler-js/runtime`
(`yukibana.runtime.Std`, compiled at build time, linked into every program as
the first module initializer, before `main`), replaces `System.out`, `System.err`
and `System.in` with streams that call the worker, and sets `Console.in` (a
protected setter, reached by a structural call). Reading a line
(`scala.io.StdIn.readLine()`, `readInt()`, ...) flushes stdout (so a prompt
printed without a newline shows), stores 1 in the SharedArrayBuffer's state,
posts `stdin`, and blocks in `Atomics.wait` until the app stores 2 (a line)
or 3 (end of file, `readLine()` returns null). Without a SharedArrayBuffer
(page not cross-origin isolated) reading gives end of file.

**Output** is posted as it is written, partial lines included, so text
printed before a long computation shows during it (nothing can flush a buffer
while `main` runs without yielding, so the runner does not hold text in the
ordinary case). Only bursts are coalesced: after 32 messages within 50 ms,
further writes collect and go out with the first write after that window, at
8 KB, before a read, at the end, or when the program yields; 100000
`println`s arrive in about 150 messages. The one remaining delay: if a
program prints such a burst and then computes silently without yielding, the
burst's last lines show only at its next write or its end. The test checks
both cases.

**Downloads** all start at once, but compiling waits only for `scalac.js`,
`classpath.bin` and `classpath-sjs.bin`; the library IR and the linker are
awaited before linking, so a program that does not compile is reported
without waiting for them.

**Versions and upstream:** Scala 3.7.4 compiler (scala/scala3 at
`40be7608`); Scala.js 1.19.0 linker, `scalajs-javalib` 1.19.0,
`scalajs-library_2.13` 1.19.0, `scalajs-scalalib_2.13` 2.13.16+1.19.0 and
`scala3-library_sjs1_3` 3.7.4 (all from Maven Central, sha256-pinned in
`build.sh`; the linker through sbt); ScalaCheck `scalacheck_sjs1_3` 1.18.1
and `scalajs-test-interface_2.13` 1.19.0 (below).

**Limits**, all of them Scala.js's, not this pack's (a program that hits one
fails at link time with Scala.js's own message on stderr, never silently):

* **Scala.js semantics, not the JVM's.** A `Double` with an integral value
  prints without `.0`, as in JavaScript: the sample prints
  `Point(0,0) to Point(3,4): 5` and `5` where the JVM prints
  `Point(0.0,0.0) to Point(3.0,4.0): 5.0` and `5.0`. `Int` overflow, `Long`,
  `Char` and string formatting (`f"..."`) behave as on the JVM. The linker
  runs with Scala.js's "compliant" semantics, so a bad cast, an index out of
  bounds, a null dereference or a negative array size throws the JVM's
  exception instead of being undefined behaviour.
* **JDK API:** only what Scala.js implements (`java.lang`, most of
  `java.util`, `java.io` streams, `java.time` is absent). There are **no
  threads** (`new Thread(...)` is a link error), **no files**, **no
  network**, **no `System.exit`/`sys.exit`** (a link error: Scala.js's
  javalib does not have it), no reflection, no `java.util.Scanner`
  (use `scala.io.StdIn`). A program that compiles can therefore still fail to
  link, with a `link error: Referring to non-existent ...` on stderr.
* **No macros** (as in the language server: they are JVM code the browser
  cannot run), no dependencies but ScalaCheck (below), no `scala.concurrent.Await` (Scala.js cannot
  block). The run ends when `main` returns, so asynchronous work still
  pending then (a `Future` callback, a timer) is cut off.
* **One run per worker:** each Run starts a fresh worker, so the compiler and
  the linker start cold every time (the files come from the cache). A
  program that never ends keeps the worker busy until the app terminates it
  (Stop), which the test checks.
* Needs `crossOriginIsolated` only for standard input; everything else works
  without it.

### Property-based tests (ScalaCheck)

[ScalaCheck](https://scalacheck.org) 1.18.1 for Scala.js
(`org.scalacheck:scalacheck_sjs1_3`, the newest) is on the class path of
a project that names `org.scalacheck` anywhere in its sources (an import
or a qualified name), as sbt would put it there for
`libraryDependencies += "org.scalacheck" %%% "scalacheck" % "1.18.1"`.
The editor then completes and hovers it and type-checks against it; Run
compiles and links against it. Scala has no Test here yet, so properties
run from a `main`:

```scala
import org.scalacheck.{Gen, Properties}
import org.scalacheck.Prop.forAll

object GeometrySpec extends Properties("Geometry"):
  val point = for x <- Gen.choose(-1e9, 1e9); y <- Gen.choose(-1e9, 1e9) yield (x, y)
  property("distance is symmetric") = forAll(point, point)((a, b) => distance(a, b) == distance(b, a))
  property("norm stays under 100") = forAll((n: Int) => distance((n.toDouble, 0.0), (0.0, 0.0)) < 100)

@main def properties(): Unit = GeometrySpec.check()
```

prints ScalaCheck's own report, the failing case shrunk (the original
argument and a seed to replay it with `.withInitialSeed` included):

```
+ Geometry.distance is symmetric: OK, passed 100 tests.
failing seed for Geometry.norm stays under 100 is gSDBwVAWsX6I_Dqn5rHoGZex0xCdkhSW35XBQkjRoKD=
! Geometry.norm stays under 100: Falsified after 0 passed tests.
> ARG_0: 127
> ARG_0_ORIGINAL: 2147483647
```

Limits: `check()` prints and returns, so a falsified property does not make
the run exit non-zero; `Properties.main` (what sbt's runner would call)
does not link, because it calls `System.exit`, which Scala.js does not have.
ScalaCheck's shrinking of numbers halves them, so the shrunk value is a
small failing one, not always the smallest (127 above, not 100). What
`build.sh` does: the jar and the `scalajs-test-interface` it depends on
(its POM names 1.16.0; this pack's 1.19.0, as sbt's eviction would pick)
are stripped like `classpath.bin` into `scalacheck-1.18.1-classpath.bin`
(137 TASTy and class files) and their IR bundled into
`scalacheck-1.18.1-sjsir.bin` (215 files); the server creates its
compiler again over both class paths when a document first names
`org.scalacheck` (diagnostics wait for it), and the runner adds both. Download's `build.sbt`
adds ScalaCheck (`%%`, the JVM build) when the project names it, and `sbt
run` prints the same report.

| file | raw | gzip | brotli |
|---|---:|---:|---:|
| `scalacheck-1.18.1-classpath.bin` (server and runner) | 759 KB | 330 KB | 245 KB |
| `scalacheck-1.18.1-sjsir.bin` (runner) | 1.9 MB | 479 KB | 340 KB |

ScalaCheck is BSD-3-Clause (`LICENSE-scalacheck.txt`, from its repository at
`v1.18.1`, sha256-pinned); scalajs-test-interface is Apache-2.0, as is
Scala.js.

### Mutation testing: not available

[Stryker4s](https://stryker-mutator.io/docs/stryker4s/getting-started/),
the Scala mutation tester, is an sbt (or Maven) plugin: it rewrites the
sources with scalameta, then has sbt compile and run the test suite for
every mutant, on the JVM. Here there is no sbt, no JVM and no Test yet,
and each mutant would be a compile and a link of 3 s or more. There is no
tool that runs in this pack.

**Speed** on this shared 4-core machine while another build ran (headless
Chromium, files from localhost): a run of the sample takes 3.5-10 s depending
on the load (3.5 s cold and 3.4 s warm in the run below, at load average
about 5; 7.7 s at load 9), of which compiling (including starting
the compiler) is 2-6 s and linking 1-3 s; the program itself runs in
milliseconds. A warm run (files
from the HTTP cache, as the service worker gives the app) is not faster:
the time is the compiler and the linker starting cold in a new worker, not
the download. See the test output below.

**Sizes** of what the runner downloads (raw / gzip / brotli):

| file | raw | gzip | brotli |
|---|---:|---:|---:|
| `scalac.js` (shared with the server) | 5.6 MB | 1.57 MB | 1.13 MB |
| `classpath.bin` (shared with the server) | 5.6 MB | 1.93 MB | 1.41 MB |
| `classpath-sjs.bin` (scala.scalajs API, java.base closure; 1200 files) | 1.4 MB | 0.34 MB | 0.26 MB |
| `sjsir.bin` (library IR, 4957 files) | 15.7 MB | 4.15 MB | 3.03 MB |
| `sjslinker.js` (Scala.js linker, fullLinkJS, minified) | 2.1 MB | 0.54 MB | 0.41 MB |
| `runner.js` | 10 KB | 3.9 KB | 3.4 KB |
| **total** | **30.5 MB** | **8.5 MB** | **6.2 MB** |
| of which not already downloaded by the server | 19.2 MB | 5.0 MB | 3.7 MB |

`sjsir.bin` is the whole Scala.js standard library (javalib, scalalib,
library, scala3-library) because the linker needs the IR of every class a
program might reach; it is the bulk of the download. Putting the back-end
phases into the shared `scalac.js` made it 0.26 MB (brotli) larger for the
language server too; a separate compiler file for the runner would have cost
the runner a second 1.1 MB compiler instead.

**How it is built** (part of `build.sh`, see below): the sbt build compiles
two more small projects, `compiler-js/linker` (fullLinkJS, minified by
esbuild into `sjslinker.js`) and `compiler-js/runtime` (only compiled; its
IR goes into `sjsir.bin`); `scripts/sjsir-bundle.mjs` packs the library IR;
`StripClasses.java` builds `classpath-sjs.bin`. The compiler needed one more,
smaller patch for its later phases (`patches/scala3-3.7.4-runner.patch`, see
[The patch](#the-patch-126-changed-lines-in-26-upstream-files)) and the
Scala.js build of the IR's SHA-1 (`scalajs-ir_sjs1` sources), which the back
end hashes classes with. A clean sbt build (cache `target/` deleted, downloads kept) of everything,
compiler included, took **13 min** this time (load average 9-17 on 4 cores
from another build; sbt's compile of the compiler alone was 10 min). The
runner's own parts are small: linking the Scala.js linker takes about 20 s,
the runtime helper 2 s, the IR bundle and `classpath-sjs.bin` a few seconds.
An incremental rebuild after editing `ScalaService.scala` or
`ScalaJSCompiler.scala` took 1-2.5 minutes.

## Sizes

| file | raw | gzip | brotli |
|---|---:|---:|---:|
| `scalac.js` (compiler + service + the runner's back end, Scala.js fullLinkJS, minified by esbuild) | 5.6 MB | 1.57 MB | 1.13 MB |
| `classpath.bin` (4149 class/TASTy files, method bodies stripped) | 5.6 MB | 1.93 MB | 1.41 MB |
| `server.js` | 9 KB | 3.2 KB | 2.7 KB |
| `manifest.json` | 0.2 KB | | |
| **total** | **11.2 MB** | **3.5 MB** | **2.5 MB** |

(`scalac.js` was 4.2 / 1.19 / 0.87 MB before it also carried the phases after
the typer and the Scala.js back end for the runner. The runner's files are in
[Running](#running).)

Scala.js does not run Closure on ES-module output, so the linked module was
once shipped as 13.8 MB of indented code (1.97 MB gzip) while this table
called it minified. esbuild now minifies it.

`build.sh` writes `.gz` and `.br` siblings of every file. Progress
(`yukibana/loading`) is reported against the uncompressed sizes in
`manifest.json`.

The page does **not** need to be `crossOriginIsolated`: there are no threads
and no `SharedArrayBuffer`. Nothing is fetched from anywhere but
`/packs/scala/`. The worker imports `scalac.js` through a blob URL so that its
download can report progress.

## How it is built

`./build.sh` took about **6.5 minutes from scratch** for the language server
alone, and **13 minutes** for a clean sbt build with the runner's parts, on
this 4-core machine while other builds ran (the load varied, so most of the
difference is the load). Most of it is sbt compiling the ~600 compiler sources
to Scala.js IR (~3–4 min), then the linker (~45 s) and brotli. Downloads come
on top on a first run: sbt (pinned tgz with sha256), the scala3 sources (a
sparse clone, commit-checked), and the jars (sha256-checked). A rebuild with
the cache warm takes about 40 seconds to 1.5 minutes. It needs git, curl, unzip, patch,
node and npm (esbuild), and a JDK 17+ to run sbt and the stripper (not the
JDK whose API is shipped: that one is the pinned Temurin). The cache is `$PACK_CACHE/scala`, about 750 MB, mostly
sbt/coursier.

1. `scripts/prepare-upstream.sh` copies `compiler/src` and `tasty/src` from
   the checkout, adds the `scalajs-ir` 1.19.0 sources renamed to
   `dotty.tools.sjs.ir` exactly as upstream's own build does, and applies
   `patches/scala3-3.7.4-browser.patch`.
2. sbt (`compiler-js/build.sbt`) compiles all of it, the compiler with its
   own flags (`-Yexplicit-nulls -source 3.3`), plus `ScalaService.scala`, with
   Scala 3.7.4's Scala.js backend. The Scala.js linker then keeps only what
   the service reaches. The JVM back end, the REPL, sbt/zinc integration and
   the profiler are compiled but never linked.
3. `compiler-js/ir-shims` gives the linker Scala.js IR for the classes that
   the reachable code names and that Scala.js's Java library lacks:
   * the Java interfaces of `scala3-interfaces` and `dotc/sbt/interfaces`.
     The compiler is type-checked against the real Java ones, because Java
     methods may be called with or without `()`; the IR is the same.
   * two `compiler-interface` enums the typer records into.
   * `java.lang.ref` on top of JavaScript `WeakRef`, and `WeakHashMap` with
     `WeakRef` keys.
   * `EnumSet`, as a hash set.
   * MD5 `MessageDigest`, which the compiler uses to shorten over-long
     generated names.
   * a path-only `java.io.File` and `java.nio.file`: the in-browser compiler
     never touches a file. Every path "does not exist", and reads and writes
     throw `IOException`.
4. `scripts/StripClasses.java` (ASM 9.8) builds `classpath.bin`. For each
   class it keeps what the type checker reads (headers, signatures,
   annotations, InnerClasses, Scala pickles) and drops method bodies, debug
   info and private members of Java classes. For classes that have TASTy it
   keeps only the `.tasty` file. The format is one big-endian u32 header
   length, a JSON index, then the bytes. `ScalaService` turns it into a
   `VirtualDirectory`, which the compiler reads through its own
   `VirtualDirectoryClassPath`. The `java.base` it reads is that of the
   pinned Temurin 21.0.8+9 (sha256-checked; only `lib/modules`,
   `lib/jrt-fs.jar` and `release` are kept in the cache, about 140 MB),
   opened as a `jrt:` file system with that `java.home`.
5. esbuild 0.25.12 (pinned in `package.json`) minifies the linked module.
   Scala.js emits ES modules without running Closure, so its output keeps
   all whitespace; esbuild only strips that and renames locals, with no
   property mangling.
6. For the runner (see [Running](#running)): sbt also links
   `compiler-js/linker` (the Scala.js linker) into `sjslinker.js` and
   compiles `compiler-js/runtime`. `scripts/sjsir-bundle.mjs` packs the IR of
   the runtime helper and of the four Scala.js library jars into `sjsir.bin`
   (same format as `classpath.bin`). `StripClasses.java` writes
   `classpath-sjs.bin`: the `scala.scalajs` API of `scalajs-library` and
   `scala3-library_sjs1`, plus the closure of `java.base` classes that
   `classpath.bin`'s JDK classes name but it lacks (810 of them:
   package-private supertypes like `AbstractStringBuilder`, and types like
   `java.security.ProtectionDomain` in member signatures). The type checker
   never asks for them; erasure and the checks after it do.
   `prepare-upstream.sh` takes `SHA1.scala` from the Scala.js build of the IR
   sources (`scalajs-ir_sjs1`), because the JVM one wraps
   `MessageDigest("SHA-1")`, which Scala.js lacks.

### The patch (126 changed lines in 26 upstream files)

Each change is marked `yukibana:` in the source. There are two patch files:
`scala3-3.7.4-browser.patch` (below) and `scala3-3.7.4-runner.patch`, which
the runner's full pipeline needs, because the phases after the typer reach
more JVM-only code (a phase is linked when it is constructed, whether it runs
or not):

* Macro annotations: the code after the "not supported" error, which ran the
  annotation through `quoted.Interpreter` (reflection, a class loader), is
  removed. A `return` before it was enough while only the typer ran, but the
  Scala.js linker follows calls in dead code too.
* `Pickler`: no executor thread for parallel pickling, no early TASTy
  output (`-Xearly-tasty-output`, sbt pipelining: files and jars), no
  `-Ytest-pickler` and best-effort output files.
* `TreePickler`: `floatToIntBits`/`doubleToLongBits` for the Raw versions,
  as the first patch does elsewhere.
* `ScalaVersion.current`: the constant `2.13.16` instead of reading
  `library.properties` through the class loader.
* `JSCodeGen` (the Scala.js back end): `toLowerCase()` without
  `java.util.Locale`, and an unbuffered output stream (Scala.js has no
  `BufferedOutputStream`; the output is in memory anyway).

The compiler the runner uses (`BrowserSJSCompiler` in `ScalaJSCompiler.scala`)
is upstream's phase list without the sbt callbacks, SemanticDB, coverage
and `GenBCode` (the JVM back end), and it overrides `phases` itself:
overriding only upstream's four phase lists would still link them, because
`InteractiveCompiler` inherits them.

The browser patch:

* **Removes what needs a JVM:**
  * Profiler: always the no-op one (JMX, threads, files).
  * Macro class loader: `null`.
  * Splicer and macro annotations: report that macros are unsupported. Only
    a transparent inline macro reaches this from the typer; the rest expand
    in the Inlining phase, which does not run here (see above).
  * Compiler plugins: none.
  * `Class.getResourceAsStream` and jar manifest reads: none.
  * `System.exit`, `Thread.dumpStack` and `java.util.logging`: replaced.
  * `JDK9Reflectors`: a constant 17.
* **Replaces reflection:**
  * `MegaPhase` asks reflection which `transformX` methods a mini phase
    overrides. The patch assumes all of them, which is still correct because
    the defaults are identities.
  * A `CheckUnused` lookup takes its existing "class not found" branch.
* **Works around missing JDK API:** `URI.toURL` becomes `new URL(uri.toString)`.
  `doubleToRawLongBits` and `floatToRawIntBits` become the canonicalising
  versions (they differ only for NaN payloads).
* **`-Xshow-phases`** no longer instantiates the full JVM `Compiler`.
* **`NoSourcePosition`** passes `outer = null` explicitly. Its default argument
  names the object being constructed: the JVM sees `null` there, but Scala.js
  would build the object again until the stack overflows.
* **Numbers keep their type.** On Scala.js every `Byte`, `Short`, `Int`,
  `Float` and `Double` is a JS number, and a type test decides by value (`3`
  "is a" `Byte`). `Constant(value: Any)` therefore typed `val x = 3` as
  `Byte`. The parser and `typedNumber` now use the typed `Constant`
  overloads, and `Constant(Any)` no longer guesses `Byte`, `Short` or `Float`.

`ScalaService` also does in its own code what upstream's `Driver.setup` and
`InteractiveDriver` do. In interactive mode, a symbol from a deleted file
stays visible in later runs. So when a file is closed, or a top-level
definition disappears, the service starts a fresh compiler universe.

## Why not Metals

Metals is the Scala LSP server, but it is a JVM application. It is built on
lsp4j and runs a build server over BSP (Bloop or sbt) as a separate process.
It downloads dependencies with coursier, and runs scalafmt and scalafix as JVM
tools. It uses threads and the file system throughout. None of that has a
browser equivalent. Its Scala 3 support
(`scala3-presentation-compiler` with mtags) is again a JVM artifact on top of
the compiler. It adds lsp4j and mtags' Java interfaces and adds no type
checking of its own. It needs the same porting done here and more, so it was
not attempted.

What was evaluated:

* **(a) The Scala 3 compiler on Scala.js.** There is no upstream build of the
  compiler for Scala.js.
  * scala/scala3 3.7.4's `project/Build.scala` has Scala.js projects only for
    the library, sandboxes and tests.
  * sjrd/dotty's `scalajs-repl-project` branch runs the JVM compiler to
    produce JS. It is not the compiler on JS.
  * The closest prior work found is `sjrd/scalajs-pres-compiler`: a 2016
    student project that ran the Scala 2.11 presentation compiler on
    Scala.js 0.6.

  This pack does that port for Scala 3.7.4. It is the option chosen.
* **(b) A JVM in the browser.**
  * CheerpJ is proprietary and loads its runtime from a third-party CDN,
    which the contract rules out.
  * TeaVM compiles bytecode ahead of time and has no runtime class loading,
    so the compiler would need the same JDK-API porting as here, on a smaller
    class library. It was not tried hands-on.
  * GraalVM's experimental Web Image back end was not tried either. It would
    produce a much larger Wasm binary of the whole compiler.

  Both were dropped once (a) worked.
* **(c) Metals mtags / the presentation compiler on (a).** Possible in
  principle with more shims (lsp4j and mtags interfaces are Java). It would
  add rename, code actions and inlay hints, but not better type checking.
  Not done.

Nothing third-party is shipped. All runtime code is upstream Scala 3, the
Scala.js runtime, and this pack's own files.

## Test

`npm install && node test.mjs` (after `./build.sh`) serves `app/static` over
http, starts `server.js` as a module worker in Chromium
(`/opt/pw-browsers/chromium`), and drives it as the app's client does. Last run (lines cut at 400 characters):

```text
PASS  initialize answers after the compiler and class path download, with progress notifications  (1052 ms, 23 progress messages, last {"label":"classpath.bin","loaded":5647106,"total":5647106}, server scala3-compiler-js (Scala 3.7.4 presentation front end))
PASS  the two-file project type-checks with no diagnostics  (1193 ms) []
PASS  Geometry.scala has no diagnostics either  []
PASS  assigning a String to an Int is a type error on that line  (2694 ms) "Found:    (\"five\" : String)\nRequired: Int" at {"start":{"line":6,"character":19},"end":{"line":6,"character":25}}
PASS  completion after `p.` offers the members of Point from Geometry.scala  (499 ms, 39 items) ["ne","->","==","canEqual","!=","ensuring","ensuring","ensuring","ensuring","productIterator","y","productArity","toString","hashCode","asInstanceOf"]
PASS  completion after `p.` lists norm among the first three items, Point's members before Any/Product ones and symbolic ones last  ["copy","norm","x","y","canEqual","equals","hashCode","productArity","productElement","productElementName","productElementNames","productIterator"]
PASS  completion after `xs.` offers List methods from the standard library  (589 ms, 213 items) map: {"label":"map","detail":"[B](f: Int => B): List[B]","kind":2,"sortText":"0map"}
PASS  hover on `norm` shows its declaration and Scaladoc  (90 ms) "```scala\ndef norm: Double\n```\n\nDistance from the origin."
PASS  hover on `map` (standard library) shows its signature  "```scala\noverride final def map[B](f: A => B): List[B]\n```"
PASS  hover on `xs` shows the inferred type List[Int]  "```scala\nval xs: List[Int]\n```"
PASS  go to definition of `Point` lands in Geometry.scala on its class name  (5 ms) [{"uri":"file:///workspace/Geometry.scala","range":{"start":{"line":3,"character":11},"end":{"line":3,"character":16}}}]
PASS  go to definition of `Util.double` lands on `def double` in Geometry.scala  [{"uri":"file:///workspace/Geometry.scala","range":{"start":{"line":8,"character":6},"end":{"line":8,"character":12}}}]
PASS  references to `norm` include its declaration and its use in Main.scala  ["Main.scala:5","Geometry.scala:5"]
PASS  prepareRename on `norm` in Main.scala offers its name  {"jsonrpc":"2.0","id":10,"result":{"range":{"start":{"line":5,"character":12},"end":{"line":5,"character":16}},"placeholder":"norm"}}
PASS  renaming `norm` to `length` edits its declaration and its use, and nothing else  ["Geometry.scala:5:6-10=length","Main.scala:5:12-16=length"]
PASS  renaming Point from its construction `Point(3, 4)` renames the class too  {"changes":{"file:///workspace/Main.scala":[{"range":{"start":{"line":3,"character":10},"end":{"line":3,"character":15}},"newText":"Vec"}],"file:///workspace/Geometry.scala":[{"range":{"start":{"line":3,"character":11},"end":{"line":3,"character":16}},"newText":"Vec"}]}}
PASS  renaming the case class Point also renames its construction in Main.scala  {"changes":{"file:///workspace/Main.scala":[{"range":{"start":{"line":3,"character":10},"end":{"line":3,"character":15}},"newText":"Vec"}],"file:///workspace/Geometry.scala":[{"range":{"start":{"line":3,"character":11},"end":{"line":3,"character":16}},"newText":"Vec"}]}}
PASS  renaming `println` is refused: it is declared in the standard library  {"jsonrpc":"2.0","id":14,"error":{"code":-32600,"message":"This symbol is declared outside the project (in the standard library) and cannot be renamed."}}
PASS  a reserved word is refused as a new name  {"code":-32602,"message":"\"val\" is not a Scala identifier"}
PASS  document symbols list Point, Point.norm, Util and Util.double  ["Point","Point.x","Point.y","Point.norm","Util","Util.double"]
PASS  signature help inside `Util.double(...)` shows its parameter  {"label":"double(v: Double): Double","documentation":"","parameters":[{"label":"v: Double"}]}
PASS  hover on `Point` shows `case class Point(x: Double, y: Double)` and its Scaladoc, not a tree dump  "```scala\ncase class Point(x: Double, y: Double)\n```\n\nA point in the plane."
PASS  hover on `Util` shows `object Util`  "```scala\nobject Util\n```"
PASS  references to the case class Point (asked from Geometry.scala) include `Point(3, 4)` in Main.scala  ["Geometry.scala:3:11","Main.scala:3:10"]
PASS  references to the case class Point (asked from Main.scala) include `Point(3, 4)` in Main.scala  ["Geometry.scala:3:11","Main.scala:3:10"]
PASS  without includeDeclaration, references to Point leave out its declaration  [{"uri":"file:///workspace/Main.scala","range":{"start":{"line":3,"character":10},"end":{"line":3,"character":15}}}]
PASS  keyword completion: `whil` offers `while`, `{ val n = 1; i` offers `if` after the symbols, `xs.fi` offers no keyword  {"whil":["while"],"i":["io","invoke","if","implicit","import","infix"],"xs.fi":[]}
PASS  after `case Re` in a match on a Color, `Color.Red` is offered (and not Color.Green)  [{"label":"Record","detail":"Record","kind":9,"sortText":"0Record"},{"label":"ReflectiveOperationException","detail":"ReflectiveOperationException","kind":9,"sortText":"0ReflectiveOperationException"},{"label":"Readable","detail":"Readable","kind":9,"sortText":"0Readable"},{"label":"Color.Red","filterText":"
PASS  `Shou` offers Shouter from package tools, with `import tools.Shouter` after the package clause  {"label":"Shouter","kind":9,"labelDetails":{"description":"tools"},"detail":"import tools.Shouter","sortText":"2Shouter","additionalTextEdits":[{"range":{"start":{"line":0,"character":12},"end":{"line":0,"character":12}},"newText":"\n\nimport tools.Shouter"}]}
PASS  a position past the end of a line answers for the end of that line  {"contents":{"kind":"markdown","value":"```scala\ncase class Point(x: Double, y: Double)\n```\n\nA point in the plane."}}
PASS  a completion request without a document or position is refused as InvalidParams  {"code":-32602,"message":"expected textDocument.uri and a position { line, character } of non-negative integers"}
PASS  deleting Geometry.scala makes Point and Util unresolved in Main.scala  ["Not found: Point - did you mean print?"]
PASS  a use of an ordinary inline macro type-checks silently (it is never expanded)  []
PASS  a use of a transparent inline macro reports, at its splice, that macros are not supported  {"range":{"start":{"line":5,"character":54},"end":{"line":5,"character":72}},"severity":1,"source":"scala3","message":"macro expansion is not supported by the in-browser Scala compiler"}
PASS  a non-Scala project file is not compiled
PASS  shutdown answers
PASS  a request after shutdown is refused as InvalidRequest  {"code":-32600,"message":"textDocument/hover after shutdown"}
PASS  the worker reported no errors  []
  [server log] Scala 3.7.4 compiler loaded in 673 ms, class path (4149 files) read in 336 ms
  [server log] checked 2 file(s) in 875 ms: 0 diagnostic(s)
  [server log] checked 2 file(s) in 2418 ms: 1 diagnostic(s)
  [server log] checked 2 file(s) in 209 ms: 1 diagnostic(s)
  [server log] checked 2 file(s) in 90 ms: 1 diagnostic(s)
  [server log] checked 2 file(s) in 82 ms: 0 diagnostic(s)
  [server log] rename norm -> length: 2 occurrence(s) in 2 file(s)
  [server log] rename Point -> Vec: 2 occurrence(s) in 2 file(s)
  [server log] rename Point -> Vec: 2 occurrence(s) in 2 file(s)
  [server log] checked 2 file(s) in 2763 ms: 3 diagnostic(s)
  [server log] checked 3 file(s) in 78 ms: 2 diagnostic(s)
  [server log] checked 4 file(s) in 67 ms: 1 diagnostic(s)
  [server log] checked 2 file(s) in 392 ms: 0 diagnostic(s)
  [server log] checked 1 file(s) in 381 ms: 1 diagnostic(s)
  [server log] checked 3 file(s) in 178 ms: 1 diagnostic(s)
  [server log] checked 3 file(s) in 78 ms: 2 diagnostic(s)
all checks passed
```

### Runner test

`node test-run.mjs` (after `./build.sh`) serves `app/static` with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, starts `runner.js` as a module
worker in Chromium and drives the contract's messages and the stdin
SharedArrayBuffer from the page. The sample project is read from
`app/src/lib/languages.ts` as it is. The first run is cold (fresh browser
profile, every file downloaded raw from localhost); the last is warm (the HTTP
disk cache, nothing fetched). Last run (output lines cut at 420 characters;
the whole test took 58 s, load average about 5):

```text
PASS  the page is cross-origin isolated (SharedArrayBuffer available)
PASS  the sample project runs as-is and prints its two lines (cold)  (3503 ms, 30.5 MB fetched: Compiling@130ms Linking@2315ms Running@3464ms exit@3503ms) stdout="Point(0,0) to Point(3,4): 5\n5\n" stderr=""
PASS  progress was reported for every download  {"classpath-sjs.bin":1392747,"sjslinker.js":2129167,"classpath.bin":5647106,"scalac.js":5575596,"sjsir.bin":15717455}
PASS  a prompt printed without a newline is visible when the program waits for input  ["First number: ","First number: Second number: "]
PASS  two lines read from stdin through the SharedArrayBuffer are summed  (3222 ms: Compiling@179ms Linking@1922ms Running@3074ms exit@3222ms) stdout="First number: Second number: Sum: 42\n" stderr=""
PASS  a type error is reported on stderr with its position, and the exit code is non-zero  (2333 ms: Compiling@195ms exit@2333ms) exit=1 stderr="Main.scala:2:16: error: Found:    (\"five\" : String)\nRequired: Int\n  val n: Int = \"five\"\n               ^\n1 error found\n"
PASS  a syntax error is reported on stderr, and the exit code is non-zero  stderr="Main.scala:2:11: error: unclosed string literal\n  println(\"unclosed\n          ^\n1 error found\n"
PASS  a program that loops forever runs until the worker is terminated, and the test goes on  (4263 ms, terminated 1 s after its first output) stdout="spinning\n"
PASS  output printed before a long computation shows during it, a partial line included  stdout="start\nworking..."
PASS  100000 printed lines arrive complete and in order, in few messages  (4424 ms) 173 messages for 588895 characters
PASS  a project of four files in folders runs, and the entry file's main is the one that runs  stdout="hello x 42\n" stderr=""
PASS  end of input (Ctrl-D) makes readLine return null  stdout="end of file\n" stderr=""
PASS  without a SharedArrayBuffer (stdin: null) readLine returns null  stdout="end of file\n" stderr=""
PASS  an exception's stack trace names Scala.js frames and has no empty frame line  stderr="Exception in thread \"main\" java.lang.IllegalStateException: boom\n    at $c_LMain$package$.boom__V\n    at $s_Lboom__main__AT__V\n"
PASS  `object Main { def main }` runs, and an uncaught exception goes to stderr with exit 1  stderr="Exception in thread \"main\" java.lang.ArrayIndexOutOfBoundsException: 3\n    at $throwArrayIndexOutOFBoundsException"
PASS  JDK API that Scala.js does not have (threads) is a link error on stderr, exit 1  stderr="link error: Referring to non-existent method constructor java.lang.Thread.<init>(java.lang.Runnable)void\nlink error:   called from Main$package$.threads()void"
PASS  a program using enums, givens, extension methods, collections, f-strings and Longs runs  stdout="Circle(1), Rect(2,3)\n3.142 6.0\n#42\n2432902008176640000\n(l,3) (o,2) (d,1)\nSome(12)\nList((3,0), (2,1), (1,2))\nUnicode: été ✓\n" stderr=""
PASS  sys.exit is not available (Scala.js has no System.exit): a link error, exit 1  stderr="link error: Referring to non-existent method static java.lang.System.exit(int)void\nlink error:   called from scala.sys.package$.exit(int)nothing"
PASS  the sample project runs again (warm: no download)  (3356 ms, 0.0 MB fetched: Compiling@125ms Linking@2179ms Running@3321ms exit@3356ms)
all checks passed
```

## Files

```text
build.sh                    the build (see above)
src/server.js               the worker: LSP over postMessage
src/runner.js               the worker that runs a program (compile, link, run)
compiler-js/                sbt project: ScalaService.scala, ScalaJSCompiler.scala,
                            ir-shims/, linker/ (Scala.js linker entry), runtime/
                            (standard streams of a running program), build.sbt
patches/                    the upstream patches (browser, runner)
scripts/                    prepare-upstream.sh, StripClasses.java, jdk-packages.txt,
                            sjsir-bundle.mjs, finish.mjs
test.mjs                    the headless test of the language server
test-run.mjs                the headless test of the runner
```
