#!/usr/bin/env bash
# Builds the Haskell pack into ../../app/static/packs/haskell/:
#
#   yuki.mjs, yuki.wasm  MicroHs $MICROHS_VERSION (Lennart Augustsson's Haskell
#                        compiler, patched: patches/microhs-ide.patch) with our
#                        entry points (src/hs/Yuki.hs), compiled by MicroHs to
#                        combinators and with its C runtime by Emscripten to
#                        WebAssembly: the server and the runner both load it
#   base.pkg             MicroHs's base library, compiled (types and code)
#   containers.pkg       containers $CONTAINERS_VERSION from Hackage (Data.Map,
#                        Data.Set, Data.IntMap, Data.IntSet), compiled by MicroHs
#   hspec.pkg            our Test.Hspec, hspec's API for the tests (src/hslib),
#                        compiled
#   server.js            the language server worker (src/server.js)
#   runner.js            the Run and Test worker (src/runner.js)
#   manifest.json        versions, and the files with their sizes
#   LICENSE-*.txt        MicroHs's (Apache-2.0) and containers' (BSD-3-Clause)
#   *.gz, *.br           compressed siblings
#
# Nothing here needs GHC: MicroHs's release carries its compiler as C
# (generated/mhs.c), which cc builds into the native mhs that compiles the
# rest. Idempotent: each step is skipped when its output in the cache
# ($PACK_CACHE/haskell, default ~/.cache/yukibana-packs/haskell) is current.
# Emscripten is the C++ pack's ($PACK_CACHE/cpp/emsdk) when it is there and
# the same version, else fetched into this cache, pinned the same way. Needs
# cc, make, curl, python3, git and node 22. About 6 minutes on 2 cores, most
# of it MicroHs compiling base and itself (README, "Building").
set -euo pipefail

MICROHS_VERSION=0.16.0.0
MICROHS_SHA256=d8cfa846765ee091098abb2abb83aa36ee0c1fbb57ac8a53c43c169761493155
CONTAINERS_VERSION=0.8.1
CONTAINERS_SHA256=9bd0f5156306b04a799c32ff49a6129f7c8dd6ec96c6ddeb7885975ffffc9e99
# The Emscripten the C++ pack builds with (packs/cpp/build.sh says how the
# pins were found).
EMSDK_VERSION=4.0.22
EMSDK_COMMIT=15915cad554b707837024dc2758b6a1c5b94b036
EMSDK_RELEASE=bebaf7e50e31865b0724f17eaa52e161e2dfef5a
EMSDK_BINARIES_SHA256=81219e78defb2f46d12a67a2fa6d128344d850f1e4375b173a324036236b40ef
EMSDK_NODE=node-v22.16.0-linux-x64.tar.xz
EMSDK_NODE_SHA256=f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e
# Heap cells (8 bytes each in wasm32) MicroHs's runtime allocates at start:
# its heap does not grow. The runner's is larger than MicroHs's own default
# for native code divided by two; see README, "Limits".
HEAP_CELLS=24000000

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/haskell"
PACKS="${PACK_CACHE:-$HOME/.cache/yukibana-packs}"
CACHE="$PACKS/haskell"
NICE="nice -n 10"
MHS="$CACHE/MicroHs-$MICROHS_VERSION"
mkdir -p "$CACHE/dl" "$OUT"
cd "$CACHE"

step() { printf '\n== %s\n' "$*"; }
# fetch URL FILE SHA256: downloads once, and checks the file every time.
fetch() {
    if [ ! -f "$2" ]; then
        curl -fsSL --retry 3 -o "$2.part" "$1"
        mv "$2.part" "$2"
    fi
    echo "$3  $2" | sha256sum -c --quiet - || { echo "$2: checksum mismatch (from $1)" >&2; rm -f "$2"; exit 1; }
}
# stamp FILE INPUT...: true when FILE records the hash of the inputs given,
# which may be files or strings (a version, a flag).
hash_of() { for x in "$@"; do if [ -f "$x" ]; then sha256sum < "$x"; else echo "$x"; fi; done | sha256sum | cut -d' ' -f1; }
current() { local f=$1; shift; [ -f "$f.stamp" ] && [ "$(cat "$f.stamp")" = "$(hash_of "$@")" ]; }
record() { local f=$1; shift; hash_of "$@" > "$f.stamp"; }

step "sources"
fetch "https://hackage.haskell.org/package/MicroHs-$MICROHS_VERSION/MicroHs-$MICROHS_VERSION.tar.gz" "dl/MicroHs-$MICROHS_VERSION.tar.gz" $MICROHS_SHA256
fetch "https://hackage.haskell.org/package/containers-$CONTAINERS_VERSION/containers-$CONTAINERS_VERSION.tar.gz" "dl/containers-$CONTAINERS_VERSION.tar.gz" $CONTAINERS_SHA256
# A changed patch means a fresh tree, and everything after it rebuilt.
PATCH="$HERE/patches/microhs-ide.patch"
if ! current "$MHS/.tree" "$PATCH" $MICROHS_VERSION; then
    rm -rf "$MHS"
    tar xzf "dl/MicroHs-$MICROHS_VERSION.tar.gz"
    patch -s -d "$MHS" -p1 < "$PATCH"
    record "$MHS/.tree" "$PATCH" $MICROHS_VERSION
fi
CONTAINERS="$CACHE/containers-$CONTAINERS_VERSION"
[ -d "$CONTAINERS" ] || tar xzf "dl/containers-$CONTAINERS_VERSION.tar.gz"

step "emscripten $EMSDK_VERSION"
EMSDK="$PACKS/cpp/emsdk"
if [ "$(cat "$EMSDK/upstream/emscripten/emscripten-version.txt" 2>/dev/null)" != "\"$EMSDK_VERSION\"" ]; then
    EMSDK="$CACHE/emsdk"
    if [ ! -x emsdk/upstream/emscripten/emcc ] || [ "$(git -C emsdk rev-parse HEAD 2>/dev/null)" != "$EMSDK_COMMIT" ]; then
        rm -rf emsdk
        git clone --quiet --depth 1 --branch $EMSDK_VERSION https://github.com/emscripten-core/emsdk
        [ "$(git -C emsdk rev-parse HEAD)" = "$EMSDK_COMMIT" ] || { echo "emsdk $EMSDK_VERSION is not commit $EMSDK_COMMIT" >&2; exit 1; }
        mkdir -p emsdk/downloads
        fetch "https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/$EMSDK_RELEASE/wasm-binaries.tar.xz" \
            $EMSDK_BINARIES_SHA256 "emsdk/downloads/$EMSDK_RELEASE-wasm-binaries.tar.xz"
        fetch "https://storage.googleapis.com/webassembly/emscripten-releases-builds/deps/$EMSDK_NODE" \
            $EMSDK_NODE_SHA256 "emsdk/downloads/$EMSDK_NODE"
        (cd emsdk && EMSDK_KEEP_DOWNLOADS=1 ./emsdk install $EMSDK_VERSION >/dev/null && ./emsdk activate $EMSDK_VERSION >/dev/null)
        rm -rf emsdk/downloads
    fi
fi
echo "$EMSDK"

step "native mhs and cpphs"
# From the release's C, with the host's cc: the compiler that compiles base,
# containers and Yuki.hs. It is MicroHs as released, unpatched (the patch
# changes the compiler Yuki.hs is built from, not this one).
(cd "$MHS" && $NICE make -s bin/mhs bin/cpphs >/dev/null)
export MHSDIR="$MHS"

step "base.pkg"
# Every module of MicroHs's lib/, which is what its own install builds as
# base, but Mhs.Reflect (it does not compile in 0.16.0.0) and the
# alternatives that are not: MiniPrelude, the GMP variants.
if ! current base.pkg "$MHS/bin/mhs" $MICROHS_VERSION; then
    mods=$(cd "$MHS/lib" && find . -name '*.hs' | sed 's|^\./||; s|\.hs$||; s|/|.|g' | grep -v -E '^(AllOfLib|MiniPrelude|gmp\.|dist-mcabal\.|Mhs\.Reflect)$|^(gmp|dist-mcabal)\.' | sort)
    (cd "$MHS" && $NICE bin/mhs -q -i -ilib -Pbase-$MICROHS_VERSION -o "$CACHE/base.pkg" $mods)
    record base.pkg "$MHS/bin/mhs" $MICROHS_VERSION
fi

step "containers.pkg"
# containers supports MicroHs itself (its #ifdef __MHS__). Not here:
# Data.Sequence, Data.Graph and Data.Tree, which need the array package.
if ! current containers.pkg "$MHS/bin/mhs" base.pkg $CONTAINERS_VERSION; then
    mods=$(sed -n '/exposed-modules:/,/^$/p' "$CONTAINERS/containers.cabal" | grep -v exposed-modules | tr -d ' ' | grep . | grep -v -E 'Sequence|Graph|Tree')
    (cd "$CONTAINERS" && MHSCPPHS="$MHS/bin/cpphs" $NICE "$MHS/bin/mhs" -q -XCPP -Iinclude \
        '-DMIN_VERSION_base(x,y,z)=((x)<4||(x)==4&&(y)<19||(x)==4&&(y)==19&&(z)<=1)' \
        -i -isrc -p"$CACHE/base.pkg" -Pcontainers-$CONTAINERS_VERSION -o "$CACHE/containers.pkg" $mods)
    record containers.pkg "$MHS/bin/mhs" base.pkg $CONTAINERS_VERSION
fi

step "hspec.pkg"
if ! current hspec.pkg "$MHS/bin/mhs" base.pkg "$HERE/src/hslib/Test/Hspec.hs"; then
    (cd "$HERE/src/hslib" && $NICE "$MHS/bin/mhs" -q -i -i. -p"$CACHE/base.pkg" -Pyukibana-hspec-1.0 -o "$CACHE/hspec.pkg" Test.Hspec)
    record hspec.pkg "$MHS/bin/mhs" base.pkg "$HERE/src/hslib/Test/Hspec.hs"
fi

step "yuki.c"
# MicroHs's compiler and Yuki.hs as one combinator program in C. Without
# MicroHs's compilation cache: with it, 0.16.0.0 writes the foreign export
# once per cached compile, and the C has it twice.
if ! current yuki.c "$MHS/bin/mhs" "$MHS/.tree.stamp" "$HERE/src/hs/Yuki.hs"; then
    rm -rf yuki-src && mkdir yuki-src && cp "$HERE/src/hs/Yuki.hs" yuki-src/
    (cd yuki-src && $NICE "$MHS/bin/mhs" -z -i"$MHS/mhs" -i"$MHS/src" -i"$MHS/lib" -i. Yuki -o"$CACHE/yuki.c")
    record yuki.c "$MHS/bin/mhs" "$MHS/.tree.stamp" "$HERE/src/hs/Yuki.hs"
fi

step "yuki.wasm"
# One module for both workers: the runner calls main (callMain), the server
# calls mhs_init once and then yuki_request (README, "How it works").
# INVOKE_RUN=0 and EXIT_RUNTIME=0 keep the heap between requests.
EMFLAGS=(-O3 -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createYuki -sENVIRONMENT=worker,node
    -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=8MB -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM
    -sEXPORTED_FUNCTIONS=_main,_mhs_init,_yuki_request,_free,_fflush
    -sEXPORTED_RUNTIME_METHODS=FS,callMain,stringToNewUTF8,UTF8ToString
    -DUSE_SYSTEM_RAW -DHEAP_CELLS=$HEAP_CELLS -Wno-address-of-packed-member)
if ! current yuki.wasm yuki.c "$HERE/src/yuki-io.c" "${EMFLAGS[*]}" $EMSDK_VERSION; then
    # shellcheck disable=SC1091
    source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
    rm -rf yuki-em && mkdir yuki-em
    $NICE emcc "${EMFLAGS[@]}" -I"$MHS/src/runtime" -I"$MHS/src/runtime/unix" \
        "$MHS/src/runtime/main.c" "$MHS/src/runtime/eval.c" yuki.c "$HERE/src/yuki-io.c" -lm -o yuki-em/yuki.mjs
    mv yuki-em/yuki.mjs yuki-em/yuki.wasm . && rmdir yuki-em
    record yuki.wasm yuki.c "$HERE/src/yuki-io.c" "${EMFLAGS[*]}" $EMSDK_VERSION
fi

step "pack"
rm -f "$OUT"/hspec.hs*
cp yuki.mjs yuki.wasm base.pkg containers.pkg hspec.pkg "$OUT/"
cp "$HERE/src/server.js" "$HERE/src/runner.js" "$HERE/src/project.js" "$OUT/"
cp "$MHS/LICENSE" "$OUT/LICENSE-MicroHs.txt"
cp "$CONTAINERS/LICENSE" "$OUT/LICENSE-containers.txt"
node "$HERE/scripts/finish.mjs" "$OUT" "$MICROHS_VERSION" "$CONTAINERS_VERSION"
