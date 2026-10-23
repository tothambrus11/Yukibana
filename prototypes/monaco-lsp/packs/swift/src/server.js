// The swift pack's module Worker: a small LSP server whose analysis runs in
// swift-ls.wasm, a Swift program built on swift-syntax and compiled to
// wasm32-wasi with the swift.org Wasm SDK. It is NOT SourceKit-LSP (see
// README.md). swift-ls.wasm parses; it does not type-check. Type errors come
// from the real Swift 6.3.3 compiler frontend (swift-frontend.wasm, from
// swift-toolchain-wasm), which typecheck.js runs with -emit-sil in a nested
// worker, loaded lazily after `initialize`; its diagnostics are merged with
// the syntax ones. Completion, hover and navigation stay syntactic.
//
// One JSON-RPC object per postMessage in each direction (CONTRACT.md). This
// file owns the protocol: positions (LSP's UTF-16 line/character against the
// wasm's UTF-8 byte offsets), the document store, the capability list. The
// wasm owns every answer about Swift.

import { readDiagnostics } from './dia.js';

const NAME = 'swift-syntax-ls + swift-frontend 6.3.3 type checker';
const VERSION = '0.2.0 (swift-syntax 604.0.0 on the Swift 6.4.1 Wasm SDK; diagnostics also from swift-frontend 6.3.3, swift-toolchain-wasm release swift-6.3.3-wasm)';
const WASM_URL = new URL('./swift-ls.wasm', import.meta.url);

/** Semantic token types, in the order Server.swift numbers them. */
const TOKEN_TYPES = ['keyword', 'type', 'string', 'number', 'comment', 'variable', 'operator', 'macro',
    'decorator', 'regexp', 'function', 'property', 'enumMember', 'parameter'];

const send = (msg) => self.postMessage(msg);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const log = (type, message) => notify('window/logMessage', { type, message });

// ---------------------------------------------------------------- WASI

/**
 * The fourteen WASI calls the Swift runtime imports, and no more: no file
 * system (every document reaches the wasm through yk_call), stdout/stderr
 * become window/logMessage, the clock and randomness come from the browser.
 */
function wasi(getMemory) {
    const ENOSYS = 52, EBADF = 8, OK = 0;
    const view = () => new DataView(getMemory().buffer);
    const decoder = new TextDecoder();
    const pending = { 1: '', 2: '' };
    return {
        args_sizes_get: (argc, size) => { view().setUint32(argc, 0, true); view().setUint32(size, 0, true); return OK; },
        args_get: () => OK,
        environ_sizes_get: (n, size) => { view().setUint32(n, 0, true); view().setUint32(size, 0, true); return OK; },
        environ_get: () => OK,
        fd_write(fd, iovs, iovsLen, nwritten) {
            if (fd !== 1 && fd !== 2) return EBADF;
            const v = view();
            let total = 0;
            for (let i = 0; i < iovsLen; i++) {
                const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
                pending[fd] += decoder.decode(new Uint8Array(getMemory().buffer, ptr, len));
                total += len;
            }
            let nl;
            while ((nl = pending[fd].indexOf('\n')) >= 0) {
                log(fd === 2 ? 1 : 4, pending[fd].slice(0, nl));
                pending[fd] = pending[fd].slice(nl + 1);
            }
            v.setUint32(nwritten, total, true);
            return OK;
        },
        fd_read: () => EBADF,
        fd_close: () => EBADF,
        fd_seek: () => EBADF,
        fd_fdstat_get: (fd, out) => {
            if (fd > 2) return EBADF;
            const v = view();
            v.setUint8(out, 2); // character device
            v.setUint16(out + 2, 0, true);
            v.setBigUint64(out + 8, 0n, true);
            v.setBigUint64(out + 16, 0n, true);
            return OK;
        },
        fd_prestat_get: () => EBADF, // no preopened directories
        fd_prestat_dir_name: () => EBADF,
        path_open: () => ENOSYS,
        random_get(ptr, len) {
            const bytes = new Uint8Array(getMemory().buffer, ptr, len);
            for (let i = 0; i < len; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(len, i + 65536)));
            return OK;
        },
        proc_exit(code) { throw new Error(`swift-ls.wasm exited with ${code}`); },
    };
}

// ---------------------------------------------------------------- loading

async function fetchWithProgress(url, label) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status}`);
    // Content-Length is the encoded size when the host compresses; then
    // the count below runs past it and the bar just fills.
    const total = Number(res.headers.get('content-encoding') ? 0 : res.headers.get('content-length') ?? 0);
    const chunks = [];
    let loaded = 0, last = 0;
    const reader = res.body.getReader();
    notify('yukibana/loading', { label, loaded: 0, total });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (loaded - last > 256 * 1024) { last = loaded; notify('yukibana/loading', { label, loaded, total }); }
    }
    notify('yukibana/loading', { label, loaded, total: total || loaded });
    const bytes = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return bytes;
}

let wasm = null; // the instance's exports; null when it must be (re)started first
let module; // compiled once, instantiated again after a trap

async function start() {
    let memory;
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi(() => memory) });
    memory = instance.exports.memory;
    instance.exports._initialize();
    wasm = instance.exports;
}
const encoder = new TextEncoder(), decoder = new TextDecoder();

const ready = (async () => {
    const t0 = performance.now();
    const bytes = await fetchWithProgress(WASM_URL, 'swift-ls.wasm');
    module = await WebAssembly.compile(bytes);
    await start();
    log(3, `${NAME} ${VERSION}: loaded ${(bytes.length / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms`);
})();

/**
 * Documents the wasm could not take: their `set` trapped. uri -> the error.
 * They are not in the wasm, every request on them answers null, and they get
 * one diagnostic saying so, until their text changes or they are closed.
 */
const broken = new Map();

/**
 * A trap leaves the instance unusable: a WebAssembly.RuntimeError (a bug,
 * or running off the end of the wasm's 8 MB shadow stack) or a RangeError
 * (the browser's own native stack ran out inside wasm frames; the shadow
 * stack pointer is then never restored). Either way the next call must not
 * reuse it.
 */
const isTrap = (err) => err instanceof WebAssembly.RuntimeError || err instanceof RangeError;

/**
 * One request to the wasm: `cmd\nuri\noffset\n` + payload, JSON back. After
 * a trap the request fails, and a fresh instance is started with every open
 * document set again, each in its own try: a document whose own `set` traps
 * is left out (see `broken`), so one pathological file cannot keep the
 * server down for the others. An earlier version replayed the trapping
 * document too, outside any try, and stayed trapped for every file.
 */
async function call(cmd, uri, offset = 0, payload = '') {
    if (!wasm) await restart();
    try {
        return callOnce(cmd, uri, offset, payload);
    } catch (err) {
        if (!isTrap(err)) throw err;
        wasm = null;
        log(1, `swift-ls.wasm trapped in ${cmd} ${uri}@${offset}: ${err.message}; restarting it`);
        if (cmd === 'set') broken.set(uri, err.message);
        await restart();
        throw err;
    }
}

/** A fresh instance with every open, unbroken document set in it. */
async function restart() {
    for (;;) {
        wasm = null;
        await start();
        let trapped = false;
        for (const d of docs.values()) {
            if (broken.has(d.uri)) continue;
            try {
                callOnce('set', d.uri, 0, d.text);
            } catch (err) {
                if (!isTrap(err)) throw err;
                log(1, `swift-ls.wasm trapped setting ${d.uri} again: ${err.message}; leaving it out`);
                broken.set(d.uri, err.message);
                markBroken(d);
                trapped = true;
                break;
            }
        }
        if (!trapped) return;
    }
}

function callOnce(cmd, uri, offset, payload) {
    const input = encoder.encode(`${cmd}\n${uri}\n${offset}\n${payload}`);
    const ptr = wasm.yk_alloc(input.length);
    new Uint8Array(wasm.memory.buffer, ptr, input.length).set(input);
    const len = wasm.yk_call(ptr, input.length);
    const out = wasm.yk_output();
    return JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, out, len)));
}

// ---------------------------------------------------------------- documents

/**
 * A document and its position tables. The wasm speaks UTF-8 byte offsets,
 * LSP speaks UTF-16 code units per line; `u8[i]` is the byte offset of
 * UTF-16 index i, so both directions are a lookup or a binary search.
 */
class Doc {
    constructor(uri, text, version) {
        this.uri = uri;
        this.version = version;
        this.text = text;
        this.lineStarts = [0];
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
        this.u8 = new Uint32Array(text.length + 1);
        let b = 0;
        for (let i = 0; i < text.length; i++) {
            this.u8[i] = b;
            const c = text.charCodeAt(i);
            if (c < 0x80) b += 1;
            else if (c < 0x800) b += 2;
            else if (c >= 0xd800 && c <= 0xdbff) { b += 4; this.u8[++i] = b; } // low surrogate: after the pair
            else b += 3;
        }
        this.u8[text.length] = b;
        this.diagnostics = [];
    }
    /** UTF-16 index where line `line`'s content ends: before its `\n` or `\r\n`. */
    lineEnd(line) {
        let e = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] - 1 : this.text.length;
        if (e > this.lineStarts[line] && this.text.charCodeAt(e - 1) === 13) e--;
        return e;
    }
    /** Byte offset of an LSP position; a character past the end of its line is the line's end. */
    offset(pos) {
        const line = Math.max(0, Math.min(pos.line, this.lineStarts.length - 1));
        return this.u8[Math.min(this.lineStarts[line] + Math.max(0, pos.character), this.lineEnd(line))];
    }
    position(byte) {
        let lo = 0, hi = this.text.length;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.u8[mid] <= byte) lo = mid; else hi = mid - 1; }
        let l = 0, h = this.lineStarts.length - 1;
        while (l < h) { const m = (l + h + 1) >> 1; if (this.lineStarts[m] <= lo) l = m; else h = m - 1; }
        return { line: l, character: lo - this.lineStarts[l] };
    }
    range(s, e) { return { start: this.position(s), end: this.position(e) }; }
}

const docs = new Map();

/** An open document the wasm holds, or undefined (unknown, or broken). */
const live = (uri) => (broken.has(uri) ? undefined : docs.get(uri));

async function setDoc(uri, text, version) {
    const doc = new Doc(uri, text, version);
    docs.set(uri, doc);
    fixes.delete(uri); // computed on the old text
    broken.delete(uri); // new text, new chance
    try {
        doc.diagnostics = await call('set', uri, 0, text);
    } catch (err) {
        if (!isTrap(err)) throw err;
        markBroken(doc);
        return;
    }
    publish(doc);
    scheduleCheck();
}

/** Publishes a document's syntax diagnostics merged with the type checker's. */
function publish(doc) {
    const syntax = doc.diagnostics.map((d) => ({
        range: doc.range(d.s, d.e), severity: d.sev, source: 'swift-syntax', message: d.msg,
    }));
    // The frontend's parser reports the same syntax errors (with the same or a
    // slightly different message): keep swift-syntax's, which has the quick fix.
    const norm = (m) => m.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // Parse errors are matched loosely: the two parsers recover differently
    // and may place the same missing `)` on different lines.
    const parseError = /^(expected |consecutive statements|unterminated |extraneous |unexpected |unbalanced )/;
    const syntaxErrors = syntax.some((x) => x.severity === 1);
    const duplicate = (d) => (syntaxErrors && d.severity === 1 && parseError.test(d.message)) ||
        syntax.some((x) => x.range.start.line === d.range.start.line && norm(x.message) === norm(d.message));
    const typed = (semantic.get(doc.uri) ?? []).filter((d) => !duplicate(d));
    notify('textDocument/publishDiagnostics', { uri: doc.uri, version: doc.version, diagnostics: [...syntax, ...typed] });
}

/** Tells the editor that a document crashed the server and is left out. */
function markBroken(doc) {
    doc.diagnostics = [];
    notify('textDocument/publishDiagnostics', {
        uri: doc.uri, version: doc.version,
        diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: doc.lineEnd(0) } },
            severity: 2, source: 'swift-syntax-ls',
            message: `swift-syntax-ls crashed analysing this file (${broken.get(doc.uri)}) and leaves it out ` +
                'until it changes: no diagnostics, completion or navigation for it. The other files are unaffected.',
        }],
    });
}

async function closeDoc(uri) {
    docs.delete(uri);
    semantic.delete(uri);
    fixes.delete(uri);
    scheduleCheck();
    const wasBroken = broken.delete(uri);
    if (!wasBroken) await call('remove', uri);
    notify('textDocument/publishDiagnostics', { uri, diagnostics: [] });
}

const at = (p) => {
    const doc = live(p.textDocument.uri);
    return doc ? [doc, doc.offset(p.position)] : [null, 0];
};
const location = (l) => {
    const d = docs.get(l.uri);
    return d ? { uri: l.uri, range: d.range(l.s, l.e) } : null;
};

// ---------------------------------------------------------------- type checking

/**
 * Semantic diagnostics: the real compiler's `-emit-sil` over every open
 * .swift file, run by typecheck.js in a nested worker so a check never holds
 * up completion or hover. It starts on the first document (the frontend is
 * ~110 MB of wasm, fetched from the same URL as the runner's), runs
 * CHECK_DELAY ms after the last edit, and a result is used only if no
 * document changed since its snapshot: a superseded result is discarded and
 * the newer check (already scheduled by that change) replaces it.
 */
const CHECK_DELAY = 350;
const semantic = new Map(); // uri -> LSP diagnostics of the newest completed check
const fixes = new Map(); // uri -> compiler fix-its of the newest completed check, see fixesOf
let checker = null;
let checkerDown = false;
let checkTimer = 0;
let checkId = 0;
let snapshot = null; // { id, docs: Map(uri -> Doc) } of the check in flight

function scheduleCheck() {
    if (checkerDown) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(sendCheck, CHECK_DELAY);
}

const WORKSPACE = 'file:///workspace/';
const pathOf = (uri) => (uri.startsWith(WORKSPACE) ? decodeURIComponent(uri.slice(WORKSPACE.length)) : null);
const uriOf = (path) => WORKSPACE + path.split('/').map(encodeURIComponent).join('/');

function startChecker() {
    const worker = new Worker(new URL('./typecheck.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: m }) => {
        if (m.type === 'loading') notify('yukibana/loading', { label: m.label, loaded: m.loaded, total: m.total });
        else if (m.type === 'ready') log(3, `swift-frontend 6.3.3 type checker loaded in ${m.ms} ms`);
        else if (m.type === 'failed') {
            log(1, `the swift-frontend type checker failed: ${m.message}; diagnostics stay syntax-only`);
        } else if (m.type === 'result') applyCheck(m);
    };
    worker.onerror = (e) => {
        checkerDown = true;
        log(1, `the swift-frontend type checker could not start (${e.message ?? 'worker error'}); diagnostics stay syntax-only`);
    };
    return worker;
}

function sendCheck() {
    const files = {};
    const docsNow = new Map();
    for (const d of docs.values()) {
        const path = pathOf(d.uri);
        if (path === null || !path.endsWith('.swift')) continue;
        files[path] = d.text;
        docsNow.set(d.uri, d);
    }
    checker ??= startChecker();
    snapshot = { id: ++checkId, docs: docsNow };
    checker.postMessage({ type: 'check', id: checkId, files });
}

function applyCheck({ id, output, dia, ms }) {
    if (!snapshot || id !== snapshot.id) return; // superseded
    const docsThen = snapshot.docs;
    for (const [uri, d] of docsThen) if (docs.get(uri) !== d) return; // changed since: a newer check is scheduled
    if ([...docs.keys()].some((u) => !docsThen.has(u) && pathOf(u)?.endsWith('.swift'))) return;
    snapshot = null;
    const found = new Map([...docsThen.keys()].map((u) => [u, []]));
    for (const d of parseFrontend(output)) {
        const uri = d.file.startsWith('/workspace/') ? uriOf(d.file.slice('/workspace/'.length)) : null;
        const doc = uri && docsThen.get(uri);
        if (!doc) {
            if (d.severity <= 2) log(2, `swift-frontend: ${d.file}:${d.line}:${d.col}: ${d.message}`);
            continue;
        }
        const related = (d.notes ?? []).flatMap((n) => {
            const nuri = n.file.startsWith('/workspace/') ? uriOf(n.file.slice('/workspace/'.length)) : null;
            const ndoc = nuri && docsThen.get(nuri);
            return ndoc ? [{ location: { uri: nuri, range: rangeOf(ndoc, n) }, message: n.message }] : [];
        });
        const noteText = (d.notes ?? []).filter((n) => !n.file.startsWith('/workspace/')).map((n) => `\nnote: ${n.message}`).join('');
        found.get(uri).push({
            range: rangeOf(doc, d), severity: d.severity, source: 'swiftc', message: d.message + noteText,
            ...(related.length ? { relatedInformation: related } : {}),
        });
    }
    fixes.clear();
    if (dia) {
        try {
            for (const [uri, list] of fixesOf(readDiagnostics(new Uint8Array(dia)), docsThen, found)) fixes.set(uri, list);
        } catch (e) {
            log(2, `swift-frontend: could not read its fix-its: ${e?.message ?? e}`);
        }
    }
    for (const [uri, list] of found) {
        const before = JSON.stringify(semantic.get(uri) ?? []);
        semantic.set(uri, list);
        if (JSON.stringify(list) !== before) publish(docs.get(uri));
    }
    log(4, `swift-frontend check: ${[...found.values()].flat().length} diagnostics in ${ms} ms`);
}

/**
 * The compiler's fix-its as quick fixes, by the URI of the diagnostic they
 * fix: `{ range, title, diagnostic, edit }`. A fix-it on an error or warning
 * is titled after it; one on a note (`add stubs for conformance`) is titled
 * by the note and offered on its parent's range, where the user's cursor is.
 * Edits are byte ranges in the file text the check saw (`docsThen`), so they
 * are only offered while that text is current (applyCheck runs on exactly
 * that text, and an edit clears the fix-its with the diagnostics).
 */
function fixesOf(diagnostics, docsThen, found) {
    const out = new Map();
    const docOf = (file) => {
        const uri = file.startsWith('/workspace/') ? uriOf(file.slice('/workspace/'.length)) : null;
        return uri && docsThen.has(uri) ? [uri, docsThen.get(uri)] : [null, null];
    };
    for (const d of diagnostics) {
        const [uri, doc] = docOf(d.file);
        if (!doc) continue;
        const line = d.line - 1;
        // The LSP diagnostic this compiler diagnostic became (same line and message).
        const diagnostic = found.get(uri)?.find((x) => x.range.start.line === line && x.message.startsWith(d.message));
        const range = diagnostic?.range ?? doc.range(d.offset, d.offset);
        for (const [source, title] of [[d, `Fix: ${d.message}`], ...d.notes.map((n) => [n, n.message.charAt(0).toUpperCase() + n.message.slice(1)])]) {
            if (!source.fixits.length) continue;
            const changes = {};
            let usable = true;
            for (const f of source.fixits) {
                const [furi, fdoc] = docOf(f.start.file);
                if (!fdoc) usable = false;
                else (changes[furi] ??= []).push({ range: fdoc.range(f.start.offset, f.end.offset), newText: placeholders(f.text) });
            }
            if (usable) (out.get(uri) ?? out.set(uri, []).get(uri)).push({ range, title, diagnostic, edit: { changes } });
        }
    }
    return out;
}

/**
 * Editor placeholders (`<#code#>`) as plain text (`code`), as SourceKit-LSP
 * does for a client that applies edits rather than snippets: what is left
 * then fails to compile and says what to fill in.
 */
const placeholders = (text) => text.replace(/<#(?:T##)?(.*?)(?:##.*?)?#>/g, '$1');

/**
 * The frontend's LLVM-style output: `file:line:col: severity: message`,
 * then (when it has a location in a buffer) the source line and a caret line
 * such as `   ~~~~^~~~`. Notes follow the error or warning they belong to.
 */
function parseFrontend(output) {
    const lines = output.split('\n');
    const SEVERITY = { error: 1, warning: 2, remark: 3, note: 4 };
    const out = [];
    let last = null;
    for (let i = 0; i < lines.length; i++) {
        const m = /^(.*?):(\d+):(\d+): (error|warning|note|remark): (.*)$/.exec(lines[i]);
        if (!m) continue;
        const d = { file: m[1], line: +m[2], col: +m[3], severity: SEVERITY[m[4]], message: m[5] };
        if (i + 2 < lines.length && /^[ ~]*\^[ ~]*$/.test(lines[i + 2])) d.marks = lines[i + 2];
        if (d.severity === 4) {
            if (last) (last.notes ??= []).push(d);
        } else {
            out.push(d);
            last = d;
        }
    }
    return out;
}

/**
 * The LSP range of a frontend diagnostic: its column is a 1-based UTF-8 byte
 * column; the caret line's `~` run around `^` gives the extent (in
 * characters, so it is used as is). Without one, the identifier at the
 * position, or one character.
 */
function rangeOf(doc, d) {
    const line = Math.max(0, Math.min(d.line - 1, doc.lineStarts.length - 1));
    const start = doc.position(doc.u8[doc.lineStarts[line]] + Math.max(0, d.col - 1));
    const lineLength = doc.lineEnd(start.line) - doc.lineStarts[start.line];
    let from = start.character, to = start.character + 1;
    const caret = d.marks?.indexOf('^') ?? -1;
    if (caret >= 0) {
        let a = caret, b = caret;
        while (a > 0 && d.marks[a - 1] === '~') a--;
        while (b + 1 < d.marks.length && d.marks[b + 1] === '~') b++;
        from = start.character - (caret - a);
        to = start.character + (b - caret) + 1;
    }
    if (to - from <= 1) {
        const text = doc.text.slice(doc.lineStarts[start.line], doc.lineStarts[start.line] + lineLength);
        const word = /^[\p{L}\p{N}_$]+/u.exec(text.slice(start.character));
        if (word) to = start.character + word[0].length;
    }
    from = Math.max(0, Math.min(from, lineLength));
    to = Math.max(from, Math.min(to, lineLength));
    return { start: { line: start.line, character: from }, end: { line: start.line, character: to } };
}

// ---------------------------------------------------------------- LSP

const handlers = {
    initialize: async () => {
        await ready;
        return {
            capabilities: {
                textDocumentSync: { openClose: true, change: 1 },
                completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
                hoverProvider: true,
                signatureHelpProvider: { triggerCharacters: ['(', ','] },
                definitionProvider: true,
                referencesProvider: true,
                documentHighlightProvider: true,
                documentSymbolProvider: true,
                renameProvider: { prepareProvider: true },
                documentFormattingProvider: true,
                codeActionProvider: { codeActionKinds: ['quickfix'] },
                semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] }, full: true },
            },
            serverInfo: { name: NAME, version: VERSION },
        };
    },
    initialized: () => {},
    shutdown: () => null,
    exit: () => self.close(),
    '$/cancelRequest': () => {},
    '$/setTrace': () => {},
    'workspace/didChangeConfiguration': () => {},
    'workspace/didChangeWatchedFiles': () => {}, // didOpen/didClose already carry the files

    'textDocument/didOpen': ({ textDocument: t }) => setDoc(t.uri, t.text, t.version),
    'textDocument/didChange': async ({ textDocument: t, contentChanges }) => {
        // Full sync is advertised, but a ranged change is applied rather
        // than mistaken for the whole text.
        let text = docs.get(t.uri)?.text ?? '';
        for (const c of contentChanges) {
            if (!c.range) { text = c.text; continue; }
            const lines = [0];
            for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines.push(i + 1);
            const idx = (p) => Math.min(text.length, (lines[Math.min(p.line, lines.length - 1)] ?? 0) + p.character);
            text = text.slice(0, idx(c.range.start)) + c.text + text.slice(idx(c.range.end));
        }
        await setDoc(t.uri, text, t.version);
    },
    'textDocument/didSave': () => {},
    'textDocument/didClose': ({ textDocument: t }) => closeDoc(t.uri),

    'textDocument/completion': async (p) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        const r = (await call('complete', doc.uri, off));
        return {
            isIncomplete: false,
            items: r.items.map((i) => ({
                label: i.label, kind: i.kind, detail: i.detail, sortText: i.sort,
                ...(i.doc ? { documentation: { kind: 'markdown', value: i.doc } } : {}),
            })),
        };
    },
    'textDocument/hover': async (p) => {
        const [doc, off] = at(p);
        const r = doc && (await call('hover', doc.uri, off));
        return r ? { contents: { kind: 'markdown', value: r.md }, range: doc.range(r.s, r.e) } : null;
    },
    'textDocument/signatureHelp': async (p) => {
        const [doc, off] = at(p);
        const r = doc && (await call('signature', doc.uri, off));
        if (!r) return null;
        return {
            signatures: r.signatures.map((s) => ({
                label: s.label,
                ...(s.doc ? { documentation: { kind: 'markdown', value: s.doc } } : {}),
                parameters: s.params.map((x) => ({ label: x.label })),
            })),
            activeSignature: 0,
            activeParameter: r.active,
        };
    },
    'textDocument/definition': async (p) => {
        const [doc, off] = at(p);
        return doc ? (await call('definition', doc.uri, off)).map(location).filter(Boolean) : null;
    },
    'textDocument/references': async (p) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        let refs = (await call('references', doc.uri, off));
        if (p.context && !p.context.includeDeclaration) {
            const decl = (await call('definition', doc.uri, off))[0];
            if (decl) refs = refs.filter((r) => !(r.uri === decl.uri && r.s === decl.s));
        }
        return refs.map(location).filter(Boolean);
    },
    'textDocument/documentHighlight': async (p) => {
        const [doc, off] = at(p);
        return doc ? (await call('highlight', doc.uri, off)).map((r) => ({ range: doc.range(r.s, r.e), kind: 1 })) : null;
    },
    'textDocument/documentSymbol': async ({ textDocument }) => {
        const doc = live(textDocument.uri);
        if (!doc) return null;
        const conv = (s) => ({
            name: s.name, kind: s.kind, detail: s.detail,
            range: doc.range(s.s, s.e), selectionRange: doc.range(s.ss, s.se),
            children: s.children.map(conv),
        });
        return (await call('symbols', doc.uri)).map(conv);
    },
    'textDocument/prepareRename': async (p) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        const own = (await call('highlight', doc.uri, off)).find((r) => r.s <= off && off <= r.e);
        return own ? doc.range(own.s, own.e) : null;
    },
    'textDocument/rename': async (p) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        // The parser decides: Unicode names (`naïve`) and backticked keywords (`\`default\``) are identifiers too.
        if (!(await call('isname', '', 0, p.newName))) throw rpcError(-32602, `"${p.newName}" is not a Swift identifier`);
        const changes = {};
        for (const r of (await call('references', doc.uri, off))) {
            const d = docs.get(r.uri);
            if (d) (changes[r.uri] ??= []).push({ range: d.range(r.s, r.e), newText: p.newName });
        }
        return { changes };
    },
    'textDocument/formatting': async ({ textDocument, options }) => {
        const doc = live(textDocument.uri);
        if (!doc) return null;
        const unit = options?.insertSpaces === false ? 't' : `s${options?.tabSize ?? 4}`;
        const { text } = (await call('format', doc.uri, 0, unit));
        if (text === doc.text) return [];
        return [{ range: doc.range(0, doc.u8[doc.text.length]), newText: text }];
    },
    'textDocument/codeAction': async (p) => {
        const doc = live(p.textDocument.uri);
        if (!doc) return null;
        const s = doc.offset(p.range.start), e = doc.offset(p.range.end);
        const actions = [];
        for (const d of doc.diagnostics) {
            if (d.e < s || d.s > e) continue;
            for (const fix of d.fix) {
                actions.push({
                    title: fix.title, kind: 'quickfix',
                    diagnostics: [{ range: doc.range(d.s, d.e), severity: d.sev, source: 'swift-syntax', message: d.msg }],
                    edit: { changes: { [doc.uri]: fix.edits.map((x) => ({ range: doc.range(x.s, x.e), newText: x.t })) } },
                });
            }
        }
        // The compiler's fix-its, while the text they were computed on is still current.
        const before = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
        for (const fix of fixes.get(doc.uri) ?? []) {
            if (!before(fix.range.start, p.range.end) || !before(p.range.start, fix.range.end)) continue;
            actions.push({ title: fix.title, kind: 'quickfix', ...(fix.diagnostic ? { diagnostics: [fix.diagnostic], isPreferred: true } : {}), edit: fix.edit });
        }
        return actions;
    },
    'textDocument/semanticTokens/full': async ({ textDocument }) => {
        const doc = live(textDocument.uri);
        if (!doc) return null;
        const flat = (await call('tokens', doc.uri));
        const data = [];
        let pl = 0, pc = 0;
        for (let i = 0; i < flat.length; i += 3) {
            const start = doc.position(flat[i]), end = doc.position(flat[i] + flat[i + 1]);
            // LSP tokens are single-line: split multi-line comments and strings.
            for (let line = start.line; line <= end.line; line++) {
                const c0 = line === start.line ? start.character : 0;
                const lineEnd = doc.lineEnd(line) - doc.lineStarts[line]; // without the \r of a CRLF
                const c1 = line === end.line ? end.character : lineEnd;
                if (c1 <= c0) continue;
                data.push(line - pl, line === pl ? c0 - pc : c0, c1 - c0, flat[i + 2], 0);
                pl = line; pc = c0;
            }
        }
        return { data };
    },
};

function rpcError(code, message) { return Object.assign(new Error(message), { code }); }

// Messages are handled one at a time, in order: a didChange is applied
// before the completion that follows it, and nothing runs before the wasm
// has loaded (only `initialize` waits for it explicitly, the rest queue).
let queue = Promise.resolve();
self.onmessage = ({ data: msg }) => {
    queue = queue.then(() => handle(msg));
};

async function handle(msg) {
    const h = handlers[msg.method];
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (!h) {
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported` } });
        return;
    }
    try {
        if (msg.method !== 'initialize') await ready;
        const result = await h(msg.params ?? {});
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (err) {
        log(1, `${msg.method}: ${err?.stack ?? err}`);
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } });
    }
}
