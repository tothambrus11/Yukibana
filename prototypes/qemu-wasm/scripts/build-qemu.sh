#!/bin/bash
# Clones ktock/qemu-wasm at patches/BASE, applies patches/*.patch, and builds
# qemu-system-aarch64 and qemu-system-x86_64 (virtfs on, no debug info) into web/<arch>/.
# Run scripts/build-deps.sh first, with the same emsdk activated. It must be 5.0.5 or
# later: 3.1.50, which upstream pins, loses a proxied-call wakeup and freezes the VM.
set -euxo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HERE/work}
TARGET=$WORK/target
SRC=$WORK/qemu-wasm
if [ ! -d "$SRC" ]; then
  git clone -q https://github.com/ktock/qemu-wasm "$SRC"
  git -C "$SRC" checkout -q "$(cat "$HERE/patches/BASE")"
  git -C "$SRC" -c user.name=build -c user.email=build@localhost am -q "$HERE"/patches/*.patch
fi
export PKG_CONFIG_LIBDIR=$TARGET/lib/pkgconfig PKG_CONFIG_PATH=$TARGET/lib/pkgconfig EM_PKG_CONFIG_PATH=$TARGET/lib/pkgconfig CPATH=$TARGET/include
OUT=$WORK/build; mkdir -p "$OUT"; cd "$OUT"
# qemu-wasm tests the EMSCRIPTEN macro, which emscripten stopped defining after
# 3.1.x (only __EMSCRIPTEN__ remains); without it the Wasm JIT paths compile out.
# size_t is now unsigned long while glib 2.75's gsize is unsigned int: same width.
CFLAGS="-O3 -Wno-unused-command-line-argument -Wno-error=incompatible-pointer-types -matomics -mbulk-memory -pthread -DEMSCRIPTEN -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE"
LDFLAGS="-sASYNCIFY=1 -sASYNCIFY_IMPORTS=ffi_call_js -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH
 -sTOTAL_MEMORY=2300MB -sMALLOC=emmalloc -sEXPORT_ES6=1 --js-library=$WORK/node_modules/xterm-pty/emscripten-pty.js -L$TARGET/lib
 -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS,FS_createPath,FS_createDataFile"
[ -f config.status ] || emconfigure "$SRC/configure" --static --target-list=aarch64-softmmu,x86_64-softmmu --cpu=wasm32 --cross-prefix= \
  --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
  --extra-cflags="$CFLAGS" --extra-cxxflags="$CFLAGS" --extra-ldflags="$(echo $LDFLAGS)"
emmake make -j"$(nproc)" qemu-system-aarch64 qemu-system-x86_64
for a in aarch64 x86_64; do
  mkdir -p "$HERE/web/$a"
  cp "qemu-system-$a" "qemu-system-$a.wasm" "$HERE/web/$a/"
done
mkdir -p "$HERE/web/x86_64/bios"
cp "$SRC"/pc-bios/{bios-256k.bin,kvmvapic.bin,linuxboot_dma.bin,vgabios-stdvga.bin} "$HERE/web/x86_64/bios/"
