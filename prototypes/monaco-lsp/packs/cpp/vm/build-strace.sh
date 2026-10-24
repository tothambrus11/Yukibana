#!/usr/bin/env bash
# Builds a static strace 6.12 per guest architecture with cc.sh (musl), and packs each
# as $ART/strace-<arch>.cpio (bin/strace, mode 0755): the initramfs segment
# src/vm/system.js appends when the run asks for strace. Also $ART/LICENSE-strace.txt.
# --enable-bundled=yes: strace 6.12 checks io_uring structs against its own bundled
# UAPI headers rather than the newer 6.12.114 ones, whose reserved fields differ in size.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.txt
source "$HERE/pins.txt"
QC=${QC:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/qemu-wasm}
ART=${ART:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/vm-artifacts}
JOBS=${JOBS:-3}
export QC
SRC=$QC/src/strace-$STRACE_VERSION
mkdir -p "$ART" "$QC/src"
if [ ! -x "$SRC/configure" ]; then
  curl -sSfL -o "$QC/src/strace.tar.xz.part" "$STRACE_URL"
  echo "$STRACE_SHA256  $QC/src/strace.tar.xz.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $STRACE_URL" >&2; exit 1; }
  tar xJf "$QC/src/strace.tar.xz.part" -C "$QC/src" && rm "$QC/src/strace.tar.xz.part"
fi
for a in ${ARCHES:-x86_64 aarch64 riscv64}; do
  # The sysroot cc.sh uses (its default, or $SYSROOTS): every file of it is an input.
  sr=${SYSROOTS:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/targets/sysroot}/$a
  [ -f "$sr/lib/libc.a" ] || { echo "build-strace.sh: no musl sysroot in $sr (run ../build-targets.sh)" >&2; exit 1; }
  stamp=$(cat "$HERE/pins.txt" "$HERE/cc.sh" "$HERE/$(basename "${BASH_SOURCE[0]}")" <(cd "$sr" && find . -type f | LC_ALL=C sort | xargs sha256sum) <(clang-18 --version | head -1) | sha256sum | cut -d' ' -f1)
  if [ "$(cat "$ART/strace-$a.stamp" 2>/dev/null)" = "$stamp" ] && [ -f "$ART/strace-$a.cpio" ]; then echo "strace-$a: up to date"; continue; fi
  B=$QC/strace-build-$a; rm -rf "$B"; mkdir -p "$B"; cd "$B"
  "$SRC/configure" -q --host=$a-linux-musl CC="$HERE/cc.sh $a" CFLAGS="-Os" LDFLAGS="-static -Wl,--gc-sections -s" \
    --enable-mpers=no --enable-bundled=yes --disable-gcc-Werror --without-libdw --without-libunwind --without-libselinux >/dev/null
  nice -n 10 make -s -j"$JOBS" >/dev/null
  node --input-type=module -e '
    const { cpio } = await import(process.argv[1]);
    const fs = await import("node:fs");
    fs.writeFileSync(process.argv[3], cpio([{ name: "bin", mode: 0o040755 }, { name: "bin/strace", mode: 0o100755, data: fs.readFileSync(process.argv[2]) }]));
  ' "$HERE/../src/vm/cpio.js" src/strace "$ART/strace-$a.cpio"
  cd "$HERE"; rm -rf "$B"
  echo "$stamp" > "$ART/strace-$a.stamp"
done
cp "$SRC/COPYING" "$ART/LICENSE-strace.txt"
ls -la "$ART"/strace-*.cpio
