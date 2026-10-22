# Linux syscall playground (prototype)

A page where a student writes C, and the browser tab itself compiles it with
clang into a static Linux executable and runs it under an emulated Linux
system call layer, with a trace of every system call. No server runs any
code: the page is static files. The point is an OS course where students
experiment with `write`, `open`, `mmap`, `pipe`, signals and threads without
a machine to log in to.

```text
main.c --clang--> main.o --ld.lld--> a.out --Blink--> output + strace
                     musl or glibc libc.a    (all three are WebAssembly)
```

## What works

* **Compiling** C for x86-64 and AArch64 Linux, against musl 1.2.5 or glibc
  2.41, always static. Clang and lld are LLVM 21.1.8 built to WebAssembly
  with Emscripten (X86 and AArch64 backends; i386 comes free with X86).
  glibc is Debian trixie's, with gcc's `crtbeginT.o` and `libgcc`.
* **Running** the x86-64 build under [Blink](https://github.com/jart/blink),
  a user-mode x86-64 emulator that implements Linux system calls itself.
  Files live in an in-memory filesystem; stdin is the text box under the
  editor.
* **Threads.** On a cross-origin isolated page (COOP + COEP headers, which
  `test/serve.mjs` sends), the threaded Blink runs each guest thread on its
  own Web Worker, so threads really run in parallel: the data-race sample
  loses about half its increments, the mutex sample loses none.
  Elsewhere the single-threaded Blink loads and `clone()` fails.
* **Tracing**: Blink's strace, one line per call with its arguments and
  result, `[tid]` in front of calls from other threads, and the calls the
  emulator refuses (`fork() -> -ENOSYS`) in sequence.
* **Disassembly** of the student's object file (`llvm-objdump -d -r`), for
  both architectures, AT&T or Intel syntax.
* **Files** the program leaves in its working directory, shown after it
  exits.
* **Stop** for a program that never ends: the worker is terminated and a
  fresh one loads.

The samples in `web/samples.js` double as the checks: `write`, a hand-written
`syscall`/`svc`, files, `brk` and `mmap`, `errno`, reading stdin, `uname`
and clocks, `pipe`, signals, threads with and without a mutex, and `fork`
failing visibly. `test/smoke.mjs` compiles every sample for both
architectures and both C libraries and runs the x86-64 builds (146 checks);
`test/page.mjs` drives the page in headless Chromium.

## What does not, yet

* **AArch64 programs do not run.** They compile and link and can be
  disassembled or downloaded, but Blink is x86-64 only, and no AArch64
  user-mode emulator builds for the web today (Unicorn 2 has no
  interpreter backend; QEMU's linux-user has not been ported). Running
  AArch64 means a full system emulator, which is what the "Full Linux in
  the browser" work is evaluating.
* **One process.** Emscripten has no `fork`, so `fork`, `execve` and
  `wait4` return `ENOSYS`, and sockets are off. A process can signal itself
  and use a pipe with itself. `fork` would need Blink to run each process
  in its own worker with shared page tables; a full VM gets it for free.
* **stdin is given up front.** A read never waits, because waiting needs
  Asyncify or a `SharedArrayBuffer` handshake with the page; an empty pipe
  with a writer still open reads as `EAGAIN` rather than blocking forever.
* **The kernel is Blink's idea of Linux**: `uname` says
  `4.5.0-blink-1.1.0`, pid is 42, uid is 0, `/proc` is partial, and
  `rseq`/`clone3` are refused (glibc falls back by itself).
* **Contended mutexes are slow**: every futex wait and wake goes through
  Blink and Emscripten's atomics; 40 000 contended lock/unlock pairs over
  four threads take about a second.

## Size and speed

| Piece | Download |
| --- | --- |
| `llvm.wasm`: clang, lld, objdump, nm, ar, readobj | 81 MB (26 MB gzipped) |
| `blink.wasm`, `blink-mt.wasm` | 0.3 MB, 0.6 MB |
| `sysroot-<arch>-musl.tar.gz` | 0.8 MB |
| `sysroot-<arch>-gnu.tar.gz` | 6.4 to 7.3 MB |

In headless Chromium on a 4-core build machine, the first compile takes
about 0.8 s (the sysroot is unpacked then), later ones 50–300 ms for clang
and 30–80 ms for ld.lld; a hello world runs in about 20 ms.

## Running it

```bash
WORK=/big/disk ./scripts/build.sh # about two hours, once; 30 GB
node test/serve.mjs               # then open http://localhost:8080/web/
node test/smoke.mjs               # every sample, in Node
node test/page.mjs                # the page, in Chromium (needs playwright)
```

`scripts/build.sh` fetches Emscripten, LLVM, musl, Blink and Debian's glibc
packages, applies the patches in `scripts/`, and writes `dist/`. Its steps
are the ones the prototype was built with, but they ran one at a time
while it was being made; the script has not yet been run from empty in
one go. It needs
clang, lld, cmake, ninja, git, curl, python3, xz and dpkg-deb on a Linux
host. A host serving the page needs to send
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` for threads.

## Layout

* `web/toolchain.js` is the whole pipeline with no DOM: compile, link,
  disassemble, run. The page uses it in a worker, `test/smoke.mjs` in Node.
  `toolchain.tool('llvm', files, ['clang' | 'ld.lld' | 'objdump', ...])`
  runs any one tool on any files, which is how other targets (a kernel
  module, an i386 object) can be built without new code.
* `web/worker.js` downloads `dist/` with progress and answers run requests.
* `web/index.html` and `web/app.js` are the page.
* `scripts/build.sh` builds `dist/`. `llvm-no-tool-symlinks.patch` lets the
  Emscripten multicall build configure. `blink-browser.patch` makes Blink
  enter programs with `rdx = 0` as Linux does (glibc otherwise jumps to a
  string at exit), adds `kill`/`tkill`/`pipe` for a one-process guest,
  implements `FUTEX_WAIT_BITSET` (glibc's `pthread_join` spins forever
  without it), and drops waits that need Asyncify. The build also fixes
  Emscripten's pipes to report end of file once the last writer closes.

A sysroot is a gzipped ustar with `include/`, `lib/` and `res/include`
(clang's freestanding headers), unpacked at `/sys`; clang runs as
`--target=<arch>-linux-<musl|gnu> -resource-dir=/sys/res -nostdlibinc
-isystem /sys/include`.
