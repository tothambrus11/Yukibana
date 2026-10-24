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
        post(amend(msg));
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

/** The text of each document, by URI, for the completion added below. */
const texts = new Map();

function mirror(php, msg) {
    const p = msg.params;
    if (msg.method === 'textDocument/didOpen') {
        const path = pathOf(p.textDocument.uri);
        texts.set(p.textDocument.uri, p.textDocument.text);
        if (path) writeFile(php, path, p.textDocument.text);
    } else if (msg.method === 'textDocument/didChange') {
        const path = pathOf(p.textDocument.uri);
        const last = p.contentChanges.at(-1);
        if (last && !('range' in last)) texts.set(p.textDocument.uri, last.text);
        if (path && last && !('range' in last)) writeFile(php, path, last.text);
    } else if (msg.method === 'workspace/didChangeWatchedFiles') {
        for (const change of p.changes) {
            const path = pathOf(change.uri);
            if (change.type === 3) texts.delete(change.uri);
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
    if (msg.id !== undefined && AMENDED.has(msg.method)) asked.set(msg.id, msg);
    send(msg);
}

/** Notes Phpactor's own output, for the check above. */
function published(msg) {
    if (msg.method === 'textDocument/publishDiagnostics') {
        unchecked.delete(msg.params.uri);
        busy();
    }
}

// ---- what this layer adds to Phpactor's answers
//
// * Keywords. Phpactor completes only declaration keywords (`class`,
//   `function`...) at the start of a statement and visibility in a class
//   body; `whil` and `retu` in a function body offered nothing. The
//   statement and expression keywords are added here, where PHP code (not
//   HTML, a string or a comment) is typed outside a class body, and not after
//   `->`, `::`, `$` or `\`.
// * Class rename without moving the file. Phpactor's class rename ends with
//   a RenameFile operation (to where PSR-4 would put the class), which the
//   editor cannot apply, and which would move a file that holds other
//   declarations too (geometry.php). It is dropped: the class is renamed in
//   every file, and its file keeps its name (rename.php says the rest).

/** The client's requests whose answers are amended, by id. */
const asked = new Map();
const AMENDED = new Set(['textDocument/completion', 'textDocument/rename']);

function amend(msg) {
    const request = msg.id !== undefined && !msg.method ? asked.get(msg.id) : undefined;
    if (!request) return msg;
    asked.delete(msg.id);
    if (msg.error || !msg.result) return msg;
    if (request.method === 'textDocument/completion') return { ...msg, result: withKeywords(msg.result, request.params) };
    const changes = msg.result.documentChanges;
    if (request.method === 'textDocument/rename' && changes?.some((c) => c.kind === 'rename')) {
        for (const c of changes) if (c.kind === 'rename') log(3, `class rename: ${c.oldUri} keeps its file name (Phpactor would move it to ${c.newUri})`);
        return { ...msg, result: { ...msg.result, documentChanges: changes.filter((c) => c.kind !== 'rename') } };
    }
    return msg;
}

/** Statement and expression keywords; at the top level, declarations too. */
const KEYWORDS = `if else elseif while do for foreach as switch case default break continue return try catch finally
throw echo print yield global static unset isset empty list include include_once require require_once goto match fn
function new clone instanceof and or xor true false null self parent array callable iterable exit die`.split(/\s+/);
const TOP_LEVEL = 'namespace use const class interface trait enum abstract final readonly declare'.split(' ');

function withKeywords(result, { textDocument, position }) {
    const text = texts.get(textDocument.uri);
    if (text === undefined) return result;
    const lines = text.split('\n');
    let offset = position.character;
    for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1;
    const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text.slice(0, offset))?.[0] ?? '';
    if (!word) return result;
    const context = codeContext(text, offset - word.length);
    if (!context || context.inClass || /^(->|::|\$|\\|function|const|class|interface|trait|enum|new|namespace|use|extends|implements)$/i.test(context.previous)) {
        return result;
    }
    const items = Array.isArray(result) ? result : (result.items ?? []);
    const have = new Set(items.map((i) => i.label.trim().toLowerCase()));
    const lower = word.toLowerCase();
    const added = [...KEYWORDS, ...(context.depth === 0 ? TOP_LEVEL : [])]
        .filter((k) => k.startsWith(lower) && !have.has(k))
        .map((k) => ({ label: k, kind: 14, insertText: k }));
    if (!added.length) return result;
    return Array.isArray(result) ? [...result, ...added] : { ...result, items: [...items, ...added] };
}

/**
 * Where `end` is in a PHP file, by a scan of the text before it: null inside
 * HTML, a string, a heredoc or a comment; otherwise whether the innermost
 * brace is a class body, how many braces are open, and the token before.
 * A scan, not a parser: enough to keep keywords out of where they cannot go.
 */
function codeContext(text, end) {
    const braces = [];
    let i = text.indexOf('<?');
    let previous = '';
    let classNext = false;
    if (i < 0 || i >= end) return null;
    i = text.startsWith('<?php', i) ? i + 5 : i + 2;
    while (i < end) {
        const c = text[i];
        const two = text.slice(i, i + 2);
        if (two === '?>') {
            i = text.indexOf('<?', i + 2);
            if (i < 0 || i >= end) return null;
            i = text.startsWith('<?php', i) ? i + 5 : i + 2;
        } else if (two === '//' || (c === '#' && text[i + 1] !== '[')) {
            const eol = text.indexOf('\n', i);
            if (eol < 0 || eol >= end) return null;
            i = eol + 1;
        } else if (two === '/*') {
            const close = text.indexOf('*/', i + 2);
            if (close < 0 || close + 2 > end) return null;
            i = close + 2;
        } else if (c === "'" || c === '"' || c === '`') {
            let j = i + 1;
            while (j < end && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
            if (j >= end) return null;
            i = j + 1;
            previous = 'string';
        } else if (text.startsWith('<<<', i)) {
            const label = /^<<<[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i, i + 200));
            if (!label) {
                i += 3;
                continue;
            }
            const close = new RegExp(`\\n[ \\t]*${label[2]}(?![A-Za-z0-9_])`, 'g');
            close.lastIndex = i;
            const found = close.exec(text);
            if (!found || found.index + found[0].length > end) return null;
            i = found.index + found[0].length;
            previous = 'string';
        } else if (/[A-Za-z_\x80-￿]/.test(c)) {
            const name = /^[A-Za-z0-9_\x80-￿]+/.exec(text.slice(i, i + 256))[0];
            if (/^(class|interface|trait|enum)$/i.test(name) && previous !== '::' && previous !== '->') classNext = true;
            previous = name;
            i += name.length;
        } else if (c === '{') {
            braces.push(classNext ? 'class' : 'block');
            classNext = false;
            previous = c;
            i++;
        } else if (c === '}') {
            braces.pop();
            previous = c;
            i++;
        } else if (/\s/.test(c)) {
            i++;
        } else {
            const token = text.startsWith('?->', i) ? '?->' : two === '->' || two === '::' ? two : c;
            previous = token === '?->' ? '->' : token;
            if (c === ';') classNext = false;
            i += token.length;
        }
    }
    return { inClass: braces.at(-1) === 'class', depth: braces.length, previous };
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
