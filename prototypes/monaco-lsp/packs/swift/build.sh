#!/usr/bin/env bash
# Builds the Swift pack into ../../app/static/packs/swift/:
#
#   server.js      the module Worker (src/server.js, minified): LSP protocol,
#                  documents, UTF-16 <-> UTF-8 positions, a 14-call WASI shim
#   swift-ls.wasm  server/ (Swift, on swift-syntax 604.0.0) compiled to
#                  wasm32-unknown-wasip1 with the swift.org 6.4.1 Wasm SDK,
#                  stripped and wasm-opt -Oz
#   typecheck.js   nested worker of server.js: semantic diagnostics from
#                  swift-frontend.wasm -typecheck
#   runner.js      the runner (../CONTRACT.md "Running a program")
#   swift-frontend.wasm, wasm-ld.wasm
#                  the Swift 6.3.3 compiler frontend and LLVM's wasm-ld built
#                  for a wasm32-wasip1 host by tothambrus11/swift-toolchain-wasm,
#                  release swift-6.3.3-wasm (pinned with SHA-256 below), with their
#                  custom sections (name, DWARF, producers) stripped
#   swift-sysroot.tar
#                  that release's swift-sysroot-core.tar trimmed by
#                  tools/trim-sysroot.mjs to a Foundation-free core
#   plus .gz and .br siblings of every .js, .wasm and .tar
#
# The language server is swift-syntax based, NOT SourceKit-LSP: see
# README.md for why SourceKit-LSP cannot run in a browser.
#
# Idempotent. Caches in $PACK_CACHE/swift (default ~/.cache/yukibana-packs):
# the official Swift toolchain (x86_64 Ubuntu 24.04 build, ~3.5 GB
# unpacked) and the SwiftPM build tree. First build about 15 minutes on 3
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

# The wasm-hosted compiler. "latest" resolved to this tag on 2026-10-23; the
# tag is rebuilt in place upstream ("latest follows a rebuild of the same
# Swift release"), so the checksums, not the tag, are what pins the bytes.
# The .gz assets are downloaded (74 MB instead of 315 MB) and both their
# checksum and that of the decompressed file are verified.
TC_RELEASE=swift-6.3.3-wasm
TC_BASE="https://github.com/tothambrus11/swift-toolchain-wasm/releases/download/$TC_RELEASE"
TC_ARTIFACTS=(
  # name                    sha256 of name.gz                                                  sha256 of name
  "swift-frontend.wasm      e0a1adc961d9ce9d396fd57a113046cfbe475f51af292b20ed042d7c13e85194 5e0b98037d684cf8c336d806021f82c4be69c7b992016d49c260c99efe4ca427"
  "wasm-ld.wasm             773a938c2b7a39de30780e3bd57b109b55e8b6da394c4c4dc8933f331ab5fcb1 00a8d674564664c694dbdc958b915744862a7751a9b1ed48fd68ac2b3c41ec12"
  "swift-sysroot-core.tar   92be8bfe12128b07bce73c0afa540aa8247ff93c2d35508af6646cd29f5d981a 4b112ec0660e84accb13467d04959035388a064aec053dbe998cef9c63eb9314"
)

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
TOOLCHAIN_TGZ="$CACHE/dl/swift-$SWIFT_VERSION-RELEASE-ubuntu24.04.tar.gz"
SDK_TGZ="$CACHE/dl/$SDK_ID.artifactbundle.tar.gz"
fetch "$TOOLCHAIN_URL" $TOOLCHAIN_SHA256 "$TOOLCHAIN_TGZ"
fetch "$SDK_URL" $SDK_SHA256 "$SDK_TGZ"
if [ ! -x "$CACHE/toolchain/usr/bin/swift" ]; then
  rm -rf "$CACHE/toolchain" && mkdir -p "$CACHE/toolchain"
  tar xzf "$TOOLCHAIN_TGZ" -C "$CACHE/toolchain" --strip-components=1
fi
export PATH="$CACHE/toolchain/usr/bin:$PATH"
if ! swift sdk list | grep -qx "$SDK_ID"; then
  swift sdk install "$SDK_TGZ"
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

step "swift-toolchain-wasm $TC_RELEASE: swift-frontend.wasm, wasm-ld.wasm, swift-sysroot-core.tar"
TCDL="$CACHE/toolchain-wasm/dl"
for line in "${TC_ARTIFACTS[@]}"; do
  read -r name gz_sha raw_sha <<<"$line"
  if [ ! -f "$TCDL/$name" ] || ! echo "$raw_sha  $TCDL/$name" | sha256sum -c --quiet - 2>/dev/null; then
    fetch "$TC_BASE/$name.gz" "$gz_sha" "$TCDL/$name.gz"
    gzip -dc "$TCDL/$name.gz" > "$TCDL/$name.part"
    echo "$raw_sha  $TCDL/$name.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $name" >&2; exit 1; }
    mv "$TCDL/$name.part" "$TCDL/$name"
  fi
done

step "strip the compiler and the linker (custom sections only; the code is untouched)"
for name in swift-frontend.wasm wasm-ld.wasm; do
  if [ ! -f "$CACHE/stage/$name" ] || [ "$TCDL/$name" -nt "$CACHE/stage/$name" ]; then
    llvm-objcopy --strip-all "$TCDL/$name" "$CACHE/stage/$name"
  fi
  cp -p "$CACHE/stage/$name" "$OUT/$name"
done

step "trim the sysroot"
if [ ! -f "$CACHE/stage/swift-sysroot.tar" ] || [ "$HERE/tools/trim-sysroot.mjs" -nt "$CACHE/stage/swift-sysroot.tar" ] \
   || [ "$TCDL/swift-sysroot-core.tar" -nt "$CACHE/stage/swift-sysroot.tar" ]; then
  node "$HERE/tools/trim-sysroot.mjs" "$TCDL/swift-sysroot-core.tar" "$CACHE/stage/swift-sysroot.tar"
fi
cp -p "$CACHE/stage/swift-sysroot.tar" "$OUT/swift-sysroot.tar"

step "server.js, typecheck.js, runner.js"
"$HERE/node_modules/.bin/esbuild" "$HERE/src/server.js" --bundle --minify --format=esm --target=es2022 \
  --legal-comments=none --outfile="$OUT/server.js" --log-level=warning
size() { stat -c %s "$OUT/$1"; }
SIZES="{\"swift-frontend.wasm\":$(size swift-frontend.wasm),\"wasm-ld.wasm\":$(size wasm-ld.wasm),\"swift-sysroot.tar\":$(size swift-sysroot.tar)}"
for entry in typecheck runner; do
  "$HERE/node_modules/.bin/esbuild" "$HERE/src/$entry.js" --bundle --minify --format=esm --target=es2022 \
    --define:__SWIFT_TOOLCHAIN_SIZES__="$SIZES" --legal-comments=none --outfile="$OUT/$entry.js" --log-level=warning
done

step "compress"
node "$HERE/compress.mjs" "$OUT"
ls -l "$OUT"
