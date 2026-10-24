#!/usr/bin/env bash
# Builds demangle.{js,wasm} into ../../app/static/packs/cpp/: LLVM's
# Itanium demangler (llvm::itaniumDemangle, ItaniumDemangle.cpp of
# LLVMDemangle from the pack's LLVM 21.1.8 source tree, what llvm-cxxfilt
# runs for a _Z name) behind src/demangle/demangle.cpp, for the
# compiler output views (README, "Compiler output views"). Fetched by
# explorer.js only when a view opens.
#
# Emscripten 4.0.22 (build.sh's), -Oz, an ES module factory for workers and
# Node (test-demangle.mjs), no file system. demangle.cpp is compiled with
# -Wall -Wextra -Wpedantic -Werror; LLVM's own files with LLVM's usual
# warnings. Takes under a minute.
set -euo pipefail

LLVM_VERSION=21.1.8
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/cpp"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
SRC="$CACHE/llvm-project-$LLVM_VERSION.src"
W="$CACHE/demangle"
mkdir -p "$W" "$OUT"

# shellcheck disable=SC1091
source "$CACHE/emsdk/emsdk_env.sh" >/dev/null 2>&1
# No exceptions or RTTI, as LLVM is built; the demangler uses neither.
common=(-std=c++17 -Oz -fno-exceptions -fno-rtti -I"$SRC/llvm/include")
objects=()
# Only the Itanium demangler: Linux and WASI targets mangle nothing else.
for f in ItaniumDemangle; do
  em++ "${common[@]}" -c "$SRC/llvm/lib/Demangle/$f.cpp" -o "$W/$f.o"
  objects+=("$W/$f.o")
done
em++ "${common[@]}" -Wall -Wextra -Wpedantic -Werror -c "$HERE/src/demangle/demangle.cpp" -o "$W/yk.o"
# emmalloc: the smallest malloc; one call allocates a few kilobytes.
em++ -Oz "$W/yk.o" "${objects[@]}" -o "$W/demangle.js" \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createDemangle -sENVIRONMENT=worker,node \
  -sFILESYSTEM=0 -sMALLOC=emmalloc -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_yk_demangle_lines,_free -sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToNewUTF8
cp "$W/demangle.js" "$W/demangle.wasm" "$OUT/"
node "$HERE/compress.mjs" "$OUT/demangle.js" "$OUT/demangle.wasm"
