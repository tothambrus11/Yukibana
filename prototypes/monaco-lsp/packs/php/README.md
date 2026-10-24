# PHP pack: Phpactor on PHP 8.4 in WebAssembly

**Server:** [Phpactor](https://github.com/phpactor/phpactor) 2026.10.07.0,
the real one, from its release phar, run by **PHP 8.4.25 compiled to
WebAssembly** (WordPress Playground's
[`@php-wasm/web-8-4`](https://www.npmjs.com/package/@php-wasm/web-8-4)
3.1.60, the Asyncify build) in one module Web Worker. Phpactor is a PHP
program that speaks LSP over stdio; `server.js` feeds its stdin from
`postMessage` and parses its stdout back into messages. No file of
Phpactor is changed: three of its classes are replaced (one of them by a
copy of upstream's with one method changed) and two functions are defined
around them, and `server.js` adds keywords to its completions (below).

**Runner:** the same `php.wasm` running its own CLI SAPI, `php main.php`,
in a second worker; **Test** runs **PHPUnit 12.5.40** from its own phar over
`tests/`.

Everything is a pinned upstream release checked by sha256 (`build.sh`);
nothing is compiled. The build needs curl, tar, node and a PHP CLI (any PHP 8
with the phar extension, to unpack the phars) and takes about 4 minutes the
first time, nearly all of it brotli on the 20 MB wasm (cached afterwards by
hash, so a rebuild takes 1 to 2 minutes).

## Why these

* **PHP runtime.** WordPress Playground's php-wasm is the maintained build
  of current PHP for browsers, with the extensions Phpactor and PHPUnit
  need (dom, mbstring, tokenizer, phar, xml, xmlwriter, ctype, json...) and
  a CLI SAPI (`run_cli`) with argv, stdin and stdout hooks. Its loader is
  used directly (`php.mjs`, the package's `asyncify/php_8_4.js` unchanged):
  `@php-wasm/universal`, Playground's web-server layer, is not needed to
  run `php <args>`. The **Asyncify** build is used, not the JSPI one, so it
  runs in every current browser, and because Asyncify is what lets the
  language server wait for input without blocking the worker (below).
  seanmorris/php-wasm was the alternative; Playground's build is newer and
  ships PHP 8.4 with the CLI SAPI. There is no smaller build of PHP 8.4
  with dom and the CLI: a custom Emscripten build with only the needed
  extensions could be about half the size, at the price of compiling PHP
  and libxml2 here.
* **Language server.** Phpactor is MIT, written in PHP, and runs unmodified
  on php-wasm. Intelephense is not an option: its licence does not allow
  redistributing it. Psalm's and PHPStan's language servers are PHP too,
  but are analysers first (no completion worth the name, no rename);
  Phpactor's own diagnostics cover the common errors.
* **Tests.** PHPUnit is what PHP projects use; its phar runs on php-wasm as
  it is.

## What is in `app/static/packs/php/`

| file | raw | gzip | brotli | what |
|---|---|---|---|---|
| `php.wasm` | 19.95 MB | 7.73 MB | 5.55 MB | PHP 8.4.25 (Playground's Asyncify build), shared by both workers |
| `php.mjs` | 271 KB | 61 KB | 51 KB | its Emscripten loader, unchanged |
| `php.js` | 7 KB | 3 KB | 2 KB | ours: start PHP, run the CLI, unpack a tar |
| `server.js` | 15 KB | 6 KB | 5 KB | ours: the LSP worker |
| `phpactor.tar` | 26.0 MB | 2.81 MB | 1.93 MB | Phpactor, trimmed stubs, PHPUnit's `Framework/` source, the prebuilt index, our PHP files |
| `runner.js` | 6 KB | 2 KB | 2 KB | ours: the Run/Test worker |
| `phpunit.phar` | 6.36 MB | 864 KB | 632 KB | PHPUnit 12.5.40, fetched only by Test |
| `autoload.php` | 3 KB | 1 KB | 1 KB | ours: Test's class-map autoloader |
| `LICENSE-*.txt`, `phpactor-packages.txt` | | | | licences (below) |

The language server transfers **7.5 MB** with brotli (10.6 MB gzip, 46 MB
raw from a host that compresses nothing). Run then needs only `runner.js`:
`php.wasm` and its loader are the same URLs, already cached. Test adds
`phpunit.phar`, 0.6 MB. A Run before the server has loaded downloads
`php.wasm` itself (5.6 MB).

`phpactor.tar` is the phar's files unpacked: a phar compresses each file
on its own, so the phar itself is 4.5 MB even with brotli, while one tar of
its files compresses as a whole (2.3 MB with every stub, 1.5 MB trimmed as
below, 1.9 MB with PHPUnit's source and the index added). Inside it:

* **phpstorm-stubs only for the extensions php.wasm has** (Core, standard,
  SPL, date, pcre, json, mbstring, dom and 25 more; the list is in
  `build.sh`, from `get_loaded_extensions()`): 93 of 559 files. Stubs of
  extensions the runtime does not have would offer functions that fail
  when the program runs.
* **PHPUnit's `Framework/` source** (256 files, from the phar the runner
  uses), indexed as stubs, so `extends TestCase`, `$this->assertSame` and
  `#[DataProvider]` resolve, complete and hover in tests.
* **Phpactor's index of both, built at build time** (`scripts/build-index.mjs`
  runs `phpactor index:build` with this php.wasm in Node, with the same
  paths and configuration). Indexing those 349 files takes about 10 s of
  CPU in the browser, at every start. With the index shipped, the server
  indexes only the project: `test.mjs` gets the `initialize` answer 1 to
  2 s after starting the worker (local server, raw files), the app shows
  the server running after 3 to 5 s. The tar's files carry a fixed time older
  than the index (Phpactor re-reads files whose ctime is newer), which
  `untar` in `php.js` sets.

`crossOriginIsolated` is **not** required by the server. The runner needs it
only for input (the contract's SharedArrayBuffer); without it, reading stdin
is end of file.

## How the server works, and what is ours

* **stdin without blocking.** Phpactor's event loop (amphp) polls stdin. A
  read with nothing queued returns no bytes (EAGAIN), as a non-blocking pipe
  would; when the loop then waits in `select()` or sleeps, the Asyncify
  build suspends PHP and returns to the worker's event loop, so `onmessage`
  runs and queues the next message. Measured idle cost: about 20 polls and
  2% of one core while nothing happens.
* **The project is mirrored into `/workspace`** (PHP's in-memory file
  system), because Phpactor's indexer and class locators read files from
  disk: `didOpen`/`didChange` write the file, a deleted file is removed.
  Only `.php`, `.phtml` and `.inc` documents reach Phpactor; a README would
  otherwise be checked as PHP.
* **`src/phpactor.php` starts Phpactor instead of `bin/phpactor`.** That
  script refuses to run without ext-posix, which php-wasm lacks; Phpactor
  itself only calls `posix_getuid` (to name a cache folder) and
  `posix_getpid` (in logs) on the language server's paths, so those two are
  defined. It also passes the configuration: diagnostics and code actions
  in this process instead of a `phpactor` child process per document (there
  are no processes), file changes from the client instead of inotify or
  `find`, the stub paths above, and diagnostics 500 ms after the last edit
  (upstream: 1 s).
* **`src/lint.php` replaces Phpactor's `PhpLinter`**, which pipes the
  document into a `php -l` child process. The replacement asks the PHP that
  runs Phpactor: `token_get_all($code, TOKEN_PARSE)` is PHP 8.4's own
  parser and throws the same parse error `php -l` prints. What `php -l`
  also reports and this does not: errors PHP finds only while compiling
  (`Cannot redeclare`, `Cannot use [] for reading`, `break` outside a
  loop); they appear when the program runs.
* **`src/rename.php` replaces Phpactor's `ClassToFileNameToUriConverter`**,
  which names the file a renamed class will live in. Upstream finds it only
  through Composer's autoloader (or a file already named after the class),
  so every class rename failed with "There are no file path candidates".
  The replacement falls back to where PSR-4 would put the class, and
  `server.js` drops the file move Phpactor then adds to the edit (the
  editor cannot move files in a rename, and `geometry.php` holds more than
  `Point`): the class is renamed in every file and its file keeps its name.
  A Composer map was the other way, and the worse one: the same map decides
  which class a file should declare, so every file not laid out as PSR-4
  would get "Class name should probably be …" (rename.php has the details).
* **Signature help for `use function` imports.** Phpactor's
  `WorseSignatureHelper` looks a called function up by the name as written
  (`distance`, not `Geometry\distance`). `build.sh` writes a copy with that
  one method changed to resolve the name as PHP does
  (`scripts/patch-signature-helper.php`, which fails the build if
  upstream's method has changed), and `phpactor.php` loads it in place of
  upstream's.
* **Keywords.** Phpactor completes `class`, `function`… at the start of a
  statement and visibility in a class body, but not `while`, `return`,
  `foreach`, `match`… `server.js` adds those to its completion answers where
  PHP code is typed outside a class body (not in HTML, a string or a
  comment, and not after `->`, `::`, `$` or `\`), by a scan of the text,
  once a letter is typed.
* **Every file is checked when the project opens.** Phpactor's diagnostics
  engine keeps one waiting document, and each new one replaces it, so of
  the app's initial `didOpen` of every file only the last would be checked.
  Until the first edit, `server.js` sends each file opened again (as a
  `didChange` with the same text) whenever Phpactor has been quiet for
  1.5 s. After the first edit it stops, since a re-check could replace the
  edited file's; a file not reached by then is checked when it is edited.

## What works

`test.mjs` checks, in Chromium, the way the app starts the worker:
diagnostics (an unknown class, an unknown method, a parse error, and none
for the sample and its PHPUnit test), a class that resolves once its file is
added, completion of members and of PHP functions, hover (project doc
comments, and PHP's own documentation from phpstorm-stubs), definition
across files, references across files, document symbols, rename of a
method and of a class across files (no file moved), signature help in a
constructor call and in a call of a `use function` import, keyword
completion (`retu` → `return`, and none after `$`), a quick fix (import a
class), shutdown. Phpactor
also offers document highlight, workspace symbols, type definition,
implementation, selection ranges and its refactorings (extract method,
generate accessors...); the app uses what it supports.

Running: `test-run.mjs` checks the sample's output, two lines of input with
a prompt printed before the first, reading to end of file (Ctrl-D), parse
errors and uncaught exceptions on stderr with file and line (exit 255, as
PHP's CLI), warnings on stderr without stopping, `exit(3)`, UTF-8,
stdout/stderr order, streamed output, 100 000 lines, Stop of an infinite
loop. Test: PHPUnit over `tests/` with colours, a failing assertion (exit
1), a project class autoloaded without `require`, a project's own
`phpunit.xml` choosing its suites, and a project without tests (exit 2).

## What does not

* **No formatting.** Phpactor formats only through php-cs-fixer, a separate
  process.
* **No PHPStan or Psalm diagnostics**, which Phpactor runs as separate
  processes; its own checks are what is reported: unresolvable class and
  function names, missing methods and properties, undefined variables,
  unused imports, deprecated usages, missing return types and docblock
  tags. Wrong argument types or counts are not among them.
* **Functions cannot be renamed**: Phpactor has renamers for variables,
  members and classes, and none for functions or constants, whatever the
  configuration (prepareRename answers null, which the editor shows as
  "This element cannot be renamed").
* **A renamed class keeps its file name** (above): `Point.php` declaring
  `Pt` works, but is no longer PSR-4; rename the file in the explorer.
* **Compile-time errors** are not reported as you type (see `lint.php`).
* **PHP's extensions are Playground's**: no readline (`readline()` is
  undefined; read input with `fgets(STDIN)`), no intl (Playground loads it
  as a separate 8 MB module; not shipped), no network from a program, no
  `proc_open`, `exec` or `pcntl`. No Composer packages: a program uses only
  PHP and its own files.
* **Interactive programs** read input through the contract's
  SharedArrayBuffer, so only in a cross-origin isolated page.
* **One echo, one message.** PHP's CLI writes unbuffered, so `echo $a, "\n"`
  is two `stdout` messages; a program printing 100 000 lines sends 200 000
  (about 3 s here). Buffering would hold back the output of a program that
  then loops forever.
* **Memory** is the worker's: Phpactor uses about 60 to 90 MB of PHP heap
  for a small project.

## Download

`app/src/lib/export.ts` adds, when missing, `composer.json` (PHPUnit
`^12.5.40` in `require-dev`, `composer start` and `composer test`, and a
class map of every `.php` file outside `tests/` and `vendor/` as the
autoloader, which is what Test uses in the browser) and `phpunit.xml`
(`tests/`, with `vendor/autoload.php` as bootstrap). `app/tests/export.mjs`
checks them with native PHP 8.3 and Composer 2: `php main.php`, `composer
validate`, `composer update --dry-run` (resolves PHPUnit 12 from
Packagist), `composer dump-autoload`, and PHPUnit run through
`phpunit.xml`, including a test that uses a project class without
requiring it. `composer install` itself is not run there: without a GitHub
token, Composer clones PHPUnit's dependencies with their full histories
instead of downloading release zips, which filled this machine's disk.

## Licences

* php-wasm (Playground's build scripts and loader): GPL-2.0-or-later,
  `LICENSE-php-wasm.txt`; the source is
  [WordPress/wordpress-playground](https://github.com/WordPress/wordpress-playground),
  the npm package's version 3.1.60. PHP itself: PHP License 3.01,
  `LICENSE-php.txt`. The wasm also links libxml2, SQLite, OpenSSL, zlib,
  libzip, libpng/libjpeg (gd) and others under their own permissive
  licences (Playground's repository lists them).
* Phpactor: MIT, `LICENSE-phpactor.txt`. The phar leaves out its
  dependencies' licence files; `phpactor-packages.txt` lists every bundled
  package with version and commit (amphp, Symfony Console, Twig, Monolog...,
  all MIT or BSD). phpstorm-stubs: Apache-2.0, `LICENSE-phpstorm-stubs.txt`
  (fetched at the commit the phar bundles).
* PHPUnit and its bundled dependencies: BSD-3-Clause and others, all their
  licence files collected in `LICENSE-phpunit.txt`.

## Tests

```sh
./build.sh
npm install          # playwright-core
node test.mjs        # the language server
node test-run.mjs    # Run and Test
```
