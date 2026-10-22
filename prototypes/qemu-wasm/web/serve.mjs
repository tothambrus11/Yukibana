// Static server with the cross-origin isolation headers QEMU-Wasm's threads need.
// usage: node serve.mjs <root> [port]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const port = Number(process.argv[3] || 8090);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css" };
http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    // QEMU's emscripten build names its JS loader qemu-system-<arch>, no extension,
    // and its pthread workers load it by that name as a module script.
    "Content-Type": types[path.extname(p)] || (path.basename(p).startsWith("qemu-system-") ? "text/javascript" : "application/octet-stream"),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  fs.createReadStream(p).pipe(res);
}).listen(port, "127.0.0.1");
