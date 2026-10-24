#!/usr/bin/env bash
# Builds the per-target files of the Linux targets (README, "Targets") into
# ../../app/static/packs/cpp/targets/<arch>/, for arch in x86_64, aarch64 and
# riscv64:
#
#   include.tar  usr/include/<multiarch>/bits/*: the arch's complete set of
#                musl's bits/ headers. clang's Linux driver puts
#                /usr/include/<multiarch> before /usr/include, so these
#                shadow sysroot.tar.gz's x86_64 bits/ (which stay the
#                default). Fetched by clangd (server.js), the runner and
#                the explorer for that target.
#   lib.tar      usr/lib/<multiarch>/: musl's crt files, libc.a and its empty
#                stubs (libm.a, libpthread.a, ...), libc++.a (with libc++abi
#                merged in), libunwind.a;
#                usr/lib/clang/21/lib/linux/: compiler-rt's builtins and
#                crtbegin/crtend. Fetched by the runner only, to link.
#
# The libraries are Alpine v3.23's packages, pinned by SHA-256: musl 1.2.5,
# and libc++, libc++abi, libunwind and compiler-rt 21.1.2 (the headers they
# are compiled against are LLVM 21.1.8's, in sysroot.tar.gz: same major
# version, same __config_site and ABI version, checked below). Phase 2 is to
# build these runtimes from our own LLVM 21.1.8 tarball.
#
# Each file also gets .gz and .br siblings. sysroot.tar.gz is not touched.
#
# The same verified packages also make $PACK_CACHE/cpp/targets/sysroot/<arch>/
# ({include,lib}: musl's complete headers for the arch, its crt files, libc.a
# and libm.a, and compiler-rt's builtins as libclang_rt.builtins.a), the
# sysroot vm/cc.sh compiles the guest's strace and test-vm.mjs's fixtures
# with: one musl for the programs users run and the tools the VM ships.
#
# Idempotent; downloads are cached in $PACK_CACHE/cpp/targets/dl. Where they
# come from: $ALPINE_MIRROR/<arch>/<package>.apk first when it is set (a
# directory or URL holding copies; Alpine replaces a package in place when it
# publishes a new revision, so the pinned revision can vanish from its
# mirrors), then Alpine's CDN. Either way the SHA-256 pin decides.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/cpp"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp"
WORK="$CACHE/targets"
BIN="$CACHE/emsdk/upstream/bin"   # llvm-strip and llvm-ar handle every ELF arch
ALPINE=https://dl-cdn.alpinelinux.org/alpine/v3.23/main
LLVM_LIB=usr/lib/llvm21/lib/clang/21/lib
mkdir -p "$WORK/dl" "$OUT/targets"

step() { printf '\n== %s\n' "$*"; }
die() { echo "build-targets.sh: $*" >&2; exit 1; }

# arch package sha256. libc++-dev is fetched only for the check of its
# __config_site; nothing of it is shipped.
PINS="
x86_64 musl-dev-1.2.5-r24 9a45a27051991319c020abd2e4f300f01b85febd745634d9e71cdbf133363448
x86_64 libc++-static-21.1.2-r0 462b1465e6a145b4dad325e34b893bead2dc0cd988972cdf91aa75373034405b
x86_64 llvm-libunwind-static-21.1.2-r0 ef10086c62cf87b04b9d2be598d5124539092a031a18bdc70d89c2082022f47f
x86_64 compiler-rt-21.1.2-r0 1c2f55bf9d4c6d1dc3a95d67be09114a08f4befcaee06444b563ef0e3571285b
x86_64 libc++-dev-21.1.2-r0 70b781ec7ed77dcce24b6fbd8276ba6fbd8bc89a14cb92846f75e679c0021751
aarch64 musl-dev-1.2.5-r24 8e3a2e5b78069ebd1307cb092972de2f95deb0b21b866a788d1ac7d6972db43e
aarch64 libc++-static-21.1.2-r0 b29caf77824cb00f8e55431224d27d006ecef4f7d0cb8a66df1e7c7f63a7d4df
aarch64 llvm-libunwind-static-21.1.2-r0 277fa9b4a92241037097b682de52a3c9536c2065da6b037ff92aa7fe9faf2a7d
aarch64 compiler-rt-21.1.2-r0 c8dc9a9e98a23a30f4b5c89f44b7978e1d45db637742824304e0031aca12b200
aarch64 libc++-dev-21.1.2-r0 8ab36249db6ec1eb4221b5e150819119b5eb2a720141c70be5c53ead42582119
riscv64 musl-dev-1.2.5-r24 1753854396e8a6418f2f97bb14ee600ae9ff5affc92c806f21806039fb41f752
riscv64 libc++-static-21.1.2-r0 6fee0c817ce90e7eb44adf894cf8a3b114e7a5be1a57ca6b49cce3b912332dc0
riscv64 llvm-libunwind-static-21.1.2-r0 dedc558c5a8969b7ceb39d0c639f74691e302bd7597e042270191866b044eff5
riscv64 compiler-rt-21.1.2-r0 57934443df08a24a1b67870ba38233395e0169b7992b0769c2a2e97bdf3dcb41
riscv64 libc++-dev-21.1.2-r0 cea0c9bec0b7c2ec47afbb78970ee0ece174766dadf2eb68039a81f262aa3315
"
# The multiarch directory clang's Linux driver uses for each (src/targets.json).
multiarch() { node -e 'const t = require(process.argv[1]).find((t) => t.arch === process.argv[2]); if (!t) process.exit(1); console.log(t.multiarch)' "$HERE/src/targets.json" "$1"; }

fetch() { # arch package sha256 -> path
  local file="$WORK/dl/$1/$2.apk" from
  mkdir -p "$WORK/dl/$1"
  if [ ! -f "$file" ] || ! echo "$3  $file" | sha256sum -c --quiet - 2>/dev/null; then
    for from in ${ALPINE_MIRROR:+"$ALPINE_MIRROR"} "$ALPINE"; do
      rm -f "$file.part"
      case $from in
        http://*|https://*) curl -sSfL -o "$file.part" "$from/$1/$2.apk" || continue ;;
        *) cp "$from/$1/$2.apk" "$file.part" 2>/dev/null || continue ;;
      esac
      echo "$3  $file.part" | sha256sum -c --quiet - 2>/dev/null && break
      echo "build-targets.sh: checksum mismatch for $from/$1/$2.apk" >&2
      rm -f "$file.part"
    done
    [ -f "$file.part" ] || die "no copy of $1/$2.apk with sha256 $3 (ALPINE_MIRROR=${ALPINE_MIRROR:-unset}, $ALPINE)"
    mv "$file.part" "$file"
  fi
  echo "$file"
}
# An .apk is gzip members of tar: the signature, .PKGINFO, then the files;
# tar reads them as one archive. Each package goes into a fresh directory.
unpack() { # apk dir
  rm -rf "$2" && mkdir -p "$2"
  tar xzf "$1" -C "$2" --warning=no-unknown-keyword 2>/dev/null
}
tarball() { # dir out
  tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$1" -c usr > "$2"
}

# The x86_64 bits/ that sysroot.tar.gz ships at /usr/include/bits, and the
# libc++ __config_site it ships, for the checks.
ref="$WORK/ref"
rm -rf "$ref" && mkdir -p "$ref"
tar xzf "$OUT/sysroot.tar.gz" -C "$ref" usr/include/bits usr/include/c++/v1/__config_site
[ "$(cat "$ref/usr/include/c++/v1/__config_site")" = "$(cat "$CACHE/cxx-headers/include/c++/v1/__config_site")" ] \
  || die "sysroot.tar.gz's __config_site is not cxx-headers'"
grep -q '^#define _LIBCPP_ABI_VERSION 1$' "$ref/usr/include/c++/v1/__config_site" || die "libc++ ABI version is not 1"

for arch in x86_64 aarch64 riscv64; do
  step "$arch"
  ma=$(multiarch "$arch") || die "no target with arch $arch in src/targets.json"
  x="$WORK/x/$arch"
  rm -rf "$x" && mkdir -p "$x"
  while read -r a pkg sha; do
    [ "$a" = "$arch" ] || continue
    apk=$(fetch "$a" "$pkg" "$sha")
    unpack "$apk" "$x/${pkg%%-[0-9]*}"
  done <<< "$PINS"

  # Checks: musl is 1.2.5; Alpine's libc++ was configured as ours (same
  # __config_site, so the same ABI version and the same musl settings).
  grep -q '^pkgver = 1\.2\.5-' "$x/musl-dev/.PKGINFO" || die "$arch: musl-dev is not musl 1.2.5"
  cmp -s "$x/libc++-dev/usr/include/c++/v1/__config_site" "$CACHE/cxx-headers/include/c++/v1/__config_site" \
    || die "$arch: Alpine's libc++ __config_site differs from ours"
  if [ "$arch" = x86_64 ]; then
    diff -r "$x/musl-dev/usr/include/bits" "$ref/usr/include/bits" >/dev/null \
      || die "x86_64: Alpine's musl bits/ differ from sysroot.tar.gz's /usr/include/bits"
  fi
  # Headers the default (x86_64) set has and this arch's lacks: an #include
  # of one of them fails for this target, as it does on that arch's Linux.
  missing=$(comm -23 <(ls "$ref/usr/include/bits" | sort) <(ls "$x/musl-dev/usr/include/bits" | sort) | tr '\n' ' ')
  echo "bits/ headers of x86_64 that $arch has not: ${missing:-none}"

  inc="$x/inc" stage="$x/stage"
  mkdir -p "$inc/usr/include/$ma" "$stage/usr/lib/$ma" "$stage/usr/lib/clang/21/lib/linux"
  cp -r "$x/musl-dev/usr/include/bits" "$inc/usr/include/$ma/"
  lib="$stage/usr/lib/$ma"
  for f in crt1.o crti.o crtn.o rcrt1.o Scrt1.o libc.a; do
    "$BIN/llvm-strip" --strip-unneeded -o "$lib/$f" "$x/musl-dev/usr/lib/$f"
  done
  # musl's empty archives: the libraries are in libc.a, these exist so that
  # -lm, -lpthread and the like link as on any Linux.
  for f in libm.a libpthread.a librt.a libdl.a libutil.a libxnet.a libcrypt.a libresolv.a; do
    [ "$(stat -c %s "$x/musl-dev/usr/lib/$f")" -eq 8 ] || die "$arch: $f is not musl's empty stub"
    cp "$x/musl-dev/usr/lib/$f" "$lib/"
  done
  # libc++abi joins libc++.a, as LIBCXX_STATICALLY_LINK_ABI_IN_STATIC_LIBRARY
  # would build it: the driver passes -lc++ only.
  "$BIN/llvm-strip" --strip-unneeded -o "$x/libc++.a" "$x/libc++-static/usr/lib/libc++.a"
  "$BIN/llvm-strip" --strip-unneeded -o "$x/libc++abi.a" "$x/libc++-static/usr/lib/libc++abi.a"
  printf 'create %s\naddlib %s\naddlib %s\nsave\nend\n' "$lib/libc++.a" "$x/libc++.a" "$x/libc++abi.a" | "$BIN/llvm-ar" -M
  "$BIN/llvm-strip" --strip-unneeded -o "$lib/libunwind.a" "$x/llvm-libunwind-static/usr/lib/libunwind.a"
  rt="$x/compiler-rt/$LLVM_LIB/$arch-alpine-linux-musl"
  for f in "libclang_rt.builtins-$arch.a" "clang_rt.crtbegin-$arch.o" "clang_rt.crtend-$arch.o"; do
    "$BIN/llvm-strip" --strip-unneeded -o "$stage/usr/lib/clang/21/lib/linux/$f" "$rt/$f"
  done
  "$BIN/llvm-ar" t "$lib/libc++.a" | grep -qx 'cxa_exception.cpp.o' || die "$arch: libc++abi is not in libc++.a"

  # The guest tools' sysroot (vm/cc.sh), from the same packages, unstripped.
  sr="$WORK/sysroot/$arch"
  rm -rf "$sr" && mkdir -p "$sr/lib"
  cp -r "$x/musl-dev/usr/include" "$sr/include"
  cp "$x/musl-dev/usr/lib/"{crt1.o,crti.o,crtn.o,libc.a,libm.a} "$sr/lib/"
  cp "$rt/libclang_rt.builtins-$arch.a" "$sr/lib/libclang_rt.builtins.a"

  mkdir -p "$OUT/targets/$arch"
  tarball "$inc" "$OUT/targets/$arch/include.tar"
  tarball "$stage" "$OUT/targets/$arch/lib.tar"
  node "$HERE/compress.mjs" "$OUT/targets/$arch/include.tar" "$OUT/targets/$arch/lib.tar"
  rm -rf "$x"
done
rm -rf "$ref" "$WORK/x"
