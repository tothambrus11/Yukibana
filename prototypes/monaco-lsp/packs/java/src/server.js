// Yukibana Java pack: javac (OpenJDK 25u's jdk.compiler) compiled to
// WebAssembly GC with TeaVM by teavm-javac, behind a small LSP server in a
// module Web Worker. One JSON-RPC message per postMessage, as CONTRACT.md
// says. javac parses, attributes and flow-analyses every open .java file
// together; completion, hover, definition, type definition, references,
// symbols, signature help and import quick fixes are read from its
// attributed trees by LanguageService.java (see ../README.md). Positions cross to Java as UTF-16 offsets (javac's),
// and are turned into lines and characters here.

import { load } from './teavm-runtime.js';

const BASE = new URL('./', import.meta.url);

const send = (msg) => postMessage(msg);
/**
 * A javac message with types by their simple names (`String`, `List<Point>`),
 * as javac prints them on the command line (its RichDiagnosticFormatter);
 * the compiler API's messages, which these are, qualify every type.
 */
const simpleNames = (message) => message.replace(/\b(?:[a-z_$][\w$]*\.)+(?=[A-Z][\w$]*)/g, '');
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

let manifest = null;
const ready = (async () => {
    const t0 = performance.now();
    manifest = await (await fetch(new URL('manifest.json', BASE))).json();
    const [compiler, classlib, junit] = await Promise.all([
        fetchBytes(manifest.compiler.file, manifest.compiler.size),
        fetchBytes(manifest.classlibJavac.file, manifest.classlibJavac.size),
        fetchBytes(manifest.junit.file, manifest.junit.size),
    ]);
    const t1 = performance.now();
    const lib = (await load(compiler)).exports;
    const service = lib.createLanguageService();
    service.setSdk(new Int8Array(classlib.buffer));
    service.addJar(new Int8Array(junit.buffer));
    log(`javac (${manifest.versions.javac}) loaded in ${Math.round(t1 - t0)} ms, started in ${Math.round(performance.now() - t1)} ms`);
    return service;
})();
ready.catch((e) => log(`failed to start: ${e?.stack ?? e}`, 1));

// ---- Documents and positions

/** Open .java documents: uri -> { version, text, lines } (lines: offsets of line starts). */
const docs = new Map();
const PREFIX = 'file:///workspace/';
const pathOf = (uri) => (uri.startsWith(PREFIX) ? decodeURIComponent(uri.slice(PREFIX.length)) : null);
const uriOf = (path) => PREFIX + path.split('/').map(encodeURIComponent).join('/');
const isJava = (uri) => /\.java$/i.test(uri) && pathOf(uri) !== null;

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
}

function setDoc(uri, version, text) {
    docs.set(uri, { version, text, lines: lineStarts(text) });
}

/** The LSP position of an offset in a document. */
function positionOf(doc, offset) {
    const lines = doc.lines;
    offset = Math.max(0, Math.min(offset, doc.text.length));
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, character: offset - lines[lo] };
}

/** The offset of an LSP position; a character past the end of its line means the end of the line. */
function offsetOf(doc, line, character) {
    if (line >= doc.lines.length) return doc.text.length;
    const start = doc.lines[line];
    const end = line + 1 < doc.lines.length ? doc.lines[line + 1] - 1 : doc.text.length;
    return Math.min(start + character, end);
}

function rangeOf(doc, start, end) {
    return { start: positionOf(doc, start), end: positionOf(doc, end) };
}

/** A location from LanguageService's {path, start, end}, or null for a file that is not open. */
function locationOf(o) {
    const uri = uriOf(o.path);
    const doc = docs.get(uri);
    return doc ? { uri, range: rangeOf(doc, o.start, o.end) } : null;
}

// ---- Diagnostics

let dirty = false;
let timer = 0;
/** Diagnostics last published per uri, so a file whose errors are gone gets an empty list. */
const published = new Set();

function check(service) {
    clearTimeout(timer);
    timer = 0;
    if (!dirty) return;
    dirty = false;
    const t0 = performance.now();
    let result;
    try {
        result = JSON.parse(service.check());
    } catch (e) {
        log(`check failed: ${e?.stack ?? e}`, 1);
        return;
    }
    let count = 0;
    for (const [path, list] of Object.entries(result)) {
        const uri = uriOf(path);
        const doc = docs.get(uri);
        if (!doc) continue;
        const diagnostics = list.map((d) => {
            let { start, end } = d;
            if (start < 0) start = 0;
            if (end <= start) {
                // A point: the identifier there, or one character.
                end = start;
                while (end < doc.text.length && /[\w$]/.test(doc.text[end])) end++;
                if (end === start) end = Math.min(start + 1, doc.text.length);
                if (end === start && start > 0) start--;
            }
            return { range: rangeOf(doc, start, end), severity: d.severity === 'error' ? 1 : 2, source: 'javac', code: d.code, message: simpleNames(d.message) };
        });
        count += diagnostics.length;
        published.add(uri);
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: doc.version, diagnostics } });
    }
    log(`checked ${docs.size} file(s) in ${Math.round(performance.now() - t0)} ms: ${count} diagnostic(s)`, 4);
}

function schedule(service) {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => check(service), 250);
}

// ---- Requests

const capabilities = {
    textDocumentSync: { openClose: true, change: 1 },
    completionProvider: { triggerCharacters: ['.', ':'], resolveProvider: false },
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ['(', ','] },
    definitionProvider: true,
    typeDefinitionProvider: true,
    referencesProvider: true,
    documentHighlightProvider: true,
    documentSymbolProvider: true,
    renameProvider: { prepareProvider: true },
    codeActionProvider: { codeActionKinds: ['quickfix'] },
};

/** A request the client got wrong: answered with this code, not logged as a server failure. */
class RequestError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const InvalidRequest = -32600;
const InvalidParams = -32602;

/** The document, path and offset of a TextDocumentPositionParams, checked; null for a document that is not Java. */
function at(p) {
    const uri = p?.textDocument?.uri;
    const line = p?.position?.line;
    const character = p?.position?.character;
    if (typeof uri !== 'string' || !Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0)
        throw new RequestError(InvalidParams, 'expected textDocument.uri and a position { line, character } of non-negative integers');
    const doc = docs.get(uri);
    if (!doc) return null;
    return { uri, doc, path: pathOf(uri), offset: offsetOf(doc, line, character) };
}

function textDocument(p) {
    const uri = p?.textDocument?.uri;
    if (typeof uri !== 'string') throw new RequestError(InvalidParams, 'expected textDocument.uri');
    return uri;
}

const KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final ' +
    'finally float for goto if implements import instanceof int interface long native new package private protected public return short ' +
    'static strictfp super switch synchronized this throw throws transient try void volatile while true false null _').split(' '));
const isIdentifier = (name) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name) && !KEYWORDS.has(name);

/**
 * What a rename at a position would change: javac's occurrences of the
 * symbol, refused when the symbol is not declared in the project (the class
 * library cannot be edited), when it is a public top-level class (its file
 * would have to be renamed too, which an LSP rename here cannot do), or when
 * an occurrence's text is not the name.
 */
function renameTarget(s, p) {
    const here = at(p);
    if (!here) throw new RequestError(InvalidRequest, 'There is no symbol here to rename.');
    const refs = JSON.parse(s.references(here.path, here.offset));
    if (!refs) throw new RequestError(InvalidRequest, 'There is no symbol here to rename.');
    if (!refs.declared) throw new RequestError(InvalidRequest, `${refs.name} is declared outside the project (in the class library) and cannot be renamed.`);
    if (refs.kind === 'publicTopLevelClass')
        throw new RequestError(InvalidRequest, `${refs.name} is a public class, so its file must have its name: rename the file ${refs.name}.java and the class together, by hand.`);
    const locations = refs.locations.map((o) => ({ o, loc: locationOf(o) }));
    const odd = locations.find(({ o, loc }) => !loc || docs.get(loc.uri).text.slice(o.start, o.end) !== refs.name);
    if (odd) throw new RequestError(InvalidRequest, `Cannot rename: an occurrence of ${refs.name} is not written as its name (${odd.o.path}).`);
    const current = locations.find(({ o, loc }) => loc.uri === here.uri && o.start <= here.offset && here.offset <= o.end);
    if (!current) throw new RequestError(InvalidRequest, 'There is no symbol here to rename.');
    return { name: refs.name, here: current.loc, locations: locations.map(({ loc }) => loc) };
}

/** The edit that imports a class, at LanguageService's import offset: after the last import or the package line, or first in the file. */
function importEdit(doc, offset, name) {
    const pos = positionOf(doc, offset);
    return { range: { start: pos, end: pos }, newText: offset === 0 ? `import ${name};\n\n` : `\nimport ${name};` };
}

/**
 * The simple class name a `cannot find symbol` diagnostic is about: javac's
 * `symbol: class ArrayList` (a type) or `symbol: variable Collections` (the
 * qualifier of a static call), capitalised, since a lower-case name is a
 * missing variable no import can supply.
 */
function missingClass(d) {
    if (d?.source !== 'javac' || typeof d.message !== 'string' || !d.message.startsWith('cannot find symbol')) return null;
    return /\bsymbol:\s+(?:class|variable) ([A-Z][\w$]*)$/m.exec(d.message)?.[1] ?? null;
}

const SYMBOL_KINDS = new Set([5, 6, 8, 9, 10, 11, 14, 22, 23]);
function documentSymbols(doc, list) {
    return list.map((s) => ({
        name: s.name,
        kind: SYMBOL_KINDS.has(s.kind) ? s.kind : 13,
        ...(s.detail ? { detail: s.detail } : {}),
        range: rangeOf(doc, s.start, s.end),
        selectionRange: rangeOf(doc, s.nameStart, s.nameEnd),
        ...(s.children ? { children: documentSymbols(doc, s.children) } : {}),
    }));
}

const requests = {
    initialize: async () => {
        await ready;
        return { capabilities, serverInfo: { name: `javac ${manifest.versions.javac} (teavm-javac, TeaVM ${manifest.versions.teavm})`, version: '25' } };
    },
    shutdown: async () => { shutDown = true; return null; },
    'textDocument/completion': (s, p) => {
        const here = at(p);
        if (!here) return null;
        const r = JSON.parse(s.complete(here.path, here.offset));
        if (!r) return { isIncomplete: false, items: [] };
        const range = rangeOf(here.doc, r.start, here.offset);
        return {
            isIncomplete: false,
            items: r.items.map((i) => {
                const item = { label: i.label, kind: i.kind, sortText: i.sort, filterText: i.label, textEdit: { range, newText: i.insert ?? i.label } };
                if (i.detail) item.detail = i.detail;
                if (i.importText) {
                    const bar = i.importText.indexOf('|');
                    const offset = Number(i.importText.slice(0, bar));
                    const name = i.importText.slice(bar + 1);
                    item.additionalTextEdits = [importEdit(here.doc, offset, name)];
                    item.labelDetails = { description: name.slice(0, name.lastIndexOf('.')) };
                }
                return item;
            }),
        };
    },
    'completionItem/resolve': (s, p) => p,
    'textDocument/hover': (s, p) => {
        const here = at(p);
        if (!here) return null;
        const h = JSON.parse(s.hover(here.path, here.offset));
        return h && { contents: { kind: 'markdown', value: h.contents }, range: rangeOf(here.doc, h.start, h.end) };
    },
    'textDocument/signatureHelp': (s, p) => {
        const here = at(p);
        if (!here) return null;
        const h = JSON.parse(s.signatureHelp(here.path, here.offset));
        if (!h) return null;
        return {
            signatures: h.signatures.map((sig) => ({
                label: sig.label,
                parameters: sig.parameters.map((range) => ({ label: range })),
                ...(sig.documentation ? { documentation: { kind: 'markdown', value: sig.documentation } } : {}),
            })),
            activeSignature: h.activeSignature,
            activeParameter: h.activeParameter,
        };
    },
    'textDocument/definition': (s, p) => {
        const here = at(p);
        if (!here) return null;
        return JSON.parse(s.definition(here.path, here.offset)).map(locationOf).filter(Boolean);
    },
    'textDocument/typeDefinition': (s, p) => {
        const here = at(p);
        if (!here) return null;
        return JSON.parse(s.typeDefinition(here.path, here.offset)).map(locationOf).filter(Boolean);
    },
    // Quick fixes: an import for each class a `cannot find symbol` could
    // mean, the project's first; preferred when there is only one.
    'textDocument/codeAction': (s, p) => {
        const uri = textDocument(p);
        const doc = docs.get(uri);
        const diagnostics = p?.context?.diagnostics;
        if (!doc || !Array.isArray(diagnostics)) return [];
        const byName = new Map();
        for (const d of diagnostics) {
            const name = missingClass(d);
            if (name) (byName.get(name) ?? byName.set(name, []).get(name)).push(d);
        }
        const actions = [];
        for (const [name, ds] of byName) {
            const found = JSON.parse(s.importsFor(pathOf(uri), name));
            if (!found) continue;
            for (const qualified of found.classes) {
                actions.push({
                    title: `Import '${qualified}'`,
                    kind: 'quickfix',
                    diagnostics: ds,
                    isPreferred: found.classes.length === 1,
                    edit: { changes: { [uri]: [importEdit(doc, found.at, qualified)] } },
                });
            }
        }
        return actions;
    },
    'textDocument/references': (s, p) => {
        const here = at(p);
        if (!here) return null;
        const refs = JSON.parse(s.references(here.path, here.offset));
        if (!refs) return [];
        const include = !!p.context?.includeDeclaration;
        return refs.locations.filter((o) => include || !o.decl).map(locationOf).filter(Boolean);
    },
    'textDocument/documentHighlight': (s, p) => {
        const here = at(p);
        if (!here) return null;
        const refs = JSON.parse(s.references(here.path, here.offset));
        if (!refs) return [];
        return refs.locations.filter((o) => o.path === here.path).map((o) => ({ range: rangeOf(here.doc, o.start, o.end), kind: o.decl ? 3 : 2 }));
    },
    'textDocument/documentSymbol': (s, p) => {
        const uri = textDocument(p);
        const doc = docs.get(uri);
        if (!doc) return [];
        return documentSymbols(doc, JSON.parse(s.symbols(pathOf(uri))));
    },
    'textDocument/prepareRename': (s, p) => {
        const { name, here } = renameTarget(s, p);
        return { range: here.range, placeholder: name };
    },
    'textDocument/rename': (s, p) => {
        const { name, locations } = renameTarget(s, p);
        const newName = p?.newName;
        if (typeof newName !== 'string' || !isIdentifier(newName))
            throw new RequestError(InvalidParams, `"${newName}" is not a Java identifier`);
        const changes = {};
        for (const l of locations) (changes[l.uri] ??= []).push({ range: l.range, newText: newName });
        log(`rename ${name} -> ${newName}: ${locations.length} occurrence(s) in ${Object.keys(changes).length} file(s)`, 4);
        return { changes };
    },
};

// Only Java sources go to javac; the client opens every project file
// (README.md, pom.xml, ...) and those are left alone.
const notifications = {
    initialized: () => {},
    exit: () => close(),
    'textDocument/didOpen': (s, p) => {
        const { uri, version, text } = p.textDocument;
        if (!isJava(uri)) return;
        setDoc(uri, version, text);
        s.setFile(pathOf(uri), text);
        schedule(s);
    },
    'textDocument/didChange': (s, p) => {
        const text = p.contentChanges.at(-1)?.text;
        const uri = p.textDocument.uri;
        if (text === undefined || !isJava(uri)) return;
        setDoc(uri, p.textDocument.version, text);
        s.setFile(pathOf(uri), text);
        schedule(s);
    },
    // The client closes a document when its file is deleted (CONTRACT.md).
    'textDocument/didClose': (s, p) => {
        const uri = p.textDocument.uri;
        if (!docs.has(uri)) return;
        docs.delete(uri);
        s.removeFile(pathOf(uri));
        if (published.delete(uri)) send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
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
