// Drives dist/ in node: puts the libraries and the demo sources in kotlinc's in-memory file
// system, type-checks and compiles for the JVM, JS and Kotlin/Wasm (WASI), runs the JS and the
// WASI program, and prints timings.
//
//   node --experimental-wasm-exnref test/run-node.mjs dist test/demo
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wasiImports } from "./web/wasi.mjs";

const [dist, demo] = process.argv.slice(2);
const t0 = performance.now();
const yk = await new Promise((resolve) => {
    globalThis.ykReady = resolve;
    import(pathToFileURL(path.resolve(dist, "kc.js")).href);
});
console.log(`ready in ${(performance.now() - t0).toFixed(0)} ms`);

const put = (dst, src) => yk.writeFile(dst, fs.readFileSync(src).toString("latin1"));
const get = (src) => Buffer.from(String(yk.readFile(src)), "latin1");
let t = performance.now();
for (const l of fs.readdirSync(path.join(dist, "lib"))) put(`/lib/${l}`, path.join(dist, "lib", l));
yk.writeFile("/kotlinc/lib/README", "-kotlin-home must exist; compiler plugins would go here");
for (const f of fs.readdirSync(demo)) put(`/src/${f}`, path.join(demo, f));
console.log(`files in ${(performance.now() - t).toFixed(0)} ms`);

const compile = (which, args) => {
    const t = performance.now();
    const r = JSON.parse(String(yk.compile(which, args.join("\n"))));
    console.log(`${which} ${args.at(-1)}: exit ${r.exit}, ${(performance.now() - t).toFixed(0)} ms`);
    for (const m of r.messages) if (m.severity !== "info" && !m.message.includes("is deprecated"))
        console.log(`  ${m.severity} ${m.path ?? ""}:${m.line ?? ""}:${m.column ?? ""} ${m.message}`);
    return r;
};
const home = ["-kotlin-home", "/kotlinc"];

// JVM: the editor's type-check, and class files.
const jvm = [...home, "-Xuse-fast-jar-file-system=false", "-no-jdk", "-no-stdlib", "-no-reflect",
    "-classpath", "/lib/kotlin-stdlib.jar:/lib/jdk-api.jar", "-d", "/out/jvm"];
for (let i = 0; i < 3; i++) compile("jvm", [...jvm, "/src/Main.kt"]);
compile("jvm", [...jvm, "/src/Bad.kt"]);
console.log("  " + String(yk.listFiles("/out/jvm")).split("\n").join(" "));

// JS: klib, then link.
const js = [...home, "-libraries", "/lib/kotlin-stdlib-js.klib", "-ir-output-name", "main"];
compile("js", [...js, "-Xir-produce-klib-dir", "-ir-output-dir", "/out/klib", "/src/Main.kt"]);
compile("js", [...js, "-Xir-produce-js", "-Xinclude=/out/klib", "-ir-output-dir", "/out/js",
    "-main", "call", "-target", "es2015", "-module-kind", "es", "link"]);
fs.mkdirSync("/tmp/yk-js", { recursive: true });
fs.writeFileSync("/tmp/yk-js/main.mjs", get("/out/js/main.mjs"));
await import("/tmp/yk-js/main.mjs?" + Date.now());

// Kotlin/Wasm for WASI: klib, then link with a cache of the standard library's lowered IR.
const wasi = [...home, "-Xwasm-target=wasm-wasi", "-libraries", "/lib/kotlin-stdlib-wasm-wasi.klib", "-ir-output-name", "main"];
compile("wasm", [...wasi, "-Xir-produce-klib-dir", "-ir-output-dir", "/out/wklib", "/src/Io.kt"]);
for (let i = 0; i < 3; i++)
    compile("wasm", [...wasi, "-Xir-produce-js", "-Xinclude=/out/wklib", "-Xcache-directory=/cache/wasi", "-ir-output-dir", "/out/wasm", "link"]);
const bytes = get("/out/wasm/main.wasm");
const w = wasiImports(new TextEncoder().encode("Ambrus\n10\n"), (fd, text) => process.stdout.write(text));
const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: w.imports });
w.bind(instance);
console.log(`WASI program, ${bytes.length} bytes, stdin "Ambrus\\n10\\n":`);
instance.exports._start();

globalThis.gc?.();
const mu = process.memoryUsage();
console.log(`rss ${(mu.rss / 1e6).toFixed(0)} MB, heap used ${(mu.heapUsed / 1e6).toFixed(0)} MB`);
