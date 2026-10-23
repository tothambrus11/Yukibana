// The swift pack's module Worker: a small LSP server whose analysis runs in
// swift-ls.wasm, a Swift program built on swift-syntax and compiled to
// wasm32-wasi with the swift.org Wasm SDK. It is NOT SourceKit-LSP (see
// README.md). swift-ls.wasm parses; it does not type-check. The real Swift
// 6.3.3 compiler frontend (swift-frontend.wasm, from swift-toolchain-wasm)
// runs in a nested worker (typecheck.js), loaded lazily after `initialize`:
// its diagnostics are merged with the syntax ones, and its typed syntax tree
// (-dump-ast) answers hover, definition, references, rename, inlay hints and
// member completion (src/semantic.js). swift-syntax-ls answers whatever the
// compiler has not answered yet, or cannot answer.
//
// One JSON-RPC object per postMessage in each direction (CONTRACT.md). This
// file owns the protocol: positions (LSP's UTF-16 line/character against the
// wasm's UTF-8 byte offsets), the document store, the capability list. The
// wasm owns every answer about Swift.

import { readDiagnostics } from './dia.js';
import {
    Ast, IMPLICIT_PROBE, callContext, implicitBaseOf, implicitContext, implicitMembers, libraryGlobals, libraryHover, librarySignatures, libraryTypeHover, memberContext, membersOf, parseType,
    stdlib, wordAt,
} from './semantic.js';

const NAME = 'swift-syntax-ls + swift-frontend 6.3.3 type checker';
const VERSION = '0.3.0 (swift-syntax 604.0.0 on the Swift 6.4.1 Wasm SDK; diagnostics, types, hover, definition, references and member completion from swift-frontend 6.3.3 -dump-ast, swift-toolchain-wasm release swift-6.3.3-wasm)';
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
    /** UTF-16 index of an LSP position; a character past the end of its line is the line's end. */
    index(pos) {
        const line = Math.max(0, Math.min(pos.line, this.lineStarts.length - 1));
        return Math.min(this.lineStarts[line] + Math.max(0, pos.character), this.lineEnd(line));
    }
    /** The LSP range of UTF-16 indices [s, e). */
    rangeOfIndices(s, e) { return this.range(this.u8[s], this.u8[e]); }
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
 * The real compiler over every open .swift file, run by typecheck.js in a
 * nested worker so a check never holds up the syntax answers. It starts on
 * the first document (the frontend is ~110 MB of wasm, fetched from the same
 * URL as the runner's) and runs CHECK_DELAY ms after the last edit, in two
 * steps: `-dump-ast` (type errors, and the typed tree in `ast`), then, if
 * that found no error, `-emit-sil` (missing return and the other SIL
 * diagnostics). Diagnostics are used only if no document changed since the
 * check's snapshot: a superseded result is discarded and the newer check
 * (already scheduled by that change) replaces it. The tree is kept even
 * then: hover and definition map positions through the edit (semantic.js,
 * Mapping), which is better than nothing until the next check lands.
 */
const CHECK_DELAY = 350;
const semantic = new Map(); // uri -> LSP diagnostics of the newest completed check
const fixes = new Map(); // uri -> compiler fix-its of the newest completed check, see fixesOf
let checker = null;
let checkerDown = false;
let checkerReady = false;
let checkTimer = 0;
let checkId = 0;
let snapshot = null; // { id, docs: Map(uri -> Doc) } of the check in flight
const sent = new Map(); // id -> docs of every check not answered yet, for their trees
/** The newest typed tree (semantic.js Ast) and the id of the check that made it. */
let ast = null;
let astId = 0;

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
        else if (m.type === 'ready') {
            checkerReady = true;
            log(3, `swift-frontend 6.3.3 type checker loaded in ${m.ms} ms`);
            stdlib().catch((e) => log(2, `the standard library index did not load: ${e.message}`)); // for the first completion
        } else if (m.type === 'failed') {
            log(1, `the swift-frontend type checker failed: ${m.message}; diagnostics stay syntax-only`);
        } else if (m.type === 'result') applyCheck(m);
        else if (m.type === 'probe') probes.get(m.id)?.(m);
    };
    worker.onerror = (e) => {
        checkerDown = true;
        log(1, `the swift-frontend type checker could not start (${e.message ?? 'worker error'}); diagnostics stay syntax-only`);
    };
    return worker;
}

/** The open .swift documents: { files: path -> text, docs: uri -> Doc }. */
function project() {
    const files = {};
    const docsNow = new Map();
    for (const d of docs.values()) {
        const path = pathOf(d.uri);
        if (path === null || !path.endsWith('.swift')) continue;
        files[path] = d.text;
        docsNow.set(d.uri, d);
    }
    return { files, docs: docsNow };
}

function sendCheck() {
    const { files, docs: docsNow } = project();
    checker ??= startChecker();
    snapshot = { id: ++checkId, docs: docsNow };
    sent.set(checkId, docsNow);
    checker.postMessage({ type: 'check', id: checkId, files });
}

function applyCheck({ id, phase, final, output, dia, ast: tree, ms }) {
    // The tree of a superseded check is still newer than the one in use.
    if (tree && id > astId && sent.has(id)) {
        ast = new Ast(tree, sent.get(id), uriOf);
        astId = id;
        // Inlay hints were computed from the previous tree.
        send({ jsonrpc: '2.0', id: `yk-${id}`, method: 'workspace/inlayHint/refresh' });
    }
    if (phase !== 'sil') for (const k of sent.keys()) if (k <= id) sent.delete(k);
    if (!snapshot || id !== snapshot.id) return; // superseded
    const docsThen = snapshot.docs;
    for (const [uri, d] of docsThen) if (docs.get(uri) !== d) return; // changed since: a newer check is scheduled
    if ([...docs.keys()].some((u) => !docsThen.has(u) && pathOf(u)?.endsWith('.swift'))) return;
    if (final) snapshot = null;
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
    if (dia?.length) {
        try {
            // One serialized-diagnostics buffer per file the frontend wrote one for.
            const all = dia.flatMap((b) => readDiagnostics(new Uint8Array(b)));
            for (const [uri, list] of fixesOf(all, docsThen, found)) fixes.set(uri, list);
        } catch (e) {
            log(2, `swift-frontend: could not read its fix-its: ${e?.message ?? e}`);
        }
    }
    for (const [uri, list] of found) {
        const before = JSON.stringify(semantic.get(uri) ?? []);
        semantic.set(uri, list);
        if (JSON.stringify(list) !== before) publish(docs.get(uri));
    }
    log(4, `swift-frontend check: ${[...found.values()].flat().length} diagnostics in ${ms} ms (${phase === 'sil' ? '-emit-sil' : '-dump-ast'})`);
}

/** Answers of typecheck.js to probes, by probe id. */
const probes = new Map();
let probeId = 0;
/** The probe a request is waiting for, by request id, so `$/cancelRequest` can end the wait. */
const waiting = new Map();
const PROBE_TIMEOUT = 4000;

/**
 * Types the project with one file's text replaced (`text` for `doc`), and
 * returns { ast, doc, output }: its Ast, the variant Doc it describes and
 * the frontend's stderr (its diagnostics as text). Null if the type checker
 * is not loaded yet, failed, took longer than PROBE_TIMEOUT, or the request
 * was cancelled. This is how completion learns the type of the expression
 * before a dot that was typed after the last check, and the contextual type
 * of an implicit member expression (`.member` with no base).
 */
async function probe(doc, text, requestId) {
    if (!checker || !checkerReady || checkerDown) return null;
    const { files, docs: docsNow } = project();
    const path = pathOf(doc.uri);
    files[path] = text;
    const variant = new Doc(doc.uri, text, doc.version);
    docsNow.set(doc.uri, variant);
    const id = ++probeId;
    const t0 = performance.now();
    const answer = await new Promise((resolve) => {
        const done = (m) => {
            probes.delete(id);
            waiting.delete(requestId);
            clearTimeout(timer);
            resolve(m);
        };
        const timer = setTimeout(() => done(null), PROBE_TIMEOUT);
        probes.set(id, done);
        if (requestId !== undefined) waiting.set(requestId, () => done(null));
        checker.postMessage({ type: 'probe', id, files });
    });
    if (!answer?.ast) return null;
    log(4, `swift-frontend probe: typed in ${answer.ms} ms (${Math.round(performance.now() - t0)} ms with waiting)`);
    return { ast: new Ast(answer.ast, docsNow, uriOf), doc: variant, output: answer.output ?? '' };
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

// ---------------------------------------------------------------- compiler answers

/** The standard library index, or null if it cannot be fetched (then library answers are left out). */
const library = () => stdlib().catch((e) => {
    log(2, `the standard library index did not load: ${e.message}`);
    return null;
});

/** Whether the newest tree was computed on exactly the open documents. */
const astIsCurrent = () => !!ast && [...ast.then].every(([u, d]) => docs.get(u) === d) &&
    ![...docs.keys()].some((u) => !ast.then.has(u) && pathOf(u)?.endsWith('.swift'));

const splitKey = (key) => {
    const m = /^(.*):(\d+):(\d+)$/.exec(key);
    return [m[1], +m[2], +m[3]];
};

/** The current location of the name the compiler places at "file:line:col" in `tree`'s snapshot, or null. */
function nameLocation(tree, key) {
    const [f, l, c] = splitKey(key);
    const then = tree.docThen(f);
    const i = tree.indexThen(f, l, c);
    const w = then && i >= 0 ? wordAt(then.text, i) : null;
    return w && w[0] === i ? tree.location(docs, f, l, c, w[1] - w[0]) : null;
}

/** The text at a location in the open documents. */
function textAt(loc) {
    const d = docs.get(loc.uri);
    if (!d) return '';
    return d.text.slice(d.index(loc.range.start), d.index(loc.range.end));
}

/** swift-syntax-ls's hover markdown at a location: the declaration as written and its doc comment. */
async function syntaxHover(loc) {
    const d = live(loc.uri);
    if (!d) return null;
    return (await call('hover', d.uri, d.offset(loc.range.start)))?.md ?? null;
}

/**
 * Hover from the compiler: for a variable, constant or parameter its type
 * (`let total: Int`) with the doc comment from its declaration; for a
 * function or type of the project, swift-syntax-ls's rendering of the
 * declaration the compiler resolved the name to (which may be in another
 * file, or one of several overloads); for the standard library, the
 * declaration and doc comment from the index. Null leaves it to
 * swift-syntax-ls.
 */
async function compilerHover(doc, i) {
    const std = await library();
    const hit = ast?.at(doc, i);
    const w = hit?.word ?? wordAt(doc.text, i);
    if (!w) return null;
    const range = doc.rangeOfIndices(w[0], w[1]);
    const word = doc.text.slice(w[0], w[1]);
    if (hit) {
        const ref = hit.refs.find((r) => r.d);
        if (ref && !ref.at) {
            const md = std && libraryHover(std, ref);
            if (md) return { md, range };
        }
        const key = ref?.at?.join(':') ?? hit.key;
        if (key) {
            const decl = ast.declAt.get(key);
            const loc = nameLocation(ast, key);
            const syntax = loc ? await syntaxHover(loc) : null;
            if (decl && decl.k !== 'var_decl') return syntax ? { md: syntax, range } : null;
            const type = parseType(ref?.t ?? decl?.t ?? ast.refsTo.get(key)?.[0]?.t ?? '').text;
            if (type && !/error type|<null>/.test(type)) {
                const [code = '', comment = ''] = (syntax ?? '').split('\n\n---\n\n');
                const context = /^```swift\n(\/\/ [^\n]*\n)/.exec(code)?.[1] ?? '';
                const keyword = decl?.flags.includes('let') || !decl ? 'let' : 'var';
                return { md: `\`\`\`swift\n${context}${keyword} ${word}: ${type}\n\`\`\`` + (comment ? `\n\n---\n\n${comment}` : ''), range };
            }
        }
    }
    // A library type in a type annotation (the dump does not locate those).
    if (std && /^[A-Z]/.test(word) && !ast?.typeDecls(word).length) {
        const md = libraryTypeHover(std, word);
        if (md) return { md, range };
    }
    return null;
}

/**
 * Definition from the compiler: where the declaration it resolved the name
 * to is written. `[]` for a standard library declaration, which has no
 * source here (its hover shows the declaration and documentation);
 * undefined when the compiler has no answer for this spot.
 */
function compilerDefinition(doc, i) {
    const hit = ast?.at(doc, i);
    if (!hit) return undefined;
    const ref = hit.refs.find((r) => r.d);
    if (ref && !ref.at) return [];
    const key = ref?.at?.join(':') ?? hit.key;
    const loc = key && nameLocation(ast, key);
    return loc ? [loc] : undefined;
}

/**
 * References from the compiler: every place it resolved to the same
 * declaration, so two unrelated `x` members are told apart. Only while the
 * tree is current (an edit may add uses it has not seen), and not for
 * types and initialisers: a type name in an annotation (`let p: Point`) is
 * not located in the dump, and `Point(...)` names the initialiser.
 * undefined leaves it to swift-syntax-ls. `library` is true for a
 * standard-library declaration (its uses are listed, but it cannot be renamed).
 */
function compilerReferences(doc, i, includeDeclaration) {
    if (!astIsCurrent()) return undefined;
    const hit = ast.at(doc, i);
    if (!hit) return undefined;
    const ref = hit.refs.find((r) => r.d);
    let list, key = null;
    if (ref && !ref.at) list = ast.refsNamed.get(ref.d) ?? [];
    else {
        key = ref?.at?.join(':') ?? hit.key;
        const decl = key && ast.declAt.get(key);
        if (!key || (decl && !/^(var_decl|func_decl|enum_element_decl)$/.test(decl.k))) return undefined;
        list = ast.refsTo.get(key) ?? [];
    }
    const out = [];
    const seen = new Set();
    const add = (loc) => {
        if (!loc || textAt(loc) !== hit.text) return;
        const k = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(loc);
    };
    if (key && includeDeclaration) add(nameLocation(ast, key));
    for (const r of list) add(nameLocation(ast, `${r.f}:${r.l}:${r.c}`));
    return { locations: out, library: !key };
}

/**
 * Member completion from the compiler: the type of the expression before
 * the dot, then its members (semantic.js membersOf). The type comes from the
 * newest tree when that stretch of text is unchanged since; otherwise from a
 * probe, which type-checks the project with this file's `.partial` removed,
 * so `xs.` is checked as `xs`. Undefined when neither knows the type.
 */
async function compilerMembers(doc, i, ctx, requestId) {
    const std = await library();
    let tree = ast, type = ast?.typeOfSpan(doc, ctx.start, ctx.last) ?? null, how = 'tree';
    if (!type) {
        const t0 = performance.now();
        const p = await probe(doc, doc.text.slice(0, ctx.end) + doc.text.slice(i), requestId);
        type = p?.ast.typeOfSpan(p.doc, ctx.start, ctx.last) ?? null;
        if (p) tree = p.ast;
        how = `probe, ${Math.round(performance.now() - t0)} ms`;
    }
    if (!type) return undefined;
    if (ctx.unwrap) {
        const t = parseType(type);
        if (t.name === 'Optional') type = t.args[0];
    }
    const { items, wrapped } = membersOf(tree, std, type);
    if (wrapped) {
        // `opt.` offers Optional's own members, and the wrapped type's as `opt?.member`.
        const range = doc.rangeOfIndices(ctx.dot, i);
        for (const item of membersOf(tree, std, wrapped).items) {
            items.push({ ...item, sortText: `0${item.sortText}`, filterText: `.${item.label}`, textEdit: { range, newText: `?.${item.insertText ?? item.label}` }, insertText: undefined });
        }
    }
    if (!items.length) return undefined;
    log(4, `completion: ${items.length} members of ${parseType(type).text} (${how})`);
    // Project items: where their declaration is now, for completionItem/resolve.
    for (const item of items) {
        if (item.data?.k !== 'project') continue;
        const loc = nameLocation(tree, `${item.data.f}:${item.data.l}:${item.data.c}`);
        item.data = loc ? { k: 'project', uri: loc.uri, position: loc.range.start } : undefined;
    }
    return items;
}

/**
 * Completion of an implicit member expression, `.member` with no base
 * (`return .sad()`, `let c: Color = .red`, `f(.init(x: 1))`): the static
 * members, enum cases and initialisers of the contextual type.
 *
 * The AST cannot say what the contextual type is, because a `.partial` that
 * names nothing does not type-check, and without it there is no expression
 * to have a type. The compiler says it in words instead: the probe replaces
 * the partial name with IMPLICIT_PROBE, which no type has, and the error
 * names the type the member was looked up in (`type 'Int' has no member
 * ...`). The same probe tells a member on the line before apart, since
 * Swift reads `xs.map { ... }⏎.filter` as a chain: then the error is
 * `value of type '[Int]' has no member ...`, and that type's instance
 * members are offered. Undefined when the compiler names no type (no
 * contextual type: `cannot infer contextual base ...`).
 */
async function compilerImplicitMembers(doc, i, ctx, requestId) {
    const std = await library();
    const text = doc.text.slice(0, ctx.start) + IMPLICIT_PROBE + doc.text.slice(ctx.end);
    const t0 = performance.now();
    const p = await probe(doc, text, requestId);
    const found = p && implicitBaseOf(p.output);
    if (!found) return undefined;
    const items = found.instance ? membersOf(p.ast, std, found.type).items : implicitMembers(p.ast, std, found.type);
    if (!items.length) return undefined;
    log(4, `completion: ${items.length} ${found.instance ? 'members of' : 'implicit members of'} ${found.type} (probe, ${Math.round(performance.now() - t0)} ms)`);
    for (const item of items) {
        if (item.data?.k !== 'project') continue;
        const loc = nameLocation(p.ast, `${item.data.f}:${item.data.l}:${item.data.c}`);
        item.data = loc ? { k: 'project', uri: loc.uri, position: loc.range.start } : undefined;
    }
    return items;
}

/** Signature help for a standard-library function or method, when swift-syntax-ls has none. */
async function librarySignatureHelp(doc, i) {
    const ctx = callContext(doc.text, i);
    const std = ctx && (await library());
    if (!std) return null;
    let type = null;
    if (ctx.base) {
        type = ast?.typeOfSpan(doc, ctx.base[0], ctx.base[1]) ?? null;
        if (!type) return null;
    }
    const signatures = librarySignatures(ast, std, ctx.name, type);
    if (!signatures.length) return null;
    const active = Math.max(0, signatures.findIndex((s) => s.params.length > ctx.active));
    return {
        signatures: signatures.map((s) => ({
            label: s.label,
            ...(s.doc ? { documentation: { kind: 'markdown', value: s.doc } } : {}),
            parameters: s.params.map((label) => ({ label })),
        })),
        activeSignature: active,
        activeParameter: ctx.active,
    };
}

/** `: Type` after the names of variables and constants declared without one. */
function inlayHints(doc, range) {
    if (!ast) return [];
    const path = pathOf(doc.uri);
    const from = doc.index(range.start), to = doc.index(range.end);
    const hints = [];
    for (const d of ast.decls) {
        if (d.k !== 'var_decl' || d.f !== path || d.flags.includes('implicit') || !d.t) continue;
        const type = parseType(d.t);
        if ((!type.name && !type.tuple) || /error type/.test(d.t)) continue;
        const loc = nameLocation(ast, `${d.f}:${d.l}:${d.c}`);
        if (!loc || loc.uri !== doc.uri) continue;
        const end = doc.index(loc.range.end);
        if (end < from || end > to) continue;
        if (/^\s*:/.test(doc.text.slice(end, end + 80))) continue; // written with its type
        hints.push({ position: loc.range.end, label: `: ${type.text}`, kind: 1 });
    }
    return hints;
}

// ---------------------------------------------------------------- LSP

const handlers = {
    initialize: async () => {
        await ready;
        return {
            capabilities: {
                textDocumentSync: { openClose: true, change: 1 },
                completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
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
                inlayHintProvider: true,
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

    'textDocument/completion': async (p, requestId) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        const i = doc.index(p.position);
        const member = memberContext(doc.text, i);
        if (member) {
            const items = await compilerMembers(doc, i, member, requestId);
            if (items) return { isIncomplete: false, items };
        }
        const implicit = !member && implicitContext(doc.text, i);
        if (implicit) {
            const items = await compilerImplicitMembers(doc, i, implicit, requestId);
            if (items) return { isIncomplete: false, items };
        }
        const r = (await call('complete', doc.uri, off));
        const items = r.items.map((x) => ({
            label: x.label, kind: x.kind, detail: x.detail, sortText: x.sort,
            ...(x.doc ? { documentation: { kind: 'markdown', value: x.doc } } : {}),
        }));
        // A plain name: the standard library's functions and types too.
        const std = !member && (await library());
        if (std) {
            const have = new Set(items.map((x) => x.label));
            for (const x of libraryGlobals(std)) if (!have.has(x.label)) items.push(x);
        }
        return { isIncomplete: false, items };
    },
    'completionItem/resolve': async (item) => {
        if (item.data?.k === 'std') {
            const std = await library();
            const doc = std?.doc(item.data.doc);
            return doc ? { ...item, documentation: { kind: 'markdown', value: doc } } : item;
        }
        if (item.data?.k === 'project') {
            const md = await syntaxHover({ uri: item.data.uri, range: { start: item.data.position, end: item.data.position } });
            return md ? { ...item, documentation: { kind: 'markdown', value: md } } : item;
        }
        return item;
    },
    'textDocument/hover': async (p) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        const typed = await compilerHover(doc, doc.index(p.position));
        if (typed) return { contents: { kind: 'markdown', value: typed.md }, range: typed.range };
        const r = await call('hover', doc.uri, off);
        return r ? { contents: { kind: 'markdown', value: r.md }, range: doc.range(r.s, r.e) } : null;
    },
    'textDocument/inlayHint': ({ textDocument, range }) => {
        const doc = live(textDocument.uri);
        return doc ? inlayHints(doc, range) : null;
    },
    'textDocument/signatureHelp': async (p) => {
        const [doc, off] = at(p);
        const r = doc && (await call('signature', doc.uri, off));
        if (!r || !r.signatures?.length) return doc ? librarySignatureHelp(doc, doc.index(p.position)) : null;
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
        if (!doc) return null;
        const typed = compilerDefinition(doc, doc.index(p.position));
        if (typed) return typed;
        return (await call('definition', doc.uri, off)).map(location).filter(Boolean);
    },
    'textDocument/references': async (p) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        const typed = compilerReferences(doc, doc.index(p.position), p.context?.includeDeclaration !== false);
        if (typed) return typed.locations;
        let refs = (await call('references', doc.uri, off));
        if (p.context && !p.context.includeDeclaration) {
            const decl = (await call('definition', doc.uri, off))[0];
            if (decl) refs = refs.filter((r) => !(r.uri === decl.uri && r.s === decl.s));
        }
        return refs.map(location).filter(Boolean);
    },
    'textDocument/documentHighlight': async (p) => {
        const [doc, off] = at(p);
        if (!doc) return null;
        const typed = compilerReferences(doc, doc.index(p.position), true);
        if (typed) return typed.locations.filter((l) => l.uri === doc.uri).map((l) => ({ range: l.range, kind: 1 }));
        return (await call('highlight', doc.uri, off)).map((r) => ({ range: doc.range(r.s, r.e), kind: 1 }));
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
        const typed = compilerReferences(doc, doc.index(p.position), true);
        if (typed?.library) throw rpcError(-32602, 'this is declared in the standard library, which cannot be renamed');
        if (typed) {
            for (const l of typed.locations) (changes[l.uri] ??= []).push({ range: l.range, newText: p.newName });
            return { changes };
        }
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
//
// `$/cancelRequest` is handled as it arrives, not in turn: a completion
// waiting for the compiler (see probe) stops waiting and answers with what
// swift-syntax-ls has, and a request cancelled before its turn is not run.
let queue = Promise.resolve();
const cancelled = new Set();
self.onmessage = ({ data: msg }) => {
    if (msg.method === '$/cancelRequest') {
        if (cancelled.size > 256) cancelled.clear(); // ids of requests answered before their cancellation arrived
        cancelled.add(msg.params?.id);
        waiting.get(msg.params?.id)?.();
        return;
    }
    if (!msg.method) return; // the client's answer to a request of ours (workspace/inlayHint/refresh)
    queue = queue.then(() => handle(msg));
};

async function handle(msg) {
    const h = handlers[msg.method];
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (isRequest && cancelled.delete(msg.id)) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32800, message: 'cancelled' } });
        return;
    }
    if (!h) {
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported` } });
        return;
    }
    try {
        if (msg.method !== 'initialize') await ready;
        const result = await h(msg.params ?? {}, msg.id);
        cancelled.delete(msg.id);
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (err) {
        log(1, `${msg.method}: ${err?.stack ?? err}`);
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } });
    }
}
