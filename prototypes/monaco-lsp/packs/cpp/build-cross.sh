#!/usr/bin/env bash
# Builds cc-cross.{js,wasm}: clang 21.1.8 and ld.lld (ELF only) in one
# Emscripten binary, for the Linux targets x86-64, AArch64 and RISC-V 64
# (README, "Targets"). It is the runner's and the explorer's compiler for a
# project whose compile_flags.txt names one of those targets; cc.wasm
# (build-runner.sh) stays the WebAssembly compiler, untouched, so a project
# on the default target downloads nothing new.
#
# The configuration is build-runner.sh's, except for what makes it a Linux
# cross compiler:
#
#   LLVM_TARGETS_TO_BUILD=X86;AArch64;RISCV   no WebAssembly, no ARM
#   LLVM_DEFAULT_TARGET_TRIPLE=x86_64-linux-musl
#   LLVM_EXTERNAL_LLD_SOURCE_DIR              a copy of lld/ with
#                                             patches/elf-ld-only.patch
#   CLANG_DEFAULT_{CXX_STDLIB,RTLIB,UNWINDLIB,LINKER}
#                                             libc++, compiler-rt, libunwind,
#                                             lld: the LLVM runtimes that
#                                             build-targets.sh ships
#   -sENVIRONMENT=worker,node                 Node too, for test-targets.mjs
#
# The artifact is kept in $CACHE/artifacts/cc-cross with a STAMP (the
# SHA-256 of the LLVM and Emscripten versions, the cmake arguments and the
# patch), as build-runner.sh keeps cc's; the LLVM step is skipped while it
# matches. pack-runner.sh copies it to cc-cross.{js,wasm}.
#
# CROSS_BUILD_DIR picks the build tree (default $CACHE/build-wasm-cross, a
# fresh tree: about 2500 steps, as long as build-runner.sh's first build).
# Any tree of this LLVM can be reused: switching a tree between this
# configuration and build-runner.sh's rebuilds most of it, because the
# default triple and the native target are in llvm-config.h, which nearly
# every file includes (README, "Targets", Build).
set -euo pipefail

LLVM_VERSION=21.1.8

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
JOBS=${JOBS:-3}
NICE="nice -n 10"
SRC="$CACHE/llvm-project-$LLVM_VERSION.src"
B="${CROSS_BUILD_DIR:-$CACHE/build-wasm-cross}"
LLD="$CACHE/lld-elf-$LLVM_VERSION"
ART="$CACHE/artifacts/cc-cross"
cd "$CACHE"

step() { printf '\n== %s\n' "$*"; }

step "lld sources (ELF only)"
# LLVM's CMake refuses LLVM_ENABLE_PROJECTS=lld unless llvm/../lld exists,
# even with LLVM_EXTERNAL_LLD_SOURCE_DIR pointing elsewhere. build.sh runs
# this script before build-runner.sh, which extracts that directory, so on a
# clean machine it is not there yet: extracted here exactly as
# build-runner.sh does it (with .patched, so that script then keeps it).
if [ ! -f "$SRC/lld/.patched" ]; then
  rm -rf "$SRC/lld"
  tar xJf "llvm-project-$LLVM_VERSION.src.tar.xz" "llvm-project-$LLVM_VERSION.src/lld"
  patch -d "$SRC" -p1 < "$HERE/patches/wasm-ld-only.patch"
  touch "$SRC/lld/.patched"
fi
# A copy of lld/ of its own: build-runner.sh's $SRC/lld is patched to wasm
# only and is never touched here. .patched holds the SHA-256 of the patch
# the copy was made with; a changed patch means a fresh copy.
patch_sha=$(sha256sum < "$HERE/patches/elf-ld-only.patch" | cut -d' ' -f1)
if [ "$(cat "$LLD/.patched" 2>/dev/null)" != "$patch_sha" ]; then
  rm -rf "$LLD" && mkdir -p "$LLD"
  tar xJf "llvm-project-$LLVM_VERSION.src.tar.xz" -C "$LLD" --strip-components=1 "llvm-project-$LLVM_VERSION.src/lld"
  patch -d "$LLD" -p1 < "$HERE/patches/elf-ld-only.patch"
  echo "$patch_sha" > "$LLD/.patched"
fi

step "clang + ld.lld for x86-64, AArch64 and RISC-V 64 Linux"
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null 2>&1
# As build-runner.sh's, with node in ENVIRONMENT: test-targets.mjs drives the
# compiler in Node. The glue grows by its Node branch (README, sizes).
ldflags="-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createCC -sENVIRONMENT=worker,node \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB"
cmake_args=(-G Ninja
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_EXE_LINKER_FLAGS="$ldflags"
  -DCMAKE_EXE_LINKER_FLAGS_MINSIZEREL="-Oz"
  -DLLVM_ENABLE_PROJECTS="clang;lld" -DLLVM_TARGETS_TO_BUILD="X86;AArch64;RISCV"
  -DLLVM_EXTERNAL_LLD_SOURCE_DIR="$LLD/lld"
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON -DLLVM_DISTRIBUTION_COMPONENTS="clang;lld"
  -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten -DLLVM_DEFAULT_TARGET_TRIPLE=x86_64-linux-musl
  -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DCLANG_DEFAULT_RTLIB=compiler-rt -DCLANG_DEFAULT_UNWINDLIB=libunwind
  -DCLANG_DEFAULT_LINKER=lld
  -DLLVM_NATIVE_TOOL_DIR="$CACHE/build-native/bin"
  -DLLVM_TABLEGEN="$CACHE/build-native/bin/llvm-tblgen" -DCLANG_TABLEGEN="$CACHE/build-native/bin/clang-tblgen"
  -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF
  -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF -DLLVM_ENABLE_CURL=OFF
  -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_ENABLE_CRASH_OVERRIDES=OFF -DLLVM_ENABLE_UNWIND_TABLES=OFF
  -DLLVM_ENABLE_PLUGINS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF
  -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_BUILD_UTILS=OFF -DLLVM_INCLUDE_DOCS=OFF
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_OBJC_REWRITER=OFF -DCLANG_PLUGIN_SUPPORT=OFF
  -DCLANG_INCLUDE_TESTS=OFF -DCLANG_INCLUDE_DOCS=OFF)
stamp=$({ echo "llvm $LLVM_VERSION"; emcc --version | head -1; printf '%s\n' "${cmake_args[@]}";
          cat "$HERE/patches/elf-ld-only.patch"; } | sha256sum | cut -d' ' -f1)
if [ "$(cat "$ART/STAMP" 2>/dev/null)" = "$stamp" ] && [ -f "$ART/llvm.wasm" ] && [ -f "$ART/llvm.js" ]; then
  echo "cc-cross.wasm is up to date (artifacts/cc-cross/STAMP $stamp)"
  exit 0
fi
$NICE emcmake cmake -S "$SRC/llvm" -B "$B" "${cmake_args[@]}" >/dev/null
$NICE ninja -C "$B" -j"$JOBS" llvm-driver
mkdir -p "$ART"
rm -f "$ART/STAMP"
cp "$B/bin/llvm.js" "$B/bin/llvm.wasm" "$ART/"
echo "$stamp" > "$ART/STAMP"
ls -l "$ART"
