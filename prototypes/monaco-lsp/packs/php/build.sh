#!/usr/bin/env bash
# Builds the PHP pack into ../../app/static/packs/php/ from pinned upstream
# releases, checked by sha256; nothing is compiled. Idempotent: downloads are
# cached in $PACK_CACHE (default ~/.cache/yukibana-packs)/php. Needs curl,
# tar, node and a PHP CLI with the phar extension (to unpack Phpactor's phar;
# any PHP 8, the browser's PHP is the one below).
set -euo pipefail

# PHP 8.4.25 compiled to WebAssembly by WordPress Playground: the npm package
# @php-wasm/web-8-4, which holds the Asyncify and the JSPI build. The
# Asyncify one is used: it runs in every browser (JSPI is Chrome 137+).
PHPWASM_VERSION=3.1.60
PHPWASM_SHA256=741dc4ff896f1f92f33ddf347af295704218347785157f80526deb30d8015078
PHP_VERSION=8.4.25
# Phpactor's own phar, from its GitHub release.
PHPACTOR_VERSION=2026.10.07.0
PHPACTOR_SHA256=b28bf6166e016d539fc2f2aec18ef918b12590e436a6f1ccbdf30b5bbdbdb16b
# PHPUnit's phar, from phar.phpunit.de.
PHPUNIT_VERSION=12.5.40
PHPUNIT_SHA256=83f8098d7e6513befa61cd0df2689d42398d43404969b0dc21528ff52674ebc6
# Eris, PHP's property-based testing library for PHPUnit (MIT), at a release
# tag whose commit is checked. GitHub's archive downloads are not reachable
# from every build machine, its git transport is, so it is cloned.
ERIS_VERSION=1.3.0
ERIS_COMMIT=049239fb03b495af80b3d493a3a5c7e5c96224fa
# The phar leaves its dependencies' licence files out; phpstorm-stubs'
# (Apache-2.0, which asks for it) is fetched at the commit the phar bundles.
STUBS_COMMIT=e4f5f6c3de39f3bab3e9f3fca4b8cdb8b061e681
STUBS_LICENSE_SHA256=0b6bf6984e35b44f04c68ec5e18950cc10fea56b04576fab95fde116d0290408

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/php"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/php"
mkdir -p "$CACHE/dl" "$OUT"

# fetch URL FILE SHA256: downloads once, and checks the file every time.
fetch() {
    if [ ! -f "$2" ]; then
        curl -fsSL --retry 3 -o "$2.part" "$1"
        mv "$2.part" "$2"
    fi
    echo "$3  $2" | sha256sum -c --quiet - || { echo "$2: checksum mismatch (from $1)" >&2; rm -f "$2"; exit 1; }
}

fetch "https://registry.npmjs.org/@php-wasm/web-8-4/-/web-8-4-$PHPWASM_VERSION.tgz" "$CACHE/dl/php-wasm-web-8-4-$PHPWASM_VERSION.tgz" "$PHPWASM_SHA256"
fetch "https://github.com/phpactor/phpactor/releases/download/$PHPACTOR_VERSION/phpactor.phar" "$CACHE/dl/phpactor-$PHPACTOR_VERSION.phar" "$PHPACTOR_SHA256"
fetch "https://phar.phpunit.de/phpunit-$PHPUNIT_VERSION.phar" "$CACHE/dl/phpunit-$PHPUNIT_VERSION.phar" "$PHPUNIT_SHA256"
fetch "https://raw.githubusercontent.com/JetBrains/phpstorm-stubs/$STUBS_COMMIT/LICENSE" "$CACHE/dl/phpstorm-stubs-$STUBS_COMMIT-LICENSE" "$STUBS_LICENSE_SHA256"

ERIS="$CACHE/eris-$ERIS_VERSION"
if [ ! -d "$ERIS/.git" ]; then
    rm -rf "$ERIS"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ERIS_VERSION" https://github.com/giorgiosironi/eris "$ERIS"
fi
[ "$(git -C "$ERIS" rev-parse HEAD)" = "$ERIS_COMMIT" ] || { echo "eris $ERIS_VERSION is not commit $ERIS_COMMIT" >&2; exit 1; }
git -C "$ERIS" diff --quiet HEAD || { echo "$ERIS has local changes" >&2; exit 1; }

# 1. PHP: the Asyncify build's loader and wasm, unchanged.
PHPWASM="$CACHE/php-wasm-web-8-4-$PHPWASM_VERSION"
if [ ! -f "$PHPWASM/.done" ]; then
    rm -rf "$PHPWASM" && mkdir -p "$PHPWASM"
    tar -xzf "$CACHE/dl/php-wasm-web-8-4-$PHPWASM_VERSION.tgz" -C "$PHPWASM" --strip-components=1 \
        package/LICENSE package/asyncify/php_8_4.js "package/asyncify/${PHP_VERSION//./_}/php_8_4.wasm"
    touch "$PHPWASM/.done"
fi
cp "$PHPWASM/asyncify/php_8_4.js" "$OUT/php.mjs"
cp "$PHPWASM/asyncify/${PHP_VERSION//./_}/php_8_4.wasm" "$OUT/php.wasm"

# 2. Phpactor, unpacked from its phar into a tar the server unpacks into
#    PHP's memory file system at /opt: a phar is compressed file by file,
#    so the whole tar compresses far better (the phar is 4.5 MB brotli).
#    phpstorm-stubs, which describe PHP's own functions and classes to
#    Phpactor, are kept only for the extensions php.wasm has (the list
#    below, from get_loaded_extensions() of that build, plus the
#    superglobals): stubs of extensions the runtime lacks would offer
#    functions that fail when the program runs, and cost download and
#    indexing time. Next to them, PHPUnit's Framework namespace from the
#    phar the runner uses (TestCase, Assert, the attributes), so tests
#    resolve; Eris's source, so a property-based test resolves too; and the
#    index of them all, built ahead of time (build-index.mjs).
STUBS_KEEP="Core standard SPL Reflection date pcre json mbstring ctype dom libxml SimpleXML xml xmlreader xmlwriter
tokenizer Phar random hash iconv filter fileinfo zlib zip bcmath calendar exif gd session sqlite3 PDO openssl curl soap
superglobals"
cp "$HERE/src/php.js" "$OUT/"
TREE="$CACHE/phpactor-tree"
TAR=(tar --sort=name --mtime='2026-01-01 00:00:00Z' --owner=0 --group=0 --numeric-owner --format=gnu)
rm -rf "$TREE" && mkdir -p "$TREE/phpactor" "$TREE/yukibana" "$TREE/phpunit" "$TREE/eris"
php -d phar.readonly=1 -r '(new Phar($argv[1]))->extractTo($argv[2]);' "$CACHE/dl/phpactor-$PHPACTOR_VERSION.phar" "$TREE/phpactor"
rm -rf "$TREE/phpactor/.box" "$TREE/phpactor/.box_dump"
STUBS="$TREE/phpactor/vendor/jetbrains/phpstorm-stubs"
for dir in "$STUBS"/*/; do
    name="$(basename "$dir")"
    grep -qw -- "$name" <<<"$STUBS_KEEP" || rm -rf "$dir"
done
php -d phar.readonly=1 -r '(new Phar($argv[1]))->extractTo($argv[2], null, true);' "$CACHE/dl/phpunit-$PHPUNIT_VERSION.phar" "$TREE/phpunit-all"
mv "$TREE/phpunit-all/phpunit/Framework" "$TREE/phpunit/Framework"
rm -rf "$TREE/phpunit-all"
cp -r "$ERIS/src" "$TREE/eris/src"
cp "$HERE/src/phpactor.php" "$HERE/src/lint.php" "$HERE/src/rename.php" "$TREE/yukibana/"
php "$HERE/scripts/patch-signature-helper.php" \
    "$TREE/phpactor/lib/Completion/Bridge/TolerantParser/WorseReflection/WorseSignatureHelper.php" "$TREE/yukibana/WorseSignatureHelper.php"
"${TAR[@]}" -cf "$TREE.tar" -C "$TREE" eris phpactor phpunit yukibana
node "$HERE/scripts/build-index.mjs" "$OUT" "$TREE.tar" "$TREE/cache"
"${TAR[@]}" -cf "$OUT/phpactor.tar" -C "$TREE" cache eris phpactor phpunit yukibana
cp "$TREE/phpactor/LICENSE" "$OUT/LICENSE-phpactor.txt"
cp "$CACHE/dl/phpstorm-stubs-$STUBS_COMMIT-LICENSE" "$OUT/LICENSE-phpstorm-stubs.txt"
grep -q "$STUBS_COMMIT" "$TREE/phpactor/vendor/composer/installed.php" || { echo "phpactor bundles another phpstorm-stubs commit" >&2; exit 1; }
# What else the phar bundles, by Composer's record of it (versions and commits).
php -r '$i = require $argv[1]; foreach ($i["versions"] as $n => $v) if (isset($v["reference"])) printf("%s %s %s\n", $n, $v["pretty_version"], $v["reference"]);' \
    "$TREE/phpactor/vendor/composer/installed.php" > "$OUT/phpactor-packages.txt"
rm -rf "$TREE" "$TREE.tar"

# 3. PHPUnit for Test, and our bootstrap.
cp "$CACHE/dl/phpunit-$PHPUNIT_VERSION.phar" "$OUT/phpunit.phar"
cp "$HERE/src/autoload.php" "$OUT/autoload.php"
#    Eris for a Test of a project that uses it: its src/ and licence as
#    released, and our stand-in for its Composer autoload section, unpacked
#    by the runner to /opt/yukibana/lib/eris/ (unversioned, as phpunit.phar).
ERIS_TREE="$CACHE/eris-tree"
rm -rf "$ERIS_TREE" && mkdir -p "$ERIS_TREE/lib/eris"
cp -r "$ERIS/src" "$ERIS/LICENSE" "$ERIS_TREE/lib/eris/"
cp "$HERE/src/eris-autoload.php" "$ERIS_TREE/lib/eris/autoload.php"
"${TAR[@]}" -cf "$OUT/eris.tar" -C "$ERIS_TREE" lib
rm -rf "$ERIS_TREE"
cp "$ERIS/LICENSE" "$OUT/LICENSE-eris.txt"

# 4. The workers, and the licences.
cp "$HERE/src/server.js" "$HERE/src/runner.js" "$OUT/"
cp "$PHPWASM/LICENSE" "$OUT/LICENSE-php-wasm.txt"
cp "$HERE/LICENSE-php.txt" "$OUT/LICENSE-php.txt"
# PHPUnit's licence and its bundled dependencies' (all in the phar), in one file.
php -r '$p = "phar://" . realpath($argv[1]);
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($p, FilesystemIterator::SKIP_DOTS)) as $f) {
        if ($f->getFilename() === "LICENSE") $l[substr($f->getPathname(), strlen($p) + 1)] = file_get_contents($f->getPathname());
    }
    ksort($l);
    foreach ($l as $n => $t) echo "==> $n <==\n", $t, "\n";' "$OUT/phpunit.phar" > "$OUT/LICENSE-phpunit.txt"
grep -q "Sebastian Bergmann" "$OUT/LICENSE-phpunit.txt" || { echo "no PHPUnit licence in phpunit.phar" >&2; exit 1; }

# 5. Precompressed siblings. Brotli at quality 11 takes minutes on the
#    20 MB wasm, so siblings are cached by the file's sha256.
rm -f "$OUT"/*.gz "$OUT"/*.br
mkdir -p "$CACHE/compressed"
for f in "$OUT"/php.wasm "$OUT"/php.mjs "$OUT"/phpactor.tar "$OUT"/phpunit.phar "$OUT"/eris.tar \
    "$OUT"/php.js "$OUT"/server.js "$OUT"/runner.js "$OUT"/autoload.php; do
    key="$CACHE/compressed/$(sha256sum "$f" | cut -c1-32)"
    if [ ! -f "$key.br" ] || [ ! -f "$key.gz" ]; then
        node "$HERE/scripts/compress.mjs" "$f"
        mv "$f.br" "$key.br" && mv "$f.gz" "$key.gz"
    fi
    cp "$key.br" "$f.br" && cp "$key.gz" "$f.gz"
done
echo "built $(du -sh "$OUT" | cut -f1) into $OUT"
