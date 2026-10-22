#!/bin/bash
# Clones ktock/qemu-wasm at patches/BASE, applies patches/*.patch, and builds
# qemu-system-aarch64 and qemu-system-x86_64 (virtfs on, no debug info) into web/<arch>/.
# Run scripts/build-deps.sh first, with the same emsdk 3.1.50 activated.
# Also patches the activated emsdk's libc with patches/emscripten/*.patch (a lost
# wakeup in synchronous proxying that froze the VM about once in 20 boots) and
# rebuilds the cached libc, so use an emsdk dedicated to this build.
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
EMROOT=$(dirname "$(command -v emcc)")
for p in "$HERE"/patches/emscripten/*.patch; do
  if patch -d "$EMROOT" -p1 -R --dry-run -s -f < "$p" >/dev/null 2>&1; then continue; fi
  patch -d "$EMROOT" -p1 -s -f < "$p"
  embuilder build libc-mt libc-mt-debug --force
done
export PKG_CONFIG_LIBDIR=$TARGET/lib/pkgconfig PKG_CONFIG_PATH=$TARGET/lib/pkgconfig EM_PKG_CONFIG_PATH=$TARGET/lib/pkgconfig CPATH=$TARGET/include
OUT=$WORK/build; mkdir -p "$OUT"; cd "$OUT"
FLAGS="-O3 -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE
 -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT
 -sMALLOC=emmalloc --js-library=$WORK/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js
 -L$TARGET/lib"
FLAGS=$(echo $FLAGS)
[ -f config.status ] || emconfigure "$SRC/configure" --static --target-list=aarch64-softmmu,x86_64-softmmu --cpu=wasm32 --cross-prefix= \
  --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
  --extra-cflags="$FLAGS" --extra-cxxflags="$FLAGS" \
  --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS,FS_createPath,FS_createDataFile"
emmake make -j"$(nproc)" qemu-system-aarch64 qemu-system-x86_64
for a in aarch64 x86_64; do
  mkdir -p "$HERE/web/$a"
  cp "qemu-system-$a" "$HERE/web/$a/out.js"
  cp "qemu-system-$a.wasm" "qemu-system-$a.worker.js" "$HERE/web/$a/"
done
mkdir -p "$HERE/web/x86_64/bios"
cp "$SRC"/pc-bios/{bios-256k.bin,kvmvapic.bin,linuxboot_dma.bin,vgabios-stdvga.bin} "$HERE/web/x86_64/bios/"
