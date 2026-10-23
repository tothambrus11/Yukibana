# Kotlin pack: a syntax-level server on tree-sitter

**Server:** ours (`src/server.js`), on
[web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter) 0.25.10
(the tree-sitter runtime, compiled to WebAssembly) and the Kotlin grammar
[`@tree-sitter-grammars/tree-sitter-kotlin`](https://github.com/tree-sitter-grammars/tree-sitter-kotlin)
1.1.0, as published on npm, in one module Web Worker. It parses every
`.kt` and `.kts` file of the project and answers from the syntax trees:
syntax errors, completion, hover with KDoc, signature help, go to
definition, references, highlights and document symbols, across files.

**Runner:** none. Run and Test are not offered for Kotlin ("Why no Run").

**Syntax only.** There is no Kotlin compiler in the browser, so there are
no type errors, no inference, and nothing about the standard library's or
any library's types beyond a list of names. Names are resolved by scope and
by declared or constructed types written in the source (`val p: Point`,
`val p = Point(…)`), which covers a beginner's project and not much more.

Both packages are fetched from the npm registry, checked against its
sha512 (`build.sh`); nothing is compiled. The build takes seconds and caches
5 MB in `~/.cache/yukibana-packs/kotlin`.

## Why no Run, and why not a real server

* **The Kotlin compiler is a JVM program.** `kotlinc` (K2) runs only on a
  JVM; JetBrains publishes no build of it for JavaScript or WebAssembly.
  Kotlin/JS and Kotlin/Wasm are *targets*: they compile Kotlin to run in a
  browser, but the compiler itself stays on the JVM. Running it here would
  need a JVM in the browser:
  * **CheerpJ** runs real JVM programs, kotlinc included, but is
    proprietary (free for personal use only) and loads its runtime and JDK
    from Leaning Technologies' CDN: a static, self-hosted, offline-capable
    site cannot use it.
  * **TeaVM**, which the Java pack uses to compile javac, needs a program
    that avoids reflection, class loading and threads; kotlinc relies on all
    three (IntelliJ's platform core, `ServiceLoader`, coroutines), and is
    some 60 MB of bytecode. Not feasible, and not attempted.
  * **Doppio** is a Java 8 JVM, unmaintained since 2018.
* **The Kotlin language servers need the compiler too.** JetBrains'
  `kotlin-lsp` (2025, IntelliJ-based) and fwcd's `kotlin-language-server`
  are JVM programs built on the compiler. A remote server would break the
  pack contract: no backend.
* **Kotlin Playground** (play.kotlinlang.org) compiles on JetBrains'
  servers, the same objection.

So the honest pack is a syntax-level one: tree-sitter's Kotlin grammar is
small (3.4 MB raw, 163 KB brotli), MIT, maintained, and recovers from
errors, which an editor needs. Download still gives a Gradle build that
runs and tests the project with the real compiler.

## What is in `app/static/packs/kotlin/`

| file | raw | gzip | brotli | what |
|---|---|---|---|---|
| `tree-sitter-kotlin.wasm` | 3.44 MB | 304 KB | 163 KB | the Kotlin grammar 1.1.0, as published |
| `tree-sitter.wasm` | 205 KB | 81 KB | 66 KB | web-tree-sitter 0.25.10's runtime |
| `tree-sitter.js` | 151 KB | 31 KB | 26 KB | its loader, unchanged |
| `server.js` | 36 KB | 10 KB | 9 KB | ours: the LSP worker |
| `manifest.json`, `LICENSE-*.txt` | | | | sizes and versions; both licences (MIT) |

The language server transfers **0.26 MB** with brotli. It starts in under
0.1 s once downloaded.

## What the server does

* **Diagnostics:** tree-sitter's `ERROR` and `MISSING` nodes, as "Syntax
  error: unexpected …" or "Syntax error: missing …", source `kotlin (syntax)`. One
  mistake can make the grammar's error recovery swallow the rest of a
  block; the server reports each such region once, where it starts.
* **Completion:** after `.`, the members of a project class when the
  receiver's class is known (a parameter or property with a declared type,
  a `val` initialised with a constructor call, `this`, a class or object
  name), with its supertypes' members from the project, `Any`'s, and
  `copy` for a data class. After a receiver of any other type it offers
  nothing, and Monaco falls back to the document's words. Elsewhere: the
  names visible at the cursor (locals declared before it, parameters,
  lambda parameters and `it`, members of the enclosing class, top-level
  declarations of every file), keywords, and common standard library
  functions and types (`println`, `listOf`, `String`, …).
* **Hover:** the declaration's signature, its KDoc, and where it is.
* **Signature help** in calls of project functions and constructors.
* **Definition, references and highlights** of project declarations, by
  scope: a parameter, a local, a member through a receiver of known class,
  a top-level declaration.
* **Document symbols:** classes, objects, their properties and functions,
  top-level functions and properties, type aliases, enum entries.

## Download (Gradle)

Download writes `build.gradle.kts` (Kotlin 2.4.21, the `application`
plugin with the entry's `MainKt` class, `kotlin.test` on JUnit 5) and
`settings.gradle.kts`. `gradle run -q --console=plain` runs the program
(stdin connected) and `gradle test` runs the tests. Checked with Gradle
8.14.3 and Temurin 25: the sample prints
`Point(x=0.0, y=0.0) to Point(x=3.0, y=4.0): 5.0` and its three tests pass.

## What does not work

* **No type checking**: a type error, an unresolved name or a wrong
  argument count is not reported. Only syntax errors are.
* **No library types**: members of `String`, `List`, or any standard
  library or dependency type are not completed (the editor offers the
  document's words), and hover over them shows nothing.
* **Resolution is by name and written types**: no inference across calls
  (`val p = makePoint()` has no known class), no overload resolution, no
  extension functions on library types, no smart casts. Simple string
  template references (`"$name"`) are not found; `${…}` ones are.
* **No rename, no formatting, no quick fixes, no Run, no Test.**
* Error recovery is tree-sitter's: an unfinished construct can hide
  declarations after it until it is closed (a text fallback keeps member
  completion working for top-level `val x = Class(…)`).

## Licences

web-tree-sitter (`LICENSE-web-tree-sitter.txt`) and tree-sitter-kotlin
(`LICENSE-tree-sitter-kotlin.txt`) are MIT; both texts are copied from the
npm packages by `build.sh`.

## Building and testing

```sh
./build.sh            # into ../../app/static/packs/kotlin/
node test.mjs         # 26 checks (playwright-core: npm install, or link ../java/node_modules)
```

The app's `tests/e2e.mjs kotlin` drives the built app (no Run or Test).
