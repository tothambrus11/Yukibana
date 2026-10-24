#!/usr/bin/env bash
# Builds yk-init (guest/init.c) for each guest architecture with the kernel's nolibc
# (tools/include/nolibc of the pinned Linux tree) into $ART/init-<arch>: static, a
# few KB, no C library. Before that, the gates for the C we write:
#   - guest/test-init.c, the unit tests of guest/init-args.h, built natively with
#     clang-18 and AddressSanitizer + UndefinedBehaviorSanitizer, must pass;
#   - clang-tidy (guest/.clang-tidy) must be clean on init.c and test-init.c;
#   - init.c builds with -Wall -Wextra -Wpedantic -Werror and more.
# Needs build-kernel.sh's UAPI headers in $QC/hdr/<karch>/include.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.txt
source "$HERE/pins.txt"
QC=${QC:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/qemu-wasm}
ART=${ART:-${PACK_CACHE:-$HOME/.cache/yukibana-packs}/cpp/vm-artifacts}
N=$QC/linux-$LINUX_VERSION/tools/include/nolibc
G=$HERE/guest
CC=${CC_HOST:-clang-18}
TIDY=${CLANG_TIDY:-clang-tidy-18}
mkdir -p "$ART"
WARN=(-Wall -Wextra -Wpedantic -Werror -Wconversion -Wshadow -Wstrict-prototypes -Wmissing-prototypes)

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
"$CC" -std=c11 -D_POSIX_C_SOURCE=200809L -g "${WARN[@]}" -Wno-missing-prototypes \
  -fsanitize=address,undefined -fno-sanitize-recover=all -o "$tmp/test-init" "$G/test-init.c"
"$tmp/test-init"
"$TIDY" --quiet "$G/test-init.c" -- -std=c11 -D_POSIX_C_SOURCE=200809L 2> >(grep -v 'warnings generated' >&2)

for p in x86_64:x86_64 aarch64:arm64 riscv64:riscv; do
  a=${p%%:*} k=${p##*:}
  flags=(--target=$a-linux -nostdlib -static -ffreestanding -fno-stack-protector -std=gnu11
    -isystem "$N" -isystem "$QC/hdr/$k/include" -include nolibc.h)
  "$TIDY" --quiet "$G/init.c" -- "${flags[@]}" 2> >(grep -v 'warnings generated' >&2)
  # -Wpedantic stays on; only the GNU statement expressions inside nolibc's own
  # macros (strlen) are let through, as they are not in our code.
  "$CC" "${flags[@]}" -Os "${WARN[@]}" -Wno-gnu-statement-expression-from-macro-expansion -fuse-ld=lld -Wl,--gc-sections -s -o "$ART/init-$a" "$G/init.c"
done
ls -la "$ART"/init-*
