#!/usr/bin/env bash
# Builds GHC's half of the Haskell pack: a root file system with GHC 9.14's
# library directory (its package database, interface files and every boot
# package as a WebAssembly shared library, libHSghc.so included), a few
# packages from Hackage built the same way, and libyuki.so (Yuki.hs, the
# pack's GHC API program). The browser loads all of it with GHC's own wasm
# dynamic linker, dyld.mjs, which is copied next to it.
#
#   ghc/build-rootfs.sh OUT
#
# writes OUT/rootfs.tar (everything under /tmp, as the browser's file system
# has it), OUT/dyld.mjs, OUT/post-link.mjs, OUT/prelude.mjs and
# OUT/versions.json, then runs ghc/smoke.mjs against it with Node.
#
# It needs GHC's wasm toolchain (ghc-wasm-meta, ~3 GB installed), which is
# why the pack's build.sh does not run it: CI does
# (.github/workflows/haskell-ghc.yml) and build.sh takes its artifact. The
# toolchain is installed into $GHC_WASM_PREFIX (default ~/.ghc-wasm) from
# ghc-wasm-meta at a pinned commit, whose autogen.json pins each bindist by
# URL and hash.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(realpath -m "${1:?usage: build-rootfs.sh OUT}")
META_REV=8079eb96bbc63823d99ad8acaff0765532625474
FLAVOUR=9.14
PREFIX=${GHC_WASM_PREFIX:-$HOME/.ghc-wasm}
# Everything the browser sees lives under /tmp, the one directory a
# browser_wasi_shim root file system and Node's real one agree on.
ROOT=/tmp/yk-root
STORE=/tmp/yk/store
# Packages from Hackage beyond GHC's boot packages, pinned. Their
# dependencies are pinned by the freeze file next to this script.
PACKAGES=(QuickCheck hspec random)

log() { printf '\n== %s\n' "$*"; }

if [[ ! -x "$PREFIX/wasm32-wasi-ghc/bin/wasm32-wasi-ghc" ]]; then
    log "installing ghc-wasm-meta $META_REV (FLAVOUR=$FLAVOUR) into $PREFIX"
    tmp=$(mktemp -d)
    curl -fsSL --retry 5 "https://github.com/haskell-wasm/ghc-wasm-meta/archive/$META_REV.tar.gz" | tar xz -C "$tmp" --strip-components=1
    FLAVOUR=$FLAVOUR PREFIX=$PREFIX "$tmp/setup.sh"
    rm -rf "$tmp"
fi
# shellcheck disable=SC1091
source "$PREFIX/env"
GHC=wasm32-wasi-ghc
GHC_PKG=wasm32-wasi-ghc-pkg
LIBDIR=$($GHC --print-libdir)
GHC_VERSION=$($GHC --numeric-version)
log "GHC $GHC_VERSION, libdir $LIBDIR"

# GHC runs wasm-opt over every shared library it links when this is set:
# what the GHC test suite's browser playground does for production.
export WASM_SO_OPT="--debuginfo --low-memory-unused --strip-dwarf -Oz"

log "packages: ${PACKAGES[*]}"
mkdir -p "$STORE"
wasm32-wasi-cabal update
PKGDIR=$(mktemp -d)
cp "$HERE/cabal.project.freeze" "$PKGDIR/" 2>/dev/null || true
(
    cd "$PKGDIR"
    wasm32-wasi-cabal --store-dir="$STORE" install --lib --package-env="$PKGDIR/env" \
        --enable-shared --disable-profiling --disable-documentation \
        --ghc-options=-haddock "${PACKAGES[@]}"
)
STOREDB=$(find "$STORE" -maxdepth 2 -name package.db -type d | head -1)
log "store package db: $STOREDB"

log "libyuki.so"
BUILD=$(mktemp -d)
cp "$HERE/Yuki.hs" "$BUILD/"
(cd "$BUILD" && $GHC -v1 -package ghc -shared -dynamic -no-keep-hi-files -no-keep-o-files -O2 Yuki.hs -o "$BUILD/libyuki.so")

log "root file system in $ROOT"
rm -rf "$ROOT"
mkdir -p "$ROOT/tmp/hslib"
# /tmp/clib: the C libraries (libc, libc++, libffi) as shared libraries.
cp -r "$PREFIX/wasi-sdk/share/wasi-sysroot/lib/wasm32-wasi" "$ROOT/tmp/clib"
find "$ROOT/tmp/clib" -type f ! -name '*.so' -delete
find "$ROOT/tmp/clib" -type d -empty -delete
rm -f "$ROOT/tmp/clib/libsetjmp.so" "$ROOT"/tmp/clib/libwasi-emulated-*.so
# /tmp/hslib/lib: GHC's libdir, without what only a native GHC or a static
# link needs.
cp -r "$LIBDIR" "$ROOT/tmp/hslib/lib"
$GHC_PKG --no-user-package-db --global-package-db="$ROOT/tmp/hslib/lib/package.conf.d" unregister --force Cabal Cabal-syntax || true
$GHC_PKG --no-user-package-db --global-package-db="$ROOT/tmp/hslib/lib/package.conf.d" recache
find "$ROOT/tmp/hslib/lib" \( -name '*.hi' -o -name '*.a' -o -name '*.p_hi' -o -name '*.p_dyn_hi' \
    -o -name 'libHS*_p*.so' -o -name 'libHSrts*_debug*.so' -o -name '*.o' \) -delete
rm -rf "$ROOT/tmp/hslib/lib/doc" "$ROOT/tmp/hslib/lib/html" "$ROOT/tmp/hslib/lib/latex" \
    "$ROOT"/tmp/hslib/lib/*.mjs "$ROOT"/tmp/hslib/lib/*.js "$ROOT"/tmp/hslib/lib/*.txt
HS_SEARCHDIR=$(find "$ROOT/tmp/hslib/lib" -type f -name 'libHSbase-*.so' -print0 | xargs -0 -n1 dirname | sed "s|^$ROOT||")
rm -rf "$ROOT$HS_SEARCHDIR"/*Cabal*
# Packages nothing here links and a student's program has no use for:
# haddock's (the API and its markup library), and haskeline and xhtml, which
# only GHCi's line editor and haddock use. ghc-pkg refuses (and the build
# stops) if anything left depends on one.
UNUSED=(haddock-api haddock-library haskeline xhtml)
$GHC_PKG --no-user-package-db --global-package-db="$ROOT/tmp/hslib/lib/package.conf.d" unregister "${UNUSED[@]}"
for p in "${UNUSED[@]}"; do
    rm -rf "$ROOT$HS_SEARCHDIR/$p"-[0-9]* "$ROOT$HS_SEARCHDIR/libHS$p"-[0-9]*
done
$GHC_PKG --no-user-package-db --global-package-db="$ROOT/tmp/hslib/lib/package.conf.d" recache
# The bindist's shared libraries keep their DWARF (libHSghc.so is 170 MB
# with it); stripping it is what makes them as small as GHC's own browser
# build. Not -Oz, as WASM_SO_OPT does for what GHC links here: on
# libHSghc.so that takes more memory than a CI runner has (the runner was
# shut down), and gains little over stripping. Two at a time, for the same
# reason.
find "$ROOT/tmp/hslib/lib" -name '*.so' -print0 | xargs -0 -P 2 -I{} wasm-opt --strip-dwarf --strip-producers {} -o {}
find "$ROOT/tmp/clib" -name '*.so' -print0 | xargs -0 -P "$(nproc)" -I{} wasm-opt --strip-dwarf --strip-producers {} -o {}
# The ghc package's own interface files (36 MB) serve only a program that
# imports the GHC API; libyuki.so needs its shared library, not them.
find "$ROOT$HS_SEARCHDIR" -maxdepth 1 -type d -name 'ghc-[0-9]*' -exec rm -rf {} +
# The store: each package's shared library, interfaces and registration.
mkdir -p "$ROOT$STORE"
cp -r "$STORE"/. "$ROOT$STORE/"
find "$ROOT$STORE" \( -name '*.hi' -o -name '*.a' -o -name '*.o' -o -name '*.p_hi' -o -name '*.p_dyn_hi' -o -name '*.dyn_o' \) -delete
find "$ROOT$STORE" -type d \( -name doc -o -name share \) -prune -exec rm -rf {} +
cp "$BUILD/libyuki.so" "$ROOT/tmp/libyuki.so"

mkdir -p "$OUT"
tar -C "$ROOT" --owner=0 --group=0 --numeric-owner --sort=name --mtime=@0 -cf "$OUT/rootfs.tar" tmp
cp "$LIBDIR"/dyld.mjs "$LIBDIR"/post-link.mjs "$LIBDIR"/prelude.mjs "$OUT/"
# The licences of GHC and of every package in the root file system, as their
# bindist and store have them.
{
    for f in $(find "$PREFIX/wasm32-wasi-ghc" "$STORE" -type f \( -iname 'LICENSE' -o -iname 'LICENSE.*' -o -iname 'COPYING*' \) | sort); do
        printf '==== %s\n\n' "${f#"$PREFIX/"}"
        cat "$f"
        printf '\n\n'
    done
} > "$OUT/LICENSE-ghc-and-libraries.txt"
BINDIST_URL=$(jq -r ".\"wasm32-wasi-ghc-$FLAVOUR\".url" "$PREFIX/../ghc-wasm-meta-autogen.json" 2>/dev/null || true)
cat > "$OUT/versions.json" <<EOF
{
  "ghc": "$GHC_VERSION",
  "ghcWasmMeta": "$META_REV",
  "flavour": "$FLAVOUR",
  "hsSearchDir": "$HS_SEARCHDIR",
  "storeDb": "$STOREDB",
  "packages": "$(printf '%s ' "${PACKAGES[@]}")",
  "bindist": "$BINDIST_URL"
}
EOF
log "sizes"
du -sh "$ROOT/tmp"/* "$ROOT$HS_SEARCHDIR" "$ROOT$STORE"
ls -la "$OUT"
find "$ROOT" -name '*.so' -size +1M -exec ls -la {} + | sort -k5 -n -r | head -20

log "smoke test (Node)"
# Node's WASI sees the real file system, so the root goes where the
# browser's will be.
cp -r "$ROOT/tmp/." /tmp/
timeout 900 node "$HERE/smoke.mjs" "$OUT" "$HS_SEARCHDIR" "$STOREDB" editor
echo world | timeout 900 node "$HERE/smoke.mjs" "$OUT" "$HS_SEARCHDIR" "$STOREDB" runner
(cd "$PKGDIR" && wasm32-wasi-cabal --store-dir="$STORE" freeze "${PACKAGES[@]}" 2>/dev/null && cp cabal.project.freeze "$OUT/") || true
cat "$PKGDIR/env" > "$OUT/package-env" || true

log "compressed siblings"
# The compressed siblings the app's host serves (brotli 11 with a 16 MB
# window: 230 MB take minutes, so here rather than in the pack's build.sh).
if command -v brotli >/dev/null; then brotli -q 11 -w 24 -k -f -o "$OUT/rootfs.tar.br" "$OUT/rootfs.tar"; fi
gzip -9 -n -k -f "$OUT/rootfs.tar"
(cd "$OUT" && sha256sum $(ls | grep -v SHA256SUMS) > SHA256SUMS)
cat "$OUT/SHA256SUMS"
ls -la "$OUT"
