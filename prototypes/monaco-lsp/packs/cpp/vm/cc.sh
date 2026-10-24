#!/usr/bin/env bash
# A cross C compiler for static musl programs in the guest, with the host's clang:
#   cc.sh <arch> [clang args...]        arch: x86_64 | aarch64 | riscv64
# for strace (build-strace.sh) and the test programs (vm/fixtures, test-vm.mjs).
# Sysroots: $SYSROOTS/<arch>/{include,lib} (default $PACK_CACHE/cpp/targets/sysroot,
# made by ../build-targets.sh, which build.sh runs before build-vm.sh) with musl
# 1.2.5's headers, crt1.o, crti.o, crtn.o, libc.a and compiler-rt's
# libclang_rt.builtins.a: the SHA-256-pinned Alpine packages the Linux targets'
# lib.tar is made of, so the guest's tools and users' programs share one musl.
# Linux UAPI headers come from build-kernel.sh's headers_install, last (-idirafter),
# so a program that bundles its own, as strace does, wins.
# Compiling (-c/-E/-S/-M*) gets only the include paths; linking also gets crt and libraries.
set -euo pipefail
a=$1; shift
QC=${QC:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/qemu-wasm}
SYSROOTS=${SYSROOTS:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/targets/sysroot}
D=$SYSROOTS/$a
case $a in x86_64) k=x86_64 ;; aarch64) k=arm64 ;; riscv64) k=riscv ;; *) echo "cc.sh: unknown arch $a" >&2; exit 2 ;; esac
[ -f "$D/lib/libc.a" ] || { echo "cc.sh: no musl sysroot in $D (run ../build-targets.sh)" >&2; exit 1; }
H=$QC/hdr/$k/include
CLANG=${CLANG:-clang-18}
inc=(--target=$a-linux-musl -nostdlibinc -isystem "$("$CLANG" -print-resource-dir)/include" -isystem "$D/include" -idirafter "$H")
for x in "$@"; do case $x in -c|-E|-S|-M|-MM) exec "$CLANG" "${inc[@]}" "$@" ;; esac; done
exec "$CLANG" "${inc[@]}" -static -fuse-ld=lld -nostdlib \
  "$D/lib/crt1.o" "$D/lib/crti.o" "$@" "$D/lib/libc.a" "$D/lib/libclang_rt.builtins.a" "$D/lib/crtn.o"
