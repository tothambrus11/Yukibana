#!/usr/bin/env bash
# Builds the C/C++ pack's Linux VM, which runs programs compiled for a Linux target
# (x86_64, aarch64, riscv64; see src/targets.json) in the browser with QEMU-Wasm,
# into ../../app/static/packs/cpp/:
#
#   vm.js                      the runtime (src/vm/run-linux.js), which runner.js imports
#                              only for a Linux target
#   vm/<arch>/                 system emulation (the default): qemu-system-<arch>.{mjs,wasm},
#                              the Linux 6.12 kernel, the initrd with yk-init (vm/guest/),
#                              strace.cpio, and qboot.rom (x86_64) or OpenSBI (riscv64)
#   user/<arch>/               user emulation (experimental): qemu-<arch>.{mjs,wasm}
#   LICENSE-{qemu,linux,strace,opensbi,qboot}.txt
#
# with .gz and .br siblings. vm/README.md is the report: what works, sizes, timings,
# every patch and why, and where the GPL sources are (vm/pins.txt, vm/patches/).
#
# Steps, each skipped when its stamp in $PACK_CACHE/cpp/vm-artifacts matches its inputs:
#   vm/build-qemu.sh          emscripten 6.0.13, QEMU's dependencies, qemu-system-*
#   vm/build-kernel.sh <arch> Linux 6.12.114 with clang, and its UAPI headers
#   vm/build-init.sh          yk-init with the kernel's nolibc (+ its unit tests, clang-tidy)
#   vm/build-strace.sh        static strace 6.12 (musl)
#   vm/build-qemu-user.sh     qemu-<arch> (linux-user) with patches/qemu-linux-user-wasm.patch
#   vm/stage.sh               lays it all out, bundles vm.js, compresses
# Caches: $PACK_CACHE/qemu-wasm (sources, emsdk, build trees), $PACK_CACHE/cpp/vm-artifacts.
# KEEP_TREES=0 deletes the kernel and QEMU build trees once their artifacts exist
# (about 0.6 GB; a later change to a kernel config or QEMU then rebuilds from scratch).
# USER_MODE=0 skips user emulation (stage.sh then ships no user/).
#
# Needs: clang-18 + lld + llvm-strip (kernels, init, strace), clang-tidy-18, make, flex,
# bison, bc, cpio, git, curl, python3, node 22, autoconf, automake, libtool, pkg-config,
# jq; and the musl sysroots build-targets.sh leaves in $PACK_CACHE/cpp/targets/sysroot
# (build.sh runs it first; vm/cc.sh says what they hold).
#
#   JOBS=3 ./build-vm.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PACK_CACHE=${PACK_CACHE:-$HOME/.cache/yukibana-packs}
export QC=$PACK_CACHE/qemu-wasm ART=$PACK_CACHE/cpp/vm-artifacts JOBS=${JOBS:-3}
mkdir -p "$QC" "$ART"
step() { printf '\n== %s\n' "$*"; }
timed() { local t=$SECONDS; "$@"; echo "($(basename "$1") ${*:2}: $((SECONDS - t)) s)"; }

step "QEMU system emulation"
timed "$HERE/vm/build-qemu.sh"
for a in x86_64 aarch64 riscv64; do
  step "Linux for $a"
  timed "$HERE/vm/build-kernel.sh" "$a"
done
step "yk-init"
timed "$HERE/vm/build-init.sh"
step "strace"
timed "$HERE/vm/build-strace.sh"
if [ "${USER_MODE:-1}" = 1 ]; then
  step "QEMU user emulation (experimental)"
  timed "$HERE/vm/build-qemu-user.sh"
else
  rm -rf "$ART/user"
fi
step "stage"
"$HERE/vm/stage.sh"
if [ "${KEEP_TREES:-1}" = 0 ]; then
  rm -rf "$QC/kbuild" "$QC/work/build-run" "$QC/work/build-user"
fi
