#!/usr/bin/env bash
# GoogleTest and RapidCheck for the Linux targets (README, "Targets", Tests),
# into ../../app/static/packs/cpp/targets/<arch>/:
#
#   gtest.tar        usr/lib/<multiarch>/libgtest.a, libgtest_main.a
#   rapidcheck.tar   usr/lib/<multiarch>/librapidcheck.a
#
# where clang's Linux driver finds -lgtest and -lrapidcheck in the target's
# file system. The runner fetches them like the default target's gtest.tar
# and rapidcheck.tar: only for a Test or a program that includes them. The
# headers are the default target's, in sysroot.tar.gz.
#
# The same sources as the default target's libraries, pinned the same way
# (GoogleTest's release tarball by SHA-256, as build-cxx-runtime.sh fetches
# it; RapidCheck's commit and tree hash, as build-test-frameworks.sh does:
# the pins are read from those scripts, so there is one of each). Compiled
# by build-test-libs-linux.mjs with cc-cross.wasm itself, in Node, so the
# libraries come from the compiler, headers and flags a student's tests on
# that target are compiled with; archived with wasi-sdk 30's llvm-ar
# (deterministic, no timestamps). Catch2 and doctest are not built for
# Linux (yet): the runner refuses them there by name.
#
# Needs cc-cross.wasm, sysroot.tar.gz and targets/<arch>/include.tar in
# app/static/packs/cpp (build.sh: build-cross.sh, build-targets.sh), and
# build-cxx-runtime.sh's wasi-sdk. Idempotent: skipped while
# $CACHE/testfw-linux/.built holds the SHA-256 of this script, of
# build-test-libs-linux.mjs, of cc-cross.wasm and of the three include.tar.
# About 6 minutes (111 compiles, one at a time).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/cpp"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
WORK="$CACHE/testfw-linux"
NICE="nice -n 10"
pin() { sed -n "s/^$2=//p" "$HERE/$1"; }
GTEST_VERSION=$(pin build-cxx-runtime.sh GTEST_VERSION)
GTEST_SHA256=$(pin build-cxx-runtime.sh GTEST_SHA256)
RAPIDCHECK_COMMIT=$(pin build-test-frameworks.sh RAPIDCHECK_COMMIT)
RAPIDCHECK_TREE_SHA256=$(pin build-test-frameworks.sh RAPIDCHECK_TREE_SHA256)
WSDK="$CACHE/wasi/wasi-sdk-30.0-x86_64-linux"
ARCHES=(x86_64 aarch64 riscv64)
declare -A MULTIARCH=([x86_64]=x86_64-linux-gnu [aarch64]=aarch64-linux-gnu [riscv64]=riscv64-linux-gnu)

for f in cc-cross.wasm cc-cross.js sysroot.tar.gz "${ARCHES[@]/#/targets/}"; do
  case $f in targets/*) f="$f/include.tar" ;; esac
  [ -f "$OUT/$f" ] || { echo "build-test-frameworks-linux.sh: $OUT/$f is missing (build.sh builds it)" >&2; exit 1; }
done
stamp=$(cat "$HERE/build-test-frameworks-linux.sh" "$HERE/build-test-libs-linux.mjs" "$OUT/cc-cross.wasm" \
  "$OUT"/targets/{x86_64,aarch64,riscv64}/include.tar | sha256sum | cut -d' ' -f1)
if [ "$(cat "$WORK/.built" 2>/dev/null)" = "$stamp" ] && [ -f "$OUT/targets/riscv64/rapidcheck.tar" ]; then
  echo "GoogleTest and RapidCheck for Linux: cached ($WORK)"
  exit 0
fi

"$HERE/build-cxx-runtime.sh" >/dev/null # wasi-sdk (llvm-ar), and GoogleTest's tarball checked
rm -rf "$WORK" && mkdir -p "$WORK"
cd "$WORK"
echo "$GTEST_SHA256  $CACHE/googletest-$GTEST_VERSION.tar.gz" | sha256sum -c --quiet -
tar xzf "$CACHE/googletest-$GTEST_VERSION.tar.gz"
git init -q rapidcheck-src
git -C rapidcheck-src fetch -q --depth 1 https://github.com/emil-e/rapidcheck.git "$RAPIDCHECK_COMMIT"
git -C rapidcheck-src -c advice.detachedHead=false checkout -q FETCH_HEAD
got=$(git -C rapidcheck-src rev-parse HEAD)
[ "$got" = "$RAPIDCHECK_COMMIT" ] || { echo "RapidCheck fetched commit $got, expected $RAPIDCHECK_COMMIT" >&2; exit 1; }
got=$(cd rapidcheck-src && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)
[ "$got" = "$RAPIDCHECK_TREE_SHA256" ] || { echo "RapidCheck's tree hashes to $got, expected $RAPIDCHECK_TREE_SHA256" >&2; exit 1; }

$NICE node "$HERE/build-test-libs-linux.mjs" "$WORK/googletest-$GTEST_VERSION" "$WORK/rapidcheck-src" "$WORK/obj"

for arch in "${ARCHES[@]}"; do
  lib="stage/$arch/usr/lib/${MULTIARCH[$arch]}"
  mkdir -p "$lib"
  for name in gtest gtest_main rapidcheck; do
    (cd "obj/$arch/$name" && LC_ALL=C ls *.o) | sed "s|^|obj/$arch/$name/|" | xargs "$WSDK/bin/llvm-ar" rcsD "$lib/lib$name.a"
  done
  pack() { # archive libs...
    local archive=$1; shift
    tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "stage/$arch" -c \
      "${@/#/usr/lib/${MULTIARCH[$arch]}/}" > "$OUT/targets/$arch/$archive"
  }
  pack gtest.tar libgtest.a libgtest_main.a
  pack rapidcheck.tar librapidcheck.a
done
rm -rf obj stage rapidcheck-src "googletest-$GTEST_VERSION"
echo "$stamp" > "$WORK/.built"
ls -la "$OUT"/targets/*/{gtest,rapidcheck}.tar
