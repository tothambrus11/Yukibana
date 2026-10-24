#!/usr/bin/env bash
# Builds the Kotlin pack into ../../app/static/packs/kotlin/:
#
#   tree-sitter.js, tree-sitter.wasm   web-tree-sitter $WEB_TREE_SITTER_VERSION (the
#                                      tree-sitter runtime, compiled to WebAssembly)
#   tree-sitter-kotlin.wasm            the Kotlin grammar (tree-sitter-grammars/
#                                      tree-sitter-kotlin $KOTLIN_GRAMMAR_VERSION), as published
#   server.js                          the language server worker (src/server.js)
#   manifest.json                      file names, sizes and versions
#   LICENSE-*.txt                      both packages' licences (MIT)
#   *.gz, *.br                         compressed siblings
#
# There is no runner: nothing compiles Kotlin in a browser (README.md, "Why
# no Run"). Idempotent; the npm tarballs are cached in $PACK_CACHE/kotlin
# (default ~/.cache/yukibana-packs/kotlin) and checked against the
# registry's sha512. Needs curl, node 18+ and python3.
set -euo pipefail

WEB_TREE_SITTER_VERSION=0.25.10
WEB_TREE_SITTER_SHA512=Y09sF44/13XvgVKgO2cNDw5rGk6s26MgoZPXLESvMXeefBf7i6/73eFurre0IsTW6E14Y0ArIzhUMmjoc7xyzA==
KOTLIN_GRAMMAR_VERSION=1.1.0
KOTLIN_GRAMMAR_SHA512=vlVXaxEE8t2kpJgfZpa8XVvxcnKw9AYtRTgy7KWjsDmAsadk06RxAT80IXOgGQnmM9i/orQn1nD84gPNUHu6DQ==
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/kotlin"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/kotlin"
mkdir -p "$CACHE" "$OUT"

fetch() { # fetch <url> <file> <sha512 base64>: into $CACHE, verified
    local dst="$CACHE/$2"
    if [ ! -f "$dst" ]; then
        curl -fsSL -o "$dst.part" "$1"
        mv "$dst.part" "$dst"
    fi
    if [ "$(openssl dgst -sha512 -binary "$dst" | base64 -w0)" != "$3" ]; then
        rm -f "$dst"
        echo "checksum mismatch: $2" >&2
        exit 1
    fi
}
fetch "$REGISTRY/web-tree-sitter/-/web-tree-sitter-$WEB_TREE_SITTER_VERSION.tgz" \
    "web-tree-sitter-$WEB_TREE_SITTER_VERSION.tgz" "$WEB_TREE_SITTER_SHA512"
fetch "$REGISTRY/@tree-sitter-grammars/tree-sitter-kotlin/-/tree-sitter-kotlin-$KOTLIN_GRAMMAR_VERSION.tgz" \
    "tree-sitter-kotlin-$KOTLIN_GRAMMAR_VERSION.tgz" "$KOTLIN_GRAMMAR_SHA512"

# Only the files the pack serves, straight from the tarballs.
python3 -I "$HERE/scripts/extract.py" "$CACHE/web-tree-sitter-$WEB_TREE_SITTER_VERSION.tgz" "$OUT" \
    package/tree-sitter.js package/tree-sitter.wasm package/LICENSE=LICENSE-web-tree-sitter.txt
python3 -I "$HERE/scripts/extract.py" "$CACHE/tree-sitter-kotlin-$KOTLIN_GRAMMAR_VERSION.tgz" "$OUT" \
    package/tree-sitter-kotlin.wasm package/LICENSE=LICENSE-tree-sitter-kotlin.txt
cp "$HERE/src/server.js" "$OUT/"
node "$HERE/scripts/finish.mjs" "$OUT" "$WEB_TREE_SITTER_VERSION" "$KOTLIN_GRAMMAR_VERSION"
