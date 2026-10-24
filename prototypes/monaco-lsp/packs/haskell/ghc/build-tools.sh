#!/usr/bin/env bash
# Builds the Haskell pack's formatter and linter: ormolu and hlint, each as
# a WebAssembly command (wasm32-wasi, statically linked, reading the module
# on stdin) built from Hackage with GHC's wasm toolchain. Both parse with
# ghc-lib-parser, their own copy of GHC's parser, so neither needs the root
# file system: the language server starts one only when the editor asks to
# format, or for hints, and keeps it.
#
#   ghc/build-tools.sh OUT
#
# writes OUT/ormolu.wasm, OUT/hlint.wasm, OUT/hlint/ (hlint's data files:
# its hints), OUT/tools.json (versions) and OUT/LICENSE-tools.txt, then runs
# each once under wasmtime (which ghc-wasm-meta installs).
#
# ghc-lib-parser generates its lexer and parser when it is built, with the
# build machine's alex and happy (the workflow installs them).
#
# Like build-rootfs.sh it needs GHC's wasm toolchain, so it runs in CI
# (.github/workflows/haskell-ghc.yml), which installs it the same way.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(realpath -m "${1:?usage: build-tools.sh OUT}")
META_REV=8079eb96bbc63823d99ad8acaff0765532625474
FLAVOUR=9.14
PREFIX=${GHC_WASM_PREFIX:-$HOME/.ghc-wasm}
STORE=/tmp/yk/tools-store
# Pinned: the formatter's output is the project's style, and hlint's hints
# are what the editor offers.
ORMOLU=0.9.0.0
HLINT=3.10

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
log "GHC $(wasm32-wasi-ghc --numeric-version)"

wasm32-wasi-cabal update
mkdir -p "$OUT" "$STORE"
BIN=$(mktemp -d)
WORK=$(mktemp -d)
build() { # package version exe [cabal flags]
    log "$1 $2"
    (
        cd "$WORK"
        wasm32-wasi-cabal --store-dir="$STORE" install "$1-$2" "${@:4}" \
            --installdir="$BIN" --install-method=copy --overwrite-policy=always \
            --disable-profiling --disable-documentation \
            --with-alex="$(command -v alex)" --with-happy="$(command -v happy)" \
            --ghc-options='-O1'
    )
    wasm-opt --low-memory-unused --strip-dwarf --strip-debug -Oz "$BIN/$3" -o "$OUT/$3.wasm"
    ls -la "$BIN/$3" "$OUT/$3.wasm"
}
build ormolu "$ORMOLU" ormolu
# -gpl: hlint without hscolour (GPL), as its own release builds are.
build hlint "$HLINT" hlint --constraint='hlint -gpl'

# hlint's data files (hlint.yaml and the hints it includes), from the
# package's source: hlint --datadir=/hlint finds them there.
rm -rf "$OUT/hlint"
(cd "$WORK" && wasm32-wasi-cabal get "hlint-$HLINT" >/dev/null)
cp -r "$WORK/hlint-$HLINT"*/data "$OUT/hlint"
(cd "$WORK" && wasm32-wasi-cabal get "ormolu-$ORMOLU" >/dev/null)
{
    printf '==== ormolu %s\n\n' "$ORMOLU"; cat "$WORK/ormolu-$ORMOLU"/LICENSE*
    printf '\n\n==== hlint %s\n\n' "$HLINT"; cat "$WORK/hlint-$HLINT"*/LICENSE*
    printf '\n\nBoth link ghc-lib-parser (GHC'"'"'s parser, BSD-3-Clause) and other Hackage\npackages under BSD-style licences; their licences are in the source\ndistributions on hackage.haskell.org.\n'
} > "$OUT/LICENSE-tools.txt"
cat > "$OUT/tools.json" <<EOF
{ "ormolu": "$ORMOLU", "hlint": "$HLINT", "ghc": "$(wasm32-wasi-ghc --numeric-version)", "ghcWasmMeta": "$META_REV" }
EOF

log "smoke test (wasmtime)"
printf 'module Main where\nmain = do { print  (map (\\x -> x+1) [1,2,3]) ; return () }\n' > "$WORK/A.hs"
wasmtime run "$OUT/ormolu.wasm" --stdin-input-file A.hs < "$WORK/A.hs"
# hlint exits 1 when it has hints, as this module has.
hints=$(wasmtime run --dir "$OUT/hlint::/hlint" --dir "$WORK::/w" "$OUT/hlint.wasm" --datadir=/hlint --json /w/A.hs || true)
echo "$hints"
grep -q '"hint"' <<<"$hints"
ls -la "$OUT"
