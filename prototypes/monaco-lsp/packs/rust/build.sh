#!/usr/bin/env bash
# Builds the Rust pack into ../../app/static/packs/rust/. Idempotent: each
# step is skipped when its output is in the cache ($PACK_CACHE, default
# ~/.cache/yukibana-packs). Needs curl, python3, node 22, npm, ar, and
# rustup (the pinned toolchain and the wasm32-wasip1 target are installed
# by this script). First build: about 10 minutes on 4 cores (4 for rust-analyzer's
# crates, most of the rest brotli), ~1 GB of build directory in the cache,
# ~130 MB of downloads.
#
#   server   rust-analyzer's IDE crates (ra_ap_ide, crates.io) and our LSP
#            layer (server/), compiled to wasm32-wasip1 with Rust 1.98.0
#   std-src  core, alloc and std from rust-src 1.98.0 (static.rust-lang.org)
#   runner   Miri compiled to wasm32-wasip1 and its sysroot, from the rubri
#            project at a pinned commit (sha256 of every file checked)
set -euo pipefail

RUST_TOOLCHAIN=1.98.0          # ra_ap_* 0.0.358 needs rustc >= 1.98
# The standard library rust-analyzer reads: the release the server is built
# with. Not Miri's (1.78): rust-analyzer lowers format_args! only the way
# std 1.93 and later expect, and reports every write!/format! of an older
# std as a type error (see README).
RUST_SRC_VERSION=1.98.0
RUST_SRC_SHA256=0e977492aed5ff137815bf9b4b796e8a85b80fb2367ed64e82d5c5839870f2bf
RUBRI_COMMIT=00de75bcec3d8cf5156aef2382c738cbfe069986
RUBRI_URL="https://raw.githubusercontent.com/LyonSyonII/rubri/$RUBRI_COMMIT/example/public/wasm-rustc"
MIRI_WASM=bin/miri.opt.1718474653.wasm

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/rust"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/rust"
NICE="nice -n 10"
mkdir -p "$CACHE" "$OUT"

# 1. The toolchain that builds the server.
if ! rustup run "$RUST_TOOLCHAIN" rustc --print target-list >/dev/null 2>&1 \
    || ! rustup target list --toolchain "$RUST_TOOLCHAIN" --installed | grep -qx wasm32-wasip1; then
    rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-wasip1
fi

# 2. The server: Cargo.lock pins every crate; the target directory is cached.
(cd "$HERE/server" && CARGO_TARGET_DIR="$CACHE/target" $NICE cargo "+$RUST_TOOLCHAIN" build --release --locked --target wasm32-wasip1)
cp "$CACHE/target/wasm32-wasip1/release/yukibana_rust_analyzer.wasm" "$OUT/rust-analyzer.wasm"

# 3. The standard library's sources, for rust-analyzer.
SRC_TAR="$CACHE/rust-src-$RUST_SRC_VERSION.tar.xz"
if [ ! -f "$SRC_TAR" ]; then
    curl -sSfL -o "$SRC_TAR.part" "https://static.rust-lang.org/dist/rust-src-$RUST_SRC_VERSION.tar.xz"
    mv "$SRC_TAR.part" "$SRC_TAR"
fi
echo "$RUST_SRC_SHA256  $SRC_TAR" | sha256sum -c --quiet
LIBRARY="$CACHE/rust-src-$RUST_SRC_VERSION/rust-src/lib/rustlib/src/rust/library"
if [ ! -d "$LIBRARY/core" ]; then
    tar -xJf "$SRC_TAR" -C "$CACHE"
fi
python3 -I "$HERE/scripts/make-sysroot-src.py" "$LIBRARY" "$OUT/std-src.tar"

# 4. The runner's Miri and sysroot, from rubri, every file checked against
#    scripts/rubri.sha256. The rlibs are cut down to their metadata (the
#    `lib.rmeta` member): Miri reads MIR from it and never the object code.
RUBRI="$CACHE/rubri-$RUBRI_COMMIT"
while read -r sum rel; do
    if [ ! -f "$RUBRI/$rel" ]; then
        mkdir -p "$(dirname "$RUBRI/$rel")"
        curl -sSfL -o "$RUBRI/$rel.part" "$RUBRI_URL/$rel"
        mv "$RUBRI/$rel.part" "$RUBRI/$rel"
    fi
    echo "$sum  $RUBRI/$rel" | sha256sum -c --quiet
done < "$HERE/scripts/rubri.sha256"
if [ ! -f "$CACHE/sysroot.tar" ] || [ "$HERE/scripts/rubri.sha256" -nt "$CACHE/sysroot.tar" ]; then
    META="$CACHE/sysroot-meta"
    rm -rf "$META"
    mkdir -p "$META/lib/rustlib/x86_64-unknown-linux-gnu/lib"
    grep '\.rlib\.gz$' "$HERE/scripts/rubri.sha256" | while read -r _ rel; do
        name="$(basename "$rel" .gz)"
        work="$(mktemp -d)"
        gunzip -c "$RUBRI/$rel" > "$work/$name"
        (cd "$work" && ar x "$name" lib.rmeta && ar rcD "$META/lib/rustlib/x86_64-unknown-linux-gnu/lib/$name" lib.rmeta)
        rm -rf "$work"
    done
    tar --format=ustar --owner=0 --group=0 --numeric-owner --mtime=@0 --sort=name -C "$META" -cf "$CACHE/sysroot.tar.part" lib
    mv "$CACHE/sysroot.tar.part" "$CACHE/sysroot.tar"
    rm -rf "$META"
fi
cp "$CACHE/sysroot.tar" "$OUT/sysroot.tar"
gunzip -c "$RUBRI/$MIRI_WASM.gz" > "$OUT/miri.wasm"

# 5. The workers, bundled (the runner's WASI file system comes from npm).
[ -d "$HERE/node_modules/esbuild" ] || (cd "$HERE" && npm ci --no-audit --no-fund)
size() { stat -c %s "$OUT/$1"; }
"$HERE/node_modules/.bin/esbuild" "$HERE/src/server.js" --bundle --format=esm --minify --target=es2022 --log-level=warning \
    --define:SERVER_WASM_SIZE="$(size rust-analyzer.wasm)" --define:STD_SRC_SIZE="$(size std-src.tar)" --outfile="$OUT/server.js"
"$HERE/node_modules/.bin/esbuild" "$HERE/src/runner.js" --bundle --format=esm --minify --target=es2022 --log-level=warning \
    --loader:.rs=text --define:MIRI_WASM_SIZE="$(size miri.wasm)" --define:SYSROOT_SIZE="$(size sysroot.tar)" --outfile="$OUT/runner.js"

# 6. Licences and precompressed siblings.
cp "$HERE/LICENSES.txt" "$OUT/LICENSES.txt"
node "$HERE/scripts/compress.mjs" "$OUT/server.js" "$OUT/runner.js" "$OUT/rust-analyzer.wasm" "$OUT/std-src.tar" "$OUT/miri.wasm" "$OUT/sysroot.tar"
echo "built $(du -sh "$OUT" | cut -f1) into $OUT"
