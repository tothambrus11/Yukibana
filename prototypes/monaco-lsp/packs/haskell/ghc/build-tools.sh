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
# its hints), OUT/tools.json (versions), OUT/LICENSE-tools.txt and
# OUT/SHA256SUMS (every file's), then runs each once under wasmtime (which
# ghc-wasm-meta installs).
#
# ghc-lib-parser generates its lexer and parser when it is built, with the
# build machine's alex and happy (the workflow installs them).
#
# Like build-rootfs.sh it needs GHC's wasm toolchain, so it runs in CI
# (.github/workflows/haskell-ghc-tools.yml), which installs it the same way,
# but GHC 9.12's, not the pack's 9.14: hlint's latest release (3.10, and
# its master) parses with ghc-lib-parser 9.12, whose base stops before
# GHC 9.14's, and the tools are commands of their own, linked with nothing
# of the pack's GHC. ormolu is taken at its last release on the same
# parser, so that one ghc-lib-parser (most of the build) serves both. Both
# then parse what GHC 9.12 parses; what 9.14 added to the language is rare
# in a course's code, and a module neither can parse gets GHC's error from
# the language server all the same.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(realpath -m "${1:?usage: build-tools.sh OUT}")
META_REV=8079eb96bbc63823d99ad8acaff0765532625474
FLAVOUR=9.12
PREFIX=${GHC_WASM_TOOLS_PREFIX:-$HOME/.ghc-wasm-$FLAVOUR}
STORE=/tmp/yk/tools-store
# Pinned: the formatter's output is the project's style, and hlint's hints
# are what the editor offers.
ORMOLU=0.8.0.2
ORMOLU_SHA256=4d89f82ee87c3e4b4cafa490a1a8260ed3f5af1a81a48a43ddfd6fe435a902ba
HLINT=3.10
HLINT_SHA256=d99672337c06b455884ac14418d562701143141d0d7e46af476817c2ae3efe37
# Their dependencies: what Hackage's index offered then.
INDEX_STATE=2026-10-24T00:00:00Z

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

wasm32-wasi-cabal update "hackage.haskell.org,$INDEX_STATE"
mkdir -p "$OUT" "$STORE"
BIN=$(mktemp -d)
WORK=$(mktemp -d)
# Each is built from its source as a local package: their executables ask
# for GHC's threaded RTS (-threaded), which WebAssembly has not, so the flag
# is taken out of the .cabal file first, and with it ormolu's
# -with-rtsopts=-N (as many capabilities as cores), which the
# non-threaded RTS refuses at start-up.
build() { # package version sha256 exe [cabal flags]
    log "$1 $2"
    (
        cd "$WORK"
        curl -fsSL --retry 5 -o "$1-$2.tar.gz" "https://hackage.haskell.org/package/$1-$2/$1-$2.tar.gz"
        echo "$3  $1-$2.tar.gz" | sha256sum -c --quiet -
        tar xzf "$1-$2.tar.gz"
        cd "$1-$2"
        sed -i -e 's/-threaded//g' -e 's/-with-rtsopts=-N\([[:space:]]\|$\)/\1/g' "$1.cabal"
        wasm32-wasi-cabal --store-dir="$STORE" install "exe:$4" "${@:5}" \
            --installdir="$BIN" --install-method=copy --overwrite-policy=always \
            --disable-profiling --disable-documentation \
            --with-alex="$(command -v alex)" --with-happy="$(command -v happy)" \
            --ghc-options='-O1'
    )
    # cabal names a wasm executable X.wasm.
    local exe="$BIN/$4.wasm"
    [[ -f "$exe" ]] || exe="$BIN/$4"
    wasm-opt --low-memory-unused --strip-dwarf --strip-debug -Oz "$exe" -o "$OUT/$4.wasm"
    ls -la "$exe" "$OUT/$4.wasm"
}
build ormolu "$ORMOLU" "$ORMOLU_SHA256" ormolu
# -gpl: hlint without hscolour (GPL), as its own release builds are;
# +ghc-lib: on ghc-lib-parser, as ormolu is, not on the toolchain's ghc.
build hlint "$HLINT" "$HLINT_SHA256" hlint --flags='-gpl +ghc-lib'

# hlint's data files (hlint.yaml and the hints it includes), from the
# package's source: hlint --datadir=/hlint finds them there.
rm -rf "$OUT/hlint"
cp -r "$WORK/hlint-$HLINT/data" "$OUT/hlint"
{
    printf '==== ormolu %s\n\n' "$ORMOLU"; cat "$WORK/ormolu-$ORMOLU"/LICENSE*
    printf '\n\n==== hlint %s\n\n' "$HLINT"; cat "$WORK/hlint-$HLINT"/LICENSE*
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
# Every file's hash, for the pack's build.sh to pin (it pins this file's).
(cd "$OUT" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS)
cat "$OUT/SHA256SUMS"
ls -la "$OUT"
