# QEMU-Wasm for the OS course VM

A real Linux VM in the browser for the OS course: x86_64 and aarch64 guests,
several virtual CPUs, glibc, kernel modules. Everything the students run is
compiled outside the VM (by the in-browser clang) and dropped in over 9p.
The emulator is [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm), QEMU
8.2 with a TCG backend that turns hot translation blocks into WebAssembly
modules. This directory holds our fixes to that backend, the scripts that build
it without Docker, and the tests that caught the bugs.

## The bugs, and what was fixed

`patches/0001-*.patch` applies to ktock/qemu-wasm at `patches/BASE`. We build
with emscripten 6.0.13 instead of the 3.1.50 that qemu-wasm pins, which fixes
the freeze in the last row.
The patch fixes the Wasm backend in `tcg/wasm32/tcg-target.c.inc`, in
code that runs only after a block has executed 1500 times and is compiled to
Wasm. Until then, the TCI interpreter runs the block correctly, which is why
each bug shows up only some of the time.

| Bug | Effect in a guest | Caught by |
| --- | --- | --- |
| `add2_i32` / `sub2_i32` took the carry from a 64-bit add of the low halves instead of bit 32 | AArch64 `adds`/`cmn` on W registers set the wrong C flag, so the kernel's `vsnprintf` stopped recognising digits: `unsupported %1 in format string`, printk lines without timestamps, `/proc/uptime` reading `9.s` | Verbose boot log; `alutest.c` category 0 |
| `mulu2_i32` / `muls2_i32` did not zero/sign-extend their operands | x86 32-bit `imul` of negative numbers gave the wrong EDX and CF/OF | `alutest.c` category 2 |
| `extract_i32` / `sextract_i32` used 32-bit shift amounts with 64-bit shifts | Bits above `pos + len` leaked in; AArch64 `fcvt` read `FPCR.AHP` together with `FPSR.NZCV` | `alutest.c` category 4 |
| `clz_i32` / `ctz_i32` tested all 64 bits for zero | Wrong result for a zero input with a dirty upper half | Code audit |
| `sub2_i64` and `ctpop_i32` pushed an i32 where an i64 belongs | The module fails validation inside a vCPU thread | Code audit |
| emscripten 3.1.50's `emscripten_proxy_finish` signalled the waiter after unlocking (fixed in 5.0.5 by emscripten-core/emscripten#26582) | The whole VM froze about once in 20 boots on either architecture | Worker stacks over the DevTools protocol, then a bounded wait that logged the lost wakeup |

The freeze is not in QEMU. QEMU's main loop calls `poll` about 5000 times a
second, and each call is proxied synchronously to the page's main thread
(xterm-pty's stdin and emscripten's pipe file system live there). The caller
waits on a condition variable inside a context on its own stack. The page
thread set the state to done, unlocked the mutex, and only then signalled. In
that gap the caller could see "done" without waiting, return, and start the
next call in the same stack slot, so the late signal hit the new call's
condition variable and its wakeup was lost. Emscripten 5.0.5 moved the signal
inside the lock.

Building with a current emscripten needs a few changes, all in
`scripts/build-*.sh`: link-only `-s` flags go to the linker, `-DEMSCRIPTEN` is
defined by hand (qemu-wasm tests that macro, which emscripten no longer
defines, and without it the Wasm JIT compiles out), and glib's `gsize`
(`unsigned int`) no longer matches `size_t` (`unsigned long`) by name. There is
no separate `.worker.js` any more: the pthread workers load `qemu-system-<arch>`
itself, so `web/` serves it under that name.

## Layout

- `scripts/build-deps.sh` builds zlib, libffi, glib and pixman with emscripten
  6.0.13. It is a native port of the Dockerfile stages.
- `scripts/build-qemu.sh` clones the base, applies the patches, and builds
  `qemu-system-aarch64` and `qemu-system-x86_64` into `web/<arch>/`. Both builds
  have virtfs and no debug info: about 18 MB and 12 MB raw, against 66 MB
  and 41 MB for the published demo builds.
- `scripts/build-kernels.sh` builds Linux 6.12 LTS for both architectures with
  `LLVM=1`, from `tinyconfig` plus `guest/kernel-*.config`.
- `scripts/build-guest.sh` builds the test programs and module on the host,
  then packs the initramfs images.
- `scripts/test.sh` runs both tests in headless Chromium for each architecture:
  - `alu`: `guest/alutest.c` must print the same checksums as
    `guest/alutest-expected.txt`. These are the checksums from native x86_64 and
    from qemu-user aarch64.
  - `stress`: insmod/rmmod and a 4-thread race, repeated. The run must finish,
    and no printk line may lose its timestamp.
- `web/` holds the test page (`index.html?arch=&smp=&verbose=&share=`), a
  static server with the COOP/COEP headers that SharedArrayBuffer needs, and
  the Playwright driver.

```sh
source /path/to/emsdk/emsdk_env.sh      # emsdk 6.0.13 (5.0.5 or later)
./scripts/build-deps.sh && ./scripts/build-qemu.sh
./scripts/build-kernels.sh && ./scripts/build-guest.sh
./scripts/test.sh
```

## Still open

- An idle VM still costs most of a core (8 s of browser CPU per 10 s idle,
  both architectures). With 3.1.50 this was the main loop spinning because
  `poll` ignored its timeout; 6.0.13 honours it, and the remaining cost has not
  been traced yet.
- No gdb connection to QEMU's gdbstub from the browser yet.
