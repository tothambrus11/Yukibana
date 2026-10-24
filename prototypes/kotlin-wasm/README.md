# kotlinc in WebAssembly

The real Kotlin compiler, JetBrains' `kotlinc` 2.4.21 (K2), unmodified, compiled
to **WebAssembly GC** by **GraalVM Web Image** (`native-image --tool:svm-wasm`)
and running in a browser worker. It type-checks with kotlinc's own diagnostics
and compiles for three targets: JVM class files, JavaScript, and Kotlin/Wasm
for WASI. The last of these gives a runner with no server and no JVM: kotlinc
writes a small WASI module that runs in the browser with stdin.

This is a prototype next to the Kotlin pack (`../monaco-lsp/packs/kotlin`),
which is still syntax-only. That pack's README says kotlinc cannot run in a
browser. It can, and this directory shows how.

## Measured

Chromium (headless, Playwright) in a worker, on a 4-core cloud container, with
`test/web/index.html`. Node 22 gives the same numbers within 10%.

| step | first | warm |
|---|---|---|
| instantiate `kc.js.wasm` (91 MB) | 1.9 s | |
| load the libraries into the in-memory file system | 2.4 s | |
| type-check and compile `Main.kt` to class files (JVM) | 2.8 to 3.0 s | 0.28 to 0.46 s |
| the same with two errors (`Bad.kt`): diagnostics only | | 0.40 s |
| Kotlin/Wasm WASI: source to klib | 0.43 s | 0.42 s |
| Kotlin/Wasm WASI: klib to `main.wasm` (stdlib IR cache in `/cache`) | 3.6 to 4.2 s | 0.94 to 1.2 s |
| run the WASI program (642 KB) | 13 ms | |
| JS: source to klib, klib to `main.mjs` (600 KB) | 0.5 s + 5.6 s | |

For comparison, kotlinc on HotSpot (JDK 25, same machine) takes 3.8 s for a
cold compile of `Main.kt`. Ahead-of-time compilation makes the wasm build start
faster than the JVM. Warm, it is about two to three times slower than a warm
HotSpot.

Memory (node, after the run above): 345 MB of heap, 1.35 GB resident, most of
it V8's compiled code for the 91 MB module.

| file | raw | gzip | brotli (q9) |
|---|---|---|---|
| `kc.js.wasm` | 90.9 MB | 31.2 MB | **23.6 MB** |
| `kc.js` | 108 KB | | 30 KB |
| `lib/kotlin-stdlib-wasm-wasi.klib` | 11.7 MB | 3.7 MB | 2.8 MB |
| `lib/kotlin-stdlib.jar` | 4.8 MB | 1.3 MB | 0.9 MB |
| `lib/jdk-api.jar` (java.base's `java.*`) | 12.7 MB | 4.3 MB | 3.2 MB |
| `lib/kotlin-stdlib-js.klib` | 10.5 MB | 3.3 MB | 2.5 MB |

The libraries' zip entries are stored, not deflated (see "Run-time gaps"), so
their raw sizes are larger than the originals. The transfer size is the
compressed one. A pack that type-checks and runs through Kotlin/Wasm needs
`kc.js.wasm` and the wasi klib: about **26.5 MB with brotli**. That is
between the Haskell pack (33 MB) and the C++ pack.

`wasm-opt -O2` shrinks the module by 10% (21.5 MB brotli), but its output fails
at the JS boundary ("type incompatibility when transforming from/to JS"). It is
not used.

## Why the earlier conclusion was wrong

The pack's README rules out every way of running a JVM program in a browser:

* **CheerpJ:** proprietary, and loaded from Leaning Technologies' CDN. That
  is still true, and it is still ruled out.
* **TeaVM:** kotlinc needs reflection, `ServiceLoader` and about 60 MB of
  bytecode. That is also still true for TeaVM.
* **Doppio:** unmaintained.

The list missed **GraalVM Web Image**. It is the WebAssembly GC backend of
`native-image`, experimental, and part of Oracle GraalVM 25.1. It is a
closed-world AOT compiler with the full JDK class library, not a subset.
Reflection, resources and service loading work from reachability metadata,
which `native-image-agent` traces on HotSpot. That is exactly what kotlinc
needs. The Java pack's README mentions Web Image and dismisses it because "it
cannot compile itself into the browser". For the Kotlin pack that does not
matter. Web Image compiles kotlinc ahead of time, and kotlinc compiles user
code at run time.

The other ideas I checked:

* **Compiling kotlinc itself with Kotlin/JS or Kotlin/Wasm.** Not possible.
  The compiler is Kotlin *and* Java and is built on IntelliJ's platform core,
  which is Java. Neither Kotlin backend compiles Java.
* **J2CL / J2Wasm.** These compile Java source, not bytecode, and support a
  small JRE emulation. Not possible for the same reason.
* **JetBrains' Kotlin Playground.** It compiles on JetBrains' servers
  (`kotlin-compiler-server`, a Spring application) and only runs the JS or
  Wasm *output* in the page. Kotlin Notebook runs a JVM kernel. Neither runs
  the compiler in the browser.
* **A JVM in the browser** (CheerpJ, or OpenJDK's Zero interpreter under
  Emscripten or QEMU-Wasm). These would work in principle, but they
  interpret or emulate a JIT-oriented VM, so they would be far slower than
  AOT, and CheerpJ's licence rules it out.

## How it works

* `service/src/yk/KotlinService.java` is the image's entry point. `main()`
  puts an object at `globalThis.yk` (Web Image's `@JS` interop) with
  `writeFile`, `readFile`, `listFiles`, `deleteTree` and
  `compile(which, args)`. `which` is `jvm`, `js` or `wasm` (K2JVMCompiler,
  K2JSCompiler, KotlinWasmCompiler), and args are kotlinc's own, one per line.
  `compile` returns JSON with the exit code and the messages, each with
  severity, path and a 1-based start and end line and column. Files live in
  Web Image's in-memory file system (jimfs). Bytes cross the boundary as
  Latin-1 strings, one char per byte, which is the only bulk type Web Image
  converts.
* JVM compilations use `-no-jdk` with `lib/jdk-api.jar` on the classpath, the
  `java.*` class files of GraalVM's `java.base`. There is no JDK image in
  the browser.
* `test/web/worker.js` loads `kc.js` with `importScripts`, fetches the
  libraries, and answers compile requests. `test/web/index.html` drives it.
  It also runs the WASI output with a minimal WASI shim. Kotlin/Wasm's WASI
  stdlib imports only `fd_write`, `fd_read`, `poll_oneoff` and `random_get`,
  and `readln()` reads stdin through them.

### Build-time workarounds (Web Image 25.1 EA)

* **Interfaces that redeclare `equals`, `hashCode` or `toString`.** Web
  Image's single-abstract-method check counts these on `@FunctionalInterface`
  interfaces (`com.intellij.util.containers.RefHashMap$Key`, 37 more) and
  aborts. `tools/StripObjectMethods.java` drops those redeclarations from
  the jars. They change nothing at run time.
* **Unstructured locking.** Web Image has no support method for the
  `UNSTRUCTURED_LOCKING` bytecode exception and aborts.
  `tools/PatchWebImage.java` maps it to the `IncompatibleClassChangeError`
  one in the builder. The path only runs when monitors are misused.
* **The jline config inside `kotlin-compiler.jar`.** It names files the jar
  does not have, so the build removes it.
* **Memory.** The builder needs about 8 GB of heap. `wasm-as` then needs
  3 GB or more for the 2 GB text file, and the two together do not fit in
  16 GB. `tools/wasm-as-stub.sh` defers `wasm-as` until the builder has
  exited.
* **Large functions.** `-H:ImageHeapObjectsPerFunction=20000` keeps the
  image-heap initialisers under V8's 7.6 MB function size limit.

### Run-time gaps, and what fills them

* **No stack walking.** `Reflection.getCallerClass()` is null, so every
  `Atomic*FieldUpdater.newUpdater` throws, and kotlin.Lazy and IntelliJ's
  collections create updaters in static initialisers.
  `substitutions/FieldUpdaterSubstitutions.java` passes the class as its own
  caller. `tools/FindUpdaters.java` registers the fields of the 57 classes
  involved.
* **No thread CPU clock.** kotlinc's PerformanceManager enables it before
  every compilation. `substitutions/ThreadMXBeanSubstitutions.java` answers
  with wall-clock time.
* **No mmap.** `-Xuse-fast-jar-file-system=false`: kotlinc reads jars with
  `ZipFile`, and prints an info message about it.
* **No zlib.** `java.util.zip.Inflater` needs the native library, so every
  archive the compiler reads has stored entries (`build.sh`). For the same
  reason, outputs must be directories (`-d dir`, `-Xir-produce-klib-dir`),
  not jars or packed klibs.
* **Argument parsing is reflective.** All of
  `org.jetbrains.kotlin.cli.common.arguments` is registered.
* **`-kotlin-home` must name an existing directory** (`/kotlinc`). Otherwise
  kotlinc looks for itself through `PathUtil.class` as a resource.
* **Charsets.** `-H:+AddAllCharsets` covers IntelliJ's BOM detection, which
  needs UTF-32.
* **One thread.** `Thread.start()` does nothing. None of the compilations
  above needed a second thread.

## What this means for the Kotlin pack

* **Diagnostics:** real now, at 0.3 to 0.5 s per check once warm. That is
  fast enough to run on every edit after a debounce.
* **Run and Test:** two routes.
  1. **Kotlin/Wasm for WASI (shown here).** kotlinc produces a WASI module
     that runs in a worker with a terminal on stdin and stdout. Numbers
     print as on the JVM (`0.0`, unlike Kotlin/JS's `0`). The catch is that
     the program uses Kotlin's common standard library: no `java.*` (no
     `Scanner`, no `java.io.File`). For consistency, the editor should then
     type-check against the wasi klib too (`compile("wasm", …)`), not the JVM
     classpath. `kotlin.test` for wasm-wasi is a separate klib on Maven
     Central (`kotlin-test-wasm-wasi`) that this prototype does not fetch yet.
  2. **JVM class files, linked by the Java pack's TeaVM-in-the-browser.**
     This keeps JVM semantics and `java.*`, within TeaVM's class library.
     That link step belongs to the Java pack, and I have not tried it with
     kotlin-stdlib.
* **Language features beyond diagnostics** (completion, hover, definition)
  need the compiler's analysis, not just its CLI. They could be built in Java
  on FIR inside this same image, the way the Java pack's
  `LanguageService.java` works on javac's trees, and exposed next to
  `compile`.
* **Toolchain risk.** Web Image is experimental, and the build pins an Oracle
  GraalVM *early-access* build, whose terms say it is not for production.
  The Web Image source is open (oracle/graal, `web-image/`, GPLv2 with the
  Classpath Exception), so a release build could use a GraalVM built from
  source, or Oracle GraalVM 25.1 once it ships under its usual free terms.
  Both builder bugs above should go upstream.

## Building and testing

```sh
./build.sh                                                   # into dist/, about 15 min the first time
node --experimental-wasm-exnref test/run-node.mjs dist test/demo
node test/browser.mjs dist                                   # playwright from the global node_modules
```

`build.sh` pins and checks GraalVM `jdk-25e1-25.0.3-ea.32`, binaryen 133 and
kotlinc 2.4.21 by sha256, and caches them in `~/.cache/yukibana-kotlin-wasm`.
The image takes about 5 minutes to build, with a peak of about 10 GB.
`config/traced-reachability-metadata.json` is the tracing agent's output for
the compilations `test/run-node.mjs` makes. Delete it to trace again.
