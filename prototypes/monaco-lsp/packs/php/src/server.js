// PHP language server for the Yukibana IDE (packs/CONTRACT.md): Phpactor,
// the real one, run by PHP 8.4 compiled to WebAssembly, in this module
// worker. Phpactor is a PHP program that speaks LSP over stdio; here its
// stdin is fed from postMessage and its stdout is parsed back into messages.
//
// Phpactor's event loop (amphp) polls stdin without blocking. php-wasm's
// build is Asyncify-instrumented and yields to the JavaScript event loop
// whenever PHP sleeps or waits in select(), so while Phpactor is idle this
// worker's onmessage runs, appends the message to the stdin queue, and the
// next poll reads it. No SharedArrayBuffer, no second worker: the server
// does not need crossOriginIsolated.
//
// The project is mirrored into /workspace in PHP's in-memory file system,
// because Phpactor's indexer and its class locators read files from disk.

import { download, runCli, startPhp, untar, writeFile } from './php.js';

const ROOT = '/workspace';
const ROOT_URI = 'file:///workspace/';
/**
 * Where Phpactor keeps its index: /opt/cache comes in phpactor.tar with the
 * index of the stubs already built (build.sh), so only the project is
 * indexed when the server starts. scripts/build-index.mjs says the same.
 */
const ENV = { XDG_CACHE_HOME: '/opt/cache', XDG_DATA_HOME: '/tmp/data', XDG_CONFIG_HOME: '/tmp/config' };

const post = (msg) => self.postMessage(msg);
const log = (type, message) => post({ jsonrpc: '2.0', method: 'window/logMessage', params: { type, message } });
const encoder = new TextEncoder();

// ---- stdin: framed messages, read a byte at a time by PHP

/** Bytes waiting to be read by PHP, as a queue of chunks. */
const input = [];
let inputAt = 0;
let exited = false;

function stdin() {
    while (input.length && inputAt >= input[0].length) {
        input.shift();
        inputAt = 0;
    }
    if (input.length) return input[0][inputAt++];
    return exited ? null : undefined;
}

function send(msg) {
    const body = encoder.encode(JSON.stringify(msg));
    input.push(encoder.encode(`Content-Length: ${body.length}\r\n\r\n`), body);
}

// ---- stdout: Content-Length framed JSON, back into messages

let pending = new Uint8Array(0);
const decoder = new TextDecoder();

function stdout(chunk) {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    pending = joined;
    for (;;) {
        const end = indexOfHeaderEnd(pending);
        if (end < 0) return;
        const header = decoder.decode(pending.subarray(0, end));
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
        if (!Number.isFinite(length)) {
            log(1, `phpactor wrote something that is not a message: ${header}`);
            pending = pending.slice(end + 4);
            continue;
        }
        if (pending.length < end + 4 + length) return;
        const body = decoder.decode(pending.subarray(end + 4, end + 4 + length));
        pending = pending.slice(end + 4 + length);
        let msg;
        try {
            msg = JSON.parse(body);
        } catch {
            log(1, `phpactor wrote a message that is not JSON: ${body.slice(0, 200)}`);
            continue;
        }
        published(msg);
        post(msg);
    }
}

function indexOfHeaderEnd(bytes) {
    for (let i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    }
    return -1;
}

const errorText = new TextDecoder();
let errorLine = '';
function stderr(chunk) {
    errorLine += errorText.decode(chunk, { stream: true });
    const lines = errorLine.split('\n');
    errorLine = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) log(4, line);
}

// ---- the project, mirrored into the file system

/** The file-system path of a project URI, or null for one outside the project. */
function pathOf(uri) {
    if (!uri.startsWith(ROOT_URI)) return null;
    return `${ROOT}/${decodeURIComponent(uri.slice(ROOT_URI.length))}`;
}

function mirror(php, msg) {
    const p = msg.params;
    if (msg.method === 'textDocument/didOpen') {
        const path = pathOf(p.textDocument.uri);
        if (path) writeFile(php, path, p.textDocument.text);
    } else if (msg.method === 'textDocument/didChange') {
        const path = pathOf(p.textDocument.uri);
        const last = p.contentChanges.at(-1);
        if (path && last && !('range' in last)) writeFile(php, path, last.text);
    } else if (msg.method === 'workspace/didChangeWatchedFiles') {
        for (const change of p.changes) {
            const path = pathOf(change.uri);
            if (path && change.type === 3) {
                try {
                    php.FS.unlink(path);
                } catch {
                    // Already gone.
                }
            }
        }
    }
}

// ---- diagnostics for every file of the project when it opens
//
// Phpactor's diagnostics engine keeps one waiting document: each didOpen or
// didChange replaces the one before it, and a document replaced while it is
// being checked loses the rest of its results. An editor opens the file it
// shows; the app opens every file of the project at once, so only the last
// of them would be checked. So the files opened before the first edit are
// sent again, as a didChange with the same text, one at a time, each when
// the server has been quiet for QUIET_MS (nothing published). The first edit
// from the client ends this for good: from then on, a check started here
// could replace the edited file's, whose diagnostics are the ones that
// matter. A file the first edit came before is checked when it is edited.

const QUIET_MS = 1500;
/** The text and version of each file opened before the first edit, by URI, while unchecked. */
const unchecked = new Map();
let quiet = 0;

function busy() {
    clearTimeout(quiet);
    if (unchecked.size) quiet = setTimeout(checkNext, QUIET_MS);
}

function checkNext() {
    const next = unchecked.entries().next().value;
    if (!next) return;
    const [uri, { text, version }] = next;
    unchecked.delete(uri);
    send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
    busy();
}

const isPhp = (uri) => /\.(php|phtml|inc)$/i.test(uri);
let edited = false;

/**
 * What reaches Phpactor of a message from the client: documents that are not
 * PHP (README.md, composer.json) are only mirrored into the file system, or
 * Phpactor would check them as PHP and report the text as a parse error.
 */
function forward(msg) {
    const uri = msg.params?.textDocument?.uri;
    if (msg.method?.startsWith('textDocument/did') && uri && !isPhp(uri)) return;
    if (msg.method === 'textDocument/didOpen' && !edited) {
        unchecked.set(uri, { text: msg.params.textDocument.text, version: msg.params.textDocument.version });
        busy();
    } else if (msg.method === 'textDocument/didChange' || msg.method === 'textDocument/didClose') {
        edited = true;
        unchecked.clear();
        clearTimeout(quiet);
    }
    send(msg);
}

/** Notes Phpactor's own output, for the check above. */
function published(msg) {
    if (msg.method === 'textDocument/publishDiagnostics') {
        unchecked.delete(msg.params.uri);
        busy();
    }
}

// ---- start

const report = (params) => post({ jsonrpc: '2.0', method: 'yukibana/loading', params });
const early = [];
let php = null;

self.onmessage = ({ data: msg }) => {
    if (php) {
        mirror(php, msg);
        forward(msg);
    } else early.push(msg);
};

async function main() {
    const [runtime, phpactor] = await Promise.all([
        startPhp({ report, stdin, stdout, stderr, env: ENV }),
        download('phpactor.tar', report),
    ]);
    untar(runtime, phpactor, '/opt');
    runtime.FS.mkdirTree(ROOT);
    runtime.FS.chdir(ROOT);
    php = runtime;
    for (const msg of early.splice(0)) {
        mirror(php, msg);
        forward(msg);
    }
    const code = await runCli(php, ['php', '/opt/yukibana/phpactor.php', 'language-server']);
    exited = true;
    log(code === 0 ? 3 : 1, `phpactor exited with code ${code}`);
}

main().catch((e) => {
    log(1, `PHP language server failed to start: ${e?.stack ?? e}`);
    // Answer a waiting initialize, so the client reports the failure.
    for (const msg of early) {
        if (msg.method === 'initialize') post({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
});
