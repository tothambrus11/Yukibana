#!/usr/bin/env bash
# Builds the Haskell pack into ../../app/static/packs/haskell/:
#
#   rootfs.tar        GHC $GHC_VERSION for WebAssembly: its library directory
#                     (package database, interface files, every boot package as
#                     a wasm shared library, libHSghc.so among them), QuickCheck,
#                     hspec and random built the same way, the C libraries, and
#                     libyuki.so (ghc/Yuki.hs, the pack's GHC API program).
#                     Built by ghc/build-rootfs.sh (see below), unpacked by the
#                     workers into an in-memory file system
#   dyld.mjs          GHC's wasm dynamic linker, from GHC's libdir, patched to
#                     import ./wasi.js, take the runner's stdio and keep fds 0-2
#                     open (scripts/patch-dyld.mjs)
#   prelude.mjs, post-link.mjs   what dyld.mjs imports, from GHC's libdir
#   wasi.js           browser_wasi_shim (the haskell-wasm fork GHC's browser
#                     tests use), bundled by esbuild
#   ghc.js            ours: starting GHC in a worker, the project's layout
#   server.js         ours: the language server worker
#   runner.js         ours: the Run and Test worker
#   tools.js          ours: running ormolu and hlint for the server
#   ormolu.wasm, hlint.wasm, hlint-data.json   ormolu 0.8.0.2 and hlint 3.10
#                     as WASI commands, and hlint's hint files (ghc/build-tools.sh)
#   manifest.json     versions, GHC's paths, and the files with their sizes
#   LICENSE-*.txt     GHC's and its libraries', the packages', the shim's,
#                     ormolu's and hlint's
#   *.gz, *.br        compressed siblings
#
# GHC's wasm toolchain (ghc-wasm-meta) takes some 3 GB installed, so
# ghc/build-rootfs.sh runs in CI (.github/workflows/haskell-ghc.yml) and
# this script takes what it uploads, the "haskell-ghc-rootfs" artifact, from
# $HASKELL_GHC_ROOTFS (a directory or the artifact's zip), checking each file
# by the sha256 below (of its SHA256SUMS); ormolu and hlint likewise, the
# "haskell-ghc-tools" artifact of .github/workflows/haskell-ghc-tools.yml,
# from $HASKELL_GHC_TOOLS. With the toolchain installed ($GHC_WASM_PREFIX or
# ~/.ghc-wasm), set HASKELL_GHC_ROOTFS=build to build it here instead (the
# hashes then differ: they pin CI's build). Idempotent; the unpacked
# artifact is kept in $PACK_CACHE/haskell (default
# ~/.cache/yukibana-packs/haskell). Needs node 22 and npm.
set -euo pipefail

GHC_VERSION=9.14.1.20260731
# The CI build the pack is made of: its run, and the sha256 of its
# SHA256SUMS, which holds every other file's.
ROOTFS_RUN=40098246484
SUMS_SHA256=b9f4a8933aaa57078b6337f8725c4408d348833cc5e36ea8f32c529dac7a883d
# ormolu and hlint (ghc/build-tools.sh, .github/workflows/haskell-ghc-tools.yml):
# the CI build, and the sha256 of its SHA256SUMS.
TOOLS_RUN=40098246483
TOOLS_SUMS_SHA256=fb197fb0215b158f615519407882ee084c54ea371eeed06a76d3f2c19277fdd1
# browser_wasi_shim: the haskell-wasm fork at the commit GHC's browser tests
# use (ghc-in-browser loads it from esm.sh at this commit).
SHIM_REPO=https://github.com/haskell-wasm/browser_wasi_shim
SHIM_COMMIT=2f86b49dce50916e2984029c535321e34b234229

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/haskell"
PACKS="${PACK_CACHE:-$HOME/.cache/yukibana-packs}"
CACHE="$PACKS/haskell"
mkdir -p "$CACHE" "$OUT"

step() { printf '\n== %s\n' "$*"; }

step "GHC root file system"
ART="$CACHE/ghc-rootfs-$ROOTFS_RUN"
if [ "${HASKELL_GHC_ROOTFS:-}" = build ]; then
    ART="$CACHE/ghc-rootfs-local"
    "$HERE/ghc/build-rootfs.sh" "$ART"
elif [ -n "${HASKELL_GHC_ROOTFS:-}" ]; then
    rm -rf "$ART.part" && mkdir -p "$ART.part"
    if [ -d "$HASKELL_GHC_ROOTFS" ]; then cp -al "$HASKELL_GHC_ROOTFS"/. "$ART.part/" 2>/dev/null || cp -r "$HASKELL_GHC_ROOTFS"/. "$ART.part/"
    else (cd "$ART.part" && unzip -q "$(realpath "$HASKELL_GHC_ROOTFS")"); fi
    rm -rf "$ART" && mv "$ART.part" "$ART"
fi
if [ ! -f "$ART/rootfs.tar" ]; then
    cat >&2 <<EOF
No GHC root file system in $ART.
Download the "haskell-ghc-rootfs" artifact of
https://github.com/tothambrus11/Yukibana/actions/runs/$ROOTFS_RUN
and run HASKELL_GHC_ROOTFS=path/to/haskell-ghc-rootfs.zip $0
(or HASKELL_GHC_ROOTFS=build with GHC's wasm toolchain installed).
EOF
    exit 1
fi
if [ "${HASKELL_GHC_ROOTFS:-}" != build ]; then
    echo "$SUMS_SHA256  $ART/SHA256SUMS" | sha256sum -c --quiet - || { echo "$ART: not the pinned build (run $ROOTFS_RUN)" >&2; exit 1; }
    (cd "$ART" && sha256sum -c --quiet SHA256SUMS) || { echo "$ART: a file differs from its SHA256SUMS" >&2; exit 1; }
fi

step "ormolu and hlint"
TOOLS="$CACHE/ghc-tools-$TOOLS_RUN"
if [ -n "${HASKELL_GHC_TOOLS:-}" ]; then
    rm -rf "$TOOLS.part" && mkdir -p "$TOOLS.part"
    if [ -d "$HASKELL_GHC_TOOLS" ]; then cp -r "$HASKELL_GHC_TOOLS"/. "$TOOLS.part/"
    else (cd "$TOOLS.part" && unzip -q "$(realpath "$HASKELL_GHC_TOOLS")"); fi
    rm -rf "$TOOLS" && mv "$TOOLS.part" "$TOOLS"
fi
if [ -n "$TOOLS_RUN" ] && [ ! -f "$TOOLS/SHA256SUMS" ]; then
    cat >&2 <<EOF
No ormolu and hlint in $TOOLS.
Download the "haskell-ghc-tools" artifact of
https://github.com/tothambrus11/Yukibana/actions/runs/$TOOLS_RUN
and run HASKELL_GHC_TOOLS=path/to/haskell-ghc-tools.zip $0
EOF
    exit 1
fi
if [ -n "$TOOLS_RUN" ]; then
    echo "$TOOLS_SUMS_SHA256  $TOOLS/SHA256SUMS" | sha256sum -c --quiet - || { echo "$TOOLS: not the pinned build (run $TOOLS_RUN)" >&2; exit 1; }
    (cd "$TOOLS" && sha256sum -c --quiet SHA256SUMS) || { echo "$TOOLS: a file differs from its SHA256SUMS" >&2; exit 1; }
else
    echo "no ormolu and hlint pinned: the pack formats nothing and has no hints"
fi

# Everything but rootfs.tar (hard-linked again below) is made anew.
for f in "$OUT"/*; do case "$(basename "$f")" in rootfs.tar*) ;; *) rm -f "$f" ;; esac; done

step "browser_wasi_shim $SHIM_COMMIT"
SHIM="$CACHE/browser_wasi_shim"
if [ "$(git -C "$SHIM" rev-parse HEAD 2>/dev/null)" != "$SHIM_COMMIT" ]; then
    rm -rf "$SHIM"
    git clone -q "$SHIM_REPO" "$SHIM"
    git -C "$SHIM" checkout -q "$SHIM_COMMIT"
fi
cd "$HERE"
[ -x node_modules/.bin/esbuild ] || npm ci --no-audit --no-fund
node_modules/.bin/esbuild "$SHIM/src/index.ts" --bundle --format=esm --target=es2022 --minify --legal-comments=none --log-level=warning --outfile="$OUT/wasi.js"

step "pack files"
# A hard link, not a copy: 230 MB.
[ "$ART/rootfs.tar" -ef "$OUT/rootfs.tar" ] || ln -f "$ART/rootfs.tar" "$OUT/rootfs.tar" 2>/dev/null || cp "$ART/rootfs.tar" "$OUT/rootfs.tar"
for s in br gz; do
    if [ -f "$ART/rootfs.tar.$s" ]; then ln -f "$ART/rootfs.tar.$s" "$OUT/rootfs.tar.$s" 2>/dev/null || cp "$ART/rootfs.tar.$s" "$OUT/"; else rm -f "$OUT/rootfs.tar.$s"; fi
done
cp "$ART/prelude.mjs" "$ART/post-link.mjs" "$OUT/"
node "$HERE/scripts/patch-dyld.mjs" "$ART/dyld.mjs" "$OUT/dyld.mjs"
cp "$HERE"/src/ghc.js "$HERE"/src/server.js "$HERE"/src/runner.js "$OUT/"
for l in "$ART"/LICENSE-*.txt; do [ -f "$l" ] && cp "$l" "$OUT/"; done
cp "$SHIM/LICENSE-MIT" "$OUT/LICENSE-browser_wasi_shim.txt"
cp "$HERE/src/tools.js" "$OUT/"
if [ -n "$TOOLS_RUN" ]; then
    cp "$TOOLS/ormolu.wasm" "$TOOLS/hlint.wasm" "$TOOLS/LICENSE-tools.txt" "$OUT/"
    # hlint's hints, its .yaml data files, as one file the server loads.
    node -e 'const fs = require("fs"), path = require("path"); const dir = process.argv[1]; const out = {}; for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".yaml")) out[f] = fs.readFileSync(path.join(dir, f), "utf8"); fs.writeFileSync(process.argv[2], JSON.stringify(out));' "$TOOLS/hlint" "$OUT/hlint-data.json"
fi

step "manifest and compressed siblings"
node "$HERE/scripts/finish.mjs" "$OUT" "$ART/versions.json"
