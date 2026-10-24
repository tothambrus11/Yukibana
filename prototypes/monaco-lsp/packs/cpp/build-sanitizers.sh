#!/usr/bin/env bash
# Builds the sanitizer runtimes (README, "Sanitizers") into
# ../../app/static/packs/cpp/, each archive fetched by the runner only for a
# project whose compile_flags.txt asks for that sanitizer:
#
#   asan.tar     usr/lib/clang/21/lib/wasm32-unknown-wasip1/libclang_rt.asan.a:
#                AddressSanitizer with LeakSanitizer and UBSan, for the
#                default target (wasm32-wasip1)
#   ubsan.tar    .../libclang_rt.ubsan_standalone.a and ubsan_minimal.a:
#                UndefinedBehaviorSanitizer alone
#   targets/<arch>/asan.tar, ubsan.tar
#                the same for each Linux target, as clang's Linux driver
#                links them (usr/lib/clang/21/lib/linux/libclang_rt.*-<arch>.a
#                and their .syms), and asan.tar also musl's dynamic loader as
#                usr/lib/<multiarch>/libc.so: AddressSanitizer refuses a
#                static program, so a sanitized program links dynamically
#                against musl, and the runner puts the same file into the
#                guest as /lib/ld-musl-<arch>.so.1
#
# WebAssembly: compiler-rt's Emscripten port (emsdk's
# upstream/emscripten/system/lib/compiler-rt, LLVM 20.1.8 with Emscripten's
# changes) with patches/compiler-rt-wasi.patch, compiled for wasm32-wasip1
# by wasi-sdk 30's clang (build-cxx-runtime.sh fetches it) with the source
# lists and flags of Emscripten's tools/system_libs.py, plus
# src/sanitizer-rt/: what Emscripten's runtime would give the port (the host
# half is src/sanitizer.js). No debug information: a runtime frame reads
# "in malloc (program.wasm+0x...)", as natively for a library without it.
#
# Linux: Alpine v3.23's compiler-rt 21.1.2 (the same package
# build-targets.sh takes the builtins from) and musl 1.2.5, pinned by
# SHA-256, the runtimes' debug information stripped.
#
# Idempotent: skipped when $CACHE/sanitizers/.built holds the SHA-256 of
# this script, the patch and src/sanitizer-rt/, and the archives exist.
# Under a minute at -j3.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/cpp"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
JOBS=${JOBS:-3}
WASI_SDK="$CACHE/wasi/wasi-sdk-30.0-x86_64-linux"
EMSDK_LIB="$CACHE/emsdk/upstream/emscripten/system/lib"
BIN="$CACHE/emsdk/upstream/bin"   # llvm-strip and llvm-ar handle every ELF arch
W="$CACHE/sanitizers"
ALPINE=https://dl-cdn.alpinelinux.org/alpine/v3.23/main
LLVM_LIB=usr/lib/llvm21/lib/clang/21/lib

step() { printf '\n== %s\n' "$*"; }
die() { echo "build-sanitizers.sh: $*" >&2; exit 1; }
[ -x "$WASI_SDK/bin/clang" ] || die "no wasi-sdk in $WASI_SDK (build-cxx-runtime.sh fetches it)"
[ -f "$EMSDK_LIB/compiler-rt/lib/asan/asan_emscripten.cpp" ] || die "no emsdk in $CACHE/emsdk (build.sh installs it)"

stamp=$(cat "$HERE/build-sanitizers.sh" "$HERE/patches/compiler-rt-wasi.patch" "$HERE"/src/sanitizer-rt/*.c \
  "$HERE"/src/sanitizer-rt/include/*.h "$HERE"/src/sanitizer-rt/include/emscripten/*.h | sha256sum | cut -d' ' -f1)
outputs=("$OUT/asan.tar" "$OUT/ubsan.tar")
for arch in x86_64 aarch64 riscv64; do outputs+=("$OUT/targets/$arch/asan.tar" "$OUT/targets/$arch/ubsan.tar"); done
built=1
for f in "${outputs[@]}"; do [ -f "$f" ] || built=; done
if [ -n "$built" ] && [ "$(cat "$W/.built" 2>/dev/null)" = "$stamp" ]; then
  echo "sanitizer runtimes: cached ($W)"
  exit 0
fi
mkdir -p "$W/dl" "$OUT/targets"

# A file is written beside its target and renamed over it: the app's build
# may hold a hard link to the old one, which must not change under it.
tarball() { # dir out (the dir holds usr/)
  tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$1" -c usr > "$2.part"
  mv "$2.part" "$2"
}

step "compiler-rt for wasm32-wasip1"
rm -rf "$W/rt" "$W/obj" "$W/stage"
mkdir -p "$W/rt/lib" "$W/obj"
for d in sanitizer_common asan ubsan ubsan_minimal lsan interception; do cp -r "$EMSDK_LIB/compiler-rt/lib/$d" "$W/rt/lib/"; done
cp -r "$EMSDK_LIB/compiler-rt/include" "$W/rt/include"
patch -s -d "$W/rt" -p1 < "$HERE/patches/compiler-rt-wasi.patch"
# Emscripten's flags for these libraries (CompilerRTLibrary and its
# subclasses), for wasm32-wasip1: wasi-libc's emulations of what WASI lacks
# (signal(), mmap(), getpid(), clock()), which the runner links too.
cflags=(--target=wasm32-wasip1 -O2 -fno-builtin -fno-exceptions -std=c++17 -D_LARGEFILE64_SOURCE -Wno-format
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS
  -I"$HERE/src/sanitizer-rt/include" -I"$W/rt/lib" -I"$W/rt/include")
compile() { # dir objdir extra-flags... -- sources...
  local dir=$1 obj=$2; shift 2
  local extra=()
  while [ "$1" != -- ]; do extra+=("$1"); shift; done
  shift
  mkdir -p "$obj"
  printf '%s\n' "$@" | xargs -P "$JOBS" -I{} sh -c \
    "'$WASI_SDK/bin/clang++' $(printf "'%s' " "${cflags[@]}" "${extra[@]}") -c '$dir/{}' -o '$obj/{}.o'"
}
cd "$W/rt/lib"
# As tools/system_libs.py lists them, but sanitizer_platform_limits_posix.cpp:
# it describes Emscripten's libc's structures, which WASI's are not, and
# nothing on WASI intercepts the calls that need them.
compile sanitizer_common "$W/obj/common" -- $(cd sanitizer_common && ls *.cpp | grep -vx 'sanitizer_common_nolibc.cpp\|sanitizer_platform_limits_posix.cpp')
compile ubsan "$W/obj/ubsan" -DUBSAN_CAN_USE_CXXABI -- $(cd ubsan && ls *.cpp | grep -vx 'ubsan_diag_standalone.cpp')
compile lsan "$W/obj/lsan" -- $(cd lsan && ls lsan_common*.cpp)
compile asan "$W/obj/asan" -- $(cd asan && ls *.cpp)
compile ubsan_minimal "$W/obj/minimal" -- ubsan_minimal_handlers.cpp
cd "$W"
cc=("$WASI_SDK/bin/clang" --target=wasm32-wasip1 -O2 -Wall -Werror -D_WASI_EMULATED_MMAN -I"$HERE/src/sanitizer-rt/include")
"${cc[@]}" -c "$HERE/src/sanitizer-rt/wasi_emscripten.c" -o obj/wasi_emscripten.o
"${cc[@]}" -c "$HERE/src/sanitizer-rt/wasi_heap.c" -o obj/wasi_heap.o
# dlmalloc's own warnings are Emscripten's business; the bulk memory
# instructions are the unchecked memcpy and memset.
"$WASI_SDK/bin/clang" --target=wasm32-wasip1 -O2 -mbulk-memory -D_WASI_EMULATED_MMAN -I"$EMSDK_LIB" \
  -c "$HERE/src/sanitizer-rt/wasi_asan.c" -o obj/wasi_asan.o
rt=stage/usr/lib/clang/21/lib/wasm32-unknown-wasip1
mkdir -p "$rt"
archive() { rm -f "$1"; "$WASI_SDK/bin/llvm-ar" rcs "$@"; }
# AddressSanitizer's runtime holds UBSan's and LeakSanitizer's, as on Linux
# (and as Emscripten links them together).
archive "$rt/libclang_rt.asan.a" obj/common/*.o obj/ubsan/*.o obj/lsan/*.o obj/asan/*.o obj/wasi_emscripten.o obj/wasi_asan.o
archive "$rt/libclang_rt.ubsan_standalone.a" obj/common/*.o obj/ubsan/*.o obj/wasi_emscripten.o obj/wasi_heap.o
rm -rf stage-ub && mkdir -p stage-ub/usr/lib/clang/21/lib/wasm32-unknown-wasip1
mv "$rt/libclang_rt.ubsan_standalone.a" stage-ub/usr/lib/clang/21/lib/wasm32-unknown-wasip1/
archive stage-ub/usr/lib/clang/21/lib/wasm32-unknown-wasip1/libclang_rt.ubsan_minimal.a obj/minimal/*.o obj/wasi_emscripten.o
tarball stage "$OUT/asan.tar"
tarball stage-ub "$OUT/ubsan.tar"
rm -rf rt obj stage stage-ub

step "Alpine's sanitizer runtimes for the Linux targets"
# arch package sha256: compiler-rt as build-targets.sh pins it, and musl
# for its dynamic loader (libc.so and ld-musl-<arch>.so.1 are one file).
PINS="
x86_64 compiler-rt-21.1.2-r0 1c2f55bf9d4c6d1dc3a95d67be09114a08f4befcaee06444b563ef0e3571285b
x86_64 musl-1.2.5-r24 d49d703392f1a6d2fe822db1b57e61735063077e1ad846d5f40d79fe507ec727
aarch64 compiler-rt-21.1.2-r0 c8dc9a9e98a23a30f4b5c89f44b7978e1d45db637742824304e0031aca12b200
aarch64 musl-1.2.5-r24 d7043c549029c98d438e9bc94213b006e5c88540eb58d1f5b0f0d1d56dbf9c98
riscv64 compiler-rt-21.1.2-r0 57934443df08a24a1b67870ba38233395e0169b7992b0769c2a2e97bdf3dcb41
riscv64 musl-1.2.5-r24 d2b9760fca0bf386f0eee1b7e68ad55c2497a2c2b12fdc34496956ef81404a83
"
multiarch() { node -e 'const t = require(process.argv[1]).find((t) => t.arch === process.argv[2]); if (!t) process.exit(1); console.log(t.multiarch)' "$HERE/src/targets.json" "$1"; }
fetch() { # arch package sha256 -> path; build-targets.sh's, with its cache
  local file="$CACHE/targets/dl/$1/$2.apk" from
  mkdir -p "$CACHE/targets/dl/$1"
  if [ ! -f "$file" ] || ! echo "$3  $file" | sha256sum -c --quiet - 2>/dev/null; then
    for from in ${ALPINE_MIRROR:+"$ALPINE_MIRROR"} "$ALPINE"; do
      rm -f "$file.part"
      case $from in
        http://*|https://*) curl -sSfL -o "$file.part" "$from/$1/$2.apk" || continue ;;
        *) cp "$from/$1/$2.apk" "$file.part" 2>/dev/null || continue ;;
      esac
      echo "$3  $file.part" | sha256sum -c --quiet - 2>/dev/null && break
      echo "build-sanitizers.sh: checksum mismatch for $from/$1/$2.apk" >&2
      rm -f "$file.part"
    done
    [ -f "$file.part" ] || die "no copy of $1/$2.apk with sha256 $3 (ALPINE_MIRROR=${ALPINE_MIRROR:-unset}, $ALPINE)"
    mv "$file.part" "$file"
  fi
  echo "$file"
}
for arch in x86_64 aarch64 riscv64; do
  ma=$(multiarch "$arch") || die "no target with arch $arch in src/targets.json"
  x="$W/x/$arch"
  rm -rf "$x" && mkdir -p "$x"
  while read -r a pkg sha; do
    [ "$a" = "$arch" ] || continue
    mkdir -p "$x/${pkg%%-[0-9]*}"
    tar xzf "$(fetch "$a" "$pkg" "$sha")" -C "$x/${pkg%%-[0-9]*}" --warning=no-unknown-keyword 2>/dev/null
  done <<< "$PINS"
  grep -q '^pkgver = 1\.2\.5-' "$x/musl/.PKGINFO" || die "$arch: musl is not musl 1.2.5"
  from="$x/compiler-rt/$LLVM_LIB/$arch-alpine-linux-musl"
  asan="$x/asan/usr/lib/clang/21/lib/linux" ubsan="$x/ubsan/usr/lib/clang/21/lib/linux"
  mkdir -p "$asan" "$ubsan" "$x/asan/usr/lib/$ma"
  for lib in asan asan_static asan_cxx asan-preinit; do
    "$BIN/llvm-strip" --strip-debug -o "$asan/libclang_rt.$lib-$arch.a" "$from/libclang_rt.$lib-$arch.a"
    [ -f "$from/libclang_rt.$lib-$arch.a.syms" ] && cp "$from/libclang_rt.$lib-$arch.a.syms" "$asan/"
  done
  for lib in ubsan_standalone ubsan_standalone_cxx ubsan_minimal; do
    "$BIN/llvm-strip" --strip-debug -o "$ubsan/libclang_rt.$lib-$arch.a" "$from/libclang_rt.$lib-$arch.a"
    [ -f "$from/libclang_rt.$lib-$arch.a.syms" ] && cp "$from/libclang_rt.$lib-$arch.a.syms" "$ubsan/"
  done
  cp "$x/musl/lib/ld-musl-$arch.so.1" "$x/asan/usr/lib/$ma/libc.so"
  mkdir -p "$OUT/targets/$arch"
  tarball "$x/asan" "$OUT/targets/$arch/asan.tar"
  tarball "$x/ubsan" "$OUT/targets/$arch/ubsan.tar"
  rm -rf "$x"
done
rm -rf "$W/x"

step "compress"
node "$HERE/compress.mjs" "${outputs[@]}"
echo "$stamp" > "$W/.built"
ls -la "${outputs[@]}" "${outputs[@]/%/.br}"
