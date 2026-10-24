#!/usr/bin/env bash
# Builds the Scala pack into ../../app/static/packs/scala/:
#
#   scalac.js        the Scala 3.7.4 compiler (upstream sources, patched by
#                    patches/*.patch) + ScalaService, compiled to one ES module
#                    with Scala.js 1.19.0 (fullLinkJS), minified by esbuild
#                    (pinned in package.json): Scala.js's ES-module output
#                    is not run through Closure, so it keeps its whitespace
#   classpath.bin    what the compiler type-checks against: java.base of a
#                    pinned Temurin JDK $JDK_VERSION (public API of the
#                    packages in scripts/jdk-packages.txt), Scala
#                    2.13.16 and Scala 3.7.4 libraries, stripped of bytecode
#   server.js        the worker: LSP over postMessage (src/server.js)
#   runner.js        the worker that runs a program (src/runner.js): compiles
#                    with scalac.js and -scalajs, links with sjslinker.js,
#                    runs the linked module (README, "Running")
#   sjslinker.js     the Scala.js $SCALAJS_VERSION linker compiled with Scala.js
#                    (scalajs-linker_sjs1), fullLinkJS, minified by esbuild
#   sjsir.bin        the Scala.js IR of everything a program links against:
#                    scalajs-javalib, scalajs-scalalib, scalajs-library,
#                    scala3-library_sjs1, and the runner's stream helper
#   classpath-sjs.bin  what -scalajs type-checks against on top of
#                    classpath.bin: scala.scalajs.* of scalajs-library and
#                    scala3-library_sjs1, stripped like classpath.bin
#   scalacheck-$SCALACHECK_VERSION-classpath.bin, scalacheck-$SCALACHECK_VERSION-sjsir.bin
#                    ScalaCheck for Scala.js (scalacheck_sjs1_3) and the
#                    scalajs-test-interface it depends on: their TASTy and
#                    class files stripped like classpath.bin, and their IR;
#                    loaded only for a project that names org.scalacheck
#   LICENSE-scalacheck.txt  ScalaCheck's licence (BSD-3-Clause)
#   manifest.json    file names and uncompressed sizes, for progress
#   *.gz, *.br       compressed siblings
#
# Idempotent; everything downloaded or built is cached in $PACK_CACHE/scala
# (default ~/.cache/yukibana-packs/scala). Needs: git, curl, unzip, patch,
# node 18+, npm, a JDK 17+ (java) to run sbt and the stripper. The JDK whose
# API student code sees is not that one: it is downloaded (pinned) below. sbt is fetched (pinned) into the cache.
set -euo pipefail

SCALA_VERSION=3.7.4
SCALA3_COMMIT=40be7608a48477951218ae3a8ac8749fe02ba988
SCALAJS_VERSION=1.19.0          # what scala3 3.7.4 builds its Scala.js support with
SCALA2_LIBRARY=2.13.16          # what scala3-library 3.7.4 depends on
SBT_VERSION=1.11.7
SCALACHECK_VERSION=1.18.1       # the newest scalacheck_sjs1_3
# ScalaCheck's LICENSE at its release tag (the jar has none).
SCALACHECK_LICENSE_SHA256=aac4ed1eece9c424fc97590c2199e661a747e7b851630f5141a89823fd242374
SBT_SHA256=1232818f91c39639a93bbe1108e12d94c7044a646a7847f1a3977b9e46716cd6
declare -A SHA256=(
    [scalajs-ir_2.13-$SCALAJS_VERSION-sources.jar]=177a2f22b74d6c758eedcee84dba3679eb510ec4fbfbb176d0783e11168d26e4
    [scala-library-$SCALA2_LIBRARY.jar]=1ebb2b6f9e4eb4022497c19b1e1e825019c08514f962aaac197145f88ed730f1
    [scala3-library_3-$SCALA_VERSION.jar]=73089d33f763b94758170e0a66be978f9397c14b7795e343898aa89b3d7b6639
    [asm-9.8.jar]=876eab6a83daecad5ca67eb9fcabb063c97b5aeb8cf1fca7a989ecde17522051
    # For the runner: the Scala.js build of the IR's SHA1 (the compiler's
    # back end hashes with it), and the Scala.js standard library.
    [scalajs-ir_sjs1_2.13-$SCALAJS_VERSION-sources.jar]=b4387b786569e32cb09d65e81100bc96de400735bc322ef5b31aae373dc3fc94
    [scalajs-javalib-$SCALAJS_VERSION.jar]=3d5f478d6c830c1f4b6939b9a31553bb463a6bcff7084a997be987330bb6cdbb
    [scalajs-scalalib_2.13-$SCALA2_LIBRARY+$SCALAJS_VERSION.jar]=0d4083c16576940d52231f9659df0d723de50542b4c72144d95853b0c00d2792
    [scalajs-library_2.13-$SCALAJS_VERSION.jar]=a17c6d84dd64e9f38c0707338e21ed6e97d3a5431bb61b35ecab5ee4375c3cbd
    [scala3-library_sjs1_3-$SCALA_VERSION.jar]=6cf19666c73dac29f216b916018b0e7031134d132b7590c0a5bc6f0cfd9f80a8
    # ScalaCheck, and the test interface its POM names (1.16.0 there; this
    # pack's Scala.js version, as sbt's eviction would pick).
    [scalacheck_sjs1_3-$SCALACHECK_VERSION.jar]=46631652e4ea1a09d737f86de439880f6a13847df3f41df993b6ef5a53b6901f
    [scalajs-test-interface_2.13-$SCALAJS_VERSION.jar]=a913d2caf254bfb86be183af17749d2c817d86366f28756563a91515a5ad8506
)
# The JDK whose java.base API goes into classpath.bin. Pinned so the class path
# does not depend on whichever JDK runs the build (that was the case once).
JDK_VERSION=21.0.8+9
declare -A JDK_SHA256=(
    [x86_64]=f2dc5418092c43003db8f9005c4a286e1c0104fea96ccdd49e8ebd037cac9219
    [aarch64]=e5c41a1ab0865ea5de9b4529bf8526005f1d4593090845387d14fe450ce39c33
)
MAVEN="${MAVEN_REPO:-https://repo1.maven.org/maven2}"
MAVEN_MIRROR=https://maven-central.storage-download.googleapis.com/maven2

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/scala"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/scala"
NICE="nice -n 10"
mkdir -p "$CACHE/jars" "$CACHE/bin" "$OUT"

fetch() { # fetch <maven path> <file name>: into $CACHE/jars, checksum-verified
    local dst="$CACHE/jars/$2"
    if [ ! -f "$dst" ]; then
        curl -fsSL -o "$dst.part" "$MAVEN/$1" || curl -fsSL -o "$dst.part" "$MAVEN_MIRROR/$1"
        mv "$dst.part" "$dst"
    fi
    echo "${SHA256[$2]}  $dst" | sha256sum -c --quiet - || { rm -f "$dst"; echo "checksum mismatch: $2" >&2; exit 1; }
}

java -version 2>&1 | grep -qE 'version "(1[7-9]|[2-9][0-9])' || { echo "a JDK 17+ is required (java -version)" >&2; exit 1; }

# 1. sbt, pinned.
if [ ! -x "$CACHE/bin/sbt-$SBT_VERSION/bin/sbt" ]; then
    curl -fsSL -o "$CACHE/bin/sbt.tgz" "https://github.com/sbt/sbt/releases/download/v$SBT_VERSION/sbt-$SBT_VERSION.tgz"
    echo "$SBT_SHA256  $CACHE/bin/sbt.tgz" | sha256sum -c --quiet -
    rm -rf "$CACHE/bin/sbt-$SBT_VERSION" "$CACHE/bin/sbt" && tar xzf "$CACHE/bin/sbt.tgz" -C "$CACHE/bin" && mv "$CACHE/bin/sbt" "$CACHE/bin/sbt-$SBT_VERSION"
    rm "$CACHE/bin/sbt.tgz"
fi

# 2. Upstream Scala 3 sources at the release commit (only what is compiled).
SRC="$CACHE/scala3-$SCALA_VERSION"
if [ ! -d "$SRC/.git" ]; then
    rm -rf "$SRC"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$SCALA_VERSION" --filter=blob:none --sparse https://github.com/scala/scala3 "$SRC"
    git -C "$SRC" sparse-checkout set compiler/src tasty/src
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$SCALA3_COMMIT" ] || { echo "scala3 $SCALA_VERSION is not $SCALA3_COMMIT" >&2; exit 1; }

# 3. Pinned artifacts: the Scala.js IR sources the compiler embeds, the
#    libraries for the class path, ASM for the class-file stripper.
fetch "org/scala-js/scalajs-ir_2.13/$SCALAJS_VERSION/scalajs-ir_2.13-$SCALAJS_VERSION-sources.jar" "scalajs-ir_2.13-$SCALAJS_VERSION-sources.jar"
fetch "org/scala-lang/scala-library/$SCALA2_LIBRARY/scala-library-$SCALA2_LIBRARY.jar" "scala-library-$SCALA2_LIBRARY.jar"
fetch "org/scala-lang/scala3-library_3/$SCALA_VERSION/scala3-library_3-$SCALA_VERSION.jar" "scala3-library_3-$SCALA_VERSION.jar"
fetch "org/ow2/asm/asm/9.8/asm-9.8.jar" "asm-9.8.jar"
fetch "org/scala-js/scalajs-ir_sjs1_2.13/$SCALAJS_VERSION/scalajs-ir_sjs1_2.13-$SCALAJS_VERSION-sources.jar" "scalajs-ir_sjs1_2.13-$SCALAJS_VERSION-sources.jar"
fetch "org/scala-js/scalajs-javalib/$SCALAJS_VERSION/scalajs-javalib-$SCALAJS_VERSION.jar" "scalajs-javalib-$SCALAJS_VERSION.jar"
fetch "org/scala-js/scalajs-scalalib_2.13/$SCALA2_LIBRARY%2B$SCALAJS_VERSION/scalajs-scalalib_2.13-$SCALA2_LIBRARY%2B$SCALAJS_VERSION.jar" "scalajs-scalalib_2.13-$SCALA2_LIBRARY+$SCALAJS_VERSION.jar"
fetch "org/scala-js/scalajs-library_2.13/$SCALAJS_VERSION/scalajs-library_2.13-$SCALAJS_VERSION.jar" "scalajs-library_2.13-$SCALAJS_VERSION.jar"
fetch "org/scala-lang/scala3-library_sjs1_3/$SCALA_VERSION/scala3-library_sjs1_3-$SCALA_VERSION.jar" "scala3-library_sjs1_3-$SCALA_VERSION.jar"
fetch "org/scalacheck/scalacheck_sjs1_3/$SCALACHECK_VERSION/scalacheck_sjs1_3-$SCALACHECK_VERSION.jar" "scalacheck_sjs1_3-$SCALACHECK_VERSION.jar"
fetch "org/scala-js/scalajs-test-interface_2.13/$SCALAJS_VERSION/scalajs-test-interface_2.13-$SCALAJS_VERSION.jar" "scalajs-test-interface_2.13-$SCALAJS_VERSION.jar"
if [ ! -f "$CACHE/LICENSE-scalacheck-$SCALACHECK_VERSION.txt" ]; then
    curl -fsSL -o "$CACHE/LICENSE-scalacheck-$SCALACHECK_VERSION.txt.part" "https://raw.githubusercontent.com/typelevel/scalacheck/v$SCALACHECK_VERSION/LICENSE"
    mv "$CACHE/LICENSE-scalacheck-$SCALACHECK_VERSION.txt.part" "$CACHE/LICENSE-scalacheck-$SCALACHECK_VERSION.txt"
fi
echo "$SCALACHECK_LICENSE_SHA256  $CACHE/LICENSE-scalacheck-$SCALACHECK_VERSION.txt" | sha256sum -c --quiet -

# 4. The source tree sbt compiles: upstream + patches (cheap, always redone).
"$HERE/scripts/prepare-upstream.sh" "$CACHE/upstream" "$SRC" "$CACHE/jars/scalajs-ir_2.13-$SCALAJS_VERSION-sources.jar" "$HERE/patches" \
    "$CACHE/jars/scalajs-ir_sjs1_2.13-$SCALAJS_VERSION-sources.jar"

# 5. Compile and link with Scala.js: the compiler + language service
#    (scalac.js), the linker (sjslinker.js), and the runner's stream helper
#    (compiled only; its IR goes into sjsir.bin). The sbt project is copied into the cache
#    so that sbt's own target/ and project/target/ stay out of the source tree.
rm -rf "$CACHE/sbt-project" && mkdir -p "$CACHE/sbt-project"
(cd "$HERE/compiler-js" && tar cf - --exclude=target .) | (cd "$CACHE/sbt-project" && tar xf -)
(cd "$CACHE/sbt-project" && SBT_OPTS="-Xmx6g -Xss8m" COURSIER_REPOSITORIES="$MAVEN_MIRROR|central" $NICE "$CACHE/bin/sbt-$SBT_VERSION/bin/sbt" \
    -Dsbt.global.base="$CACHE/sbt-global" -Dsbt.boot.directory="$CACHE/sbt-boot" -Dsbt.ivy.home="$CACHE/ivy2" \
    -Dsbt.coursier.home="$CACHE/coursier" -Dsbt.repository.config="$CACHE/sbt-project/repositories" \
    -Dyukibana.upstream="$CACHE/upstream" -Dyukibana.target="$CACHE/target" --batch fullLinkJS linker/fullLinkJS runtime/compile)
LINKED="$CACHE/target/yukibana-scala-lsp/scala-$SCALA_VERSION/yukibana-scala-lsp-opt/main.js"
LINKER_LINKED="$CACHE/target/yukibana-sjs-linker/scala-$SCALA_VERSION/yukibana-sjs-linker-opt/main.js"
RUNTIME_CLASSES="$CACHE/target/yukibana-runtime/scala-$SCALA_VERSION/classes"

# 6. The class path bundle, with java.base from the pinned JDK (only its
#    lib/modules image, lib/jrt-fs.jar and release file are kept).
ARCH="$(uname -m)"; JDK_ARCH="${ARCH/x86_64/x64}"
JDK_TGZ="OpenJDK21U-jdk_${JDK_ARCH}_linux_hotspot_${JDK_VERSION/+/_}.tar.gz"
JDK_HOME="$CACHE/jdk/jdk-$JDK_VERSION"
[ -n "${JDK_SHA256[$ARCH]:-}" ] || { echo "no pinned JDK for $ARCH" >&2; exit 1; }
if [ ! -f "$JDK_HOME/release" ]; then
    mkdir -p "$CACHE/jdk"
    [ -f "$CACHE/jdk/$JDK_TGZ" ] || curl -fsSL -o "$CACHE/jdk/$JDK_TGZ" "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${JDK_VERSION/+/%2B}/$JDK_TGZ"
    echo "${JDK_SHA256[$ARCH]}  $CACHE/jdk/$JDK_TGZ" | sha256sum -c --quiet - || { rm -f "$CACHE/jdk/$JDK_TGZ"; echo "checksum mismatch: $JDK_TGZ" >&2; exit 1; }
    rm -rf "$JDK_HOME"
    tar xzf "$CACHE/jdk/$JDK_TGZ" -C "$CACHE/jdk" "jdk-$JDK_VERSION/lib/modules" "jdk-$JDK_VERSION/lib/jrt-fs.jar" "jdk-$JDK_VERSION/release"
    rm "$CACHE/jdk/$JDK_TGZ"
fi
grep -qx "SEMANTIC_VERSION=\"$JDK_VERSION\"" "$JDK_HOME/release" || { echo "$JDK_HOME is not JDK $JDK_VERSION" >&2; exit 1; }
(cd "$CACHE" && $NICE java -cp "$CACHE/jars/asm-9.8.jar" "$HERE/scripts/StripClasses.java" "$CACHE/classpath.bin" "$HERE/scripts/jdk-packages.txt" \
    "jrt:$JDK_HOME" "$CACHE/jars/scala-library-$SCALA2_LIBRARY.jar" "$CACHE/jars/scala3-library_3-$SCALA_VERSION.jar")
# What the runner's compiler needs on top: the scala.scalajs.* API (js.Any,
# annotations, runtime helpers the back end calls), and the java.base classes
# that the phases after the typer reach through the JDK API in classpath.bin
# (see "closure:" in StripClasses.java). Its own bundle so that classpath.bin
# stays the server's, byte for byte.
(cd "$CACHE" && $NICE java -cp "$CACHE/jars/asm-9.8.jar" "$HERE/scripts/StripClasses.java" "$CACHE/classpath-sjs.bin" /dev/null \
    "$CACHE/jars/scalajs-library_2.13-$SCALAJS_VERSION.jar" "$CACHE/jars/scala3-library_sjs1_3-$SCALA_VERSION.jar@scala/scalajs/" \
    "closure:$CACHE/classpath.bin=$JDK_HOME")

# 6b. The library IR a program links against, in class-path order.
rm -rf "$CACHE/sjsir" && mkdir -p "$CACHE/sjsir"
for j in "scala3-library_sjs1_3-$SCALA_VERSION" "scalajs-library_2.13-$SCALAJS_VERSION" "scalajs-scalalib_2.13-$SCALA2_LIBRARY+$SCALAJS_VERSION" "scalajs-javalib-$SCALAJS_VERSION"; do
    mkdir -p "$CACHE/sjsir/$j" && unzip -q "$CACHE/jars/$j.jar" '*.sjsir' -d "$CACHE/sjsir/$j"
done
node "$HERE/scripts/sjsir-bundle.mjs" "$CACHE/sjsir.bin" "$RUNTIME_CLASSES" "$CACHE/sjsir/scala3-library_sjs1_3-$SCALA_VERSION" \
    "$CACHE/sjsir/scalajs-library_2.13-$SCALAJS_VERSION" "$CACHE/sjsir/scalajs-scalalib_2.13-$SCALA2_LIBRARY+$SCALAJS_VERSION" \
    "$CACHE/sjsir/scalajs-javalib-$SCALAJS_VERSION"
rm -rf "$CACHE/sjsir"

# 6c. ScalaCheck, as its own pair of bundles so that a project without it
#     downloads nothing more: the class path one without a closure (the
#     java.base classes it names are in classpath.bin and classpath-sjs.bin).
(cd "$CACHE" && $NICE java -cp "$CACHE/jars/asm-9.8.jar" "$HERE/scripts/StripClasses.java" "$CACHE/scalacheck-$SCALACHECK_VERSION-classpath.bin" /dev/null \
    "$CACHE/jars/scalacheck_sjs1_3-$SCALACHECK_VERSION.jar" "$CACHE/jars/scalajs-test-interface_2.13-$SCALAJS_VERSION.jar")
rm -rf "$CACHE/sjsir-qc" && mkdir -p "$CACHE/sjsir-qc/a" "$CACHE/sjsir-qc/b"
unzip -q "$CACHE/jars/scalacheck_sjs1_3-$SCALACHECK_VERSION.jar" '*.sjsir' -d "$CACHE/sjsir-qc/a"
unzip -q "$CACHE/jars/scalajs-test-interface_2.13-$SCALAJS_VERSION.jar" '*.sjsir' -d "$CACHE/sjsir-qc/b"
node "$HERE/scripts/sjsir-bundle.mjs" "$CACHE/scalacheck-$SCALACHECK_VERSION-sjsir.bin" "$CACHE/sjsir-qc/a" "$CACHE/sjsir-qc/b"
rm -rf "$CACHE/sjsir-qc"

# 7. Output. esbuild only removes whitespace and renames locals (no property
#    mangling), which is all Scala.js's ES-module output leaves to do.
#    Its only warnings are about Scala.js comparing with -0 on purpose.
[ -x "$HERE/node_modules/.bin/esbuild" ] || (cd "$HERE" && npm ci --no-audit --no-fund)
rm -rf "$OUT" && mkdir -p "$OUT"
"$HERE/node_modules/.bin/esbuild" "$LINKED" --minify --format=esm --log-level=error --outfile="$OUT/scalac.js"
"$HERE/node_modules/.bin/esbuild" "$LINKER_LINKED" --minify --format=esm --log-level=error --outfile="$OUT/sjslinker.js"
cp "$CACHE/classpath.bin" "$OUT/classpath.bin"
cp "$CACHE/classpath-sjs.bin" "$OUT/classpath-sjs.bin"
cp "$CACHE/sjsir.bin" "$OUT/sjsir.bin"
cp "$CACHE/scalacheck-$SCALACHECK_VERSION-classpath.bin" "$CACHE/scalacheck-$SCALACHECK_VERSION-sjsir.bin" "$OUT/"
cp "$CACHE/LICENSE-scalacheck-$SCALACHECK_VERSION.txt" "$OUT/LICENSE-scalacheck.txt"
cp "$HERE/src/server.js" "$OUT/server.js"
cp "$HERE/src/runner.js" "$OUT/runner.js"
node "$HERE/scripts/finish.mjs" "$OUT" "$SCALA_VERSION" "$JDK_VERSION" "$SCALAJS_VERSION" "$SCALACHECK_VERSION"
ls -l "$OUT"
