#!/usr/bin/env bash
# Stands in for wasm-as during the image build (-H:WasmAsPath), so that the builder's JVM
# (10 GB) and wasm-as (3 GB and more on a 2 GB text file) never run at once on a 16 GB machine.
# Answers --version with the real wasm-as (the builder checks it); otherwise records the
# arguments in <output>.args and leaves an empty output. build.sh runs the real wasm-as with
# them once the builder has exited. The builder runs this without our environment, so the real
# wasm-as is found next to this script, where build.sh links it.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$1" in --version) exec "$here/wasm-as.real" --version ;; esac
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; case "$a" in --output=*) out="${a#--output=}" ;; esac; prev="$a"; done
[ -n "$out" ] || { echo "wasm-as stub: no output in: $*" >&2; exit 1; }
printf '%q ' "$@" > "$out.args"
: > "$out"
