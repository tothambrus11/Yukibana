// Serves the prototype directory over HTTP, which the page needs: workers
// and WebAssembly do not load from file:// URLs.
//
//   node test/serve.mjs [port]     then open http://localhost:8080/web/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip' };

/** Starts the server; resolves to its base URL once it listens. */
export function serve(port = 8080) {
    const server = http.createServer((req, res) => {
        let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, {
            'content-type': types[path.extname(file)] ?? 'application/octet-stream',
            'content-length': fs.statSync(file).size,
            // Cross-origin isolation, without which the browser withholds
            // SharedArrayBuffer and so guest threads.
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-embedder-policy': 'require-corp',
        });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => server.listen(port, () => resolve({ url: `http://localhost:${server.address().port}`, server })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { url } = await serve(Number(process.argv[2] ?? 8080));
    console.log(`${url}/web/`);
}
