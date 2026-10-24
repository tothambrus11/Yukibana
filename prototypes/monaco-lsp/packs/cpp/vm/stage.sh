#!/usr/bin/env bash
# Lays out what the build made ($ART) where the app serves it (OUT, app/static/packs/cpp):
#   vm.js                         src/vm/run-linux.js bundled (esbuild, ESM, minified),
#                                 with every file's raw size injected as VM_SIZES
#   vm/<arch>/qemu-system-<arch>.{mjs,wasm}, kernel, initrd (the base initramfs: init
#                                 only), strace.cpio, qboot.rom (x86_64) or
#                                 opensbi-riscv64-generic-fw_dynamic.bin (riscv64)
#   user/<arch>/qemu-<arch>.{mjs,wasm}   only when $ART/user/<arch> exists (build-qemu-user.sh)
#   LICENSE-{qemu,linux,strace,opensbi,qboot}.txt
# and a .gz and .br sibling for every file (../compress.mjs). Cheap: rerun it after a
# change to src/vm/*.js alone.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P="$(cd "$HERE/.." && pwd)"
OUT=${OUT:-"$(cd "$P/../.." && pwd)/app/static/packs/cpp"}
ART=${ART:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/vm-artifacts}
QC=${QC:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/qemu-wasm}

rm -rf "$OUT/vm" "$OUT/user"
for a in x86_64 aarch64 riscv64; do
  d=$OUT/vm/$a
  mkdir -p "$d"
  cp "$ART/qemu-system-$a.mjs" "$ART/qemu-system-$a.wasm" "$ART/strace-$a.cpio" "$d/"
  mv "$d/strace-$a.cpio" "$d/strace.cpio"
  cp "$ART/kernel-$a" "$d/kernel"
  node --input-type=module -e '
    const { cpio } = await import(process.argv[1]); const fs = await import("node:fs");
    fs.writeFileSync(process.argv[3], cpio([{ name: "init", mode: 0o100755, data: fs.readFileSync(process.argv[2]) }]));
  ' "$P/src/vm/cpio.js" "$ART/init-$a" "$d/initrd"
  case $a in
    x86_64) cp "$ART/qboot.rom" "$d/" ;;
    riscv64) cp "$ART/opensbi-riscv64-generic-fw_dynamic.bin" "$d/" ;;
  esac
  if [ -f "$ART/user/$a/qemu-$a.wasm" ]; then
    mkdir -p "$OUT/user/$a"
    cp "$ART/user/$a/qemu-$a.mjs" "$ART/user/$a/qemu-$a.wasm" "$OUT/user/$a/"
  fi
done

# Licences: QEMU GPL-2.0, qboot GPL-2.0, OpenSBI BSD-2-Clause, Linux GPL-2.0 with
# the syscall note, strace LGPL-2.1+. Not compressed: nothing fetches them.
for l in qemu linux strace opensbi qboot; do cp "$ART/LICENSE-$l.txt" "$OUT/LICENSE-$l.txt"; done

# vm.js, with the raw size of every file it may fetch (the host may send them
# compressed, and progress needs the decoded total).
dirs=(vm); [ -d "$OUT/user" ] && dirs+=(user)
sizes=$(cd "$OUT" && find "${dirs[@]}" -type f ! -name '*.br' ! -name '*.gz' 2>/dev/null | sort |
  while read -r f; do printf '"%s":%s,' "$f" "$(stat -c %s "$f")"; done)
(cd "$P" && [ -d node_modules/esbuild ] || npm ci --no-audit --no-fund >/dev/null)
"$P/node_modules/.bin/esbuild" "$P/src/vm/run-linux.js" --bundle --format=esm --minify --target=es2022 \
  --define:VM_SIZES="{${sizes%,}}" --outfile="$OUT/vm.js" --log-level=warning

mapfile -t files < <(cd "$OUT" && find "${dirs[@]}" -type f ! -name '*.br' ! -name '*.gz' | sort | sed "s|^|$OUT/|")
node "$P/compress.mjs" "$OUT/vm.js" "${files[@]}"
