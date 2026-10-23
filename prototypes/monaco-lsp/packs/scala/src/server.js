// Yukibana Scala pack: the Scala 3 compiler (3.7.4, upstream sources compiled
// to JavaScript with Scala.js, see ../README.md) behind a small LSP server in
// a module Web Worker. One JSON-RPC message per postMessage, as CONTRACT.md
// says. The compiler's front end (parser + typer) checks every open document
// together, so files see each other's definitions; completion, hover,
// definition and the rest are upstream's interactive API
// (dotty.tools.dotc.interactive) called from ScalaService.scala.

const BASE = new URL('./', import.meta.url);

const send = (msg) => postMessage(msg);
const log = (message, type = 3) => send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type, message } });

/** Fetches a pack file, reporting yukibana/loading as bytes arrive. The total
 *  comes from manifest.json (uncompressed sizes), because a host serving the
 *  .br/.gz sibling reports the compressed length, if any. */
async function fetchBytes(name, total) {
    const res = await fetch(new URL(name, BASE));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    let last = 0;
    send({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label: name, loaded: 0, total } });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (loaded - last > 256 * 1024) {
            last = loaded;
            send({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label: name, loaded, total: Math.max(total, loaded) } });
        }
    }
    send({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label: name, loaded, total: loaded } });
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

const ready = (async () => {
    const t0 = performance.now();
    const manifest = await (await fetch(new URL('manifest.json', BASE))).json();
    const [compilerJs, classpath] = await Promise.all([
        fetchBytes(manifest.compiler.file, manifest.compiler.size),
        fetchBytes(manifest.classpath.file, manifest.classpath.size),
    ]);
    // The compiler is one self-contained ES module; importing it from a blob
    // lets the download above report progress (a plain import() cannot).
    const url = URL.createObjectURL(new Blob([compilerJs], { type: 'text/javascript' }));
    const { ScalaService } = await import(url);
    URL.revokeObjectURL(url);
    const t1 = performance.now();
    const service = new ScalaService(new Int8Array(classpath.buffer));
    log(`Scala ${manifest.scalaVersion} compiler loaded in ${Math.round(t1 - t0)} ms, class path (${manifest.classpath.entries} files) read in ${Math.round(performance.now() - t1)} ms`);
    return service;
})();
ready.catch((e) => log(`failed to start: ${e?.stack ?? e}`, 1));

// Documents, and whether the compiler has seen their latest text.
const docs = new Map();
let dirty = false;
let timer = 0;

function check(service) {
    clearTimeout(timer);
    timer = 0;
    if (!dirty) return;
    dirty = false;
    const t0 = performance.now();
    let result;
    try {
        result = service.check();
    } catch (e) {
        log(`check failed: ${e?.stack ?? e}`, 1);
        return;
    }
    let count = 0;
    for (const [uri, diagnostics] of Object.entries(result)) {
        count += diagnostics.length;
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: docs.get(uri)?.version, diagnostics } });
    }
    log(`checked ${docs.size} file(s) in ${Math.round(performance.now() - t0)} ms: ${count} diagnostic(s)`, 4);
}

function schedule(service) {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => check(service), 250);
}

const capabilities = {
    textDocumentSync: { openClose: true, change: 1 },
    completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ['(', ','] },
    definitionProvider: true,
    referencesProvider: true,
    documentHighlightProvider: true,
    documentSymbolProvider: true,
    renameProvider: { prepareProvider: true },
};

/** A request the client got wrong: answered with this code, not logged as a
 *  server failure (a TypeError from missing params once was both). */
class RequestError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const InvalidRequest = -32600;
const InvalidParams = -32602;

/** The document and position of a TextDocumentPositionParams, checked. */
function at(p) {
    const uri = p?.textDocument?.uri;
    const line = p?.position?.line;
    const character = p?.position?.character;
    if (typeof uri !== 'string' || !Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0)
        throw new RequestError(InvalidParams, 'expected textDocument.uri and a position { line, character } of non-negative integers');
    return [uri, line, character];
}
function doc(p) {
    const uri = p?.textDocument?.uri;
    if (typeof uri !== 'string') throw new RequestError(InvalidParams, 'expected textDocument.uri');
    return uri;
}

/** Positioned requests run against the latest text: a pending check runs first. */
const requests = {
    initialize: async () => {
        await ready;
        return { capabilities, serverInfo: { name: 'scala3-compiler-js (Scala 3.7.4 presentation front end)', version: '3.7.4' } };
    },
    shutdown: async () => { shutDown = true; return null; },
    'textDocument/completion': (s, p) => ({ isIncomplete: false, items: s.completion(...at(p)) }),
    'completionItem/resolve': (s, p) => p,
    'textDocument/hover': (s, p) => s.hover(...at(p)),
    'textDocument/signatureHelp': (s, p) => s.signatureHelp(...at(p)),
    'textDocument/definition': (s, p) => s.definition(...at(p)),
    'textDocument/references': (s, p) => s.references(...at(p), !!p.context?.includeDeclaration),
    'textDocument/documentHighlight': (s, p) => s.highlight(...at(p)),
    'textDocument/documentSymbol': (s, p) => s.symbols(doc(p)),
    'textDocument/prepareRename': (s, p) => {
        const { name, here } = renameTarget(s, p);
        return { range: here.range, placeholder: name };
    },
    'textDocument/rename': (s, p) => {
        const { name, occurrences } = renameTarget(s, p);
        const newName = p?.newName;
        if (typeof newName !== 'string' || !isIdentifier(newName))
            throw new RequestError(InvalidParams, `"${newName}" is not a Scala identifier`);
        const changes = {};
        for (const o of occurrences) (changes[o.uri] ??= []).push({ range: o.range, newText: newName });
        log(`rename ${name} -> ${newName}: ${occurrences.length} occurrence(s) in ${Object.keys(changes).length} file(s)`, 4);
        return { changes };
    },
};

/** The text of `range` in an open document, or null. */
function textAt(uri, range) {
    const text = docs.get(uri)?.text;
    if (text === undefined || range.start.line !== range.end.line) return null;
    let offset = 0;
    for (let line = 0; line < range.start.line; line++) {
        offset = text.indexOf('\n', offset) + 1;
        if (offset === 0) return null;
    }
    return text.slice(offset + range.start.character, offset + range.end.character);
}

const contains = (r, line, character) =>
    (r.start.line < line || (r.start.line === line && r.start.character <= character)) &&
    (r.end.line > line || (r.end.line === line && r.end.character >= character));

/**
 * What a rename at a position would change: the symbol's declaration and
 * every reference in the project, from the compiler's own references (so a
 * `val` in another file, a named argument or a companion are found the way
 * go-to-references finds them). Refused, as an error the editor shows, when
 * the symbol is not declared in the project (renaming `println` would edit
 * the standard library), or when an occurrence's text is not the name (a
 * synthetic or backquoted use): editing those blindly would break the code.
 */
function renameTarget(s, p) {
    const [uri, line, character] = at(p);
    const target = s.renameTarget(uri, line, character);
    if (!target) throw new RequestError(InvalidRequest, 'There is no symbol here to rename.');
    if (!target.declared) throw new RequestError(InvalidRequest, 'This symbol is declared outside the project (in the standard library) and cannot be renamed.');
    const occurrences = [...target.locations];
    const here = occurrences.find((o) => o.uri === uri && contains(o.range, line, character));
    if (!here) throw new RequestError(InvalidRequest, 'There is no symbol here to rename.');
    const name = textAt(uri, here.range);
    const odd = occurrences.find((o) => !docs.has(o.uri) || textAt(o.uri, o.range) !== name);
    if (!name || odd) throw new RequestError(InvalidRequest, `Cannot rename: an occurrence of ${name ?? 'this symbol'} is not written as its name${odd ? ` (${odd.uri.split('/').pop()}:${odd.range.start.line + 1})` : ''}.`);
    return { name, here, occurrences };
}

const RESERVED = new Set(('abstract case catch class def do else enum export extends false final finally for forSome given if implicit import ' +
    'lazy match new null object override package private protected return sealed super then this throw trait true try type val var ' +
    'while with yield _ : = <- => <: >: # @ =>> ?=>').split(' '));

/** A plain Scala identifier (letters and digits, or operator characters), not a reserved word. */
function isIdentifier(name) {
    if (RESERVED.has(name)) return false;
    return /^[\p{L}_$][\p{L}\p{N}_$]*(?:_[!#%&*+\-/:<=>?@\\^|~]+)?$/u.test(name) || /^[!#%&*+\-/:<=>?@\\^|~]+$/.test(name);
}

// Only Scala sources go to the compiler; the client opens every project file
// (README.md, build files, ...) and those are left alone.
const isScala = (uri) => /\.scala$/i.test(uri);

const notifications = {
    initialized: () => {},
    exit: () => close(),
    'textDocument/didOpen': (s, p) => { if (!isScala(p.textDocument.uri)) return; docs.set(p.textDocument.uri, { version: p.textDocument.version, text: p.textDocument.text }); s.setText(p.textDocument.uri, p.textDocument.text); schedule(s); },
    'textDocument/didChange': (s, p) => {
        const text = p.contentChanges.at(-1)?.text;
        if (text === undefined || !isScala(p.textDocument.uri)) return;
        docs.set(p.textDocument.uri, { version: p.textDocument.version, text });
        s.setText(p.textDocument.uri, text);
        schedule(s);
    },
    // The client closes a document when its file is deleted (CONTRACT.md).
    'textDocument/didClose': (s, p) => {
        if (!docs.has(p.textDocument.uri)) return;
        docs.delete(p.textDocument.uri);
        s.remove(p.textDocument.uri);
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: p.textDocument.uri, diagnostics: [] } });
        schedule(s);
    },
    'workspace/didChangeWatchedFiles': () => {},
};

// Messages are handled one at a time, in order, after the compiler is loaded.
let chain = Promise.resolve();
// After `shutdown`, the only request LSP allows is none: all but `exit` are refused.
let shutDown = false;
self.onmessage = ({ data: msg }) => {
    chain = chain.then(() => handle(msg));
};

async function handle(msg) {
    if (msg.method === undefined) return; // a response to a request we never send
    const isRequest = msg.id !== undefined;
    if (shutDown && msg.method !== 'exit') {
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: InvalidRequest, message: `${msg.method} after shutdown` } });
        return;
    }
    try {
        if (msg.method === 'initialize' || msg.method === 'shutdown' || msg.method === 'exit') {
            const r = await (requests[msg.method] ?? notifications[msg.method])();
            if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result: r });
            return;
        }
        const service = await ready;
        if (isRequest) {
            const fn = requests[msg.method];
            if (!fn) {
                send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unhandled method ${msg.method}` } });
                return;
            }
            check(service);
            send({ jsonrpc: '2.0', id: msg.id, result: fn(service, msg.params) ?? null });
        } else {
            notifications[msg.method]?.(service, msg.params);
        }
    } catch (e) {
        if (e instanceof RequestError) {
            if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message } });
            return;
        }
        log(`${msg.method}: ${e?.stack ?? e}`, 1);
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
}
