#!/usr/bin/env bash
# Builds the guest kernel for one architecture with clang (LLVM=1), into $ART:
#   x86_64   kernel-x86_64   the stripped vmlinux, booted at its PVH entry by microvm
#   aarch64  kernel-aarch64  arch/arm64/boot/Image
#   riscv64  kernel-riscv64  arch/riscv/boot/Image
# plus config-<arch>, and the kernel's UAPI headers (as make headers_install would) in
# $QC/hdr/<karch>/include, which build-init.sh, build-strace.sh and
# build-qemu-user.sh use instead of the build machine's /usr/include.
#
# Config: tinyconfig + kconfig/common.config + kconfig/<karch>.config (+ x86_64-pvh.config).
# Every option a fragment asks for must survive olddefconfig, or the build fails:
# a missing dependency drops an option silently.
#
# usage: build-kernel.sh x86_64|aarch64|riscv64   (env: QC, ART, JOBS as build-vm.sh sets them)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.txt
source "$HERE/pins.txt"
QC=${QC:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/qemu-wasm}
ART=${ART:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/vm-artifacts}
JOBS=${JOBS:-3}
arch=$1
case $arch in
  x86_64) ka=x86_64 frags=(common x86_64 x86_64-pvh) tree=x86_64-pvh ;;
  aarch64) ka=arm64 frags=(common arm64) tree=arm64 ;;
  riscv64) ka=riscv frags=(common riscv) tree=riscv ;;
  *) echo "usage: $0 x86_64|aarch64|riscv64" >&2; exit 2 ;;
esac
files=(); for f in "${frags[@]}"; do files+=("$HERE/kconfig/$f.config"); done
K=$QC/linux-$LINUX_VERSION
O=$QC/kbuild/$tree
mkdir -p "$ART"

stamp=$(cat "$HERE/pins.txt" "${files[@]}" "${BASH_SOURCE[0]}" <(clang --version | head -1) | sha256sum | cut -d' ' -f1)
if [ "$(cat "$ART/kernel-$arch.stamp" 2>/dev/null)" = "$stamp" ] && [ -f "$QC/hdr/$ka/include/linux/types.h" ]; then
  echo "kernel-$arch: up to date"; exit 0
fi

if [ ! -f "$K/Makefile" ]; then
  tarball=$QC/linux-$LINUX_VERSION.tar.xz
  curl -sSfL -o "$tarball.part" "$LINUX_URL"
  echo "$LINUX_SHA256  $tarball.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $LINUX_URL" >&2; exit 1; }
  tar xJf "$tarball.part" -C "$QC" && rm "$tarball.part"
fi

# The UAPI headers: headers_install, done by hand because it needs rsync for the copy.
make -s -C "$K" O="$O" ARCH=$ka LLVM=1 headers
rm -rf "$QC/hdr/$ka" && mkdir -p "$QC/hdr/$ka"
(cd "$O/usr" && find include -name '*.h' -print0 | cpio -0 -pdm --quiet "$QC/hdr/$ka")
make -s -C "$K" O="$O" ARCH=$ka LLVM=1 tinyconfig
cat "${files[@]}" >> "$O/.config"
make -s -C "$K" O="$O" ARCH=$ka LLVM=1 olddefconfig
fail=0
while IFS= read -r line; do
  case "$line" in
    CONFIG_*=n) opt=${line%%=*}; grep -q "^$opt=" "$O/.config" && { echo "still set: $line"; fail=1; } ;;
    CONFIG_*) grep -qx "$line" "$O/.config" || { echo "dropped: $line"; fail=1; } ;;
  esac
done < <(cat "${files[@]}")
[ $fail = 0 ] || { echo "kernel-$arch: the config lost options (above)" >&2; exit 1; }
nice -n 10 make -s -C "$K" O="$O" ARCH=$ka LLVM=1 -j"$JOBS"
case $arch in
  x86_64) llvm-strip -o "$ART/kernel-x86_64" "$O/vmlinux" ;;
  aarch64) cp "$O/arch/arm64/boot/Image" "$ART/kernel-aarch64" ;;
  riscv64) cp "$O/arch/riscv/boot/Image" "$ART/kernel-riscv64" ;;
esac
cp "$O/.config" "$ART/config-$arch"
cat "$K/COPYING" "$K/LICENSES/preferred/GPL-2.0" "$K/LICENSES/exceptions/Linux-syscall-note" > "$ART/LICENSE-linux.txt"
echo "$stamp" > "$ART/kernel-$arch.stamp"
ls -la "$ART/kernel-$arch"
