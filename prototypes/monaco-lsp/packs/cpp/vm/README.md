# Running Linux programs in the browser: QEMU-Wasm, system and user mode

This is the experience report for the C/C++ pack's Linux targets. A program compiled
for `x86_64`, `aarch64` or `riscv64` Linux (static musl ELF, by cc-cross; see
`src/targets.json`) runs in the browser under QEMU compiled to WebAssembly, in one of
two ways:

- **System emulation, the default.** `qemu-system-<arch>` boots a small Linux 6.12
  kernel. PID 1 is `vm/guest/init.c`, which runs the program and reports how it ended.
  It is a real kernel, so signals, threads on several vCPUs, `fork`, `/proc` and strace
  all behave as they would on a machine. The cost is about 2.5 MB (brotli) of download
  and 2–4 s of boot per run.
- **User emulation, experimental.** `qemu-<arch>` (linux-user) runs the ELF directly
  and translates its system calls onto Emscripten's libc. It starts in about 0.2 s and
  downloads 0.5–0.7 MB, but some things are missing because no kernel is underneath
  (see "What user mode cannot do").

Both modes are behind one function, `runLinux` in `src/vm/run-linux.js`. It is bundled
to `vm.js`, which `runner-linux.js` imports only for a Linux target. The default
(WASI) target downloads none of this.

## Results

All figures were measured on this machine: 4 cores, headless Chromium (Playwright),
files served from localhost with brotli. Other builds were running on the machine at
the same time, so the figures vary by about ±20 % between runs. The full output of each
run is in the test logs (see "How it is tested").

### Download size per use case

These are the files fetched for one run. The `.mjs` glue is included in each total.
`vm.js` adds 5.1 KB brotli (12.9 KB raw) to every use case.

| arch | mode | raw | gzip | **brotli** | files |
|---|---|---:|---:|---:|---|
| x86_64 | system | 19.99 MB | 3.49 MB | **2.65 MB** | qemu-system wasm 1.53, kernel 1.08, qboot 0.009, initrd 0.003, glue 0.034 |
| aarch64 | system | 14.96 MB | 3.98 MB | **2.88 MB** | qemu-system wasm 1.89, kernel 0.97, initrd 0.003, glue 0.034 |
| riscv64 | system | 10.94 MB | 3.33 MB | **2.55 MB** | qemu-system wasm 1.48, kernel 0.97, OpenSBI 0.062, initrd 0.003, glue 0.034 |
| x86_64 | user | 2.15 MB | 0.67 MB | **0.51 MB** | qemu wasm 0.47, glue 0.031 |
| aarch64 | user | 4.13 MB | 1.00 MB | **0.72 MB** | qemu wasm 0.69, glue 0.031 |
| riscv64 | user | 2.52 MB | 0.67 MB | **0.50 MB** | qemu wasm 0.47, glue 0.031 |
| + strace (system) | | 1.06–1.32 MB | 0.50–0.56 MB | **0.41–0.43 MB** | `vm/<arch>/strace.cpio`, fetched only when tracing |

How the size was kept down:

- **QEMU is configured with `--without-default-devices`.** Each board gets only the
  devices it uses (`devices/*.mak`): virtio-serial on virtio-mmio, plus the board's
  console UART. There is no network, block, display, USB or 9p. The published
  qemu-wasm demo builds are 41–66 MB raw; these are 8–11.5 MB.
- **The kernels start from `tinyconfig`** plus the fragments in `kconfig/`: no modules,
  no networking, no block layer, initramfs only. On x86_64 the payload is the
  uncompressed PVH `vmlinux`, which brotli compresses better than a bzImage would, and
  booting it skips the decompressor, which is slow under emulation.
- **The initrd is 3 KB** (`init` built with the kernel's nolibc).
- **strace is a separate archive**, fetched only when tracing.
- **Guest RAM is never downloaded.** QEMU allocates it at start.

### Time to first output (hello, one vCPU)

Times are in milliseconds from the worker starting. "Cold" is the first run in a fresh
browser. "Warm" is the next run, with the files in the HTTP cache. The guest boot column
is the kernel's uptime when init executed the program.

| arch | mode | cold | warm | of which guest boot | of which QEMU start + firmware |
|---|---|---:|---:|---:|---:|
| x86_64 | system | 3431 | 2854 | 2150–2440 | ~600–800 |
| aarch64 | system | 5216 | 4059–4180 | 2870–3030 | ~1000 |
| riscv64 | system | 2638 | 2188–2200 | 980–1120 | ~1000 |
| x86_64 | user | 243 | 178–198 | — | — |
| aarch64 | user | 197 | 166–199 | — | — |
| riscv64 | user | 216 | 184–189 | — | — |

These were served from localhost. Over a real network, add the download time from the
table above to the first run.

On x86_64, the boot was slow until the TSC calibration was fixed. microvm without ACPI
has no HPET or PM timer, so the kernel fell back to jiffies with 4 ms clock steps;
`tsc_early_khz=1000000 tsc=reliable` fixes that. aarch64 boots slowest because the
Cortex-A72 TCG front end is the most expensive of the three.

### CPU, threads, idle cost, memory

| | x86_64 sys | aarch64 sys | riscv64 sys | x86_64 user | aarch64 user | riscv64 user |
|---|---:|---:|---:|---:|---:|---:|
| LCG benchmark, Miter/s (native host: 620–830) | 290–397 | 66–92 | 148–187 | 172–223 | 67–70 | 106–111 |
| 4 threads, atomics + mutex, wall | 0.78–0.88 s on 4 vCPUs | 1.58–1.72 s | 0.87–1.04 s | 0.53–0.60 s on 1 CPU | 0.85–0.92 s | 0.49–0.57 s |
| browser CPU while waiting on stdin, per 3 s | 0–0.05 s | 0.04–0.05 s | 0.03–0.05 s | 0–0.04 s | 0–0.02 s | 0–0.02 s |
| browser memory added by a run (PSS) | +420 MiB | +540 MiB | +450 MiB | +140 MiB | +150 MiB | +225 MiB |
| Stop (worker.terminate) until no worker is left | ~2.0 s | ~2.0 s | ~2.0 s | ~2.0 s | ~2.0 s | ~2.0 s |

- **Threads.** The counts are exact in every case (`atomic=8000000 mutex=7816`). The
  unsynchronised counter loses updates in every case, as it should. In system mode the
  threads ran on CPUs 0–3. In user mode the guest sees one online CPU, so
  `std::thread::hardware_concurrency()` returns 1. The threads still run concurrently
  as host threads.
- **Idle.** A program blocked on stdin costs almost nothing. QEMU's `poll` on the input
  device sleeps until the app sends input; emscripten 6 honours the timeout. The guest
  kernel is tickless. On the user-mode side, the reader waits on a futex. The earlier
  research build used xterm-pty and the pipe file system on emscripten 3.1.50, and cost
  8 s of CPU per 10 s idle.
- **Memory.** System mode's figure is mostly the 256 MiB of guest RAM, which QEMU
  zeroes at start, plus the 64 MiB translation cache and Wasm code. In user mode, the
  256 MiB guest address space comes from `sbrk` and is never written up front, so only
  the pages the program touches are committed.
- **Stop.** Chromium tears down a terminated worker asynchronously. The runner worker
  and all QEMU threads are gone after about 2 s, measured through the DevTools target
  list.
- **Two caveats on these figures.** The idle check takes the steady state: a guest
  that fell behind on a loaded machine catches up on its timers for a few seconds
  after the prompt, which was seen twice while other builds ran. The benchmark varies
  by ±20 % with machine load.

## What works

**System mode** passes all 8 tests on each of the three architectures:

- arguments with spaces and non-ASCII, `argv[0]` = `main`, environment (`HOME=/`,
  `PATH`, the run's own `env`);
- isatty true on fds 0, 1 and 2;
- a prompt without a newline appears before input is requested;
- line-by-line stdin, then EOF (exit 3 propagates);
- a null dereference gives SIGSEGV, exit 139, and "Terminated by signal 11 (SIGSEGV)",
  after the program's earlier output;
- `abort()` gives exit 134;
- 4 threads on 4 vCPUs;
- strace output on its own channel, with the program's output unchanged;
- idle cost;
- Stop.

`uname -r` is the real kernel's (6.12.114). A kernel panic or reboot without init's
result gives exit 1 and a pointer to the kernel log.

**User mode** passes all 6 tests on each of the three architectures:

- arguments, environment, and isatty on fds 0–2;
- a prompt, then two lines of stdin and EOF;
- 4 threads with exact counts;
- `abort()` gives SIGABRT, exit 134, and the signal message;
- the CPU benchmark;
- idle cost and Stop.

A null dereference is a documented difference (see the next section). `strace` also
works, through QEMU's own `-strace` sent to the trace channel. Its format is QEMU's
(`42 uname(0) = 0`), which decodes arguments less than strace(1) does.

## What user mode cannot do

These gaps come from having no kernel underneath. They are why system mode is the
default.

- **No memory protection.** The guest address space is one allocation in Wasm linear
  memory, and Wasm has no page protection or fault handler. A null dereference reads 0
  and carries on, so `crash.c` exits 0 after "about to crash" instead of 139. A
  `mprotect` is accepted but enforces nothing. Stack overflow is not detected.
- **One CPU.** `sysconf(_SC_NPROCESSORS_ONLN)` and `hardware_concurrency()` return 1,
  and `sched_getcpu()` reports nothing (the threads test shows an empty CPU list on
  aarch64 and riscv64). Threads still run in parallel as Emscripten pthreads.
- **At most 31 guest threads over the whole run.** The Wasm translation-block code
  keeps per-thread slots and does not recycle them.
- **No `fork` or `exec`.** A Wasm instance cannot be cloned, so `fork`, `vfork`,
  `system()` and `posix_spawn` fail. Only `clone` for threads works.
- **`uname` reports Emscripten.** QEMU forwards `uname` to the host, which is
  Emscripten 6.0.13, so `uname -r` is "6.0.13".
- **Signals are partial.** A signal that ends the program (from `abort`, `raise` or
  `kill` of itself) gives 128+n and the message, through `wasm_host_exit_signal`.
  Handlers for synchronous faults never run, because there are no faults. On x86_64,
  QEMU builds the guest's signal frame with a misaligned stack in some cases, so a
  handler that uses SSE can crash. Use system mode for anything signal-heavy.
- **No `poll` or `select`.** fd 0 is read through `read` and `readv` on the ring buffer.
  `poll`, `ppoll`, `select` and `pselect6` are not mapped and return `ENOSYS` (on any
  fd), so programs that wait on stdin with them need system mode. fds 0–2 are terminals for `isatty` and `TIOCGWINSZ` (24×80), but there
  is no line discipline: no echo, and no ^C or ^D processing. EOF comes from the app's
  EOF.
- **No `/proc`.** `/proc/self/maps`, `/proc/cpuinfo` and similar are missing or show
  the host's view. File system calls go to Emscripten's in-memory file system, which
  has none of the guest's files except the program.
- **No core dumps.** They are disabled; one would walk the whole 256 MiB.

## Problems found and their root causes

1. **`-cpu max` crashes on x86_64.** qemu-wasm's Wasm TCG backend traps on the first
   translation block with `-cpu max`. The default `qemu64` works and is what the
   kernel is built for.
2. **The VM froze about once in 20 boots** with emscripten 3.1.50 (which qemu-wasm
   pins) and 4.0.22 (which the rest of the pack uses). `emscripten_proxy_finish`
   signalled the waiter after unlocking, so a proxied call's wakeup could be lost.
   This was fixed in emscripten 5.0.5 (emscripten-core/emscripten#26582), and the pack
   builds QEMU with 6.0.13. It is found with worker stacks over the DevTools protocol.
3. **The TCG backend gave wrong i32 results** once a block was compiled to Wasm (after
   1500 executions). The wrong ops were `add2/sub2/mulu2/muls2/extract/sextract/clz/ctz`
   on dirty upper halves, and two cases produced invalid Wasm. Symptoms were AArch64's
   `vsnprintf` not recognising digits and x86 `imul` with a wrong EDX.
   `patches/qemu-wasm-tcg.patch` has the full description.
4. **nolibc's `WIFSIGNALED` is wrong.** Linux 6.12's nolibc defines it as
   `((s) - 1 < 0xff)`, which is true for status 0, so a program that exited with 0
   looked killed by "signal 0". `init-args.h` (`yk_status_line`) decodes the wait
   status by hand, checking for an exit first. The native tests in `guest/test-init.c`
   cover real fork statuses.
5. **The build machine has no rsync,** which `make headers_install` needs.
   `build-kernel.sh` runs `make headers` and copies the tree with `cpio` instead.
6. **The user-mode warning check needs generated headers.** `wasm-host.c` is compiled
   a second time with `-Wall -Wextra -Werror`, which needs QEMU's generated headers,
   so the check runs after ninja. QEMU's own headers are treated as system headers
   (`--system-header-prefix=qemu/`).
7. **stdout can arrive before `exec`.** In system mode a short program's first stdout
   can reach the host before init's "exec" line, because each console port is its own
   virtqueue. This was seen on riscv64. The runtime starts the "Running" phase and
   stdin at whichever arrives first, and the `exec` mark's `guestMs`, not its arrival
   time, is the boot time.
8. **User-mode stdin needed a futex.** A read of fd 0 cannot be served on Emscripten's
   main runtime thread (the runner worker): it would block, and that thread serves
   every proxied file system call. The reading guest thread therefore waits with
   `emscripten_futex_wait` on a ring buffer in linear memory, and the worker fills the
   buffer from the app's stdin protocol (`Atomics.waitAsync`, with a 10 ms poll as
   fallback).
9. **User mode used to zero 512 MB up front.** The first experiment allocated guest
   memory with `malloc` + `memset` and an `INITIAL_MEMORY` of 512 MB, so every run
   committed it. The memory now comes from `sbrk`, which is fresh and already zero, and
   `INITIAL_MEMORY` is 16 MB. test-vm passes at 8, 16 and 32 MB with the same memory
   use, because growth for the guest region dominates. 16 MB leaves headroom.
10. **Input typed while a Linux program ran never reached it** (found in review).
    The runtime cannot see when the guest reads stdin (the kernel's virtio console,
    or user mode's ring, takes input whenever it arrives), so it asks for input once
    at start and again after every answer. Its first request arrived before the
    "Running" phase, and the app treated every new phase as answering the request,
    so a line typed after the program started stayed queued in the app until Stop.
    The fix is in the contract (`../CONTRACT.md`, "Standard input"): the runtime's
    requests are now `{ type: 'stdin', streaming: true }`, which the app answers with
    each line as it is typed without showing "Waiting for input" or taking focus, and
    a phase never cancels an outstanding request. `test-run-linux.mjs` checks that
    every request is a streaming one; `app/tests/e2e-targets.mjs` types a line into
    the terminal after the program printed, in both modes, on every arch.

## The patches

- **`patches/qemu-wasm-tcg.patch`** is the backend fix from item 3, on ktock/qemu-wasm
  at `QEMU_WASM_COMMIT`. `build-qemu.sh` checks its `git patch-id`. Both modes use it.
- **`patches/qemu-linux-user-wasm.patch`** makes linux-user build and run on a Wasm
  host. QEMU 8.2 has no such host, and QEMU 10 dropped 64-bit guests on 32-bit hosts.
  - `configure`, `meson.build`, `common-user/meson.build` and `gdbstub/user-target.c`
    accept `wasm32`/emscripten as a linux-user host and build `wasm-host.c`.
  - `linux-user/main.c`:
    - `main` without `envp`, using `environ`;
    - a default `-R` of 256 MiB, because the guest space is one allocation;
    - `init_wasm32()` for the main thread.
  - `syscall.c` calls `init_wasm32()` for each new guest thread, the per-thread state
    of the Wasm TB compiler.
  - `elfload.c` reserves the guest address space as one `wasm_guest_region_alloc`
    region, because Wasm has no address hints and no `MAP_FIXED`.
  - `signal.c`:
    - a fatal signal becomes `wasm_host_exit_signal` (exit 128+n, with the signal
      recorded for the runtime);
    - no core dump.
  - `tcg/wasm32.c` and `tcg-target.c.inc`:
    - user mode has no TLB, so guest loads and stores add `guest_base` after a bounds
      and alignment check, and anything else goes to the helper;
    - the per-thread vectors are sized for 32 guest threads.
  - `common-user/host/wasm32/` contains these:

    | file | what it does |
    |---|---|
    | `safe-syscall.inc.S` | empty; there is no assembly on Wasm |
    | `host-signal.h` | the minimal host signal context QEMU's signal code expects (a signal mask) |
    | `wasm-host.c` | maps the host syscall numbers linux-user issues onto Emscripten's libc |

    `wasm-host.c` covers these areas:
    - read/write/files;
    - `mmap` inside the guest region;
    - futex onto `emscripten_futex_*`;
    - `clone` onto pthreads;
    - the stdin ring (`wasm_host_stdin()`, exported, with its layout fixed by
      `QEMU_BUILD_BUG_ON`);
    - `ENOSYS` stubs for the rest.
- **`patches/compat-wasm-host-syscall.h.patch`** is the force-included header with the
  host syscall numbering (asm-generic) and the declarations above.
- **The compat headers** come from the pinned musl 1.2.5 (headers Emscripten leaves
  out) and from the pinned kernel's UAPI headers, never from the build machine's.
- **`devices/*.mak` and `kconfig/*`** are configuration, not patches (see "Download size
  per use case").

## Building

Run `./build-vm.sh`, which uses `JOBS=3` by default and `nice`. Each step is skipped when
its stamp in `$PACK_CACHE/cpp/vm-artifacts` matches its inputs (`pins.txt`, the patches,
the configs, the script itself, the compiler version).

| step | script | time here |
|---|---|---|
| emsdk 6.0.13, zlib/libffi/glib/pixman, qemu-system ×3 | `vm/build-qemu.sh` | 210 s to relink the 3 targets (the dependencies and objects came from the research caches; a from-scratch build was not timed in this session) |
| Linux 6.12.114 per arch, with clang, + UAPI headers | `vm/build-kernel.sh <arch>` | about 30 s each with existing trees |
| yk-init (nolibc), its unit tests (ASan+UBSan), clang-tidy | `vm/build-init.sh` | 4 s |
| static strace 6.12 per arch (musl) | `vm/build-strace.sh` | 220–315 s for all three |
| qemu-<arch> linux-user ×3 | `vm/build-qemu-user.sh` | 231 s configure + build; 24–41 s relink |
| layout, vm.js (esbuild), .gz/.br | `vm/stage.sh` | 112 s, mostly brotli |

- `USER_MODE=0` skips user mode, and `stage.sh` then ships no `user/`.
- `KEEP_TREES=0` deletes the kernel and QEMU build trees, about 0.6 GB.
- The caches take 2.6 GB under `$PACK_CACHE/qemu-wasm`.
- The musl sysroots for strace and the fixtures are made by `../build-targets.sh`
  (which `build.sh` runs before this) in `$PACK_CACHE/cpp/targets/sysroot/<arch>`, from
  the same SHA-256-pinned Alpine packages as the targets' `lib.tar` (musl 1.2.5-r24,
  compiler-rt 21.1.2); see `vm/cc.sh`. Every file of the sysroot is in strace's stamp.
  (Until review they came from a hand-copied `$PACK_CACHE/qemu-wasm/sysroots` that no
  script made; strace was rebuilt against the pinned sysroot.)
- These outputs were built from the research caches and are byte-identical to the
  research build: kernel, strace, firmware and qemu-system sizes all match.
- Nothing needs seeding into the app.

## How it is tested

| command | what it checks |
|---|---|
| `node test-cpio.mjs` | newc archives match GNU cpio byte for byte; the run archive layout |
| `node --test test-vm.mjs` (or `VM_ARCHES=riscv64 …`) | 8 system and 6 user tests per arch, in headless Chromium, on fixture programs in `vm/fixtures/`; prints timings, idle CPU, memory and Stop time |
| `node --test test-run-linux.mjs` | end to end through `runner.js`: cc-cross compiles, `runner-linux.js` links, `vm.js` runs |
| `vm/build-init.sh` | init's pure functions natively under ASan and UBSan, plus clang-tidy |

`test-run-linux.mjs` skips with a reason until the compiler's half (cc-cross, the
targets) is built. With it built, all 24 cases pass. Here is what the app sees for
the sample project, from Run to the end of the program, with the program's output in
the middle:

| arch | mode | compile | link | VM loaded | first output | exit |
|---|---|---:|---:|---:|---:|---:|
| x86_64 | system | 4.3 s | 4.5 s | 4.7 s | 8.3 s | 8.4 s |
| aarch64 | system | 4.4 s | 4.7 s | 4.8 s | 11.3 s | 11.4 s |
| riscv64 | system | 4.1 s | 4.4 s | 4.5 s | 7.3 s | 7.5 s |
| x86_64 | user (hello) | 3.5 s | 3.9 s | 4.0 s | 4.2 s | 4.2 s |
| aarch64 | user (hello) | 3.6 s | 4.0 s | 4.1 s | 4.4 s | 4.4 s |
| riscv64 | user (hello) | 3.4 s | 3.9 s | 3.9 s | 4.1 s | 4.1 s |

These are cold runs. Compiling with cc-cross dominates until the VM boots, and a warm
run is about the same.

## Licences and sources (GPL)

The pack ships these GPL and other licensed binaries:

| component | licence | text |
|---|---|---|
| QEMU | GPL-2.0 | `LICENSE-qemu.txt` |
| Linux | GPL-2.0 with the syscall note | `LICENSE-linux.txt` |
| strace | LGPL-2.1+ | `LICENSE-strace.txt` |
| qboot | GPL-2.0 | `LICENSE-qboot.txt` |
| OpenSBI | BSD-2-Clause | `LICENSE-opensbi.txt` |

The corresponding source is:

- the upstream releases and commits pinned by SHA-256 or commit in `vm/pins.txt`:
  ktock/qemu-wasm, linux-6.12.114, strace-6.12, and the qboot and OpenSBI submodule
  commits of that QEMU;
- plus `vm/patches/`, `vm/kconfig/`, `vm/devices/` and `vm/guest/`.
