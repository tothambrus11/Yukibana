// Runs kotlinc (kc.js + kc.js.wasm, GraalVM Web Image) in a worker: loads the libraries into its
// in-memory file system, then answers {id, which, args} messages with kotlinc's JSON result.
const t0 = performance.now();
self.ykWasmPath = "kc.js.wasm"; // kc.js would look for worker.js.wasm
const ready = new Promise((resolve) => { self.ykReady = resolve; });
importScripts("kc.js");

function latin1(buf) { // bytes to a string of one char per byte, in chunks (apply's argument limit)
    const u8 = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
}

(async () => {
    const yk = await ready;
    const tReady = performance.now() - t0;
    const t1 = performance.now();
    const libs = ["kotlin-stdlib.jar", "jdk-api.jar", "kotlin-stdlib-js.klib", "kotlin-stdlib-wasm-wasi.klib"];
    const bufs = await Promise.all(libs.map((l) => fetch(`lib/${l}`).then((r) => r.arrayBuffer())));
    libs.forEach((l, i) => yk.writeFile(`/lib/${l}`, latin1(bufs[i])));
    yk.writeFile("/kotlinc/lib/README", "");
    postMessage({ type: "ready", tReady, tLibs: performance.now() - t1 });
    self.onmessage = (e) => {
        const { id, files, which, args } = e.data;
        const t = performance.now();
        for (const [p, text] of Object.entries(files ?? {})) yk.writeFile(p, unescape(encodeURIComponent(text)));
        let result;
        try { result = JSON.parse(String(yk.compile(which, args.join("\n")))); }
        catch (err) { result = { exit: -1, error: String(err) }; }
        const out = {};
        for (const dir of ["/out/js"]) for (const f of String(yk.listFiles(dir)).split("\n").filter(Boolean))
            out[f] = decodeURIComponent(escape(String(yk.readFile(f))));
        for (const f of String(yk.listFiles("/out/wasm")).split("\n").filter((f) => f.endsWith(".wasm"))) {
            const s = String(yk.readFile(f)), u8 = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
            out[f] = u8;
        }
        postMessage({ type: "result", id, result, out, wall: performance.now() - t });
    };
})();
