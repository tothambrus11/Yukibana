#!/bin/bash
# Builds Linux 6.12 LTS for x86_64 and arm64 with clang (LLVM=1) from tinyconfig plus
# guest/kernel-<arch>.config (SMP, modules, futex, 9p, serial) and guest/kernel-debug.config
# (lockup and hung-task detectors, sysrq), into web/<arch>/kernel. Needs clang, lld, flex, bison, bc.
set -euxo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HERE/work}
V=${LINUX_VERSION:-6.12.114}
K=$WORK/linux-$V
[ -d "$K" ] || curl -sSL "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$V.tar.xz" | tar xJC "$WORK"
for a in x86_64 arm64; do
  O=$WORK/kbuild-$a; mkdir -p "$O"
  make -C "$K" O="$O" ARCH=$a LLVM=1 tinyconfig >/dev/null
  cat "$HERE/guest/kernel-$a.config" "$HERE/guest/kernel-debug.config" >> "$O/.config"
  make -C "$K" O="$O" ARCH=$a LLVM=1 olddefconfig >/dev/null
  make -C "$K" O="$O" ARCH=$a LLVM=1 -j"$(nproc)"
done
mkdir -p "$HERE/web/aarch64" "$HERE/web/x86_64"
cp "$WORK/kbuild-arm64/arch/arm64/boot/Image" "$HERE/web/aarch64/kernel"
cp "$WORK/kbuild-x86_64/arch/x86/boot/bzImage" "$HERE/web/x86_64/kernel"
