# Java pack: javac and TeaVM in WebAssembly

**Server:** **javac** from OpenJDK 25u (`jdk.compiler`, the real one, at
jdk25u `6c48f4ed707b`), compiled to **WebAssembly GC** by **TeaVM 0.16.0**
with [teavm-javac](https://github.com/konsoletyper/teavm-javac) (TeaVM's
author's project, at `208d4c97a602`, 2026-10-05), in one module Web Worker.
javac parses, attributes and flow-analyses every `.java` file of the project
together; `LanguageService.java` (ours, in `compiler/`) answers completion
(enum constants after `case` included), hover, definition, type
definition, references, highlights, symbols, rename, signature help and
the import quick fix from javac's attributed trees, and `server.js` speaks LSP around it.
Diagnostics are javac's own, with types by their simple names as `javac`
prints them on the command line.

**Runner:** the same `compiler.wasm`. Run compiles the project with javac,
then links the class files with **TeaVM itself**, in the browser, into a
new WebAssembly GC module, and runs that in a second worker with a terminal
on `System.in`/`System.out`/`System.err`. **Test** does the same with the
project's JUnit Jupiter tests and prints a report shaped (and coloured) like
JUnit's console launcher.

Everything is pinned (`build.sh`): the teavm-javac commit, the jdk25u
revision, the Temurin JDK 25.0.5+8 that builds it, the JUnit jars and ASM's
sources (for its licence) by sha256. The first build takes about 10 minutes
(Gradle, then TeaVM compiling javac with 4 GB of heap) and leaves about
830 MB in `~/.cache/yukibana-packs/java` (JDK 300 MB, Gradle's home 310 MB,
the teavm-javac tree 210 MB). A rebuild with nothing changed takes about
20 seconds: the stamp is a checksum of the pins, the patch and our Java
sources.

## Why these

A Java pack needs a Java compiler that runs in a browser, and a way to run
what it produces. The options, as of October 2026:

* **teavm-javac (chosen).** javac compiled to WebAssembly GC by TeaVM, plus
  TeaVM compiled the same way, so the browser compiles Java *and* links it
  to WebAssembly with no server. Apache-2.0, maintained by TeaVM's author,
  javac from current OpenJDK (Java 25 language level: records, sealed types,
  pattern switches, text blocks, compact source files). The price is
  TeaVM's class library, a subset of the JDK's (below), and WebAssembly GC,
  which every current browser has (Chrome 119, Firefox 120, Safari 18.2).
* **CheerpJ.** A full JVM (OpenJDK's class library, real `javac` from a JDK
  image) in the browser. Proprietary: free for personal use only, and the
  runtime and JDK image are loaded from Leaning Technologies' CDN, which a
  self-hosted, offline-capable static site cannot depend on. Not used.
* **Doppio.** A JVM in JavaScript; unmaintained since 2018, Java 8 only.
* **GraalVM Web Image** (native-image to WebAssembly). Compiles ahead of
  time on a JVM; it cannot compile itself into the browser, so it could
  build the server but not run user code. Still experimental.
* **ECJ (Eclipse's compiler) or Eclipse JDT LS.** JDT LS is an OSGi
  application that needs a JVM; ECJ alone could be compiled with TeaVM as
  javac is, but javac gives the diagnostics `javac`, Maven and Gradle give,
  and teavm-javac already builds it.
* **java-language-server** (georgewfraser). Itself built on javac's API,
  but a JVM program with a JVM launcher; its features are what
  LanguageService.java does here with the same API.
* **TeaVM's own JS backend.** Runs too, but WebAssembly GC is TeaVM's
  current backend and is faster; teavm-javac targets it.

## What is in `app/static/packs/java/`

| file | raw | gzip | brotli | what |
|---|---|---|---|---|
| `compiler.wasm` | 5.85 MB | 2.11 MB | 1.46 MB | javac + TeaVM + ASM + ours, one WebAssembly GC module |
| `teavm-runtime.js` | 16 KB | 6 KB | 5 KB | TeaVM's loader for WebAssembly GC modules (this one and every program it builds) |
| `classlib-javac.bin` | 218 KB | 217 KB | 217 KB | the class library's API, what javac compiles against (a zip) |
| `classlib-teavm.bin` | 2.37 MB | 2.33 MB | 2.32 MB | the class library TeaVM links programs with, `classlib/` included (a zip) |
| `junit.jar` | 383 KB | 345 KB | 338 KB | JUnit Jupiter API 5.14.4, Platform Commons 1.14.4, opentest4j 1.3.0, apiguardian 1.1.2: class files only |
| `server.js` | 19 KB | 6 KB | 5 KB | ours: the LSP worker |
| `runner.js` | 28 KB | 9 KB | 8 KB | ours: the Run / Test worker |
| `manifest.json`, `LICENSE-*.txt` | | | | sizes and versions; licences (below) |

The language server transfers **2.0 MB** with brotli (`compiler.wasm`,
`classlib-javac.bin`, `junit.jar` so tests type check, the two scripts).
Run adds `classlib-teavm.bin` and `runner.js`, **2.3 MB**; the rest are the
same URLs, already cached. A cold Run before the server has loaded fetches
8.9 MB raw (4.4 MB brotli). The `.bin` files are zips, so they do not
compress further.

## Measured

Headless Chromium on a 4-core x86-64 Linux container (`test.mjs`,
`test-run.mjs`):

* Server: `initialize` answers in 0.3 to 2 s (download, then javac starts);
  a full check of a two-file project 0.3 to 0.4 s; completion 10 to 30 ms;
  hover and definition a few ms.
* Run of the sample: javac 0.1 to 0.2 s, TeaVM 2 s, 65 KB of WebAssembly,
  2.7 s from Run to exit, cold or warm. A larger program (streams,
  BigInteger, collections) links in 4 to 5 s into 850 KB.
* Test of the sample's three tests: 6.5 s (TeaVM links JUnit's assertions:
  830 KB).
* Output: 100,000 printed lines (589,000 characters) arrive in about 190
  messages in 1.5 s.

## What we changed

`teavm-javac.patch` (upstream files), `compiler/` (our Java, built into
`compiler.wasm`) and `classlib/` (our class library classes, merged into both
`.bin` files):

* **The language service** (`compiler/LanguageService.java`, `Json.java`):
  upstream has none; teavm-javac only compiles. `CompilerLib` exports it.
* **Entry points** (`compiler/EntryPoints.java`): which `main` the `java`
  launcher of Java 25 would call (JEP 512: `static` or not, with or without
  `String[]`), and the JUnit tests; the generated launcher class is written
  with ASM.
* **Division by zero** (`compiler/DivisionChecks.java`,
  `classlib/.../impl/CheckedDivision.java`): TeaVM's WebAssembly GC backend
  compiles `int`/`long` `/` and `%` to WebAssembly's instructions, which
  *trap* on zero. A TeaVM plugin rewrites each one into a call that throws
  `ArithmeticException("/ by zero")`. It is in `compiler.wasm` too, because
  javac's own constant folder relies on catching it (`1 / 0` in a source
  file crashed the compiler before).
* **Strict mode** (`compiler/build.gradle`): TeaVM's null and array bounds
  checks are on in `compiler.wasm`, so a javac bug is an exception rather
  than memory corruption, and on in every program Run builds.
* **Class library** (`classlib/`): `System.in` from the terminal
  (`TConsoleInputStream`), `System.exit` (`TRuntime`), `System.out` flushing
  a partial line to the terminal (`TSystem`, so a prompt or a progress dot
  shows while the program computes), `java.util.Scanner` and
  `InputMismatchException` (TeaVM has none), `java.lang.IO` (Java 25),
  `Formatter` with `%n`, `%e`/`%E` and `%%` that no longer consume an
  argument, `@SuppressWarnings("…")` and `@Deprecated(since, forRemoval)`
  with their elements (javac rejected both).
* **StdlibConverter**: TeaVM's `TAnnotation` implements `Annotation`, which
  after renaming made `java.lang.annotation.Annotation` extend itself:
  any annotation with a value (`@Disabled("why")`) sent javac into infinite
  recursion. The converter drops the self-reference.
* **Locale and plugin order** in `Compiler.java`, and the build reading
  `classlib/` (a `yukibanaClasslib` source set).

## Exceptions

Exceptions are Java's: `try`/`catch`, `finally`, an uncaught exception
prints `Exception in thread "main" <class>: <message>` on stderr and exits
with 1, as `java` does. What differs:

* **No stack frames.** TeaVM's WebAssembly GC backend records no Java frames
  (its frames read `Throwable$FakeClass.fakeMethod`); the runner filters
  those lines, so a trace is the exception's own line.
  TeaVM's deobfuscator (`teavm-wasm-gc-deobfuscator` 0.16.0) needs a debug
  build and returned no frames for ours; it is not shipped.
* **Array index out of bounds is a trap**, not a catchable exception: the
  run ends and the runner names it `ArrayIndexOutOfBoundsException`, saying
  it was not catchable. The same goes for a failed cast
  (`ClassCastException`) where TeaVM emits a WebAssembly cast. Null
  dereferences and stack overflow *are* Java exceptions.
* Integer division by zero is an `ArithmeticException`, as above.

## Tests

Test compiles `src/test/java/` (or `tests/`) with the main sources and
`junit.jar`, and runs every method annotated `@Test`, with `@BeforeAll`,
`@BeforeEach`, `@AfterEach`, `@AfterAll`, `@DisplayName` and `@Disabled`.
Assertions are JUnit's own classes (`Assertions`, `assertThrows`,
opentest4j's `AssertionFailedError` messages). The JUnit
Platform itself is not used: it finds and calls tests by reflection, which
TeaVM does not have, so the runner generates a class per package that
calls each test directly (package-private test classes and methods, JUnit's
usual style, need the caller in their package), and a main class in the
unnamed package that calls those: test classes without a `package`
declaration work too (until this was fixed, the main class was in a named
package, which cannot refer to the unnamed one, and such a project's Test
failed with "The generated test runner did not compile"). Therefore **`@ParameterizedTest`, `@RepeatedTest`,
`@TestFactory`, test methods with parameters, and `static` or
`private` `@Test` methods are reported as skipped**, "not supported here".
The report is the console launcher's tree (`✔`, `✘`, `↷`) and summary, in
its colours.

### Property-based tests: not available

No Java property-based testing library links under TeaVM without changing
it or replacing its entry points. What was tried and why each fails:

* **jqwik** (the maintained one) is a JUnit Platform test engine: it finds
  `@Property` methods, their parameters and their `@ForAll` generators by
  reflection and runs them through the Platform's launcher. TeaVM has no
  reflection and this runner does not use the Platform (above).
* **junit-quickcheck** is a JUnit 4 runner that resolves a generator for
  each parameter type by reflection: the same two problems.
* **QuickTheories 0.26** is a plain API (`qt().forAll(integers().all())
  .check(i -> ...)`), with shrinking, and was tried: merged into
  `junit.jar`, a two-property test compiles with javac and then fails to
  link: `error: Method is not annotated with {{c0}}` (TeaVM's message for a
  native method with no WebAssembly `@Import`). The method is
  `java.util.ServiceLoader.load`: `qt()` builds its default strategy
  through `Configuration.pickGuidance()`, which looks up an optional
  coverage-guidance plugin with `ServiceLoader`, and a one-line program
  calling `ServiceLoader.load(Runnable.class)` fails with the same error.
  Building a `Strategy` by hand avoids that path, but then `qt()`, the
  library's entry point, would not work, and the tests would not run
  unchanged with Maven.
* **vavr-test** (with vavr, about 1 MB) does not shrink: a failure
  reports the random value it happened on, so it was not tried.

### Mutation testing: not available

PIT (pitest), the Java mutation tester, mutates bytecode in a JVM and runs
each mutant's tests in child JVMs ("minions") that it drives over a
socket, through the JUnit Platform with a coverage agent attached. None of
those exist here: one TeaVM-compiled WebAssembly module per run, no class
loading, no agents, no processes. Each mutant would also be a full TeaVM
link (2 to 4 s for the sample). There is no other existing tool.

## Download (Maven)

Download writes a `pom.xml` (Java 25, JUnit 5.14.4, maven-compiler-plugin
3.14.1, surefire 3.5.6, exec-maven-plugin 3.6.4) and a README:
`mvn -q compile exec:exec` runs the program and `mvn test` runs the tests.
A project in the standard layout (`src/main/java`, `src/test/java`) uses it
as it is; a flat one sets `sourceDirectory`. `exec:exec` starts a separate
`java`, because `exec:java` cannot call a compact source file's
package-private `void main()`. Checked with Maven 3.9 and Temurin 25: the
sample prints the same output as the browser and its three tests pass.
Input typed at a terminal reaches the program; input piped into `mvn` does
not (Maven reads it first), so `java src/main/java/geometry/Main.java <
input` is the way to pipe.

## What does not work

* **The class library is TeaVM's, not the JDK's.** Most of `java.lang`,
  `java.util` (collections, streams, `Optional`, `regex`), `java.math`,
  `java.time` (part), `java.text` (part) and `java.io` over the terminal are
  there; files (`java.nio.file`, `FileReader`), networking, threads beyond
  the main one (`Thread.start` is not useful here), reflection
  (`Class.forName`, `getDeclaredMethods`), `ServiceLoader`, `java.awt` and
  Swing are not. javac reports a missing API as a compile error (`cannot
  find symbol`), in the editor, before Run.
* **No stack frames in traces**, and out-of-bounds indexing cannot be
  caught (Exceptions, above).
* Some `Formatter` conversions beyond the ones added (`%g`, `%a`, date and
  time conversions) are TeaVM's, which may not support them.
* Cloning a primitive array (`int[].clone()`) in a program that uses the
  array type nowhere else traps in TeaVM 0.16.0.
* Tests: as listed under Tests.
* No formatting, no semantic tokens (the grammar is Monaco's), no Javadoc
  of the class library (it has none), no libraries beyond JUnit.
* The only quick fix is the import for `cannot find symbol` on a class
  (from the class library, or the project's other packages). Case labels
  complete an enum's constants, but constants already used in other labels
  are offered too. Type definition finds only the project's classes: the
  class library has no sources here.
* Run takes 2 s or more however small the program: TeaVM links the whole
  reachable class library each time.

## Licences

Shipped as `LICENSE-*.txt`, written by `scripts/licences.py` from the pinned
inputs:

* javac (OpenJDK 25u): GPL-2.0 with the Classpath Exception
  (`LICENSE-openjdk.txt`). It is compiled into `compiler.wasm`; the
  `.bin` files hold TeaVM's class library, not OpenJDK's.
* TeaVM, teavm-javac, opentest4j, apiguardian: Apache-2.0
  (`LICENSE-apache-2.0.txt`). Our `classlib/` files derived from TeaVM keep
  its header.
* JUnit 5: EPL-2.0 (`LICENSE-junit.txt`).
* ASM 9.8: BSD-3-Clause (`LICENSE-asm.txt`).

## Building and testing

```sh
./build.sh            # into ../../app/static/packs/java/
npm ci                # playwright-core, for the tests
node test.mjs         # the language server: 37 checks
node test-run.mjs     # Run and Test: 26 checks
```

Both tests use the Chromium at `/opt/pw-browsers/chromium` (or
`$CHROMIUM`). The app's `tests/e2e.mjs java` drives the built app.
