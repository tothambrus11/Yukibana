#!/usr/bin/env bash
# Usage: fetch-wheels.sh <dir> [<list>]
# Downloads the wheels listed in <list> (default pytest-wheels.txt, next to
# this script) into <dir> (skipping any already there with the right sha256),
# checks each, and prints their paths in list order. Used by build-runner.sh
# (the runner's pytest and Hypothesis bundles) and by build.sh (the language
# server's pytest and Hypothesis stubs), so both see the same bytes.
set -euo pipefail
dir="$1"
list="${2:-$(dirname "${BASH_SOURCE[0]}")/pytest-wheels.txt}"
mkdir -p "$dir"
while read -r file sha url; do
    case "$file" in ''|'#'*) continue ;; esac
    f="$dir/$file"
    if [ ! -f "$f" ] || [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$sha" ]; then
        curl -sSfL -o "$f.part" "$url"
        mv "$f.part" "$f"
    fi
    got="$(sha256sum "$f" | cut -d' ' -f1)"
    [ "$got" = "$sha" ] || { echo "$file is sha256 $got, expected $sha" >&2; exit 1; }
    echo "$f"
done < "$list"
