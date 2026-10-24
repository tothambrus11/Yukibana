#!/usr/bin/env bash
# Builds the Swift pack into ../../app/static/packs/swift/:
#
#   server.js      the module Worker (src/server.js and src/lite.js, minified):
#                  drives sourcekit-lsp-lite in swift-frontend-lsp.wasm, adds
#                  swift-ls.wasm's formatting and semantic tokens
#   swift-ls.wasm  server/ (Swift, on swift-syntax 604.0.0) compiled to
#                  wasm32-unknown-wasip1 with the swift.org 6.4.1 Wasm SDK,
#                  stripped and wasm-opt -Oz: formatting and semantic tokens
#   runner.js      the runner (../CONTRACT.md "Running a program")
#   swift-frontend-lsp.wasm
#                  the Swift 6.3.3 compiler frontend and sourcekitd (with
#                  sourcekit-lsp-lite) in one wasm32-wasip1 reactor, built by
#                  tothambrus11/swift-toolchain-wasm (pinned with SHA-256
#                  below), its custom sections (name, DWARF, producers) stripped
#   wasm-ld.wasm   LLVM's wasm-ld from the same project, stripped likewise
#   SwiftMacroPlugins.wasm
#                  the macro plugins (StringifyMacros, ObservationMacros,
#                  swift-testing's TestingMacros) from the same release,
#                  stripped likewise; fetched by projects that use a macro
#   swift-sysroot.tar
#                  that release's swift-sysroot-core.tar trimmed by
#                  tools/trim-sysroot.mjs to a Foundation-free core
#   swift-testing.tar
#                  swift-testing from the swift.org Swift 6.3.3 Wasm SDK (the
#                  one that release is built with): Testing's module and
#                  archives and the FoundationEssentials it links; fetched by
#                  projects that import Testing
#   swift-xctest.tar
#                  the browser's XCTest (xctest/XCTest/*.swift): its
#                  .swiftmodule and libXCTest.a, built by
#                  tools/build-xctest.mjs with the swift-frontend-lsp.wasm above
#                  (a binary module loads only in the compiler that wrote it)
#   plus .gz and .br siblings of every .js, .wasm, .tar and .json
#
# SWIFT_TOOLCHAIN_DIR=<dir> takes swift-toolchain-wasm's files from <dir>
# (an unpacked CI artifact, or out/ of a local build) instead of a release,
# unverified: any of swift-frontend-lsp.wasm, wasm-ld.wasm,
# swift-sysroot-core.tar and SwiftMacroPlugins.wasm found there wins.
#
# Idempotent. Caches in $PACK_CACHE/swift (default ~/.cache/yukibana-packs):
# the official Swift toolchain (x86_64 Ubuntu 24.04 build, ~3.5 GB
# unpacked; its 1.2 GB download is deleted once unpacked) and the SwiftPM
# build tree. First build about 15 minutes on 3
# cores (8 of them compiling swift-syntax, 3 in wasm-opt); afterwards a
# change to server/ rebuilds in about 3 (mostly wasm-opt). Needs curl, tar, node 22, npm.
#
#   JOBS=3 ./build.sh
set -euo pipefail

SWIFT_VERSION=6.4.1
TOOLCHAIN_URL="https://download.swift.org/swift-$SWIFT_VERSION-release/ubuntu2404/swift-$SWIFT_VERSION-RELEASE/swift-$SWIFT_VERSION-RELEASE-ubuntu24.04.tar.gz"
TOOLCHAIN_SHA256=7d246c7114077ad01dba4ad897628446ada4c489d6c7dbcf39ae3f25cbe17e8b
SDK_URL="https://download.swift.org/swift-$SWIFT_VERSION-release/wasm-sdk/swift-$SWIFT_VERSION-RELEASE/swift-$SWIFT_VERSION-RELEASE_wasm.artifactbundle.tar.gz"
SDK_SHA256=783e6128d174d9f975b4eda68be02a5960681b723ef372e6876a7c2543a365d8
SDK_ID="swift-$SWIFT_VERSION-RELEASE_wasm"

# The wasm-hosted compiler, from swift-toolchain-wasm's releases. A tag can
# be rebuilt in place upstream ("latest follows a rebuild of the same Swift
# release"), so the checksums, not the tag, are what pins the bytes. The .gz
# assets are downloaded (a quarter of the size) and both their checksum and
# that of the decompressed file are verified.
#
# Everything is from swift-6.3.3-wasm-3, the first release built with macro
# support (published 2026-10-24 by build-toolchain.yml): every compiler
# module imports swift_plugin_host.*, which src/vendor/swift-plugin-host.mjs
# answers (its SHA-256 is that release's swift-plugin-host.mjs, checked
# below). Its wasm-ld.wasm is byte for byte swift-6.3.3-wasm's.
TC_DOWNLOADS=https://github.com/tothambrus11/swift-toolchain-wasm/releases/download
TC_RELEASE=swift-6.3.3-wasm-3
TC_ARTIFACTS=(
  # name                    sha256 of name.gz                                                  sha256 of name
  "swift-frontend-lsp.wasm  bc15eef10acd209ca86c7418ea66d77cfc262f23dad029ca608f597aab4626e1 83ed6dbb5b6fc5623b2c2c4f3e18e172435086f3c1286bedd0eeb947756aaba4"
  "wasm-ld.wasm             94b6857d0a7db57a9e0201aec9da4f594fa908f85370356c00c43bd1a253cae5 00a8d674564664c694dbdc958b915744862a7751a9b1ed48fd68ac2b3c41ec12"
  "swift-sysroot-core.tar   4d1d621c89b6311241b888184a235e37c1beec202f17ae99771bfc19f352644b 21484c6bbd9fae498673001ae8b268b7b83e6a3cdfc80016f5c04b1d5208b06c"
  "SwiftMacroPlugins.wasm   3550aab0000a84f90a3a53a7e931612c7fc89be7a5e4492d6482e7a87e43849d 2435499031881c60a2034849ee8f6b5645b879fbfd757b27281ed9325ea6ad33"
)
PLUGIN_HOST_SHA256=ae445e4a0f98f55b5bcebe7acaa14ca93908625ca04e36b38b9f4d2767f087c4

# swift-testing.tar is made from the Wasm SDK the toolchain release is built
# against (swift-toolchain-wasm env.sh pins the same file and checksum).
TESTING_SDK_URL="https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz"
TESTING_SDK_SHA256=cabfa08b73bb8ac783927ecd15fa386e99d0c139c5f232445067bcf58379cae7

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/swift"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/swift"
JOBS=${JOBS:-3}
NICE="nice -n 10"
mkdir -p "$CACHE/dl" "$CACHE/stage" "$CACHE/toolchain-wasm/dl" "$OUT"

step() { printf '\n== %s\n' "$*"; }
fetch() { # url sha256 file
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
    mv "$3.part" "$3"
  fi
}

step "Swift $SWIFT_VERSION toolchain and Wasm SDK"
# Downloaded only when missing, and deleted once installed.
TOOLCHAIN_TGZ="$CACHE/dl/swift-$SWIFT_VERSION-RELEASE-ubuntu24.04.tar.gz"
SDK_TGZ="$CACHE/dl/$SDK_ID.artifactbundle.tar.gz"
if [ ! -x "$CACHE/toolchain/usr/bin/swift" ]; then
  fetch "$TOOLCHAIN_URL" $TOOLCHAIN_SHA256 "$TOOLCHAIN_TGZ"
  rm -rf "$CACHE/toolchain" && mkdir -p "$CACHE/toolchain"
  tar xzf "$TOOLCHAIN_TGZ" -C "$CACHE/toolchain" --strip-components=1
  rm -f "$TOOLCHAIN_TGZ"
fi
export PATH="$CACHE/toolchain/usr/bin:$PATH"
if ! swift sdk list | grep -qx "$SDK_ID"; then
  fetch "$SDK_URL" $SDK_SHA256 "$SDK_TGZ"
  swift sdk install "$SDK_TGZ"
  rm -f "$SDK_TGZ"
fi

step "node tools (binaryen, esbuild)"
cd "$HERE"
[ -x node_modules/.bin/wasm-opt ] && [ -d node_modules/@bjorn3/browser_wasi_shim ] || npm ci --cache "$CACHE/npm" --no-audit --no-fund

step "swift build (swift-syntax + server/, wasm32-unknown-wasip1, release)"
cd "$HERE/server"
$NICE swift build -c release --swift-sdk "$SDK_ID" -j "$JOBS" --scratch-path "$CACHE/build"
WASM="$(find "$CACHE/build" -path '*Release*' -name YKSwift.wasm | head -1)"

step "strip + wasm-opt -Oz"
if [ ! -f "$CACHE/stage/swift-ls.wasm" ] || [ "$WASM" -nt "$CACHE/stage/swift-ls.wasm" ]; then
  llvm-objcopy --strip-all "$WASM" "$CACHE/stage/stripped.wasm"
  $NICE "$HERE/node_modules/.bin/wasm-opt" -Oz --strip-debug --strip-producers \
    --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int \
    "$CACHE/stage/stripped.wasm" -o "$CACHE/stage/swift-ls.wasm"
  rm -f "$CACHE/stage/stripped.wasm"
fi
cp "$CACHE/stage/swift-ls.wasm" "$OUT/swift-ls.wasm"

step "swift-toolchain-wasm $TC_RELEASE: swift-frontend-lsp.wasm, wasm-ld.wasm, swift-sysroot-core.tar, SwiftMacroPlugins.wasm"
echo "$PLUGIN_HOST_SHA256  $HERE/src/vendor/swift-plugin-host.mjs" | sha256sum -c --quiet - ||
  { echo "src/vendor/swift-plugin-host.mjs is not $TC_RELEASE's swift-plugin-host.mjs" >&2; exit 1; }
TCDL="$CACHE/toolchain-wasm/dl"
release=$TC_RELEASE
for line in "${TC_ARTIFACTS[@]}"; do
  read -r name gz_sha raw_sha <<<"$line"
  if [ -n "${SWIFT_TOOLCHAIN_DIR:-}" ] && [ -f "$SWIFT_TOOLCHAIN_DIR/$name" ]; then
    if ! cmp -s "$SWIFT_TOOLCHAIN_DIR/$name" "$TCDL/$name"; then
      echo "$name from $SWIFT_TOOLCHAIN_DIR (not verified)"
      cp "$SWIFT_TOOLCHAIN_DIR/$name" "$TCDL/$name.part" && mv "$TCDL/$name.part" "$TCDL/$name"
    fi
  elif [ "$raw_sha" = PENDING ]; then
    echo "$name: release $release is not published yet; set SWIFT_TOOLCHAIN_DIR to a directory with it (README \"Building\")" >&2
    exit 1
  elif [ ! -f "$TCDL/$name" ] || ! echo "$raw_sha  $TCDL/$name" | sha256sum -c --quiet - 2>/dev/null; then
    fetch "$TC_DOWNLOADS/$release/$name.gz" "$gz_sha" "$TCDL/$name.gz"
    gzip -dc "$TCDL/$name.gz" > "$TCDL/$name.part"
    rm -f "$TCDL/$name.gz"
    echo "$raw_sha  $TCDL/$name.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $name" >&2; exit 1; }
    mv "$TCDL/$name.part" "$TCDL/$name"
  fi
done

step "strip the compiler, the linker and the macro plugins (custom sections only; the code is untouched)"
for name in swift-frontend-lsp.wasm wasm-ld.wasm SwiftMacroPlugins.wasm; do
  if [ ! -f "$CACHE/stage/$name" ] || [ "$TCDL/$name" -nt "$CACHE/stage/$name" ]; then
    llvm-objcopy --strip-all "$TCDL/$name" "$CACHE/stage/$name"
  fi
  cp -p "$CACHE/stage/$name" "$OUT/$name"
done
# What earlier builds wrote and nothing loads any more.
rm -f "$OUT"/swift-frontend.wasm{,.gz,.br} "$OUT"/swift-stdlib-index.json{,.gz,.br} "$OUT"/typecheck.js{,.gz,.br}

step "trim the sysroot"
if [ ! -f "$CACHE/stage/swift-sysroot.tar" ] || [ "$HERE/tools/trim-sysroot.mjs" -nt "$CACHE/stage/swift-sysroot.tar" ] \
   || [ "$TCDL/swift-sysroot-core.tar" -nt "$CACHE/stage/swift-sysroot.tar" ]; then
  node "$HERE/tools/trim-sysroot.mjs" "$TCDL/swift-sysroot-core.tar" "$CACHE/stage/swift-sysroot.tar"
fi
cp -p "$CACHE/stage/swift-sysroot.tar" "$OUT/swift-sysroot.tar"

step "swift-testing from the Swift 6.3.3 Wasm SDK"
# Testing's module (its .swiftinterface: the SDK has no binary module) and
# the archives a test program links: libTesting.a's autolink entries, and
# theirs, that the core sysroot lacks (src/toolchain.js linkLibraries).
# Foundation, FoundationInternationalization, CoreFoundation and ICU are
# autolinked too but never reached, so they are left out (README "Macros").
TESTING="$CACHE/stage/swift-testing.tar"
if [ ! -f "$TESTING" ]; then
  SDK_DL="$CACHE/dl/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz"
  fetch "$TESTING_SDK_URL" $TESTING_SDK_SHA256 "$SDK_DL"
  W=swift-6.3.3-RELEASE_wasm.artifactbundle/swift-6.3.3-RELEASE_wasm/wasm32-unknown-wasip1/swift.xctoolchain/usr/lib/swift_static/wasi
  T="$CACHE/stage/testing" && rm -rf "$T" && mkdir -p "$T"
  tar xzf "$SDK_DL" -C "$T" \
    "$W/Testing.swiftmodule/wasm32-unknown-wasip1.swiftinterface" "$W/Testing.swiftmodule/wasm32-unknown-wasip1.swiftdoc" \
    "$W/libTesting.a" "$W/lib_TestDiscovery.a" "$W/lib_TestingInternals.a" "$W/lib_TestingInterop.a" \
    "$W/libFoundationEssentials.a" "$W/lib_FoundationCShims.a" "$W/lib_FoundationCollections.a"
  mkdir -p "$T/swift/lib/swift_static" && mv "$T/$W" "$T/swift/lib/swift_static/wasi"
  tar --format=ustar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf "$TESTING.part" -C "$T" swift
  mv "$TESTING.part" "$TESTING"
  rm -rf "$T" "$SDK_DL"
fi
cp -p "$TESTING" "$OUT/swift-testing.tar"

step "XCTest for the browser (swift-frontend-lsp.wasm under node)"
XCT="$CACHE/stage/swift-xctest.tar"
if [ ! -f "$XCT" ] || [ -n "$(find "$HERE/xctest/XCTest" "$HERE/tools/build-xctest.mjs" "$HERE/src/toolchain.js" "$CACHE/stage/swift-frontend-lsp.wasm" \
     "$CACHE/stage/swift-sysroot.tar" -newer "$XCT" -print -quit)" ]; then
  $NICE node "$HERE/tools/build-xctest.mjs" "$CACHE/stage" "$CACHE/stage/swift-sysroot.tar" "$XCT"
fi
cp -p "$XCT" "$OUT/swift-xctest.tar"

step "server.js, runner.js"
size() { stat -c %s "$OUT/$1"; }
SIZES="{\"swift-frontend-lsp.wasm\":$(size swift-frontend-lsp.wasm),\"wasm-ld.wasm\":$(size wasm-ld.wasm),\"swift-sysroot.tar\":$(size swift-sysroot.tar),\"swift-xctest.tar\":$(size swift-xctest.tar),\"SwiftMacroPlugins.wasm\":$(size SwiftMacroPlugins.wasm),\"swift-testing.tar\":$(size swift-testing.tar)}"
for entry in server runner; do
  "$HERE/node_modules/.bin/esbuild" "$HERE/src/$entry.js" --bundle --minify --format=esm --target=es2022 \
    --define:__SWIFT_TOOLCHAIN_SIZES__="$SIZES" --legal-comments=none --outfile="$OUT/$entry.js" --log-level=warning
done

step "compress"
node "$HERE/compress.mjs" "$OUT"
ls -l "$OUT"
