#!/bin/bash
# Runs the browser tests against web/: the differential ALU test (checksums must equal
# guest/alutest-expected.txt, which is what native x86_64 and qemu-user aarch64 print)
# and the kernel stress test (must finish, with no printk line that lost its timestamp,
# which is how the add2_i32 carry bug showed). Needs node, npm, and Chromium
# (/opt/pw-browsers or CHROMIUM=...).
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
W=$HERE/web
cd "$W"
mkdir -p vendor
# Test-only npm packages live under work/ (not in the pnpm workspace) and are linked in.
DEPS=${WORK:-$HERE/work}/web-deps
[ -d "$DEPS/node_modules/playwright-core" ] || { mkdir -p "$DEPS" && npm i --prefix "$DEPS" --no-save playwright-core@1.56.1 xterm@5.3.0 xterm-pty@0.11.1 >/dev/null; }
ln -sfn "$DEPS/node_modules" node_modules
cp node_modules/xterm/lib/xterm.js node_modules/xterm/css/xterm.css vendor/
cp node_modules/xterm-pty/index.js vendor/xterm-pty.js
export PORT=${PORT:-8090}
node serve.mjs "$W" "$PORT" & SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1
fail=0
for a in ${ARCHES:-aarch64 x86_64}; do
  for t in alu stress; do
    cp "$a/initrd-$t" "$a/initrd"
    log=$W/test-$a-$t.log
    QS="&verbose=1" node run.mjs $a "${SMP:-4}" 600 2>&1 | tr -d '\r' > "$log"
    if [ $t = alu ]; then
      awk '/=== alutest run 3/{f=1} f && /^cat[0-9] /' "$log" > "$W/alu-$a.txt"
      if cmp -s "$W/alu-$a.txt" "$HERE/guest/alutest-expected.txt"; then echo "PASS $a alu"; else echo "FAIL $a alu"; diff "$W/alu-$a.txt" "$HERE/guest/alutest-expected.txt"; fail=1; fi
    else
      broken=$(grep -cE '^\[ [^ 0-9]' "$log"); done=$(grep -c '=== DONE' "$log")
      if [ "$done" = 1 ] && [ "$broken" = 0 ]; then echo "PASS $a stress"; else echo "FAIL $a stress (done=$done, broken printk lines=$broken)"; fail=1; fi
    fi
  done
done
exit $fail
