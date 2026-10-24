// Serves dist/ with test/web/ on top and runs test/web/index.html in Chromium (Playwright),
// printing the page's log: kotlinc in a worker, type-checking, JS and Kotlin/Wasm (WASI).
//
//   node test/browser.mjs dist
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const dist = path.resolve(process.argv[2] ?? "dist");
const web = path.join(path.dirname(new URL(import.meta.url).pathname), "web");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = [web, dist].map((d) => path.join(d, rel)).find((f) => !rel.includes("..") && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log(m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => document.getElementById("log").textContent.includes("DONE"), null, { timeout: 300000 });
console.log(`total ${Date.now() - t0} ms`);
await browser.close();
server.close();
