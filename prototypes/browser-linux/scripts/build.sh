#!/usr/bin/env bash
# Builds everything the page loads into ../dist:
#
#   llvm.mjs + llvm.wasm    clang, lld, llvm-objdump in one Emscripten module
#   blink.mjs + blink.wasm  Blink, an x86-64 Linux user-mode emulator
#   blink-mt.mjs + .wasm    the same with guest threads (needs COOP/COEP)
#   sysroot-<arch>-<libc>.tar.gz
#                           musl or glibc headers and static libraries,
#                           compiler-rt builtins, clang's freestanding headers
#
# It needs a Linux host with clang, lld, cmake, ninja, git, curl, python3,
# xz and dpkg-deb.
# Emscripten is fetched into $WORK. The LLVM step is the slow one: about two
# hours on four cores, most of it the X86 and AArch64 backends.
#
#   WORK=/opt/w ./scripts/build.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HERE/.work}
DIST=$HERE/dist
JOBS=${JOBS:-$(nproc)}
LLVM_TAG=llvmorg-21.1.8
MUSL=musl-1.2.5
EMSDK_VERSION=${EMSDK_VERSION:-latest}
# Blink has no releases that carry the Emscripten fixes, so pin a commit.
BLINK_COMMIT=${BLINK_COMMIT:-f006a4f}

mkdir -p "$WORK" "$DIST"
cd "$WORK"

step() { printf '\n== %s\n' "$*"; }

step "sources"
[ -d emsdk ] || git clone --depth 1 https://github.com/emscripten-core/emsdk
[ -d llvm-project ] || git clone --depth 1 --branch $LLVM_TAG https://github.com/llvm/llvm-project
if [ ! -d blink ]; then
  git clone https://github.com/jart/blink
  git -C blink checkout $BLINK_COMMIT
  # Linux's rdx at entry, kill/tkill/pipe for a one-process guest, and no
  # waits that need Asyncify.
  git -C blink apply "$HERE/scripts/blink-browser.patch"
fi
[ -d $MUSL ] || curl -sSL https://musl.libc.org/releases/$MUSL.tar.gz | tar xz

(cd emsdk && ./emsdk install $EMSDK_VERSION && ./emsdk activate $EMSDK_VERSION) >/dev/null
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null 2>&1

# Emscripten's pipes never report end of file: a read of an empty pipe is
# EAGAIN even after the last writer closed. Linux returns 0, and a student's
# read loop depends on it.
python3 - emsdk/upstream/emscripten/src/lib/libpipefs.js <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "        if (currentLength == 0) {\n          // Behave as if"
new = "        if (currentLength == 0) {\n          if (pipe.writeClosed) return 0;\n          // Behave as if"
if "if (pipe.writeClosed) return 0;" not in s:
    assert old in s, "libpipefs.js changed; check the end-of-file fix still applies"
    open(p, "w").write(s.replace(old, new, 1))
PY

# The multicall driver tries to make a symlink per tool (clang++, ld.lld...)
# and fails at configure time when the tool is an Emscripten .js; the page
# chooses the tool by argv[1] instead, so the symlinks are not needed.
if ! grep -q 'DRIVER_BUILD AND CMAKE_SYSTEM_NAME STREQUAL "Emscripten"' llvm-project/llvm/cmake/modules/AddLLVM.cmake; then
  git -C llvm-project apply "$HERE/scripts/llvm-no-tool-symlinks.patch"
fi

for arch in x86_64 aarch64; do
  step "musl for $arch"
  sys=$WORK/sysroot/$arch
  if [ ! -f "$sys/lib/libc.a" ]; then
    mkdir -p build-musl-$arch
    (cd build-musl-$arch &&
      ../$MUSL/configure --target=$arch-linux-musl --prefix="$sys" --disable-shared \
        CC="clang --target=$arch-linux-musl -fuse-ld=lld" CFLAGS=-Os \
        AR=llvm-ar RANLIB=llvm-ranlib >/dev/null &&
      make -j"$JOBS" >/dev/null && make install >/dev/null)
  fi

  step "compiler-rt builtins for $arch"
  # aarch64 musl needs these for long double (printf's %f); x86_64 for
  # __int128 division. Built with the host clang: they are target code.
  if [ ! -f "$sys/lib/libclang_rt.builtins.a" ]; then
    inc="-nostdinc -isystem $sys/include -isystem $(clang -print-resource-dir)/include"
    cmake -S llvm-project/compiler-rt/lib/builtins -B build-rt-$arch -G Ninja \
      -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_ASM_COMPILER=clang \
      -DCMAKE_AR="$(command -v llvm-ar)" -DCMAKE_RANLIB="$(command -v llvm-ranlib)" \
      -DCMAKE_C_COMPILER_TARGET=$arch-linux-musl -DCMAKE_CXX_COMPILER_TARGET=$arch-linux-musl \
      -DCMAKE_ASM_COMPILER_TARGET=$arch-linux-musl -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_SYSTEM_PROCESSOR=$arch -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON -DCMAKE_C_FLAGS="$inc" -DCMAKE_CXX_FLAGS="$inc" \
      -DCMAKE_ASM_FLAGS="$inc" >/dev/null
    ninja -C build-rt-$arch >/dev/null
    cp build-rt-$arch/lib/linux/libclang_rt.builtins-$arch.a "$sys/lib/libclang_rt.builtins.a"
  fi
done

step "native tablegen"
if [ ! -x build-native/bin/clang-tblgen ]; then
  cmake -S llvm-project/llvm -B build-native -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="clang;lld" -DLLVM_TARGETS_TO_BUILD=X86 \
    -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DLLVM_USE_LINKER=lld >/dev/null
  ninja -C build-native llvm-tblgen clang-tblgen llvm-min-tblgen
fi

step "LLVM for WebAssembly"
# Only the tools the page runs go into the multicall binary; every other
# tool is switched off so it is neither configured nor linked in.
keep=" llvm-driver llvm-objdump llvm-readobj llvm-nm llvm-ar llvm-config "
off=()
for t in llvm-project/llvm/tools/*/; do
  t=$(basename "$t")
  [[ $keep == *" $t "* ]] || off+=("-DLLVM_TOOL_$(echo "$t" | tr a-z- A-Z_)_BUILD=OFF")
done
for t in llvm-project/clang/tools/*/; do
  t=$(basename "$t")
  [ "$t" = driver ] || off+=("-DCLANG_TOOL_$(echo "$t" | tr a-z- A-Z_)_BUILD=OFF")
done
# STACK_SIZE: clang's parser and the backends recurse deeply; 64 KiB (the
# Emscripten default) overflows on the first function. EXIT_RUNTIME: the
# page makes a fresh instance per tool run, because LLVM's globals do not
# survive a second main().
ldflags="-sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=256MB \
  -sSTACK_SIZE=8MB -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLLVM \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node \
  -sNODEJS_CATCH_EXIT=0 -sNODEJS_CATCH_REJECTION=0"
if [ ! -f build-wasm/build.ninja ]; then
  emcmake cmake -S llvm-project/llvm -B build-wasm -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG" -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG" \
    -DLLVM_ENABLE_PROJECTS="clang;lld" -DLLVM_TARGETS_TO_BUILD="X86;AArch64" \
    -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten -DLLVM_DEFAULT_TARGET_TRIPLE=x86_64-linux-musl \
    -DLLVM_TABLEGEN="$WORK/build-native/bin/llvm-tblgen" -DCLANG_TABLEGEN="$WORK/build-native/bin/clang-tblgen" \
    -DLLVM_NATIVE_TOOL_DIR="$WORK/build-native/bin" \
    -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF \
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF \
    -DLLVM_ENABLE_LIBPFM=OFF -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_BACKTRACES=OFF \
    -DLLVM_ENABLE_CRASH_OVERRIDES=OFF -DLLVM_ENABLE_UNWIND_TABLES=OFF -DLLVM_ENABLE_PLUGINS=OFF \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_UTILS=OFF -DLLVM_BUILD_UTILS=OFF -DLLVM_INCLUDE_DOCS=OFF \
    -DCLANG_ENABLE_ARCMT=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_INCLUDE_TESTS=OFF \
    -DCLANG_INCLUDE_DOCS=OFF -DCLANG_BUILD_EXAMPLES=OFF -DCLANG_ENABLE_OBJC_REWRITER=OFF \
    -DCLANG_PLUGIN_SUPPORT=OFF -DCMAKE_EXE_LINKER_FLAGS="$ldflags" "${off[@]}" >/dev/null
fi
ninja -C build-wasm -j"$JOBS" llvm-driver
cp build-wasm/bin/llvm.js "$DIST/llvm.mjs"
cp build-wasm/bin/llvm.wasm "$DIST/llvm.wasm"

step "Blink for WebAssembly"
# Two builds of the same emulator. blink.wasm has no threads and runs on any
# page; blink-mt.wasm maps each guest thread to an Emscripten pthread, which
# needs SharedArrayBuffer and so a cross-origin isolated page (COOP + COEP
# headers). Neither has a JIT (WebAssembly has no executable memory), fork
# or sockets.
blink_link="-O2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createBlink -sINVOKE_RUN=0 \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sENVIRONMENT=web,worker,node -sEXIT_RUNTIME=1 -sNODEJS_CATCH_EXIT=0 -sNODEJS_CATCH_REJECTION=0"
[ -d blink-mt ] || cp -r blink blink-mt
if [ ! -f blink/o/blink/blink.a ]; then
  (cd blink && CC=emcc emconfigure ./configure --disable-jit --disable-threads \
    --disable-fork --disable-sockets >/dev/null && emmake make -j"$JOBS" o//blink/blink >/dev/null)
fi
if [ ! -f blink-mt/o/blink/blink.a ]; then
  (cd blink-mt && CC=emcc CFLAGS=-pthread LDFLAGS=-pthread emconfigure ./configure --disable-jit \
    --disable-fork --disable-sockets >/dev/null && emmake make -j"$JOBS" o//blink/blink >/dev/null)
fi
# shellcheck disable=SC2086
emcc blink/o/blink/blink.o blink/o/blink/blink.a -o "$DIST/blink.mjs" $blink_link
# PTHREAD_POOL_SIZE: Blink's main() blocks while guest threads run, so the
# workers that carry them must exist before it starts.
# shellcheck disable=SC2086
emcc -pthread blink-mt/o/blink/blink.o blink-mt/o/blink/blink.a -o "$DIST/blink-mt.mjs" \
  $blink_link -sPTHREAD_POOL_SIZE=8

step "glibc from Debian"
# glibc does not build with clang, so take Debian trixie's (2.41) packages:
# libc6-dev for headers and static libraries, linux-libc-dev for the kernel
# headers glibc's include, and libgcc-14-dev for crtbeginT.o, crtend.o,
# libgcc.a and libgcc_eh.a, which a static glibc link needs.
for deb in amd64:x86_64 arm64:aarch64; do
  darch=${deb%%:*} arch=${deb##*:}
  sys=$WORK/sysroot-gnu/$arch
  [ -f "$sys/lib/libc.a" ] && continue
  root=$WORK/debian-$darch
  rm -rf "$root" && mkdir -p "$root"
  curl -sS https://deb.debian.org/debian/dists/trixie/main/binary-$darch/Packages.xz | xz -d > "$root/Packages"
  for pkg in libc6-dev linux-libc-dev libgcc-14-dev; do
    file=$(awk -v p=$pkg '$1=="Package:"{x=($2==p)} x&&$1=="Filename:"{print $2; exit}' "$root/Packages")
    curl -sS -o "$root/$pkg.deb" "https://deb.debian.org/debian/$file"
    dpkg-deb -x "$root/$pkg.deb" "$root/fs"
  done
  mkdir -p "$sys/include" "$sys/lib"
  # Debian splits headers by architecture; a sysroot for one has them flat.
  # The kernel's asm/ headers are symlinks into /usr/lib/linux; -L copies
  # what they point at. linux-libc-dev ships every architecture's.
  cp -rL "$root/fs/usr/include/." "$sys/include/"
  rm -rf "$sys/include/"*-linux-*
  cp -rL "$root/fs/usr/include/$arch-linux-gnu/." "$sys/include/"
  lib=$root/fs/usr/lib/$arch-linux-gnu gcc=$root/fs/usr/lib/gcc/$arch-linux-gnu/14
  cp "$lib/"{crt1.o,crti.o,crtn.o,libc.a,libmvec.a} "$sys/lib/"
  # libm.a is a linker script naming /usr/lib paths; the archive it names is
  # the library.
  cp "$lib/"libm-2.*.a "$sys/lib/libm.a"
  cp "$gcc/"{crtbeginT.o,crtend.o,libgcc.a,libgcc_eh.a} "$sys/lib/"
done

step "sysroots"
# Clang's freestanding headers (stddef.h, stdarg.h...) and nothing else:
# the intrinsics headers are 8 MB the page would download for nothing.
headers=(float.h inttypes.h iso646.h limits.h stdalign.h stdarg.h stdatomic.h stdbool.h
  stdckdint.h stdcountof.h stddef.h stdint.h stdnoreturn.h tgmath.h varargs.h cpuid.h
  ptrauth.h unwind.h)
hdr=llvm-project/clang/lib/Headers
for arch in x86_64 aarch64; do
  for libc in musl gnu; do
    src=$WORK/sysroot/$arch
    [ $libc = gnu ] && src=$WORK/sysroot-gnu/$arch
    stage=$WORK/stage-$arch-$libc
    rm -rf "$stage" && mkdir -p "$stage/res/include"
    cp -r "$src/include" "$src/lib" "$stage/"
    rm -f "$stage/lib/"{Scrt1.o,rcrt1.o,libcrypt.a,libdl.a,libpthread.a,libresolv.a,librt.a,libutil.a,libxnet.a}
    cp "$WORK/sysroot/$arch/lib/libclang_rt.builtins.a" "$stage/lib/"
    cp "${headers[@]/#/$hdr/}" $hdr/__stdarg_*.h $hdr/__stddef_*.h "$stage/res/include/"
    tar --format=ustar --dereference -C "$stage" -c include lib res | gzip -9 > "$DIST/sysroot-$arch-$libc.tar.gz"
  done
done

ls -la "$DIST"
