#!/usr/bin/env bash
# Builds the Python runner (packs/CONTRACT.md, "Running a program") into
# ../../app/static/packs/python/: runner.js plus the Pyodide core, taken from
# the npm package `pyodide` at a pinned version whose tarball is checked
# against the registry's sha512 integrity, the pytest bundle that test
# mode fetches and the Hypothesis bundle a project importing it fetches. Nothing is compiled: Pyodide's release is CPython already
# built for wasm32-emscripten, pytest is pure Python. Called by build.sh; can
# be run on its own. Idempotent; caches the downloads in $PACK_CACHE/python.
set -euo pipefail

PYODIDE_VERSION=314.0.7   # CPython 3.14.2, Emscripten 5.0.3
PYODIDE_INTEGRITY='sha512-0YvXxEhfEdpLfb/XkM2BFAeMROq0iMUX2bzzH9pOttyMcWkwq+HbE5uyuGD82LN7y2q+SNvi/6V5JEsOlD2R1A=='
CPYTHON_TAG=v3.14.2       # the CPython inside this Pyodide
# Licence texts, pinned: the npm tarball carries none. Pyodide is MPL-2.0;
# the interpreter and stdlib it ships are CPython, whose PSF licence asks that
# its notice travel with every copy.
PYODIDE_LICENSE_SHA256=1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5
CPYTHON_LICENSE_SHA256=b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/python"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/python"
TGZ="$CACHE/pyodide-$PYODIDE_VERSION.tgz"
mkdir -p "$CACHE" "$OUT"

integrity() { echo "sha512-$(openssl dgst -sha512 -binary "$1" | base64 -w0)"; }

# 1. The npm tarball, verified.
if [ ! -f "$TGZ" ] || [ "$(integrity "$TGZ")" != "$PYODIDE_INTEGRITY" ]; then
    curl -sSfL -o "$TGZ.part" "https://registry.npmjs.org/pyodide/-/pyodide-$PYODIDE_VERSION.tgz"
    mv "$TGZ.part" "$TGZ"
fi
actual="$(integrity "$TGZ")"
[ "$actual" = "$PYODIDE_INTEGRITY" ] || { echo "pyodide-$PYODIDE_VERSION.tgz is $actual, expected $PYODIDE_INTEGRITY" >&2; exit 1; }

# 2. Only the core: the loader, the Emscripten module, the interpreter and the
#    standard library. Not shipped: the lock file (its `info` is inlined into
#    runner.js, see there), source maps, typings, the demo consoles.
TMP="$(mktemp -d "$CACHE/pyodide-extract.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
tar xzf "$TGZ" -C "$TMP" package/pyodide.mjs package/pyodide.asm.mjs package/pyodide.asm.wasm \
    package/python_stdlib.zip package/pyodide-lock.json package/package.json
got="$(node -p "require('$TMP/package/package.json').version")"
[ "$got" = "$PYODIDE_VERSION" ] || { echo "tarball says version $got" >&2; exit 1; }
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm; do
    cp "$TMP/package/$f" "$OUT/$f"
done
# The stdlib archive re-stored without per-member deflate, so the .br/.gz
# siblings compress across files (scripts/store-zip.py says why).
python3 -I "$HERE/scripts/store-zip.py" "$TMP/package/python_stdlib.zip" "$OUT/python_stdlib.zip"
# pyodide.mjs ends with a sourceMappingURL to a map that is not shipped.
sed -i '/^\/\/# sourceMappingURL=/d' "$OUT/pyodide.mjs"
rm -f "$OUT/pyodide-lock.json" "$OUT/pyodide-lock.json".{gz,br}

# 3. The pytest bundle that test mode unpacks into site-packages: pytest and
#    its dependencies from PyPI wheels, pinned by sha256 in
#    scripts/pytest-wheels.txt and cached, merged by scripts/make-pytest-zip.py.
#    Named by pytest's version, so a new one is a new URL for the cache.
PYTEST_ZIP="pytest-$(sed -n 's/^pytest-\([0-9.]*\)-py3.*/\1/p' "$HERE/scripts/pytest-wheels.txt").zip"
mapfile -t wheels < <("$HERE/scripts/fetch-wheels.sh" "$CACHE/wheels")
rm -f "$OUT"/pytest-*.zip "$OUT"/pytest-*.zip.{gz,br}
python3 -I "$HERE/scripts/make-pytest-zip.py" "$OUT/$PYTEST_ZIP" "${wheels[@]}"

# 3b. The Hypothesis bundle, made the same way from
#     scripts/hypothesis-wheels.txt (Hypothesis's own wheel for Pyodide's
#     platform, and sortedcontainers). The runner fetches it only for a
#     project that imports hypothesis, in Run and in Test alike.
HYPOTHESIS_ZIP="hypothesis-$(sed -n 's/^hypothesis-\([0-9.]*\)-cp.*/\1/p' "$HERE/scripts/hypothesis-wheels.txt").zip"
mapfile -t hwheels < <("$HERE/scripts/fetch-wheels.sh" "$CACHE/wheels" "$HERE/scripts/hypothesis-wheels.txt")
rm -f "$OUT"/hypothesis-*.zip "$OUT"/hypothesis-*.zip.{gz,br}
python3 -I "$HERE/scripts/make-pytest-zip.py" "$OUT/$HYPOTHESIS_ZIP" "${hwheels[@]}"

# 4. runner.js, with the lock file's `info` and the bundle's name inlined.
info="$(node -e "process.stdout.write(JSON.stringify(require('$TMP/package/pyodide-lock.json').info))")"
node -e '
const fs = require("fs");
const [src, out, info, pytestZip, hypothesisZip] = process.argv.slice(1);
let text = fs.readFileSync(src, "utf8");
for (const [marker, value] of [
    ["/* LOCK_INFO */ { info: {}, packages: {} }", `{ info: ${info}, packages: {} }`],
    ["/* PYTEST_ZIP */ \"pytest.zip\"", JSON.stringify(pytestZip)],
    ["/* HYPOTHESIS_ZIP */ \"hypothesis.zip\"", JSON.stringify(hypothesisZip)],
]) {
    if (!text.includes(marker)) throw new Error(`marker ${marker} missing in ${src}`);
    text = text.replace(marker, value);
}
fs.writeFileSync(out, text);
' "$HERE/runner/runner.js" "$OUT/runner.js" "$info" "$PYTEST_ZIP" "$HYPOTHESIS_ZIP"

# 5. Licences (cached, so a build with a warm cache makes no request) and
#    precompressed siblings.
licence() { # name url sha256
    local f="$CACHE/$1"
    if [ ! -f "$f" ] || [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$3" ]; then
        curl -sSfL -o "$f.part" "$2"
        mv "$f.part" "$f"
    fi
    local got
    got="$(sha256sum "$f" | cut -d' ' -f1)"
    [ "$got" = "$3" ] || { echo "$1 is sha256 $got, expected $3" >&2; exit 1; }
    cp "$f" "$OUT/$1"
}
licence LICENSE-pyodide.txt "https://raw.githubusercontent.com/pyodide/pyodide/$PYODIDE_VERSION/LICENSE" "$PYODIDE_LICENSE_SHA256"
licence LICENSE-cpython.txt "https://raw.githubusercontent.com/python/cpython/$CPYTHON_TAG/LICENSE" "$CPYTHON_LICENSE_SHA256"
nice -n 10 node "$HERE/scripts/compress.mjs" "$OUT/runner.js" "$OUT/pyodide.mjs" "$OUT/pyodide.asm.mjs" "$OUT/pyodide.asm.wasm" "$OUT/python_stdlib.zip" "$OUT/$PYTEST_ZIP" "$OUT/$HYPOTHESIS_ZIP"
