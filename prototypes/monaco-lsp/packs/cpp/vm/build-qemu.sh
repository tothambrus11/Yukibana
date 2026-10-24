#!/usr/bin/env bash
# Builds qemu-system-{x86_64,aarch64,riscv64} for running one program in the C/C++
# pack's Linux VM, into $ART: qemu-system-<arch>.{mjs,wasm}, qboot.rom and
# opensbi-riscv64-generic-fw_dynamic.bin.
#
# From ktock/qemu-wasm at QEMU_WASM_COMMIT plus patches/qemu-wasm-tcg.patch (PR #3's
# Wasm TCG fixes), with emscripten 6.0.13 and the dependencies PR #3's build-deps.sh
# builds (zlib, libffi, glib, pixman), all in $QC (default ~/.cache/yukibana-packs/qemu-wasm).
# Configured with --without-default-devices: each board gets only devices/<arch>.mak
# (the board and virtio-serial), and nothing for virtfs, displays, networks or disks.
#
# Called by ../build-vm.sh (which sets QC, ART, JOBS); also runs on its own.
# Skips everything when $ART/qemu-system.stamp matches its inputs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.txt
source "$HERE/pins.txt"
QC=${QC:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/qemu-wasm}
ART=${ART:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/vm-artifacts}
JOBS=${JOBS:-3}
NICE="nice -n 10"
WORK=$QC/work SRC=$QC/work/qemu-wasm TARGET=$QC/work/target BUILD=$QC/work/build-run
mkdir -p "$ART" "$WORK/src"

# Compile flags. -DEMSCRIPTEN by hand: qemu-wasm tests that macro, which emscripten
# stopped defining after 3.1.x (only __EMSCRIPTEN__ remains), and without it the Wasm
# JIT compiles out. -Wno-error=incompatible-pointer-types: glib 2.75's gsize is
# unsigned int, emscripten's size_t now unsigned long (same width).
CFLAGS="-O3 -Wno-unused-command-line-argument -Wno-error=incompatible-pointer-types -matomics -mbulk-memory -pthread -DEMSCRIPTEN -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE"
# Link flags, only in --extra-ldflags: as compile flags, emcc warns about each -s
# (and meson's checks turn the warning into an error). ASYNCIFY for libffi's calls
# into JS; PROXY_TO_PTHREAD so QEMU's main loop is not the embedder's thread; the
# runtime methods are what src/vm/system.js uses (FS for its devices).
LDFLAGS="-sASYNCIFY=1 -sASYNCIFY_IMPORTS=ffi_call_js -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH
 -sINITIAL_MEMORY=512MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sMALLOC=emmalloc -sEXPORT_ES6=1 -L$TARGET/lib
 -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,FS"

stamp=$(cat "$HERE/pins.txt" "$HERE/patches/qemu-wasm-tcg.patch" "$HERE"/devices/*.mak <(echo "$CFLAGS $LDFLAGS") \
  "${BASH_SOURCE[0]}" | sha256sum | cut -d' ' -f1)
if [ "$(cat "$ART/qemu-system.stamp" 2>/dev/null)" = "$stamp" ]; then
  echo "qemu-system: up to date ($ART)"; exit 0
fi

fetch() { # url sha256 file
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
    mv "$3.part" "$3"
  fi
}

# --- emscripten 6.0.13, the binary release unpacked as emsdk would
EM=$QC/emsdk-$EMSDK_VERSION
if [ ! -x "$EM/install/emscripten/emcc" ]; then
  mkdir -p "$EM"
  fetch "https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/$EMSDK_RELEASE/wasm-binaries.tar.xz" \
    "$EMSDK_BINARIES_SHA256" "$EM/wasm-binaries.tar.xz"
  tar xJf "$EM/wasm-binaries.tar.xz" -C "$EM" && rm "$EM/wasm-binaries.tar.xz"
fi
if [ ! -f "$EM/env.sh" ]; then
  printf "LLVM_ROOT = '%s'\nBINARYEN_ROOT = '%s'\nNODE_JS = '%s'\n" "$EM/install/bin" "$EM/install" "$(command -v node)" > "$EM/.emscripten"
  printf 'export EM_CONFIG=%s\nexport PATH=%s:%s:$PATH\n' "$EM/.emscripten" "$EM/install/emscripten" "$EM/install/bin" > "$EM/env.sh"
fi
# shellcheck disable=SC1091
source "$EM/env.sh"
# meson 1.5 (QEMU 8.2's configure wants a newer one than distributions ship)
# and setuptools, whose distutils shim glib 2.75's gdbus-codegen imports
# (distutils.version): Python 3.12 dropped distutils, and a venv made by 3.12
# or later has no setuptools of its own.
[ -x "$QC/venv/bin/meson" ] || python3 -m venv "$QC/venv"
"$QC/venv/bin/python3" -c 'import setuptools, mesonbuild' 2>/dev/null ||
  "$QC/venv/bin/pip" -q install meson==1.5.2 setuptools==84.2.1
export PATH=$QC/venv/bin:$PATH

# --- dependencies (PR #3's scripts/build-deps.sh, with the tarballs checked)
if [ ! -f "$TARGET/lib/libglib-2.0.a" ] || [ ! -f "$TARGET/lib/libpixman-1.a" ]; then
  (
  export TARGET; mkdir -p "$TARGET/lib"; cd "$WORK/src"
  export CFLAGS="-O2 -matomics -mbulk-memory -DNDEBUG -sWASM_BIGINT -DWASM_BIGINT -pthread -sMALLOC=mimalloc -sASYNCIFY=1"
  export CXXFLAGS="$CFLAGS" LDFLAGS="-L$TARGET/lib -O2" CPATH="$TARGET/include"
  # The host's .pc files must not leak in (a host libelf breaks glib's gresource tool).
  export PKG_CONFIG_LIBDIR="$TARGET/lib/pkgconfig" PKG_CONFIG_PATH="$TARGET/lib/pkgconfig" EM_PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
  export CHOST=wasm32-unknown-linux MAKEFLAGS="-j$JOBS"
  fetch "$ZLIB_URL" "$ZLIB_SHA256" zlib.tar.gz
  [ -d zlib ] || { mkdir zlib && tar xzf zlib.tar.gz -C zlib --strip-components=1; }
  (cd zlib && emconfigure ./configure --prefix="$TARGET" --static && $NICE make install)
  [ -d libffi ] || git clone -q "$LIBFFI_REPO" libffi
  (cd libffi && git checkout -q "$LIBFFI_COMMIT" && autoreconf -fi \
    && LDFLAGS="$LDFLAGS -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0" emconfigure ./configure --host=$CHOST --prefix="$TARGET" \
       --enable-static --disable-shared --disable-dependency-tracking --disable-builddir --disable-multi-os-directory \
       --disable-raw-api --disable-structs --disable-docs \
    && $NICE emmake make install SUBDIRS=include)
  printf '#include <netdb.h>\nint res_query(const char *n, int c, int t, unsigned char *d, int l) { h_errno = HOST_NOT_FOUND; return -1; }\n' > res_query.c
  emcc $CFLAGS -c res_query.c -fPIC -o libresolv.o && emar rcs "$TARGET/lib/libresolv.a" libresolv.o
  fetch "$GLIB_URL" "$GLIB_SHA256" glib.tar.xz
  [ -d glib ] || { mkdir glib && tar xJf glib.tar.xz -C glib --strip-components=1; }
  cat > emcc-meson-wrap.sh <<'EOT'
#!/bin/bash
# emcc warns about -s flags at compile time; meson's checks must not turn that into an error.
set -euo pipefail
cmd="$1"; shift; args=()
for a in "$@"; do args+=("${a//-Werror=unused-command-line-argument/-Wno-error=unused-command-line-argument}"); done
"$cmd" "${args[@]}"
EOT
  cat > cross.meson <<EOT
[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
[binaries]
c = ['bash', '$WORK/src/emcc-meson-wrap.sh', 'emcc']
cpp = ['bash', '$WORK/src/emcc-meson-wrap.sh', 'em++']
ar = 'emar'
ranlib = 'emranlib'
pkgconfig = ['pkg-config', '--static']
EOT
  (cd glib && rm -rf _build \
    && CFLAGS="-Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types -O2 -matomics -mbulk-memory -DNDEBUG -pthread -sWASM_BIGINT -sMALLOC=mimalloc -sASYNCIFY=1" \
       meson setup _build --prefix="$TARGET" --cross-file="$WORK/src/cross.meson" --default-library=static --buildtype=release \
       --force-fallback-for=pcre2,gvdb -Dselinux=disabled -Dxattr=false -Dlibmount=disabled -Dnls=disabled -Dtests=false \
       -Dglib_assert=false -Dglib_checks=false -Dlibelf=disabled \
    && for d in HAVE_CLOSE_RANGE HAVE_EPOLL_CREATE HAVE_KQUEUE HAVE_POSIX_SPAWN HAVE_FALLOCATE; do sed -i -E "/#define $d 1/d" _build/config.h; done \
    && $NICE meson install -C _build)
  [ -d pixman ] || git clone -q "$PIXMAN_REPO" pixman
  (cd pixman && git checkout -q "$PIXMAN_COMMIT" && NOCONFIGURE=y ./autogen.sh && emconfigure ./configure --host=$CHOST --prefix="$TARGET" \
    && $NICE emmake make -C pixman install && rm -f "$TARGET"/lib/libpixman-1.so*)
  )
fi

# --- the QEMU tree: the pinned commit with PR #3's patch as one commit on top
patch_ok() {
  [ "$(git -C "$SRC" rev-parse HEAD~1 2>/dev/null)" = "$QEMU_WASM_COMMIT" ] &&
  [ "$(git -C "$SRC" diff HEAD~1 HEAD | git patch-id --stable | cut -d' ' -f1)" = "$QEMU_WASM_TCG_PATCH_ID" ]
}
if ! patch_ok; then
  rm -rf "$SRC" "$BUILD"
  git clone -q "$QEMU_WASM_REPO" "$SRC"
  git -C "$SRC" checkout -q "$QEMU_WASM_COMMIT"
  git -C "$SRC" -c user.name=build -c user.email=build@localhost am -q "$HERE/patches/qemu-wasm-tcg.patch"
  patch_ok || { echo "qemu-wasm-tcg.patch did not give the pinned patch-id" >&2; exit 1; }
fi
for a in x86_64 aarch64 riscv64; do
  cmp -s "$HERE/devices/$a.mak" "$SRC/configs/devices/$a-softmmu/yukibana.mak" 2>/dev/null ||
    cp "$HERE/devices/$a.mak" "$SRC/configs/devices/$a-softmmu/yukibana.mak"
done

# --- configure (once per build tree) and build
export PKG_CONFIG_LIBDIR=$TARGET/lib/pkgconfig PKG_CONFIG_PATH=$TARGET/lib/pkgconfig EM_PKG_CONFIG_PATH=$TARGET/lib/pkgconfig CPATH=$TARGET/include
# A tree configured with other flags (config.status records the command) starts over.
configured() {
  local f=$BUILD/config.status
  grep -qF -- "'--extra-cflags=$CFLAGS'" "$f" 2>/dev/null && grep -qF -- "'--extra-ldflags=$(echo $LDFLAGS)'" "$f" &&
  grep -qF -- "'--target-list=x86_64-softmmu,aarch64-softmmu,riscv64-softmmu'" "$f" && grep -qF -- "'--without-default-devices'" "$f"
}
if ! configured; then
  rm -rf "$BUILD"; mkdir -p "$BUILD"; cd "$BUILD"
  emconfigure "$SRC/configure" --static --target-list=x86_64-softmmu,aarch64-softmmu,riscv64-softmmu \
    --cpu=wasm32 --cross-prefix= --without-default-features --without-default-devices \
    --with-devices-x86_64=yukibana --with-devices-aarch64=yukibana --with-devices-riscv64=yukibana \
    --enable-system --with-coroutine=fiber --enable-fdt=internal \
    --extra-cflags="$CFLAGS" --extra-cxxflags="$CFLAGS" --extra-ldflags="$(echo $LDFLAGS)"
fi
cd "$BUILD"
$NICE emmake make -j"$JOBS" qemu-system-x86_64 qemu-system-aarch64 qemu-system-riscv64
# Link each once more as <name>.mjs: emscripten names the pthread workers' script after
# the output file, and a module worker needs an extension a static host serves as
# JavaScript. -sEXIT_RUNTIME=1 only here, so meson's link checks are unaffected: QEMU's
# own exit() then reaches Module.onExit, which is how system.js learns QEMU stopped.
for a in x86_64 aarch64 riscv64; do
  cmd=$(ninja -t commands "qemu-system-$a" | tail -1)
  [[ "$cmd" == *" -o qemu-system-$a "* ]] || { echo "unexpected link command for qemu-system-$a" >&2; exit 1; }
  eval "$NICE ${cmd/ -o qemu-system-$a / -o qemu-system-$a.mjs -sEXIT_RUNTIME=1 }"
  cp "qemu-system-$a.mjs" "qemu-system-$a.wasm" "$ART/"
done
cp "$SRC/pc-bios/qboot.rom" "$SRC/pc-bios/opensbi-riscv64-generic-fw_dynamic.bin" "$ART/"
echo "$QBOOT_SHA256  $ART/qboot.rom" | sha256sum -c --quiet -
echo "$OPENSBI_SHA256  $ART/opensbi-riscv64-generic-fw_dynamic.bin" | sha256sum -c --quiet -
cp "$SRC/COPYING" "$ART/LICENSE-qemu.txt"
fetch "https://raw.githubusercontent.com/bonzini/qboot/$QBOOT_COMMIT/LICENSE" "$QBOOT_LICENSE_SHA256" "$ART/LICENSE-qboot.txt"
fetch "https://raw.githubusercontent.com/riscv-software-src/opensbi/$OPENSBI_COMMIT/COPYING.BSD" "$OPENSBI_LICENSE_SHA256" "$ART/LICENSE-opensbi.txt"
echo "$stamp" > "$ART/qemu-system.stamp"
ls -la "$ART"/qemu-system-*
