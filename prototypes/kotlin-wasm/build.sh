#!/usr/bin/env bash
# Builds the real Kotlin compiler (kotlinc, K2) as WebAssembly GC with GraalVM Web Image, into
# ./dist:
#
#   kc.js, kc.js.wasm   kotlinc $KOTLIN_VERSION and yk.KotlinService (service/), compiled by
#                       native-image --tool:svm-wasm; kc.js reads globalThis.ykWasmPath
#   lib/                the libraries a compilation reads, with their zip entries stored, not
#                       deflated (there is no zlib at run time): kotlin-stdlib.jar,
#                       jdk-api.jar (java.base's java.* classes, for -no-jdk),
#                       kotlin-stdlib-js.klib, kotlin-stdlib-wasm-wasi.klib
#
# Steps: download and check the pinned GraalVM EA, binaryen and kotlinc; patch two builder bugs
# and the compiler's jars (tools/); compile the service, the substitutions and the tracing driver;
# trace kotlinc's reflection on HotSpot with native-image-agent (unless config/ already has it);
# build the image; assemble dist/.
#
# Needs curl, unzip, zip, python3, node 22+, about 12 GB of memory and 20 minutes the first time.
# Everything downloaded or built goes to $YK_CACHE (default ~/.cache/yukibana-kotlin-wasm).
set -euo pipefail

KOTLIN_VERSION=2.4.21
KOTLIN_SHA256=7cc140e76daf416a0424a5557f99afd7ca89ebd463ea1101261e3e01c33e75cd
# Oracle GraalVM 25.1 early access ("25e1"): Web Image needs 25.1 or later, and only Oracle
# GraalVM ships it prebuilt (the source is in oracle/graal, web-image/, GPLv2 with CPE).
GRAALVM_TAG=jdk-25e1-25.0.3-ea.32
GRAALVM_FILE=graalvm-jdk-25e1-25.0.3-ea.32_linux-x64_bin.tar.gz
GRAALVM_SHA256=46342977b254c57e3f870aa58aba1af152751e027e8390f3bfbd956d4cce3ef7
BINARYEN_VERSION=133
BINARYEN_SHA256=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${YK_CACHE:-$HOME/.cache/yukibana-kotlin-wasm}"
DIST="$HERE/dist"
mkdir -p "$CACHE" "$DIST/lib"

fetch() { # fetch <url> <file> <sha256>: into $CACHE, verified
    local dst="$CACHE/$2"
    [ -f "$dst" ] || { curl -fsSL -o "$dst.part" "$1"; mv "$dst.part" "$dst"; }
    echo "$3  $dst" | sha256sum -c --quiet || { rm -f "$dst"; echo "checksum mismatch: $2" >&2; exit 1; }
}
fetch "https://github.com/graalvm/oracle-graalvm-ea-builds/releases/download/$GRAALVM_TAG/$GRAALVM_FILE" "$GRAALVM_FILE" "$GRAALVM_SHA256"
fetch "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN_VERSION/binaryen-version_$BINARYEN_VERSION-x86_64-linux.tar.gz" \
    "binaryen-$BINARYEN_VERSION.tar.gz" "$BINARYEN_SHA256"
fetch "https://github.com/JetBrains/kotlin/releases/download/v$KOTLIN_VERSION/kotlin-compiler-$KOTLIN_VERSION.zip" \
    "kotlin-compiler-$KOTLIN_VERSION.zip" "$KOTLIN_SHA256"

if [ ! -d "$CACHE/graalvm" ]; then
    mkdir -p "$CACHE/graalvm.part" && tar xzf "$CACHE/$GRAALVM_FILE" -C "$CACHE/graalvm.part" --strip-components=1
    mv "$CACHE/graalvm.part" "$CACHE/graalvm"
fi
[ -d "$CACHE/binaryen" ] || { tar xzf "$CACHE/binaryen-$BINARYEN_VERSION.tar.gz" -C "$CACHE" && mv "$CACHE/binaryen-version_$BINARYEN_VERSION" "$CACHE/binaryen"; }
[ -d "$CACHE/kotlinc" ] || unzip -q "$CACHE/kotlin-compiler-$KOTLIN_VERSION.zip" -d "$CACHE"
G="$CACHE/graalvm"
export JAVA_HOME="$G" PATH="$G/bin:$CACHE/binaryen/bin:$PATH"
KLIB="$CACHE/kotlinc/lib"
B="$CACHE/build"
rm -rf "$B" && mkdir -p "$B"/{jars,tools,trace,service,subst,image}

# Our tools, against the compiler's shaded ASM.
javac -nowarn -cp "$KLIB/kotlin-compiler.jar" -d "$B/tools" "$HERE"/tools/src/yk/*.java

# The builder: Web Image has no support method for the UNSTRUCTURED_LOCKING bytecode exception
# and aborts on the first method that has one (tools/src/yk/PatchWebImage.java). Patched in a
# copy of the jar, put first on the builder's class path.
WI_JAR="$G/lib/svm/tools/svm-wasm/builder/svm-wasm.jar"
WI_CLASS=com/oracle/svm/hosted/webimage/codegen/WebImageImplicitExceptionsFeature.class
if ! unzip -p "$WI_JAR" "$WI_CLASS" | cmp -s - "$CACHE/patched-$(basename "$WI_CLASS")" 2>/dev/null; then
    mkdir -p "$B/wi" && (cd "$B/wi" && unzip -q -o "$WI_JAR" "$WI_CLASS")
    java -cp "$B/tools:$KLIB/kotlin-compiler.jar" yk.PatchWebImage "$B/wi/$WI_CLASS" "$B/wi/patched.class"
    cp -n "$WI_JAR" "$WI_JAR.orig" || true
    cp "$B/wi/patched.class" "$B/wi/$WI_CLASS" && (cd "$B/wi" && zip -q "$WI_JAR" "$WI_CLASS")
    cp "$B/wi/patched.class" "$CACHE/patched-$(basename "$WI_CLASS")"
fi

# The compiler's jars, without the jline native-image configuration kotlin-compiler.jar carries
# (it names files the jar does not have) and without interfaces' abstract redeclarations of
# Object's methods (tools/src/yk/StripObjectMethods.java).
JARS=(kotlin-compiler kotlin-stdlib kotlin-reflect kotlin-script-runtime kotlinx-coroutines-core-jvm annotations-13.0)
for j in "${JARS[@]}"; do
    java -cp "$B/tools:$KLIB/kotlin-compiler.jar" yk.StripObjectMethods "$KLIB/$j.jar" "$B/jars/$j.jar"
done
zip -q -d "$B/jars/kotlin-compiler.jar" 'META-INF/native-image/*'
CP=$(printf "$B/jars/%s.jar:" "${JARS[@]}"); CP=${CP%:}

# Reflection the image needs beyond what tracing sees: the fields of every class handed to an
# Atomic*FieldUpdater, and kotlinc's argument classes, which its parser fills reflectively.
mkdir -p "$B/service/META-INF/native-image/yk-generated"
java -cp "$B/tools:$B/jars/kotlin-compiler.jar" yk.FindUpdaters "$B"/jars/*.jar > "$B/updaters.json"
unzip -Z1 "$B/jars/kotlin-compiler.jar" 'org/jetbrains/kotlin/cli/common/arguments/*.class' > "$B/arguments.txt"
python3 -I - "$B/updaters.json" "$B/arguments.txt" "$B/service/META-INF/native-image/yk-generated/reachability-metadata.json" <<'EOF'
import json, sys
updaters, arguments, out = sys.argv[1:]
r = json.load(open(updaters))["reflection"]
for line in open(arguments):
    t = line.strip()[:-len(".class")].replace("/", ".")
    r.append({"type": t, "allDeclaredFields": True, "allDeclaredMethods": True,
              "allPublicMethods": True, "allDeclaredConstructors": True})
json.dump({"reflection": r}, open(out, "w"), indent=1)
EOF

javac -nowarn --add-modules org.graalvm.webimage.api -parameters -cp "$CP" -d "$B/service" "$HERE"/service/src/yk/*.java
cp -r "$HERE/service/META-INF" "$B/service/"
javac -nowarn --add-modules org.graalvm.nativeimage -d "$B/subst" "$HERE"/substitutions/src/yk/*.java

# Libraries, with stored entries.
store() { # store <archive> <out>
    rm -rf "$B/x" && mkdir "$B/x" && (cd "$B/x" && unzip -q "$1" && zip -q -0 -X -r "$2" .)
}
rm -f "$DIST"/lib/*
mkdir -p "$B/jdk" && jmod extract --dir "$B/jdk" "$G/jmods/java.base.jmod"
(cd "$B/jdk/classes" && find java -name '*.class' ! -name '*$[0-9]*' | sort | zip -q -0 -X "$DIST/lib/jdk-api.jar" -@)
store "$KLIB/kotlin-stdlib.jar" "$DIST/lib/kotlin-stdlib.jar"
store "$KLIB/kotlin-stdlib-js.klib" "$DIST/lib/kotlin-stdlib-js.klib"
store "$KLIB/kotlin-stdlib-wasm-wasi.klib" "$DIST/lib/kotlin-stdlib-wasm-wasi.klib"

# Reflection, resources and proxies kotlinc uses, traced on HotSpot over the same compilations
# test/run-node.mjs makes. Committed in config/; delete it to trace again.
TRACED="$HERE/config/traced-reachability-metadata.json"
if [ ! -f "$TRACED" ]; then
    javac -nowarn -cp "$CP" -d "$B/trace" "$HERE"/trace/src/yk/*.java
    T="$B/trace-run"; mkdir -p "$T/cfg"
    run() { java -agentlib:native-image-agent=config-merge-dir="$T/cfg" -cp "$B/trace:$CP" yk.Kc "$@" -kotlin-home "$CACHE/kotlinc" >/dev/null 2>&1 || true; }
    D="$HERE/test/demo"
    run jvm -no-jdk -no-stdlib -no-reflect -classpath "$DIST/lib/kotlin-stdlib.jar:$DIST/lib/jdk-api.jar" -d "$T/o1" "$D/Main.kt"
    run jvm -Xuse-fast-jar-file-system=false -no-jdk -no-stdlib -no-reflect -classpath "$DIST/lib/kotlin-stdlib.jar:$DIST/lib/jdk-api.jar" -d "$T/o2" "$D/Bad.kt"
    run js -Xir-produce-klib-dir -ir-output-dir "$T/k" -ir-output-name main -libraries "$KLIB/kotlin-stdlib-js.klib" "$D/Main.kt"
    run js -Xir-produce-js -Xinclude="$T/k" -ir-output-dir "$T/j" -ir-output-name main -libraries "$KLIB/kotlin-stdlib-js.klib" -main call -target es2015 -module-kind es
    W=(-Xwasm-target=wasm-wasi -libraries "$KLIB/kotlin-stdlib-wasm-wasi.klib" -ir-output-name main)
    run wasm "${W[@]}" -Xir-produce-klib-dir -ir-output-dir "$T/wk" "$D/Io.kt"
    run wasm "${W[@]}" -Xir-produce-js -Xinclude="$T/wk" -Xcache-directory="$T/c" -ir-output-dir "$T/w"
    run wasm "${W[@]}" -Xir-produce-js -Xinclude="$T/wk" -Xcache-directory="$T/c" -ir-output-dir "$T/w"
    cp "$T/cfg/reachability-metadata.json" "$TRACED"
fi
mkdir -p "$B/traced" && cp "$TRACED" "$B/traced/reachability-metadata.json"

# The image. -Ob (quick build) keeps the builder at about 8 GB; wasm-as runs afterwards.
mkdir -p "$B/stub" && cp "$HERE/tools/wasm-as-stub.sh" "$B/stub/wasm-as" && ln -sf "$CACHE/binaryen/bin/wasm-as" "$B/stub/wasm-as.real"
(cd "$B/image" && native-image --tool:svm-wasm -J-Xmx10g -Ob \
    -H:+AddAllCharsets -H:WasmComments=NONE -H:ImageHeapObjectsPerFunction=20000 \
    -H:WasmAsPath="$B/stub/wasm-as" \
    -H:ConfigurationFileDirectories="$B/traced" \
    -cp "$B/service:$B/subst:$CP" -o kc yk.KotlinService)
(cd "$B/image" && eval "wasm-as $(cat kc.js.wasm.args)" && rm -f kc.js.wat)

# kc.js finds its .wasm next to the script that loaded it; a worker that importScripts() it
# names the path instead.
sed 's|const wasmPath = config.wasm_path \|\| runtime.getCurrentFile() + ".wasm";|const wasmPath = config.wasm_path \|\| globalThis.ykWasmPath \|\| runtime.getCurrentFile() + ".wasm";|' \
    "$B/image/kc.js" > "$DIST/kc.js"
grep -q ykWasmPath "$DIST/kc.js" || { echo "kc.js: the wasm path line moved" >&2; exit 1; }
cp "$B/image/kc.js.wasm" "$DIST/"
ls -l "$DIST" "$DIST/lib"
