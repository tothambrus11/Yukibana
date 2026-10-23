#!/usr/bin/env bash
# Builds the two test frameworks the runner offers besides GoogleTest (which
# build-cxx-runtime.sh builds), for wasm32-wasip1 with the same flags, into
# $PACK_CACHE/cpp/testfw/ (see README, "Running", Tests):
#
#   lib/libCatch2.a, libCatch2Main.a   Catch2 3.16.1, static, as its CMake
#                                      build makes them
#   lib/libdoctest_main.a              doctest 2.5.3's implementation and main
#                                      (DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN):
#                                      doctest is header-only, and this is the
#                                      one translation unit a project would
#                                      otherwise compile with every Test
#   include/catch2/, include/doctest/  their headers (Catch2's with the
#                                      catch_user_config.hpp this build
#                                      generated); build.sh puts them in
#                                      sysroot.tar.gz, for clangd and runner.js
#
# pack-runner.sh packs each framework's libraries into an archive of its own
# (catch2.tar, doctest.tar), fetched by runner.js only for a project whose
# tests include that framework.
#
# Sources are pinned: Catch2 by the commit its v3.16.1 tag names (a shallow
# clone of the tag, checked against it: GitHub's source archives are not
# reachable from the build machine, and Catch2 publishes no source tarball of
# its own), doctest by the SHA-256 of doctest.h at its v2.5.3 commit.
#
# Compiled with wasi-sdk 30's clang (fetched by build-cxx-runtime.sh, which
# runs first) and the flags the runner compiles C++ with: WebAssembly
# exception handling in its standard form, and libc++'s fast hardening.
#
# Idempotent: skipped when $CACHE/testfw/.built holds the SHA-256 of this
# script. About a minute at -j3.
set -euo pipefail

WASI_SDK_VERSION=30
CATCH2_VERSION=3.16.1
CATCH2_COMMIT=08092139210881f01a34e60c5f2fd6afa0ea4024
DOCTEST_VERSION=2.5.3
DOCTEST_COMMIT=2d0a9359a60c51affe2a9bebb1be1dca47868151
DOCTEST_H_SHA256=cfd518a3ef90f67e1f3ba514df23fb3627437de1a2feeba78cf5062a40021421
DOCTEST_LICENSE_SHA256=0fe0b331fa1513dcce8604ff1fa925f32d1cea17d8aeb1c2471fad40d291adc5

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
JOBS=${JOBS:-3}
NICE="nice -n 10"
OUT="$CACHE/testfw"
mkdir -p "$CACHE/dl"
cd "$CACHE"

step() { printf '\n== %s\n' "$*"; }
fetch() { # url sha256 file
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
    mv "$3.part" "$3"
  fi
}

stamp=$(sha256sum "$HERE/build-test-frameworks.sh" | cut -d' ' -f1)
if [ "$(cat "$OUT/.built" 2>/dev/null)" = "$stamp" ]; then
  echo "Catch2 and doctest: cached in $OUT"
  exit 0
fi

"$HERE/build-cxx-runtime.sh" >/dev/null # wasi-sdk's clang
WSDK="$CACHE/wasi/wasi-sdk-$WASI_SDK_VERSION.0-x86_64-linux"
EHFLAGS="-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false"
TARGET="--target=wasm32-wasip1 --sysroot=$WSDK/share/wasi-sysroot"
rm -rf "$OUT" build-catch2 "Catch2-$CATCH2_VERSION" && mkdir -p "$OUT/lib" "$OUT/include/doctest"

step "Catch2 $CATCH2_VERSION"
git -c advice.detachedHead=false clone -q --depth 1 --branch "v$CATCH2_VERSION" \
  https://github.com/catchorg/Catch2.git "Catch2-$CATCH2_VERSION"
got=$(git -C "Catch2-$CATCH2_VERSION" rev-parse HEAD)
[ "$got" = "$CATCH2_COMMIT" ] || { echo "Catch2 v$CATCH2_VERSION is commit $got, expected $CATCH2_COMMIT" >&2; exit 1; }
# C++17, so the library has the std::string_view and std::byte support a
# project compiled as C++17 or later expects of it (Catch2's headers turn
# those on by the standard they are compiled with). No POSIX signals: WASI
# has none (a crash ends the program, and the runner reports it). Static,
# reproducible (no build paths in the library), no install of docs or extras.
$NICE cmake -S "Catch2-$CATCH2_VERSION" -B build-catch2 -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$WSDK/share/cmake/wasi-sdk-p1.cmake" -DWASI_SDK_PREFIX="$WSDK" \
  -DCMAKE_SYSROOT="$WSDK/share/wasi-sysroot" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=17 -DCMAKE_CXX_STANDARD_REQUIRED=ON -DCMAKE_CXX_EXTENSIONS=OFF \
  -DCMAKE_CXX_FLAGS="$EHFLAGS -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST" \
  -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG" \
  -DCATCH_CONFIG_NO_POSIX_SIGNALS=ON -DCATCH_ENABLE_REPRODUCIBLE_BUILD=ON \
  -DCATCH_INSTALL_DOCS=OFF -DCATCH_INSTALL_EXTRAS=OFF -DBUILD_TESTING=OFF \
  -DCMAKE_INSTALL_PREFIX="$CACHE/build-catch2/install" >/dev/null
$NICE ninja -C build-catch2 -j"$JOBS" --quiet Catch2 Catch2WithMain
ninja -C build-catch2 install >/dev/null
for lib in libCatch2.a libCatch2Main.a; do
  "$WSDK/bin/llvm-strip" --strip-debug -o "$OUT/lib/$lib" "build-catch2/install/lib/$lib"
done
# The installed headers include the generated catch_user_config.hpp, which
# records the options above (CATCH_CONFIG_NO_POSIX_SIGNALS); the editor and
# the runner see the same configuration as the library.
cp -r build-catch2/install/include/catch2 "$OUT/include/"
cp "Catch2-$CATCH2_VERSION/LICENSE.txt" "$OUT/LICENSE-catch2.txt"
rm -rf build-catch2 "Catch2-$CATCH2_VERSION"

step "doctest $DOCTEST_VERSION"
raw="https://raw.githubusercontent.com/doctest/doctest/$DOCTEST_COMMIT"
fetch "$raw/doctest/doctest.h" $DOCTEST_H_SHA256 "dl/doctest-$DOCTEST_VERSION.h"
fetch "$raw/LICENSE.txt" $DOCTEST_LICENSE_SHA256 "dl/doctest-$DOCTEST_VERSION-LICENSE.txt"
# One line changed: doctest turns its exception support off for any WASI
# target (`|| defined(__wasi__)`), from before WASI had exceptions, so
# CHECK_THROWS_AS would be a static_assert failure and an exception escaping
# a test would end the run. Here programs are compiled with WebAssembly
# exception handling, which clang announces as __wasm_exception_handling__;
# without it (-fno-exceptions) doctest's own test still applies.
sed 's/ || defined(__wasi__)$/ || (defined(__wasi__) \&\& !defined(__wasm_exception_handling__))/' \
  "dl/doctest-$DOCTEST_VERSION.h" > "$OUT/include/doctest/doctest.h"
[ "$(diff "dl/doctest-$DOCTEST_VERSION.h" "$OUT/include/doctest/doctest.h" | grep -c '^>')" = 1 ] || \
  { echo "doctest.h: the __wasi__ exception check was not found exactly once" >&2; exit 1; }
cp "dl/doctest-$DOCTEST_VERSION-LICENSE.txt" "$OUT/LICENSE-doctest.txt"
# The implementation and main in one object, as doctest's documentation has
# a project write it. Without POSIX signals (WASI has none); C++17 for the
# same reason as Catch2.
mkdir -p build-doctest
printf '#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN\n#include <doctest/doctest.h>\n' > build-doctest/doctest_main.cpp
$NICE "$WSDK/bin/clang++" $TARGET $EHFLAGS -std=c++17 -O2 -DNDEBUG -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST \
  -DDOCTEST_CONFIG_NO_POSIX_SIGNALS -I"$OUT/include" -c build-doctest/doctest_main.cpp -o build-doctest/doctest_main.o
rm -f "$OUT/lib/libdoctest_main.a"
"$WSDK/bin/llvm-ar" rcs "$OUT/lib/libdoctest_main.a" build-doctest/doctest_main.o
rm -rf build-doctest

echo "$stamp" > "$OUT/.built"
ls -la "$OUT/lib"
du -sh "$OUT/include/"*
