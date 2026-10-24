#!/usr/bin/env bash
# Builds the JavaScript/TypeScript pack into ../../app/static/packs/javascript/.
# Idempotent and incremental: the big outputs are named by TypeScript version
# and only rebuilt when their inputs are newer. Everything comes from npm
# packages pinned in package-lock.json (with integrity hashes).
set -euo pipefail
cd "$(dirname "$0")"
PACK_CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}"
OUT="../../app/static/packs/javascript"
STAMP=node_modules/.yukibana-lock

# Dependencies: typescript (the server itself and its lib files), esbuild,
# and dev-only types/test tools. Reinstalled only when the lock file changes.
if [[ ! -f "$STAMP" ]] || ! cmp -s package-lock.json "$STAMP"; then
  npm_config_cache="$PACK_CACHE/javascript/npm" npm ci --no-audit --no-fund
  cp package-lock.json "$STAMP"
fi

TS_VERSION="$(node -p 'require("typescript/package.json").version')"
case "$TS_VERSION" in
  5.*|6.*) ;;
  *) echo "typescript $TS_VERSION: need the 5.x/6.x JavaScript build (7.x is the Go port with no JS LanguageService)" >&2; exit 1 ;;
esac
TS_FILE="typescript-$TS_VERSION.js"
LIBS_FILE="libs-$TS_VERSION.json"
PACK_VERSION="$(node -p 'require("./package.json").version')"
# The npm packages the runner ships for bare imports (README "Packages"):
# fast-check, bundled with its one dependency, pure-rand, as one ES module.
FC_VERSION="$(node -p 'require("fast-check/package.json").version')"
FC_FILE="fast-check-$FC_VERSION.js"
PACKAGES_FILE="packages-fast-check-$FC_VERSION.json"
# The npm packages a web page may import (README "Packages"): p5.js, its
# own minified ES module build, for Preview, and its declarations, which the
# server downloads only for a project that imports it.
P5_VERSION="$(node -p 'require("./node_modules/p5/package.json").version')"  # p5's exports hide its package.json
P5_FILE="p5-$P5_VERSION.js"
P5_TYPES_FILE="packages-p5-$P5_VERSION.json"
# StrykerJS for Mutate (README "Mutation testing"): its instrumenter, its
# clear-text reporter and the metrics it reads, one ES module loaded only
# when the user asks for mutation testing.
STRYKER_VERSION="$(node -p 'require("@stryker-mutator/instrumenter/package.json").version')"
STRYKER_FILE="stryker-$STRYKER_VERSION.js"

npx tsc -p tsconfig.json

mkdir -p "$OUT"
# Drop anything a previous build of another version left behind.
for f in "$OUT"/*; do
  [[ -e "$f" ]] || continue
  case "$(basename "$f")" in
    server.js|server.js.*|runner.js|runner.js.*|strip.js|strip.js.*|"$TS_FILE"|"$TS_FILE".*|"$LIBS_FILE"|"$LIBS_FILE".*) ;;
    "$FC_FILE"|"$FC_FILE".*|"$PACKAGES_FILE"|"$PACKAGES_FILE".*|LICENSE-fast-check.txt|LICENSE-pure-rand.txt) ;;
    "$P5_FILE"|"$P5_FILE".*|"$P5_TYPES_FILE"|"$P5_TYPES_FILE".*|LICENSE-p5.txt) ;;
    "$STRYKER_FILE"|"$STRYKER_FILE".*|LICENSE-stryker.txt|LICENSE-babel.txt) ;;
    *) rm -f "$f" ;;
  esac
done

# typescript.js is a script that assigns `var ts` (and module.exports when it
# exists); appending one export makes it an ES module the worker can import.
# Its Node-only require() calls sit behind runtime checks and never run, so
# esbuild's two warnings about require/module in an ES module are expected.
if [[ ! -f "$OUT/$TS_FILE" || "$STAMP" -nt "$OUT/$TS_FILE" ]]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  { cat node_modules/typescript/lib/typescript.js; printf '\nexport default ts;\n'; } > "$TMP/typescript.mjs"
  npx esbuild "$TMP/typescript.mjs" --minify --format=esm --target=es2022 --log-level=warning \
    --log-override:unsupported-require-call=silent --log-override:commonjs-variable-in-esm=silent \
    --outfile="$OUT/$TS_FILE"
fi

if [[ ! -f "$OUT/$LIBS_FILE" || "$STAMP" -nt "$OUT/$LIBS_FILE" || tools/libs.mjs -nt "$OUT/$LIBS_FILE" ]]; then
  node tools/libs.mjs node_modules/typescript/lib "$OUT/$LIBS_FILE" es2023 dom dom.iterable dom.asynciterable
fi

# fast-check for the runner: its published ES module (lib/fast-check.js) and
# the pure-rand modules it imports, bundled into one file and minified, with
# nothing changed. Its declarations for the server, exactly the files
# TypeScript reads to resolve an import of it (tools/package-types.mjs).
npx esbuild node_modules/fast-check/lib/fast-check.js --bundle --minify --format=esm --target=es2022 \
  --log-level=warning --outfile="$OUT/$FC_FILE"
node tools/package-types.mjs "$OUT/$PACKAGES_FILE" fast-check
cp node_modules/fast-check/LICENSE "$OUT/LICENSE-fast-check.txt"
cp node_modules/pure-rand/LICENSE "$OUT/LICENSE-pure-rand.txt"

# p5.js for Preview: the package's own lib/p5.esm.min.js, copied as it is
# (it is already one minified ES module with its dependencies, and it is
# what p5.js publishes for `<script type="module">`). It is LGPL-2.1, so its
# licence goes next to it, unmodified as the file is. Its declarations as
# for fast-check: types/p5.d.ts, for
# instance mode (`new p5((p) => …)`); `p5/global`'s 1.2 MB of global
# declarations are not shipped.
cp node_modules/p5/lib/p5.esm.min.js "$OUT/$P5_FILE"
node tools/package-types.mjs "$OUT/$P5_TYPES_FILE" p5
cp node_modules/p5/license.txt "$OUT/LICENSE-p5.txt"

# StrykerJS, bundled by tools/stryker.mjs (which says what it stands in for
# Node's modules, and why). Rebuilt when the lock file or the bundle's
# sources change.
if [[ ! -f "$OUT/$STRYKER_FILE" || "$STAMP" -nt "$OUT/$STRYKER_FILE" || tools/stryker.mjs -nt "$OUT/$STRYKER_FILE" || src/stryker/index.ts -nt "$OUT/$STRYKER_FILE" ]]; then
  node tools/stryker.mjs "$OUT/$STRYKER_FILE"
fi
cp node_modules/@stryker-mutator/instrumenter/LICENSE "$OUT/LICENSE-stryker.txt"
cp node_modules/@babel/core/LICENSE "$OUT/LICENSE-babel.txt"

size() { node -p "require('fs').statSync(process.argv[1]).size" "$1"; }
npx esbuild src/server.ts --bundle --minify --format=esm --target=es2022 --log-level=warning \
  --define:__TS_FILE__="\"$TS_FILE\"" --define:__TS_SIZE__="$(size "$OUT/$TS_FILE")" \
  --define:__LIBS_FILE__="\"$LIBS_FILE\"" --define:__LIBS_SIZE__="$(size "$OUT/$LIBS_FILE")" \
  --define:__PACK_VERSION__="\"$PACK_VERSION\"" \
  --define:__PACKAGES_FILE__="\"$PACKAGES_FILE\"" --define:__PACKAGES_SIZE__="$(size "$OUT/$PACKAGES_FILE")" \
  --define:__LAZY_PACKAGES__="{\"p5\":{\"file\":\"$P5_TYPES_FILE\",\"size\":$(size "$OUT/$P5_TYPES_FILE")}}" \
  --define:__NODE_TYPES__="$(node -p 'JSON.stringify(require("fs").readFileSync("src/node/builtins.d.ts", "utf8"))')" \
  --outfile="$OUT/server.js"

# The program runner: a worker of its own, independent of the server, with
# its own node:test, node:assert, process and node:readline (src/node/). For
# a project with .ts files it loads the server's typescript.js (same URL, so
# one download) and strip.js, ts-blank-space bundled against that copy.
npx esbuild src/runner.ts --bundle --minify --format=esm --target=es2022 --log-level=warning \
  --define:__TS_FILE__="\"$TS_FILE\"" --define:__TS_SIZE__="$(size "$OUT/$TS_FILE")" \
  --define:__PACKAGES__="{\"fast-check\":\"$FC_FILE\"}" \
  --define:__PAGE_PACKAGES__="{\"p5\":\"$P5_FILE\"}" \
  --define:__STRYKER_FILE__="\"$STRYKER_FILE\"" --define:__STRYKER_SIZE__="$(size "$OUT/$STRYKER_FILE")" \
  --outfile="$OUT/runner.js"
npx esbuild src/strip.ts --bundle --minify --format=esm --target=es2022 --log-level=warning \
  --alias:typescript=./src/typescript-global.ts --outfile="$OUT/strip.js"

node tools/compress.mjs "$OUT"
