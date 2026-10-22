#!/bin/bash
# Builds the test userland for both guests and packs one initramfs per test:
#   web/<arch>/initrd-alu     runs guest/alutest.c three times and prints its checksums
#   web/<arch>/initrd-stress  N rounds of insmod/rmmod of guest/hello.c and the 4-thread
#                             race in guest/threads.c, with a watchdog that dumps blocked
#                             tasks and CPU backtraces if a round stalls for 20 s
# Everything is compiled on the host (clang, glibc static); nothing compiles in the guest.
# Needs build-kernels.sh first, clang/lld, libc6-dev-arm64-cross + libgcc-*-dev-arm64-cross, cpio.
set -euxo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HERE/work}
ROUNDS=${ROUNDS:-30}
APK=$WORK/apk-tools/sbin/apk.static
ALPINE=https://dl-cdn.alpinelinux.org/alpine/v3.22
if [ ! -x "$APK" ]; then
  mkdir -p "$WORK/apk-tools"
  f=$(curl -s "$ALPINE/main/x86_64/" | grep -o 'apk-tools-static-[^"]*\.apk' | head -1)
  curl -sSL "$ALPINE/main/x86_64/$f" | tar xzC "$WORK/apk-tools" 2>/dev/null || true
fi
for a in x86_64 aarch64; do
  ka=$([ $a = aarch64 ] && echo arm64 || echo x86_64)
  G=$WORK/guest-$a; mkdir -p "$G"
  [ -f "$G/busybox/bin/busybox.static" ] || "$APK" --arch $a -X "$ALPINE/main" -U --allow-untrusted --root "$G/busybox" --initdb add busybox-static
  clang --target=$a-linux-gnu -fuse-ld=lld -O2 -static "$HERE/guest/alutest.c" -o "$G/alutest"
  clang --target=$a-linux-gnu -fuse-ld=lld -O1 -static -pthread "$HERE/guest/threads.c" -o "$G/threads"
  mkdir -p "$G/mod" && cp "$HERE/guest/hello.c" "$HERE/guest/Makefile" "$G/mod/"
  make -C "$WORK/linux-${LINUX_VERSION:-6.12.114}" O="$WORK/kbuild-$ka" ARCH=$ka LLVM=1 M="$G/mod" modules
  for t in alu stress; do
    R=$G/root-$t; rm -rf "$R"; mkdir -p "$R"/{bin,proc,sys,dev,tmp,mnt}
    cp "$G/busybox/bin/busybox.static" "$R/bin/busybox"
    cp "$G/alutest" "$G/threads" "$R/bin/"; cp "$G/mod/hello.ko" "$R/"
    sed "s/@ROUNDS@/$ROUNDS/" "$HERE/guest/init-$t.sh" > "$R/init"; chmod +x "$R/init"
    (cd "$R" && find . | cpio -o -H newc 2>/dev/null | gzip > "$HERE/web/$a/initrd-$t")
  done
done
