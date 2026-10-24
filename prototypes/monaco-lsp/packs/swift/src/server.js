// The swift pack's module Worker. The language server is
// **sourcekit-lsp-lite over sourcekitd 6.3.3**, running here as the `lsp_*`
// exports of swift-frontend-lsp.wasm (src/lite.js): completion, hover,
// definition, references, highlights, rename, signature help, document
// symbols, inlay hints, diagnostics and their fix-its all come from the same
// sourcekitd SourceKit-LSP drives. (Its diagnostics include the mandatory
// SIL passes': a missing return, a value used before it is initialised,
// overlapping inout accesses, division by zero.) Added around it: formatting
// and semantic tokens, which sourcekitd does not give, from swift-ls.wasm
// (swift-syntax's BasicFormat and classifier), loaded first because it is
// small.
//
// One JSON-RPC object per postMessage in each direction (CONTRACT.md).
// `initialize` is answered as soon as swift-ls.wasm is loaded; the
// compiler's download (swift-frontend-lsp.wasm and the sysroot, reported as
// yukibana/loading) starts then, and requests for sourcekitd wait for it,
// in order. Documents are mirrored into the in-memory file system at
// /workspace, where sourcekitd reads the ones it is not handed.

import { Lite, isFatal } from './lite.js';
import {
    FRONTEND_WASM, loadMacroPlugins, loadSwiftTesting, loadSysroot, loadTool, loadXCTest, mkdirp, remove, sourceKitArgs,
    usesMacroPlugins, writeFile,
} from './toolchain.js';
import { importsTesting, importsXCTest, isOwnModuleImportWarning } from './xctest.js';

const NAME = 'sourcekit-lsp-lite (sourcekitd 6.3.3) + swift-syntax formatting';
const VERSION = 'sourcekitd and swift-frontend 6.3.3 from swift-toolchain-wasm (swift-frontend-lsp.wasm); formatting and semantic tokens from swift-syntax 604.0.0';
const SWIFT_LS_URL = new URL('./swift-ls.wasm', import.meta.url);

/** Semantic token types, in the order swift-ls.wasm numbers them (server/Sources/YKSwift/Server.swift). */
const TOKEN_TYPES = ['keyword', 'type', 'string', 'number', 'comment', 'variable', 'operator', 'macro',
    'decorator', 'regexp', 'function', 'property', 'enumMember', 'parameter'];

const send = (msg) => self.postMessage(msg);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const log = (type, message) => notify('window/logMessage', { type, message });
const rpcError = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------- swift-ls.wasm

/**
 * The WASI calls swift-ls.wasm's Swift runtime imports, and no more: no file
 * system (each request carries its text), stdout/stderr become
 * window/logMessage, the clock and randomness come from the browser.
 */
function swiftLsWasi(getMemory) {
    const EBADF = 8, ENOSYS = 52, OK = 0;
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

const encoder = new TextEncoder(), decoder = new TextDecoder();
let swiftLsModule = null;
let swiftLs = null; // the instance's exports; null after a trap, until the next call starts one

function startSwiftLs() {
    let memory;
    const instance = new WebAssembly.Instance(swiftLsModule, { wasi_snapshot_preview1: swiftLsWasi(() => memory) });
    memory = instance.exports.memory;
    instance.exports._initialize();
    swiftLs = instance.exports;
}

const ready = (async () => {
    const t0 = performance.now();
    const bytes = await fetchWithProgress(SWIFT_LS_URL, 'swift-ls.wasm');
    swiftLsModule = await WebAssembly.compile(bytes);
    startSwiftLs();
    log(3, `swift-ls.wasm (formatting, semantic tokens): ${(bytes.length / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms`);
})();

/**
 * One request to swift-ls.wasm, `cmd\noptions\n<text>`, JSON back. The module
 * keeps no state, so a trap (code deep enough to exhaust a stack, see
 * server/Sources/YKSwift/Source.swift) costs only this answer: the next call
 * gets a fresh instance.
 */
function syntax(cmd, options, text) {
    if (!swiftLs) startSwiftLs();
    try {
        const input = encoder.encode(`${cmd}\n${options}\n${text}`);
        const ptr = swiftLs.yk_alloc(input.length);
        new Uint8Array(swiftLs.memory.buffer, ptr, input.length).set(input);
        const len = swiftLs.yk_call(ptr, input.length);
        return JSON.parse(decoder.decode(new Uint8Array(swiftLs.memory.buffer, swiftLs.yk_output(), len)));
    } catch (err) {
        if (!isFatal(err)) throw err;
        swiftLs = null;
        log(1, `swift-ls.wasm trapped in ${cmd}: ${err.message}`);
        return null;
    }
}

// ---------------------------------------------------------------- documents

/**
 * A document and its position tables: swift-ls.wasm speaks UTF-8 byte
 * offsets, LSP UTF-16 code units per line; `u8[i]` is the byte offset of
 * UTF-16 index i, so both directions are a lookup or a binary search.
 * (sourcekit-lsp-lite does its own conversion.)
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
    }
    /** UTF-16 index where line `line`'s content ends: before its `\n` or `\r\n`. */
    lineEnd(line) {
        let e = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] - 1 : this.text.length;
        if (e > this.lineStarts[line] && this.text.charCodeAt(e - 1) === 13) e--;
        return e;
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
const WORKSPACE = 'file:///workspace/';
const pathOf = (uri) => (uri.startsWith(WORKSPACE) ? decodeURIComponent(uri.slice(WORKSPACE.length)) : null);
const uriOf = (path) => WORKSPACE + path.split('/').map(encodeURIComponent).join('/');

/** Applies a didChange's changes (full, or ranged although Full sync is advertised) to `text`. */
function applyChanges(text, changes) {
    for (const c of changes) {
        if (!c.range) { text = c.text; continue; }
        const lines = [0];
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines.push(i + 1);
        const idx = (p) => Math.min(text.length, (lines[Math.min(p.line, lines.length - 1)] ?? 0) + p.character);
        text = text.slice(0, idx(c.range.start)) + c.text + text.slice(idx(c.range.end));
    }
    return text;
}

// ---------------------------------------------------------------- sourcekitd

/**
 * Everything for sourcekitd runs through `liteQueue`, in arrival order,
 * after the compiler has loaded; a request cancelled before its turn is
 * answered as cancelled and not run. `fs` is the file system it shares with
 * nobody (the runner has its own).
 */
let lite = null;
let fs = null;
let liteQueue = Promise.resolve();
const liteReady = { promise: null };

/**
 * Documents sourcekitd does not see (uri -> why), until their text changes:
 * one that crashed it, and one its parser would take minutes on
 * (MAX_SQUARE_NESTING). They are left out of /workspace and of the server, so
 * the rest of the project keeps working, get one warning saying why, and no
 * answers from sourcekitd; formatting and semantic tokens still work.
 */
const excluded = new Map();

/**
 * The deepest `[` nesting sourcekitd is given. The compiler's parser takes
 * time exponential in it (it looks ahead for a type at each `[`): natively
 * `let t: [[...Int]]` 20 deep parses in 0.45 s and 22 deep in 1.4 s; in this
 * wasm sourcekitd, diagnostics took 0.6 s at 12, 1.6 s at 16, 2.7 s at 18,
 * and 30 deep did not finish in 3 minutes, with every other request waiting
 * behind it. Measured by swift-ls.wasm (`nesting`), outside comments and
 * strings.
 */
const MAX_SQUARE_NESTING = 16;
/** The document changed last: the one blamed when sourcekitd crashes. */
let lastChanged = null;

function startLite() {
    liteReady.promise ??= (async () => {
        const t0 = performance.now();
        const onLoading = (label, loaded, total) => notify('yukibana/loading', { label, loaded, total });
        const [module, root] = await Promise.all([loadTool(FRONTEND_WASM, onLoading), loadSysroot(onLoading)]);
        fs = root;
        mkdirp(fs, '/workspace');
        // What sourcekitd prints is its own tracing (code completion's
        // compiler instance echoes the diagnostics of the text it parsed), not
        // the user's diagnostics, so it is logged at the lowest level.
        lite = new Lite(module, fs, (text) => log(4, `sourcekitd: ${text.trimEnd()}`));
        restartLite();
        log(3, `${FRONTEND_WASM}: sourcekitd ready in ${Math.round(performance.now() - t0)} ms`);
    })();
    liteReady.promise.catch((e) => log(1, `the Swift compiler did not load: ${e?.message ?? e}; only formatting and semantic tokens work`));
    return liteReady.promise;
}

/** A fresh sourcekitd with the project open in it: after loading, and after a crash. */
function restartLite() {
    for (const name of fs.contents.get('tmp')?.contents.keys() ?? []) {
        if (name.startsWith('sourcekit-lsp-lite-')) remove(fs, `/tmp/${name}`); // the dead instance's shadow copies
    }
    lite.start();
    lite.handle({
        jsonrpc: '2.0', id: 'yk-init', method: 'initialize', params: {
            processId: null, rootUri: 'file:///workspace',
            capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
            initializationOptions: { compilerArgs: sourceKitArgs() },
        },
    });
    lite.handle({ jsonrpc: '2.0', method: 'initialized', params: {} });
    for (const doc of docs.values()) {
        if (excluded.has(doc.uri)) continue;
        try {
            forward({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: doc.uri, languageId: 'swift', version: doc.version, text: doc.text } } });
        } catch (e) {
            if (!isFatal(e)) throw e;
            markBroken(doc, e);
            return restartLite();
        }
    }
}

/** Mirrors a document into /workspace (or removes it), where sourcekitd reads the module's files it was not handed. */
function mirror(uri, text) {
    const path = pathOf(uri);
    if (path === null || !fs) return;
    if (text === null || excluded.has(uri)) remove(fs, `/workspace/${path}`);
    else writeFile(fs, `/workspace/${path}`, text);
}

/** Hands a message to sourcekitd and deals with what comes back. A fatal error is thrown, for the caller to recover from. */
function forward(msg) {
    for (const out of lite.handle(msg)) receive(out);
}

/**
 * A message from sourcekit-lsp-lite, for the client. Diagnostics lose the
 * warning that projectModuleName causes on purpose (xctest.js), and keep
 * related information inside a macro expansion (see inExpansion) at the
 * diagnostic's own place.
 */
function receive(out) {
    if (out.method === 'textDocument/publishDiagnostics') {
        const { uri, diagnostics } = out.params;
        const shown = diagnostics.filter((d) => !isOwnModuleImportWarning(d.message)).map((d) => inExpansion(uri, d));
        send({ ...out, params: { ...out.params, diagnostics: shown } });
    } else if (out.id === 'yk-init') {
        // the answer to our own initialize
    } else {
        send(out);
    }
}

/**
 * sourcekitd reports a diagnostic about macro-generated code at the macro's
 * use, where the editor can show it, but a note it relates may point into
 * the expansion itself: a buffer named like
 * `@__swiftmacro_4main5ClashC1x18ObservationTrackedfMp_.swift`, which
 * SourceKit-LSP shows as a document of its own and this editor cannot open.
 * Such a note is kept, at the diagnostic's own range, saying where it is.
 */
function inExpansion(uri, diagnostic) {
    if (!diagnostic.relatedInformation?.some((r) => !r.location.uri.startsWith(WORKSPACE))) return diagnostic;
    return {
        ...diagnostic,
        relatedInformation: diagnostic.relatedInformation.map((r) => (r.location.uri.startsWith(WORKSPACE) ? r : {
            location: { uri, range: diagnostic.range },
            message: `${r.message} (in a macro expansion)`,
        })),
    };
}

/**
 * Runs `job` (which calls sourcekitd) in turn. If sourcekitd crashes, the
 * document changed last is blamed and left out, a fresh instance gets the
 * rest (and diagnoses them again), and `job` fails with the crash (an error
 * with `crashed` set); anything else it throws, too. When there is no one
 * left to blame (the document changed last is already out), the fresh
 * instance gets everything as before but its diagnostics wait for the next
 * change, so a crash that does not depend on the text cannot loop.
 */
function enqueue(job) {
    const run = liteQueue.then(async () => {
        await startLite();
        try {
            return await job();
        } catch (e) {
            if (!isFatal(e)) throw e;
            const culprit = lastChanged && !excluded.has(lastChanged) ? docs.get(lastChanged) : null;
            log(1, `sourcekitd crashed (${e.message})${culprit ? `; leaving ${culprit.uri} out until it changes` : ''}; restarting it`);
            if (culprit) markBroken(culprit, e);
            restartLite();
            if (culprit) scheduleIdle();
            throw Object.assign(rpcError(-32603, `sourcekitd crashed: ${e.message}`), { crashed: true });
        }
    });
    liteQueue = run.catch(() => {});
    return run;
}

function markBroken(doc, e) {
    exclude(doc, `sourcekitd crashed analysing this file (${e.message}) and leaves it out until it changes: ` +
        'no diagnostics, completion or navigation for it. The other files are unaffected.');
}

/** Leaves `doc` out of sourcekitd (see `excluded`) with a warning saying why. */
function exclude(doc, why) {
    excluded.set(doc.uri, why);
    mirror(doc.uri, null);
    notify('textDocument/publishDiagnostics', { uri: doc.uri, version: doc.version, diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: doc.lineEnd(0) } },
        severity: 2, source: 'sourcekitd', message: why,
    }] });
}

// Diagnostics are computed when the client is quiet: IDLE_DELAY ms after the
// last message, one file per step, each step its own turn in the queue so
// that a request arriving meanwhile goes first.
const IDLE_DELAY = 250;
let idleTimer = 0;
function scheduleIdle(delay = IDLE_DELAY) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => enqueue(() => {
        if (lite.hasIdleWork()) {
            for (const out of lite.idle()) receive(out);
            if (lite.hasIdleWork()) scheduleIdle(0);
        }
    }).catch(() => {}), delay);
}

// ---------------------------------------------------------------- document lifecycle

/**
 * Sets a document's text. Returns whether sourcekitd had it before (`wasIn`)
 * and should have it now (`isIn`): new text is a new chance for one that
 * crashed it, and one nested too deep (MAX_SQUARE_NESTING) is left out.
 */
function open(uri, text, version) {
    const wasIn = docs.has(uri) && !excluded.has(uri);
    const doc = new Doc(uri, text, version);
    excluded.delete(uri);
    docs.set(uri, doc);
    lastChanged = uri;
    const nesting = Number(syntax('nesting', '', text) ?? 0);
    if (nesting > MAX_SQUARE_NESTING) {
        exclude(doc, `sourcekitd leaves this file out: its \`[\` brackets nest ${nesting} deep, and the Swift parser takes ` +
            `time exponential in that depth (minutes from about 24). No diagnostics, completion or navigation for it ` +
            `until they nest at most ${MAX_SQUARE_NESTING} deep; the other files are unaffected.`);
    }
    return { doc, wasIn, isIn: !excluded.has(uri) };
}

/**
 * The optional downloads, added to sourcekitd's file system before the
 * first file that needs one reaches it: XCTest and swift-testing for a file
 * that imports them, the macro plugins for one that can use their macros.
 * A failed download is tried again for the next such file.
 */
const extras = [
    { needed: importsXCTest, load: loadXCTest, loading: null },
    { needed: importsTesting, load: loadSwiftTesting, loading: null },
    { needed: usesMacroPlugins, load: loadMacroPlugins, loading: null },
];
async function ensureExtras(text) {
    const onLoading = (label, loaded, total) => notify('yukibana/loading', { label, loaded, total });
    await Promise.all(extras.filter((x) => x.needed(text)).map((x) => (x.loading ??= x.load(fs, onLoading).catch((e) => {
        x.loading = null;
        throw e;
    }))));
}

// ---------------------------------------------------------------- LSP

const handlers = {
    initialize: async () => {
        await ready;
        startLite();
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
                inlayHintProvider: true,
            },
            serverInfo: { name: NAME, version: VERSION },
        };
    },
    initialized: () => {},
    shutdown: () => null,
    exit: () => self.close(),
    '$/setTrace': () => {},
    'workspace/didChangeConfiguration': () => {},
    'workspace/didChangeWatchedFiles': () => {}, // didOpen/didClose already carry the files

    'textDocument/didOpen': ({ textDocument: t }) => {
        const { isIn } = open(t.uri, t.text, t.version);
        if (isIn) toSourceKit('textDocument/didOpen', { textDocument: t }, t.text);
    },
    'textDocument/didChange': ({ textDocument: t, contentChanges }) => {
        const text = applyChanges(docs.get(t.uri)?.text ?? '', contentChanges);
        const { wasIn, isIn } = open(t.uri, text, t.version);
        // A document sourcekitd did not have comes back as a new one; one it
        // must not have any more is closed there.
        if (isIn && wasIn) toSourceKit('textDocument/didChange', { textDocument: t, contentChanges: [{ text }] }, text);
        else if (isIn) toSourceKit('textDocument/didOpen', { textDocument: { uri: t.uri, languageId: 'swift', version: t.version, text } }, text);
        else if (wasIn) toSourceKit('textDocument/didClose', { textDocument: { uri: t.uri } }, null);
    },
    'textDocument/didSave': () => {},
    'textDocument/didClose': ({ textDocument: t }) => {
        const wasIn = docs.has(t.uri) && !excluded.has(t.uri);
        excluded.delete(t.uri);
        docs.delete(t.uri);
        notify('textDocument/publishDiagnostics', { uri: t.uri, diagnostics: [] });
        if (wasIn) toSourceKit('textDocument/didClose', { textDocument: t }, null);
    },

    'textDocument/formatting': ({ textDocument, options }) => {
        const doc = docs.get(textDocument.uri);
        if (!doc) return null;
        const unit = options?.insertSpaces === false ? 't' : `s${options?.tabSize ?? 4}`;
        const r = syntax('format', unit, doc.text);
        if (!r || r.text === doc.text) return [];
        return [{ range: doc.range(0, doc.u8[doc.text.length]), newText: r.text }];
    },
    'textDocument/semanticTokens/full': ({ textDocument }) => {
        const doc = docs.get(textDocument.uri);
        if (!doc) return null;
        const flat = syntax('tokens', '', doc.text) ?? [];
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

/**
 * A document notification for sourcekitd: mirrored into /workspace and
 * handed over in turn (`text` null for a close). An open or a change is
 * dropped if the document was excluded meanwhile (a crash before its turn);
 * a close always goes (for a document sourcekitd does not have, it is a
 * no-op).
 */
function toSourceKit(method, params, text) {
    enqueue(async () => {
        if (text !== null) await ensureExtras(text);
        const uri = params.textDocument.uri;
        if (text !== null && excluded.has(uri)) return;
        mirror(uri, text);
        forward({ jsonrpc: '2.0', method, params });
    }).catch((e) => log(1, `${method}: ${e?.message ?? e}`));
    scheduleIdle();
}

// Messages are taken in order. Document changes and swift-ls's answers are
// handled at once; everything else is sourcekitd's, queued behind the
// compiler's download and the requests before it. `$/cancelRequest` is
// handled as it arrives: a request cancelled before its turn is not run.
const cancelled = new Set();
self.onmessage = ({ data: msg }) => {
    if (msg.method === '$/cancelRequest') {
        if (cancelled.size > 256) cancelled.clear(); // ids of requests answered before their cancellation arrived
        cancelled.add(msg.params?.id);
        return;
    }
    if (!msg.method) return; // the client's answer to a request of ours
    handle(msg);
};

async function handle(msg) {
    const isRequest = msg.id !== undefined && msg.id !== null;
    const reply = (result) => isRequest && send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    const fail = (err) => {
        log(1, `${msg.method}: ${err?.stack ?? err}`);
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } });
    };
    const local = handlers[msg.method];
    if (local) {
        try {
            if (msg.method !== 'initialize') await ready;
            reply(await local(msg.params ?? {}));
        } catch (err) {
            fail(err);
        }
        return;
    }
    if (!isRequest) return; // a notification sourcekit-lsp-lite would ignore too
    // A document sourcekitd does not have gets no answer from it (null). A
    // request that crashes sourcekitd is asked once more, of the fresh
    // instance, without the document blamed for the crash.
    const uri = msg.params?.textDocument?.uri;
    const job = () => {
        if (cancelled.delete(msg.id)) {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32800, message: 'cancelled' } });
            return;
        }
        if (uri && excluded.has(uri)) return reply(null);
        forward(msg);
    };
    enqueue(job).catch((err) => (err?.crashed ? enqueue(job) : Promise.reject(err))).catch(fail);
    scheduleIdle();
}
