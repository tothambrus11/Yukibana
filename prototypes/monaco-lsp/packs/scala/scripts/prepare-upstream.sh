#!/usr/bin/env bash
# Lays out the upstream Scala 3 compiler sources the sbt project compiles:
#   $1/compiler    scala3 compiler/src, then patches/*.patch (its few .java
#                  files are only type-checked against; their Scala.js IR
#                  comes from compiler-js/ir-shims where it is needed)
#   $1/tasty       scala3 tasty/src
#   $1/scalajs-ir  scalajs-ir sources, renamed into dotty.tools.sjs.ir exactly
#                  as upstream's build does (the compiler embeds them), except
#                  SHA1.scala, which comes from the Scala.js build of the same
#                  IR (scalajs-ir_sjs1): the JVM one wraps
#                  java.security.MessageDigest("SHA-1"), which Scala.js lacks,
#                  and the compiler's Scala.js back end hashes every class it
#                  emits with it (the runner compiles to .sjsir)
# Usage: prepare-upstream.sh <out-dir> <scala3-src-checkout> <scalajs-ir-sources.jar> <patches-dir> <scalajs-ir_sjs1-sources.jar>
set -euo pipefail
OUT="$1"; SRC="$2"; IRJAR="$3"; PATCHES="$4"; IRJSJAR="$5"
rm -rf "$OUT.tmp"; mkdir -p "$OUT.tmp"
cp -r "$SRC/compiler/src" "$OUT.tmp/compiler"

cp -r "$SRC/tasty/src" "$OUT.tmp/tasty"
mkdir -p "$OUT.tmp/ir-unzip" "$OUT.tmp/scalajs-ir"
(cd "$OUT.tmp/ir-unzip" && unzip -q "$IRJAR" && unzip -qo "$IRJSJAR" org/scalajs/ir/SHA1.scala)
node -e '
const fs = require("fs"), path = require("path");
const [from, to] = process.argv.slice(1);
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(from).filter(f => f.endsWith(".scala"))) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  // replacePackage + insertUnsafeNullsImport from upstream project/Build.scala
  let i = lines.findIndex(l => l.startsWith("package "));
  if (i >= 0 && lines[i].trim() === "package org.scalajs.ir") lines[i] = "package dotty.tools.sjs.ir";
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === "" || lines[j].trim().startsWith("package "))) j++;
  if (i >= 0) lines.splice(j, 0, "import scala.language.unsafeNulls");
  fs.writeFileSync(path.join(to, path.basename(f)), lines.join("\n"));
}' "$OUT.tmp/ir-unzip" "$OUT.tmp/scalajs-ir"
rm -rf "$OUT.tmp/ir-unzip"
for p in "$PATCHES"/*.patch; do
  [ -e "$p" ] || continue
  patch -s -p1 -d "$OUT.tmp" < "$p"
done
rm -rf "$OUT"; mv "$OUT.tmp" "$OUT"
