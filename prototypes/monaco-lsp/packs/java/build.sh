#!/usr/bin/env bash
# Builds the Java pack into ../../app/static/packs/java/:
#
#   compiler.wasm      javac (OpenJDK 25u's jdk.compiler) and TeaVM 0.16.0, both
#                      compiled to one WebAssembly GC module by TeaVM: upstream
#                      teavm-javac (konsoletyper/teavm-javac at $TEAVM_JAVAC_COMMIT),
#                      patched by teavm-javac.patch, plus compiler/ (our
#                      LanguageService, EntryPoints, BootstrapDependencies)
#   teavm-runtime.js   TeaVM's WebAssembly GC loader (compiler.wasm-runtime.js),
#                      which loads compiler.wasm and every program it builds
#   classlib-javac.bin what javac compiles against: the public API of TeaVM's
#                      class library, renamed to java.* (teavm-javac's StdlibConverter)
#   classlib-teavm.bin what TeaVM links a program with: TeaVM's class library,
#                      with classlib/ (System.in, System.exit, Scanner) over it
#   junit.jar          the class files of JUnit Jupiter API $JUNIT_VERSION and what it
#                      needs (junit-platform-commons, opentest4j, apiguardian-api)
#   server.js          the language server worker (src/server.js)
#   runner.js          the Run / Test worker (src/runner.js)
#   manifest.json      file names, sizes and versions
#   LICENSE-*.txt      the licences of what is shipped (scripts/licences.py)
#   *.gz, *.br         compressed siblings
#
# Idempotent; everything downloaded or built is cached in $PACK_CACHE/java
# (default ~/.cache/yukibana-packs/java). Needs git, curl, python3, node 18+,
# and a network that reaches GitHub, Adoptium's downloads and a Maven Central
# mirror. The JDK that builds (Temurin $JDK_VERSION, which Gradle 9.1 and the
# Java 25 sources need) is downloaded, pinned.
set -euo pipefail

TEAVM_JAVAC_COMMIT=208d4c97a602ba0df055f16e6882059fb69d0122   # master, 2026-10-05
TEAVM_VERSION=0.16.0                                          # gradle/libs.versions.toml at that commit
JDK25U_REVISION=6c48f4ed707bf0b15f9b6098de30db8aae6fa40f      # gradle.properties jdk.revision at that commit
JDK_VERSION=25.0.5+8
declare -A JDK_SHA256=(
    [x86_64]=68982529869257d0ee6b824ec5aa270ff8b118bb438670da0b97ebdab178d7fb
    [aarch64]=bb5b2ded252f21c6090cf780b0a408ad0d83bbb557e702955643557f13231880
)
JUNIT_VERSION=5.14.4
JUNIT_PLATFORM_VERSION=1.14.4
declare -A SHA256=(
    [junit-jupiter-api-$JUNIT_VERSION.jar]=aa1ae085fd92dfdbf85d867e60e59adc599bac183b46fc7e0698198bf426ad3f
    [junit-platform-commons-$JUNIT_PLATFORM_VERSION.jar]=55c8a0c069ac1bc4e1f8bbb26b5eae95cbd10e4ff1b23248441ab61a607381e1
    [opentest4j-1.3.0.jar]=48e2df636cab6563ced64dcdff8abb2355627cb236ef0bf37598682ddf742f1b
    [apiguardian-api-1.1.2.jar]=b509448ac506d607319f182537f0b35d71007582ec741832a1f111e5b5b70b38
)
MAVEN="${MAVEN_REPO:-https://repo1.maven.org/maven2}"
MAVEN_MIRROR=https://maven-central.storage-download.googleapis.com/maven2

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/app/static/packs/java"
CACHE="${PACK_CACHE:-$HOME/.cache/yukibana-packs}/java"
mkdir -p "$CACHE/jars" "$OUT"

fetch() { # fetch <maven path> <file name>: into $CACHE/jars, checksum-verified
    local dst="$CACHE/jars/$2"
    if [ ! -f "$dst" ]; then
        curl -fsSL -o "$dst.part" "$MAVEN/$1" || curl -fsSL -o "$dst.part" "$MAVEN_MIRROR/$1"
        mv "$dst.part" "$dst"
    fi
    echo "${SHA256[$2]}  $dst" | sha256sum -c --quiet - || { rm -f "$dst"; echo "checksum mismatch: $2" >&2; exit 1; }
}

# 1. The JDK that runs Gradle and compiles the Java 25 sources.
ARCH="$(uname -m)"
JDK_HOME="$CACHE/jdk/jdk-$JDK_VERSION"
if [ ! -x "$JDK_HOME/bin/java" ]; then
    case "$ARCH" in x86_64) A=x64 ;; aarch64) A=aarch64 ;; *) echo "no pinned JDK for $ARCH" >&2; exit 1 ;; esac
    U="${JDK_VERSION/+/_}"
    curl -fsSL -o "$CACHE/jdk.tar.gz" \
        "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-${JDK_VERSION/+/%2B}/OpenJDK25U-jdk_${A}_linux_hotspot_$U.tar.gz"
    echo "${JDK_SHA256[$ARCH]}  $CACHE/jdk.tar.gz" | sha256sum -c --quiet -
    mkdir -p "$CACHE/jdk"
    tar xzf "$CACHE/jdk.tar.gz" -C "$CACHE/jdk"
    rm "$CACHE/jdk.tar.gz"
fi
export JAVA_HOME="$JDK_HOME"
export GRADLE_USER_HOME="$CACHE/gradle-home"

# 2. The javac sources teavm-javac compiles: only the directories its build
#    reads, from a sparse checkout (GitHub's archive download, which the
#    upstream build uses, is refused through some proxies, and is 150 MB).
JDK_ZIP="$CACHE/jdk25u-$JDK25U_REVISION.zip"
if [ ! -f "$JDK_ZIP" ]; then
    rm -rf "$CACHE/jdk25u-src"
    git init -q "$CACHE/jdk25u-src"
    git -C "$CACHE/jdk25u-src" remote add origin https://github.com/openjdk/jdk25u
    git -C "$CACHE/jdk25u-src" sparse-checkout set --no-cone /make/langtools/tools/ /src/jdk.compiler/share/classes/ \
        /src/java.compiler/share/classes/ /src/jdk.internal.opt/share/classes/ /src/java.base/share/classes/jdk/internal/jmod/
    git -C "$CACHE/jdk25u-src" fetch -q --depth 1 --filter=blob:none origin "$JDK25U_REVISION"
    git -C "$CACHE/jdk25u-src" checkout -q FETCH_HEAD
    python3 -I "$HERE/scripts/zipdir.py" "$CACHE/jdk25u-src" "$JDK_ZIP.part" "jdk25u-$JDK25U_REVISION"
    mv "$JDK_ZIP.part" "$JDK_ZIP"
    rm -rf "$CACHE/jdk25u-src"
fi

# 3. teavm-javac at the pinned commit, patched, with our sources; built
#    again only when one of those changed (the stamp is their checksum).
SRC="$CACHE/teavm-javac"
B="$SRC/compiler/build"
STAMP="$( (echo "$TEAVM_JAVAC_COMMIT $JDK25U_REVISION"; cat "$HERE/teavm-javac.patch"; \
    find "$HERE/compiler" "$HERE/classlib" -type f -name '*.java' | sort | xargs cat) | sha256sum | cut -d' ' -f1)"
if [ "$(cat "$CACHE/build.stamp" 2>/dev/null)" != "$STAMP" ] || [ ! -f "$B/generated/teavm/wasm-gc/compiler.wasm" ] \
    || [ ! -f "$B/generated/teavm/wasm-gc/compiler.wasm-runtime.js" ]; then
    if [ ! -d "$SRC/.git" ]; then
        git clone -q https://github.com/konsoletyper/teavm-javac "$SRC"
    fi
    git -C "$SRC" fetch -q origin "$TEAVM_JAVAC_COMMIT" 2>/dev/null || true
    git -C "$SRC" checkout -q -f "$TEAVM_JAVAC_COMMIT"
    git -C "$SRC" clean -q -f -d compiler/src/main/java compiler/src/main/resources
    git -C "$SRC" apply "$HERE/teavm-javac.patch"
    cp "$HERE"/compiler/org/teavm/javac/*.java "$SRC/compiler/src/main/java/org/teavm/javac/"
    # compiler.wasm's own javac needs Java's ArithmeticException too: the
    # division helper, and the plugin that calls it, for TeaVM's Gradle build.
    mkdir -p "$SRC/compiler/src/main/java/org/teavm/classlib/impl"
    cp "$HERE/classlib/org/teavm/classlib/impl/CheckedDivision.java" "$SRC/compiler/src/main/java/org/teavm/classlib/impl/"
    git -C "$SRC" checkout -q -- compiler/src/main/resources
    printf "\norg.teavm.javac.DivisionChecks\n" >> "$SRC/compiler/src/main/resources/META-INF/services/org.teavm.vm.spi.TeaVMPlugin"
    rm -f "$CACHE/build.stamp"

    # 4. Build: the compiler module (javac + TeaVM + ours, to compiler.wasm)
    #    and the two class library archives. TeaVM compiles out of process
    #    with 4 GB; about 3 minutes on 4 cores. copyWasmGCRuntime writes
    #    compiler.wasm-runtime.js (teavm-runtime.js): generateWasmGC does not,
    #    and a cache whose first build ran Gradle's whole `build` hid that.
    rm -f "$B/generated/teavm/wasm-gc/compiler.wasm" "$B/generated/teavm/wasm-gc/compiler.wasm-runtime.js"
    status=0
    ( cd "$SRC" && nice -n 10 ./gradlew --no-daemon -q \
        -Pjdk.zip="$JDK_ZIP" -Pyukibana.classlib="$HERE/classlib" \
        :compiler:generateWasmGC :compiler:copyWasmGCRuntime :compiler:buildTeaVMClassLib :compiler:generateClassLib ) \
        > "$CACHE/gradle.log" 2>&1 || status=$?
    grep -v -e '^Picked up JAVA_TOOL_OPTIONS' -e 'RELEASE_11' -e '^1 warning' -e '^Build daemon' "$CACHE/gradle.log" || true
    if [ "$status" != 0 ] || [ ! -f "$B/generated/teavm/wasm-gc/compiler.wasm" ] \
        || [ ! -f "$B/generated/teavm/wasm-gc/compiler.wasm-runtime.js" ]; then
        echo "teavm-javac did not build (gradle exit $status; log in $CACHE/gradle.log)" >&2
        exit 1
    fi
    echo "$STAMP" > "$CACHE/build.stamp"
fi

# 5. JUnit Jupiter's API, one jar of class files.
fetch org/junit/jupiter/junit-jupiter-api/$JUNIT_VERSION/junit-jupiter-api-$JUNIT_VERSION.jar junit-jupiter-api-$JUNIT_VERSION.jar
fetch org/junit/platform/junit-platform-commons/$JUNIT_PLATFORM_VERSION/junit-platform-commons-$JUNIT_PLATFORM_VERSION.jar junit-platform-commons-$JUNIT_PLATFORM_VERSION.jar
fetch org/opentest4j/opentest4j/1.3.0/opentest4j-1.3.0.jar opentest4j-1.3.0.jar
fetch org/apiguardian/apiguardian-api/1.1.2/apiguardian-api-1.1.2.jar apiguardian-api-1.1.2.jar
python3 -I "$HERE/scripts/merge-jars.py" "$OUT/junit.jar" \
    "$CACHE/jars/junit-jupiter-api-$JUNIT_VERSION.jar" "$CACHE/jars/junit-platform-commons-$JUNIT_PLATFORM_VERSION.jar" \
    "$CACHE/jars/opentest4j-1.3.0.jar" "$CACHE/jars/apiguardian-api-1.1.2.jar"

# 6. The pack.
cp "$B/generated/teavm/wasm-gc/compiler.wasm" "$OUT/compiler.wasm"
cp "$B/generated/teavm/wasm-gc/compiler.wasm-runtime.js" "$OUT/teavm-runtime.js"
cp "$B/classlib/compile-classlib-teavm.bin" "$OUT/classlib-javac.bin"
cp "$B/classlib/runtime-classlib-teavm.bin" "$OUT/classlib-teavm.bin"
cp "$HERE/src/server.js" "$HERE/src/runner.js" "$OUT/"
# ASM's licence is only in its sources' headers: the sources jar, pinned.
SHA256[asm-9.8-sources.jar]=c6294794f956f21e2b252a9bf65a96ce0489fb4c0f978447d85c8a75e485b633
fetch org/ow2/asm/asm/9.8/asm-9.8-sources.jar asm-9.8-sources.jar
python3 -I "$HERE/scripts/licences.py" "$OUT" "$JDK_HOME/legal" \
    "$CACHE/jars/junit-jupiter-api-$JUNIT_VERSION.jar" "$CACHE/jars/opentest4j-1.3.0.jar" "$CACHE/jars/asm-9.8-sources.jar"
node "$HERE/scripts/finish.mjs" "$OUT" "$TEAVM_VERSION" "$TEAVM_JAVAC_COMMIT" "$JDK25U_REVISION" "$JUNIT_VERSION"
