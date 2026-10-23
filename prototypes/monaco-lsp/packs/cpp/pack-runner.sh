#!/usr/bin/env bash
# The second half of the runner build (build-runner.sh calls it after the
# LLVM step; it can also run on its own once cc.wasm exists in the cache):
# the WASI sysroot, the test frameworks' libraries (gtest.tar, catch2.tar,
# doctest.tar), runner.js, and the
# files' .gz/.br siblings, all into ../../app/static/packs/cpp/.
set -euo pipefail

# wasi-sdk 30 is the newest release whose libc++ is LLVM 21 (21.1.4), the
# same major version as the clang that compiles against it.
WASI_SDK_VERSION=30
WASI_SYSROOT_SHA256=0c8f3e0acab6d3061834395a16550c359766909fda046af3d9b8cf3bfdb1c2cc
WASI_RT_SHA256=1aaf34d5f30227206d9d6dd3aa0d8af4019a201a1d73fc64a44fe0a6058c54c3

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/cpp"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
B="$CACHE/build-wasm-cc"
mkdir -p "$CACHE/wasi" "$OUT"
cd "$CACHE/wasi"

step() { printf '\n== %s\n' "$*"; }
fetch() { # url sha256 file
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
    mv "$3.part" "$3"
  fi
}

# libc++/libc++abi with exceptions, libunwind, GoogleTest (cached after the
# first run; build.sh has normally run it already).
"$HERE/build-cxx-runtime.sh"
EH="$CACHE/eh"

step "WASI sysroot (wasi-sdk $WASI_SDK_VERSION)"
rel="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_VERSION"
fetch "$rel/wasi-sysroot-$WASI_SDK_VERSION.0.tar.gz" $WASI_SYSROOT_SHA256 sysroot-$WASI_SDK_VERSION.tgz
fetch "$rel/libclang_rt-$WASI_SDK_VERSION.0.tar.gz" $WASI_RT_SHA256 clang_rt-$WASI_SDK_VERSION.tgz
rm -rf x stage && mkdir x stage
tar xzf sysroot-$WASI_SDK_VERSION.tgz -C x "wasi-sysroot-$WASI_SDK_VERSION.0/include/wasm32-wasip1" \
  "wasi-sysroot-$WASI_SDK_VERSION.0/lib/wasm32-wasip1"
tar xzf clang_rt-$WASI_SDK_VERSION.tgz -C x "libclang_rt-$WASI_SDK_VERSION.0/wasm32-unknown-wasip1"
src="x/wasi-sysroot-$WASI_SDK_VERSION.0"
# Laid out as clang's WASI driver expects with --sysroot=/wasi:
#   /wasi/include/wasm32-wasip1          wasi-libc's headers
#   /wasi/include/wasm32-wasip1/c++/v1   libc++: only the files that differ
#       from the language server's copy in sysroot.tar.gz (its __config_site,
#       and cxxabi.h, which that one has no use for); runner.js lays this
#       tree over that one. The rest is byte-identical apart from __config's
#       version number (21.1.4 here, 21.1.8 there), checked below.
#   /wasi/lib/wasm32-wasip1              crt1, libc, ... from wasi-sdk; libc++,
#       libc++abi, libunwind and yukibana-uncaught.o with exceptions, from
#       build-cxx-runtime.sh
#   /usr/lib/clang/21/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a
#       compiler-rt, where -resource-dir=/usr/lib/clang/21 finds it
mkdir -p stage/wasi/include stage/wasi/lib/wasm32-wasip1 stage/usr/lib/clang/21/lib/wasm32-unknown-wasip1
cp -r "$src/include/wasm32-wasip1" stage/wasi/include/
cxx="stage/wasi/include/wasm32-wasip1/c++/v1"
differ=$(diff -rq "$cxx" "$CACHE/cxx-headers/include/c++/v1" | sort || true)
expected="Files $cxx/__config and $CACHE/cxx-headers/include/c++/v1/__config differ
Files $cxx/__config_site and $CACHE/cxx-headers/include/c++/v1/__config_site differ
Only in $cxx: __cxxabi_config.h
Only in $cxx: cxxabi.h"
if [ "$differ" != "$expected" ]; then
  echo "libc++ headers of wasi-sdk $WASI_SDK_VERSION and of sysroot.tar.gz differ more than expected:" >&2
  echo "$differ" >&2
  exit 1
fi
if diff <(sed 's/210104/210108/' "$cxx/__config") "$CACHE/cxx-headers/include/c++/v1/__config" >/dev/null; then :; else
  echo "__config differs in more than the version number" >&2; exit 1
fi
find "$cxx" -type f ! -name __config_site ! -name cxxabi.h ! -name __cxxabi_config.h -delete
find "$cxx" -type d -empty -delete
# Static libraries only (nothing loads a .so), without the LTO bitcode copies;
# debug info stripped (libc++.a goes from 7.5 MB to 1.4 MB).
for f in "$src"/lib/wasm32-wasip1/*.a "$src"/lib/wasm32-wasip1/crt1*.o; do
  "$CACHE/emsdk/upstream/bin/llvm-strip" --strip-debug -o "stage/wasi/lib/wasm32-wasip1/$(basename "$f")" "$f"
done
# C++ exceptions: wasi-sdk's libc++ and libc++abi are built without them
# (no __cxa_throw), so they are replaced by the same libraries built with
# WebAssembly exception handling (build-cxx-runtime.sh; same configuration
# and __config_site otherwise, checked there).
for f in libc++.a libc++abi.a libc++experimental.a libunwind.a yukibana-uncaught.o; do
  cp "$EH/lib/$f" stage/wasi/lib/wasm32-wasip1/
done
"$CACHE/emsdk/upstream/bin/llvm-strip" --strip-debug \
  -o stage/usr/lib/clang/21/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a \
  "x/libclang_rt-$WASI_SDK_VERSION.0/wasm32-unknown-wasip1/libclang_rt.builtins.a"
# The sysroot tarball carries no licence; its VERSION file names wasi-libc
# commit ec0effd769df, whose LICENSE this is (libc++ is under LICENSE-llvm.txt).
fetch https://raw.githubusercontent.com/WebAssembly/wasi-libc/ec0effd769df/LICENSE \
  2711a8b5a5cdfef0e639f96c1aca12ae23d7d64a02d0507f1bdf14d2b27bbc3a LICENSE-wasi-libc.txt
cp LICENSE-wasi-libc.txt "$OUT/LICENSE-wasi-libc.txt"
tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C stage -c wasi usr \
  | gzip -9n > "$OUT/wasi-sysroot.tar.gz"
rm -rf x stage

step "test framework libraries (gtest.tar, catch2.tar, doctest.tar)"
# One archive per framework, fetched by runner.js only to build tests (or a
# program) that include that framework, so a project downloads the one it
# uses. The headers are in sysroot.tar.gz (build.sh), which both workers
# download anyway. Plain tar: its .br/.gz siblings are what travels.
"$HERE/build-test-frameworks.sh"
TESTFW="$CACHE/testfw"
pack_libs() { # archive dir libs...
  local archive=$1 dir=$2; shift 2
  rm -rf stage && mkdir -p stage/wasi/lib/wasm32-wasip1
  for lib in "$@"; do cp "$dir/lib/$lib" stage/wasi/lib/wasm32-wasip1/; done
  tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C stage -c wasi > "$OUT/$archive"
  rm -rf stage
}
pack_libs gtest.tar "$EH" libgtest.a libgtest_main.a
pack_libs catch2.tar "$TESTFW" libCatch2.a libCatch2Main.a
pack_libs doctest.tar "$TESTFW" libdoctest_main.a
cp "$EH/LICENSE-googletest.txt" "$OUT/LICENSE-googletest.txt"
cp "$TESTFW/LICENSE-catch2.txt" "$OUT/LICENSE-catch2.txt"
cp "$TESTFW/LICENSE-doctest.txt" "$OUT/LICENSE-doctest.txt"

step "runner"
if [ -f "$B/bin/llvm.wasm" ]; then
  cp "$B/bin/llvm.wasm" "$OUT/cc.wasm"
  cp "$B/bin/llvm.js" "$OUT/cc.js"
fi
(cd "$HERE" && [ -d node_modules/esbuild ] || npm ci --no-audit --no-fund >/dev/null)
"$HERE/node_modules/.bin/esbuild" "$HERE/src/runner.js" --bundle --outfile="$OUT/runner.js" --format=esm --minify \
  --target=es2022 --external:./cc.js --define:CC_WASM_SIZE="$(stat -c %s "$OUT/cc.wasm" 2>/dev/null || echo 0)" \
  --define:WASI_SYSROOT_SIZE="$(stat -c %s "$OUT/wasi-sysroot.tar.gz")" \
  --define:GTEST_SIZE="$(stat -c %s "$OUT/gtest.tar")" \
  --define:CATCH2_SIZE="$(stat -c %s "$OUT/catch2.tar")" \
  --define:DOCTEST_SIZE="$(stat -c %s "$OUT/doctest.tar")" \
  --define:SYSROOT_SIZE="$(stat -c %s "$OUT/sysroot.tar.gz")" --log-level=warning
files=("$OUT/runner.js" "$OUT/gtest.tar" "$OUT/catch2.tar" "$OUT/doctest.tar")
[ -f "$OUT/cc.wasm" ] && files+=("$OUT/cc.js" "$OUT/cc.wasm")
node "$HERE/compress.mjs" "${files[@]}"
ls -la "$OUT"/runner.js "$OUT"/cc.* "$OUT"/wasi-sysroot.tar.gz "$OUT"/{gtest,catch2,doctest}.tar* 2>/dev/null || true
