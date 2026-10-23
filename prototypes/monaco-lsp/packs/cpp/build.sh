#!/usr/bin/env bash
# Builds the C/C++ pack (clangd from LLVM 21.1.8, compiled with Emscripten)
# into ../../app/static/packs/cpp/:
#
#   server.js       the module Worker: transport, file mirroring, loader
#   clangd.js       Emscripten's glue (an ES module server.js imports)
#   clangd.wasm     clangd itself, no threads, JSPI for stdin
#   sysroot.tar.gz  musl and libc++ headers, clang's freestanding headers
#
# and then, through build-runner.sh, what runs a project (README, "Running"):
#
#   runner.js            the module Worker the app starts on Run
#   cc.js, cc.wasm       clang 21.1.8 + wasm-ld, one binary, WebAssembly only
#   wasi-sysroot.tar.gz  wasi-libc, libc++ (wasi-sdk 30) and compiler-rt
#
# Idempotent: each step is skipped when its output is in the cache
# ($PACK_CACHE/cpp, default ~/.cache/yukibana-packs/cpp). Needs a Linux host
# with clang, cmake, ninja, git, curl, python3, make and node 22. Emscripten
# is fetched into the cache. Most of the time is the clangd step: about an
# hour at -j3 on this machine (see README).
#
#   JOBS=3 ./build.sh
set -euo pipefail

LLVM_VERSION=21.1.8
LLVM_SHA256=4633a23617fa31a3ea51242586ea7fb1da7140e426bd62fc164261fe036aa142
MUSL_VERSION=1.2.5
MUSL_SHA256=a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4
EMSDK_VERSION=4.0.22
# The emsdk tag's commit, and the two archives `emsdk install` fetches for it
# (the toolchain, named by the release revision in that commit's
# emscripten-releases-tags.json, and node). emsdk checks no checksums itself
# so they are fetched and checked here and handed to it as kept downloads.
EMSDK_COMMIT=15915cad554b707837024dc2758b6a1c5b94b036
EMSDK_RELEASE=bebaf7e50e31865b0724f17eaa52e161e2dfef5a
EMSDK_BINARIES_SHA256=81219e78defb2f46d12a67a2fa6d128344d850f1e4375b173a324036236b40ef
EMSDK_NODE=node-v22.16.0-linux-x64.tar.xz
EMSDK_NODE_SHA256=f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/cpp"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
JOBS=${JOBS:-3}
NICE="nice -n 10"
SRC="$CACHE/llvm-project-$LLVM_VERSION.src"
mkdir -p "$CACHE" "$OUT"
cd "$CACHE"

step() { printf '\n== %s\n' "$*"; }
fetch() { # url sha256 file
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
    mv "$3.part" "$3"
  fi
}

step "sources"
fetch "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/llvm-project-$LLVM_VERSION.src.tar.xz" \
  $LLVM_SHA256 "llvm-project-$LLVM_VERSION.src.tar.xz"
fetch "https://musl.libc.org/releases/musl-$MUSL_VERSION.tar.gz" $MUSL_SHA256 "musl-$MUSL_VERSION.tar.gz"
# .patched holds the SHA-256 of the patch the tree was made with: a changed
# patch means a fresh tree (ninja then rebuilds only what the patch touches,
# as tar keeps the release's timestamps).
patch_sha=$(sha256sum < "$HERE/patches/clangd-browser.patch" | cut -d' ' -f1)
if [ "$(cat "$SRC/.patched" 2>/dev/null)" != "$patch_sha" ]; then
  rm -rf "$SRC"
  # Only the parts clangd and the libc++ headers are made of (1.9 of 2.4 GB).
  tar xJf "llvm-project-$LLVM_VERSION.src.tar.xz" \
    llvm-project-$LLVM_VERSION.src/{llvm,clang,clang-tools-extra,cmake,third-party,libcxx,libcxxabi,libc,runtimes}
  # Threads off and stdin by JSPI; see the patch's comments and README.
  patch -d "$SRC" -p1 < "$HERE/patches/clangd-browser.patch"
  echo "$patch_sha" > "$SRC/.patched"
fi
[ -d "musl-$MUSL_VERSION" ] || tar xzf "musl-$MUSL_VERSION.tar.gz"
if [ ! -x emsdk/upstream/emscripten/emcc ] || [ "$(git -C emsdk rev-parse HEAD 2>/dev/null)" != "$EMSDK_COMMIT" ]; then
  rm -rf emsdk
  git clone --quiet --depth 1 --branch $EMSDK_VERSION https://github.com/emscripten-core/emsdk
  [ "$(git -C emsdk rev-parse HEAD)" = "$EMSDK_COMMIT" ] || { echo "emsdk $EMSDK_VERSION is not commit $EMSDK_COMMIT" >&2; exit 1; }
  mkdir -p emsdk/downloads
  fetch "https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/$EMSDK_RELEASE/wasm-binaries.tar.xz" \
    $EMSDK_BINARIES_SHA256 "emsdk/downloads/$EMSDK_RELEASE-wasm-binaries.tar.xz"
  fetch "https://storage.googleapis.com/webassembly/emscripten-releases-builds/deps/$EMSDK_NODE" \
    $EMSDK_NODE_SHA256 "emsdk/downloads/$EMSDK_NODE"
  (cd emsdk && EMSDK_KEEP_DOWNLOADS=1 ./emsdk install $EMSDK_VERSION >/dev/null && ./emsdk activate $EMSDK_VERSION >/dev/null)
  rm -rf emsdk/downloads
fi

step "native table generators"
# The wasm build runs these on the host; it cannot run its own.
tools="llvm-tblgen llvm-min-tblgen clang-tblgen clang-tidy-confusable-chars-gen"
if [ ! -x build-native/bin/clang-tidy-confusable-chars-gen ]; then
  [ -f build-native/build.ninja ] || cmake -S "$SRC/llvm" -B build-native -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra" -DLLVM_TARGETS_TO_BUILD=X86 \
    -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DLLVM_USE_LINKER=lld \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF >/dev/null
  # shellcheck disable=SC2086
  $NICE ninja -C build-native -j"$JOBS" $tools
fi

step "clangd for WebAssembly"
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null 2>&1
# No threads: clangd runs with -sync, so it needs neither SharedArrayBuffer
# nor a cross-origin isolated page. The one blocking call left, reading
# stdin, suspends through JSPI. STACK_SIZE: clang's parser recurses deeply
# and Emscripten's default 64 KiB overflows on ordinary code.
ldflags="-sJSPI -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createClangd -sENVIRONMENT=worker \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB"
# Configured on every run: with nothing changed it only rereads the cache,
# and a changed flag (the linker's above, say) reaches the build instead of
# being shadowed by the first run's cache.
$NICE emcmake cmake -S "$SRC/llvm" -B build-wasm -G Ninja \
    -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_EXE_LINKER_FLAGS="$ldflags" \
    -DCMAKE_EXE_LINKER_FLAGS_MINSIZEREL="-Oz" \
    -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra" -DLLVM_TARGETS_TO_BUILD=X86 \
    -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten -DLLVM_DEFAULT_TARGET_TRIPLE=x86_64-linux-musl \
    -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DLLVM_NATIVE_TOOL_DIR="$CACHE/build-native/bin" \
    -DLLVM_TABLEGEN="$CACHE/build-native/bin/llvm-tblgen" -DCLANG_TABLEGEN="$CACHE/build-native/bin/clang-tblgen" \
    -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF \
    -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_ENABLE_CRASH_OVERRIDES=OFF -DLLVM_ENABLE_UNWIND_TABLES=OFF \
    -DLLVM_ENABLE_PLUGINS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_BUILD_UTILS=OFF -DLLVM_INCLUDE_DOCS=OFF \
    -DCLANG_ENABLE_CLANGD=ON -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_OBJC_REWRITER=OFF \
    -DCLANG_PLUGIN_SUPPORT=OFF -DCLANG_INCLUDE_TESTS=OFF -DCLANG_INCLUDE_DOCS=OFF \
    -DCLANG_TIDY_ENABLE_STATIC_ANALYZER=OFF -DCLANGD_TIDY_CHECKS=OFF -DCLANGD_BUILD_DEXP=OFF \
    -DCLANGD_BUILD_XPC=OFF -DCLANGD_ENABLE_REMOTE=OFF -DCLANGD_MALLOC_TRIM=OFF >/dev/null
$NICE ninja -C build-wasm -j"$JOBS" clangd

step "libc++ headers"
# Configured for musl, as the default target is x86_64-linux-musl; only the
# header step runs, nothing is compiled.
if [ ! -f cxx-headers/include/c++/v1/__config_site ]; then
  rm -rf build-cxx cxx-headers
  cmake -S "$SRC/runtimes" -B build-cxx -G Ninja -DLLVM_ENABLE_RUNTIMES=libcxx \
    -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_INSTALL_PREFIX="$CACHE/cxx-headers" \
    -DLIBCXX_HAS_MUSL_LIBC=ON -DLIBCXX_CXX_ABI=none -DLIBCXX_INCLUDE_TESTS=OFF \
    -DLIBCXX_INCLUDE_BENCHMARKS=OFF -DLIBCXX_ENABLE_SHARED=OFF >/dev/null
  ninja -C build-cxx install-cxx-headers >/dev/null
  rm -rf build-cxx
fi

step "sysroot"
# /usr/include: musl; /usr/include/c++/v1: libc++, where clang's Linux driver
# looks for it in a sysroot of /; /usr/lib/clang/21/include: clang's own
# headers, the freestanding ones and nothing else (the x86 intrinsics are
# 8 MB nobody's homework includes).
stage="$CACHE/sysroot"
rm -rf "$stage" && mkdir -p "$stage/usr/include" "$stage/usr/lib/clang/21/include"
make -s -C "musl-$MUSL_VERSION" ARCH=x86_64 prefix=/usr DESTDIR="$stage" install-headers >/dev/null
cp -r cxx-headers/include/c++ "$stage/usr/include/"
hdr="$SRC/clang/lib/Headers"
cp "$hdr"/{float.h,inttypes.h,iso646.h,limits.h,stdalign.h,stdarg.h,stdatomic.h,stdbool.h,stdckdint.h} \
  "$hdr"/{stdcountof.h,stddef.h,stdint.h,stdnoreturn.h,tgmath.h,varargs.h,unwind.h} \
  "$hdr"/__stdarg_*.h "$hdr"/__stddef_*.h "$stage/usr/lib/clang/21/include/"
tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$stage" -c usr \
  | gzip -9n > "$OUT/sysroot.tar.gz"

step "pack"
cp build-wasm/bin/clangd.wasm "$OUT/clangd.wasm"
cp build-wasm/bin/clangd.js "$OUT/clangd.js"
(cd "$HERE" && [ -d node_modules/esbuild ] || npm ci --no-audit --no-fund >/dev/null)
"$HERE/node_modules/.bin/esbuild" "$HERE/src/server.js" --outfile="$OUT/server.js" --format=esm --minify \
  --target=es2022 --define:CLANGD_WASM_SIZE="$(stat -c %s "$OUT/clangd.wasm")" \
  --define:SYSROOT_SIZE="$(stat -c %s "$OUT/sysroot.tar.gz")" --log-level=warning
cp "$SRC/clang-tools-extra/clangd/../LICENSE.TXT" "$OUT/LICENSE-llvm.txt" 2>/dev/null || cp "$SRC/llvm/LICENSE.TXT" "$OUT/LICENSE-llvm.txt"
cp "musl-$MUSL_VERSION/COPYRIGHT" "$OUT/LICENSE-musl.txt"
node "$HERE/compress.mjs" "$OUT/server.js" "$OUT/clangd.js" "$OUT/clangd.wasm"
ls -la "$OUT"

step "runner (clang + wasm-ld, WASI sysroot, runner.js)"
# A separate script so it can run on its own; see README, "Running".
"$HERE/build-runner.sh"
