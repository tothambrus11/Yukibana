#!/usr/bin/env bash
# Builds the experimental user-mode QEMU (linux-user) for x86_64, aarch64 and riscv64
# into $ART/user/<arch>/qemu-<arch>.{mjs,wasm}: QEMU translates the program's system
# calls onto Emscripten's libc instead of booting a kernel (src/vm/user.js runs it).
#
# QEMU 8.2 has no linux-user host support for Wasm, and QEMU 10 dropped 64-bit guests
# on 32-bit hosts, so this needs patches/qemu-linux-user-wasm.patch (vm/README.md says
# what each hunk does) on the tree build-qemu.sh prepares, and compat headers:
#   - patches/compat-wasm-host-syscall.h.patch: the force-included host syscall
#     numbering (asm-generic) and the guest memory functions;
#   - the musl 1.2.5 headers Emscripten's libc leaves out (sys/signalfd.h, ...);
#   - the Linux UAPI headers linux-user needs for struct layouts and constants, from
#     the pinned kernel (build-kernel.sh's headers), never the build machine's.
# Needs build-qemu.sh first (emsdk 6.0.13, the dependencies, the QEMU tree) and
# build-kernel.sh x86_64 (the UAPI headers).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.txt
source "$HERE/pins.txt"
QC=${QC:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/qemu-wasm}
ART=${ART:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/vm-artifacts}
JOBS=${JOBS:-3}
NICE="nice -n 10"
WORK=$QC/work SRC=$QC/work/qemu-wasm TARGET=$QC/work/target
UT=$WORK/qemu-user-src B=$WORK/build-user C=$WORK/user-compat
HDR=$QC/hdr/x86_64/include
# Linear memory at start, in MiB. 512 in the first experiment; it grows on demand, and
# the guest's address space (256 MiB, -R) comes from sbrk without being touched, so
# this only has to hold QEMU itself. test-vm.mjs passes at 8, 16 and 32 alike, with the
# same resident memory (the guest region's growth dominates); 16 leaves headroom.
USER_INITIAL_MEMORY_MB=${USER_INITIAL_MEMORY_MB:-16}
MUSL_INCLUDE=${MUSL_INCLUDE:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/musl-$MUSL_VERSION/include}

CFLAGS="-idirafter $C -include $C/wasm-host-syscall.h -O3 -Wno-unused-command-line-argument -Wno-error=incompatible-pointer-types -matomics -mbulk-memory -pthread -DEMSCRIPTEN -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE"
LDFLAGS="-sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sINITIAL_MEMORY=512MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sMALLOC=emmalloc -sEXPORT_ES6=1 -L$TARGET/lib -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,FS"
# Only on the final link (a later -s wins), so they can change without reconfiguring:
# EXIT_RUNTIME so exit() reaches Module.onExit; TTY so user.js can give fds 0-2
# terminal semantics (isatty) with output that is not line-buffered.
FINAL="-sEXIT_RUNTIME=1 -sINITIAL_MEMORY=${USER_INITIAL_MEMORY_MB}MB -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,FS,TTY"

stamp=$(cat "$HERE/pins.txt" "$HERE/patches/"*.patch "${BASH_SOURCE[0]}" | sha256sum | cut -d' ' -f1)
if [ "$(cat "$ART/user.stamp" 2>/dev/null)" = "$stamp" ]; then echo "qemu user: up to date"; exit 0; fi
[ -f "$TARGET/lib/libglib-2.0.a" ] && [ -f "$SRC/configure" ] || { echo "run build-qemu.sh first" >&2; exit 1; }
[ -f "$HDR/linux/types.h" ] || { echo "run build-kernel.sh x86_64 first (UAPI headers)" >&2; exit 1; }
# shellcheck disable=SC1091
source "$QC/emsdk-$EMSDK_VERSION/env.sh"
export PATH=$QC/venv/bin:$PATH

# --- musl's headers (the cpp pack's build.sh unpacks the same tarball)
if [ ! -f "$MUSL_INCLUDE/sys/signalfd.h" ]; then
  mkdir -p "$QC/src"
  curl -sSfL -o "$QC/src/musl.tar.gz" "$MUSL_URL"
  echo "$MUSL_SHA256  $QC/src/musl.tar.gz" | sha256sum -c --quiet -
  tar xzf "$QC/src/musl.tar.gz" -C "$QC/src" && rm "$QC/src/musl.tar.gz"
  MUSL_INCLUDE=$QC/src/musl-$MUSL_VERSION/include
fi

# --- the patched tree: hard links to build-qemu.sh's tree, so it costs no space;
# patch(1) replaces the files it changes instead of writing through the links.
psha=$(sha256sum < "$HERE/patches/qemu-linux-user-wasm.patch" | cut -d' ' -f1)
if [ "$(cat "$UT/.yk-patch" 2>/dev/null)" != "$psha" ]; then
  rm -rf "$UT" "$B"; mkdir -p "$UT"
  (cd "$SRC" && for f in * .[a-z]*; do [ "$f" = .git ] || cp -al "$f" "$UT/"; done)
  patch -d "$UT" -p1 -s < "$HERE/patches/qemu-linux-user-wasm.patch"
  echo "$psha" > "$UT/.yk-patch"
fi

# --- compat headers
csha=$(cat "$HERE/patches/compat-wasm-host-syscall.h.patch" "$HERE/pins.txt" | sha256sum | cut -d' ' -f1)
if [ "$(cat "$C/.yk-stamp" 2>/dev/null)" != "$csha" ]; then
  rm -rf "$C" "$B"; mkdir -p "$C/asm"
  E=$QC/emsdk-$EMSDK_VERSION/install/emscripten/cache/sysroot/include
  [ -d "$E" ] || E=$QC/emsdk-$EMSDK_VERSION/install/emscripten/system/include
  # musl headers Emscripten leaves out (sys/signalfd.h, sys/prctl.h, ...)
  (cd "$MUSL_INCLUDE" && find . -name '*.h') | while read -r f; do
    [ -e "$E/$f" ] || { mkdir -p "$C/$(dirname "$f")"; cp "$MUSL_INCLUDE/$f" "$C/$f"; }
  done
  # Linux UAPI (layouts and constants only); asm/ is asm-generic's, the 32-bit
  # little-endian host linux-user believes it runs on.
  for d in linux sound mtd scsi drm rdma misc video xen asm-generic; do [ -d "$HDR/$d" ] && cp -r "$HDR/$d" "$C/$d"; done
  cp "$HDR"/asm-generic/*.h "$C/asm/"
  printf '#include <linux/byteorder/little_endian.h>\n' > "$C/asm/byteorder.h"
  patch -d "$C" -p1 -s < "$HERE/patches/compat-wasm-host-syscall.h.patch"
  echo "$csha" > "$C/.yk-stamp"
fi

# --- configure and build
configured() {
  local f=$B/config.status
  grep -qF -- "'--extra-cflags=$CFLAGS'" "$f" 2>/dev/null && grep -qF -- "'--extra-ldflags=$LDFLAGS'" "$f"
}
if ! configured; then
  rm -rf "$B"; mkdir -p "$B"; cd "$B"
  PKG_CONFIG_PATH=$TARGET/lib/pkgconfig CC=emcc CXX=em++ "$UT/configure" --static \
    --target-list=x86_64-linux-user,aarch64-linux-user,riscv64-linux-user --cpu=wasm32 --cross-prefix= \
    --without-default-features --disable-werror \
    --extra-cflags="$CFLAGS" --extra-cxxflags="$CFLAGS" --extra-ldflags="$LDFLAGS"
fi
cd "$B"
PKG_CONFIG_PATH=$TARGET/lib/pkgconfig $NICE ninja -j"$JOBS" qemu-x86_64 qemu-aarch64 qemu-riscv64
# Strict warnings on the file we wrote (QEMU's own flags do not include -Wextra);
# after the build, which generates the headers it includes.
emcc $(jq -r '.[] | select(.file | endswith("wasm32/wasm-host.c")) | .command' compile_commands.json | head -1 |
  sed 's/^[^ ]* //; s/ -o [^ ]*//; s/ -c [^ ]*//; s/ -MD -MQ [^ ]* -MF [^ ]*//') \
  --system-header-prefix=qemu/ -Wall -Wextra -Wno-sign-compare -Wno-missing-field-initializers -Werror -fsyntax-only "$UT/common-user/host/wasm32/wasm-host.c"
for a in x86_64 aarch64 riscv64; do
  cmd=$(ninja -t commands "qemu-$a" | tail -1)
  [[ "$cmd" == *" -o qemu-$a "* ]] || { echo "unexpected link command for qemu-$a" >&2; exit 1; }
  mkdir -p "$ART/user/$a"
  eval "$NICE ${cmd/ -o qemu-$a / -o $ART/user/$a/qemu-$a.mjs } $FINAL"
done
echo "$stamp" > "$ART/user.stamp"
ls -la "$ART"/user/*/
