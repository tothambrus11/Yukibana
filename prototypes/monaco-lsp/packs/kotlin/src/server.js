// Yukibana Kotlin pack: a language server that reads Kotlin's syntax and
// nothing more, in a module Web Worker. One JSON-RPC message per
// postMessage, as CONTRACT.md says.
//
// There is no Kotlin compiler that runs in a browser (README.md), so this is
// tree-sitter (web-tree-sitter, with the tree-sitter-kotlin grammar) and
// name resolution done on the trees: what is declared where, which
// declarations a scope sees, and the type a variable was declared with or
// constructed as. That is enough for syntax errors, symbols, definition,
// references, hover with KDoc, signature help and completion of names and
// of the members of the project's own classes. It is not type checking: a
// type error, an unresolved name or a wrong argument is not reported, and
// the members of a library type (String, List) are not known.

import { Parser, Language } from './tree-sitter.js';

const BASE = new URL('./', import.meta.url);
const send = (msg) => postMessage(msg);
const log = (message, type = 3) => send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type, message } });

/** Fetches a pack file, reporting yukibana/loading as bytes arrive (total from manifest.json). */
async function fetchBytes(name, total) {
    const res = await fetch(new URL(name, BASE));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    send({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label: name, loaded: 0, total } });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        send({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label: name, loaded, total: Math.max(total, loaded) } });
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

let manifest = null;
const ready = (async () => {
    const t0 = performance.now();
    manifest = await (await fetch(new URL('manifest.json', BASE))).json();
    const [runtime, grammar] = await Promise.all([
        fetchBytes(manifest.runtime.file, manifest.runtime.size),
        fetchBytes(manifest.grammar.file, manifest.grammar.size),
    ]);
    await Parser.init({ wasmBinary: runtime });
    const parser = new Parser();
    parser.setLanguage(await Language.load(grammar));
    log(`tree-sitter ${manifest.versions.webTreeSitter} with tree-sitter-kotlin ${manifest.versions.kotlinGrammar} loaded in ${Math.round(performance.now() - t0)} ms`);
    return parser;
})();
ready.catch((e) => log(`failed to start: ${e?.stack ?? e}`, 1));

// ---- Documents and positions

/** Open .kt/.kts documents: uri -> { version, text, lines, tree, decls }. */
const docs = new Map();
const PREFIX = 'file:///workspace/';
const pathOf = (uri) => (uri.startsWith(PREFIX) ? decodeURIComponent(uri.slice(PREFIX.length)) : null);
const isKotlin = (uri) => /\.kts?$/i.test(uri) && pathOf(uri) !== null;

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
}
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
const rangeOf = (doc, start, end) => ({ start: positionOf(doc, start), end: positionOf(doc, end) });

// web-tree-sitter parses a JavaScript string as UTF-16, so its node indices
// are UTF-16 code units, as LSP's characters and JavaScript's strings are.
const parse = (parser, text) => parser.parse(text);

function setDoc(parser, uri, version, text) {
    const old = docs.get(uri);
    old?.tree?.delete();
    const doc = { uri, version, text, lines: lineStarts(text), tree: parse(parser, text) };
    doc.decls = declarations(doc);
    docs.set(uri, doc);
}

// ---- Declarations
//
// A declaration: { name, kind, doc (the file's document), node (the
// declaring node), nameNode, container (the declaration of the class or
// object it is a member of), scope (the node within which it is visible,
// for parameters and locals), type (the name of its declared or constructed
// type, when the syntax says it), members (for a class or object) }.

const CLASS_LIKE = new Set(['class_declaration', 'object_declaration', 'companion_object']);
const KIND = { class: 5, interface: 11, enum: 10, object: 19, fun: 12, method: 6, property: 7, field: 8, variable: 13, constructor: 9, enumMember: 22, typeParameter: 26, alias: 5 };

const named = (node) => {
    const out = [];
    for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i));
    return out;
};
const firstOfType = (node, type) => named(node).find((c) => c.type === type) ?? null;
const nameOf = (node) => node.childForFieldName?.('name') ?? firstOfType(node, 'identifier');

/** The type a declaration names: `x: Point`, or `= Point(...)` (a call of a class the project declares, checked later). */
function declaredType(node) {
    const t = named(node).find((c) => c.type === 'user_type' || c.type === 'nullable_type');
    if (t) return firstIdentifierText(t);
    const vd = firstOfType(node, 'variable_declaration');
    if (vd) {
        const t2 = named(vd).find((c) => c.type === 'user_type' || c.type === 'nullable_type');
        if (t2) return firstIdentifierText(t2);
    }
    const call = named(node).find((c) => c.type === 'call_expression');
    if (call) {
        const callee = call.namedChild(0);
        if (callee?.type === 'identifier') return { constructs: callee.text };
    }
    return null;
}
function firstIdentifierText(node) {
    if (node.type === 'identifier') return node.text;
    for (const c of named(node)) {
        const t = firstIdentifierText(c);
        if (t) return t;
    }
    return null;
}

/** The KDoc right before a declaration (`/** ... *\/`, possibly before its annotations), as Markdown. */
function kdocOf(node) {
    let prev = node.previousNamedSibling;
    if (prev?.type === 'block_comment' && prev.text.startsWith('/**')) {
        return prev.text.replace(/^\/\*\*\s?/, '').replace(/\*\/$/, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n').trim();
    }
    return '';
}

/** The declaration's header as written: up to its body or initializer. */
function signatureOf(node, doc) {
    let end = node.endIndex;
    for (const c of named(node)) {
        if (['class_body', 'enum_class_body', 'function_body', 'getter', 'setter', 'property_delegate'].includes(c.type)) { end = Math.min(end, c.startIndex); break; }
    }
    let text = doc.text.slice(node.startIndex, end);
    if (node.type === 'property_declaration') {
        const eq = topLevelEquals(text);
        if (eq >= 0) text = text.slice(0, eq);
    }
    return text.replace(/\s+/g, ' ').replace(/\s*=?\s*$/, '').trim();
}
function topLevelEquals(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '<' || c === '[') depth++;
        // The `>` of `->` closes nothing: counting it once lost the `=` of `val f: (Int) -> Int = ...`.
        else if (c === ')' || c === ']' || (c === '>' && text[i - 1] !== '-')) depth--;
        else if (c === '=' && depth === 0 && text[i + 1] !== '=' && text[i - 1] !== '!' && text[i - 1] !== '<' && text[i - 1] !== '>') return i;
    }
    return -1;
}

function classKind(node) {
    if (node.type === 'object_declaration' || node.type === 'companion_object') return 'object';
    const head = node.text.slice(0, (nameOf(node)?.startIndex ?? node.startIndex) - node.startIndex);
    if (/\binterface\b/.test(head)) return 'interface';
    if (/\benum\b/.test(head)) return 'enum';
    return 'class';
}

function declarations(doc) {
    const all = [];
    const add = (d) => { all.push(d); return d; };
    const walk = (node, container, scope) => {
        for (const c of named(node)) {
            if (CLASS_LIKE.has(c.type)) {
                const nn = nameOf(c);
                const kind = classKind(c);
                const decl = add({ name: nn?.text ?? 'Companion', kind, doc, node: c, nameNode: nn ?? c, container, scope: container ? null : null, members: [] });
                container?.members.push(decl);
                // Primary constructor: `val`/`var` parameters are properties, the rest only parameters of the constructor.
                const ctor = firstOfType(c, 'primary_constructor');
                for (const p of ctor ? named(firstOfType(ctor, 'class_parameters') ?? ctor).filter((x) => x.type === 'class_parameter') : []) {
                    const pn = firstOfType(p, 'identifier');
                    if (!pn) continue;
                    const isProperty = /^\s*(?:@\S+\s+)*(?:(?:private|public|protected|internal|override|open|final)\s+)*(?:val|var)\b/.test(p.text);
                    const d = add({ name: pn.text, kind: isProperty ? 'property' : 'variable', doc, node: p, nameNode: pn, container: isProperty ? decl : null, scope: isProperty ? null : c, type: declaredType(p) });
                    if (isProperty) decl.members.push(d);
                }
                const body = firstOfType(c, 'class_body') ?? firstOfType(c, 'enum_class_body');
                if (body) {
                    for (const e of named(body).filter((x) => x.type === 'enum_entry')) {
                        const en = firstOfType(e, 'identifier');
                        if (en) decl.members.push(add({ name: en.text, kind: 'enumMember', doc, node: e, nameNode: en, container: decl, type: decl.name }));
                    }
                    walk(body, decl, null);
                }
            } else if (c.type === 'function_declaration') {
                const nn = nameOf(c);
                if (nn) {
                    const d = add({ name: nn.text, kind: container ? 'method' : 'fun', doc, node: c, nameNode: nn, container, scope: container || !scope ? null : scope, type: declaredType(c) });
                    container?.members.push(d);
                }
                const params = firstOfType(c, 'function_value_parameters');
                for (const p of params ? named(params).filter((x) => x.type === 'parameter') : []) {
                    const pn = firstOfType(p, 'identifier');
                    if (pn) add({ name: pn.text, kind: 'variable', doc, node: p, nameNode: pn, container: null, scope: c, type: declaredType(p) });
                }
                const body = firstOfType(c, 'function_body');
                if (body) walk(body, null, c);
            } else if (c.type === 'property_declaration') {
                const vd = firstOfType(c, 'variable_declaration');
                const nn = vd && firstOfType(vd, 'identifier');
                if (nn) {
                    const local = !container && scope;
                    const d = add({ name: nn.text, kind: container ? 'property' : local ? 'variable' : 'property', doc, node: c, nameNode: nn, container, scope: local ? enclosingBlock(c) : null, after: local ? c.startIndex : 0, type: declaredType(c) });
                    container?.members.push(d);
                }
                walk(c, null, scope ?? c);
            } else if (c.type === 'type_alias') {
                const nn = firstOfType(c, 'identifier');
                if (nn) add({ name: nn.text, kind: 'alias', doc, node: c, nameNode: nn, container, scope: null });
            } else if (c.type === 'lambda_literal') {
                const lp = firstOfType(c, 'lambda_parameters');
                for (const p of lp ? named(lp) : []) {
                    const pn = p.type === 'identifier' ? p : firstOfType(p, 'identifier');
                    if (pn) add({ name: pn.text, kind: 'variable', doc, node: p, nameNode: pn, container: null, scope: c, type: declaredType(p) });
                }
                if (!lp && !all.some((d) => d.scope === c && d.name === 'it')) add({ name: 'it', kind: 'variable', doc, node: c, nameNode: null, container: null, scope: c, implicit: true });
                walk(c, null, c);
            } else if (c.type === 'for_statement') {
                const vd = firstOfType(c, 'variable_declaration');
                const nn = vd && firstOfType(vd, 'identifier');
                if (nn) add({ name: nn.text, kind: 'variable', doc, node: vd, nameNode: nn, container: null, scope: c });
                walk(c, null, c);
            } else if (c.type === 'catch_block') {
                const nn = firstOfType(c, 'identifier');
                if (nn) add({ name: nn.text, kind: 'variable', doc, node: c, nameNode: nn, container: null, scope: c });
                walk(c, null, c);
            } else {
                walk(c, container && c.type === 'ERROR' ? container : null, scope);
            }
        }
    };
    walk(doc.tree.rootNode, null, null);
    return all;
}

/** The block (or function body, lambda, file) a local declaration is visible in. */
function enclosingBlock(node) {
    for (let n = node.parent; n; n = n.parent) {
        if (['block', 'function_body', 'lambda_literal', 'source_file', 'class_body', 'control_structure_body'].includes(n.type)) return n;
    }
    return null;
}

const contains = (node, offset) => node.startIndex <= offset && offset <= node.endIndex;
const allDecls = () => [...docs.values()].flatMap((d) => d.decls);
const projectClass = (name) => allDecls().find((d) => (d.kind === 'class' || d.kind === 'object' || d.kind === 'interface' || d.kind === 'enum') && d.name === name && !d.container) ??
    allDecls().find((d) => ['class', 'object', 'interface', 'enum'].includes(d.kind) && d.name === name);

/** The declarations visible at an offset in a document, innermost first: locals and parameters, members of enclosing classes, then the project's top level. */
function visibleAt(doc, offset) {
    const out = [];
    const seen = new Set();
    const push = (d) => { if (!seen.has(d.name)) { seen.add(d.name); out.push(d); } };
    const locals = doc.decls.filter((d) => d.scope && contains(d.scope, offset) && (!d.after || d.after <= offset))
        .sort((a, b) => b.scope.startIndex - a.scope.startIndex);
    locals.forEach(push);
    for (const d of doc.decls.filter((x) => ['class', 'object', 'interface', 'enum'].includes(x.kind) && contains(x.node, offset)).sort((a, b) => b.node.startIndex - a.node.startIndex)) {
        for (const m of membersOf(d)) push(m);
    }
    for (const d of allDecls().filter((x) => !x.container && !x.scope)) push(d);
    return out;
}

/** A class's members, its supertypes' (when the project declares them) after its own. */
function membersOf(cls, seen = new Set()) {
    if (seen.has(cls)) return [];
    seen.add(cls);
    const own = [...cls.members];
    const supers = firstOfType(cls.node, 'delegation_specifiers');
    for (const s of supers ? named(supers) : []) {
        const name = firstIdentifierText(s);
        const sup = name && projectClass(name);
        if (sup) own.push(...membersOf(sup, seen).filter((m) => !own.some((o) => o.name === m.name)));
    }
    return own;
}

/** The project class a declaration's value is an instance of, when its syntax says it. */
function classOfDecl(d) {
    if (!d) return null;
    if (['class', 'object', 'interface', 'enum'].includes(d.kind)) return d.kind === 'object' ? d : null;
    if (d.kind === 'enumMember') return d.container;
    const t = d.type;
    if (!t) return null;
    if (typeof t === 'string') return projectClass(t);
    const c = projectClass(t.constructs);
    if (c) return c;
    const fn = allDecls().find((x) => (x.kind === 'fun' || x.kind === 'method') && x.name === t.constructs);
    return fn?.type && typeof fn.type === 'string' ? projectClass(fn.type) : null;
}

/** The class of a receiver expression ending at `end` (exclusive), in a document: `p`, `this`, `Point(1, 2)`, `a.b`. */
function classOfReceiver(doc, end) {
    const before = doc.text.slice(0, end).replace(/\s+$/, '');
    if (before.endsWith(')')) {
        // A call: find its callee.
        let depth = 0;
        let i = before.length - 1;
        for (; i >= 0; i--) {
            if (before[i] === ')') depth++;
            else if (before[i] === '(' && --depth === 0) break;
        }
        const callee = /([A-Za-z_][\w]*)\s*$/.exec(before.slice(0, i));
        if (!callee) return null;
        const cls = projectClass(callee[1]);
        if (cls) return cls;
        const calleeEnd = i - (before.slice(0, i).length - before.slice(0, i).trimEnd().length);
        const fn = resolveName(doc, callee[1], calleeEnd - callee[1].length, before.slice(0, calleeEnd - callee[1].length).trimEnd().endsWith('.') ? receiverStart(before, calleeEnd - callee[1].length) : null);
        return fn?.type && typeof fn.type === 'string' ? projectClass(fn.type) : null;
    }
    const m = /([A-Za-z_][\w]*)$/.exec(before);
    if (!m) return null;
    const start = before.length - m[1].length;
    if (m[1] === 'this') {
        return doc.decls.filter((x) => ['class', 'object', 'enum'].includes(x.kind) && contains(x.node, start)).sort((a, b) => b.node.startIndex - a.node.startIndex)[0] ?? null;
    }
    const qualified = before.slice(0, start).trimEnd().endsWith('.');
    const d = resolveName(doc, m[1], start, qualified ? receiverStart(before, start) : null);
    return classOfDecl(d) ?? (d || qualified ? null : classFromText(before, m[1]));
}

/**
 * Where a syntax error leaves no tree to read (tree-sitter folds what
 * follows some errors into one ERROR node), the last `val name: Type`,
 * `val name = Type(` or `name: Type` written before the use.
 */
function classFromText(before, name) {
    const re = new RegExp(`\\b${name}\\s*:\\s*([A-Za-z_]\\w*)|\\b(?:val|var)\\s+${name}\\s*=\\s*([A-Za-z_]\\w*)\\s*\\(`, 'g');
    let last = null;
    for (const m of before.matchAll(re)) last = m[1] ?? m[2];
    return last ? projectClass(last) : null;
}
/** For `x.name` with `name` at `start`: the offset just after `x` (before the dot). */
function receiverStart(text, start) {
    const t = text.slice(0, start).trimEnd();
    return t.length - 1;
}

/** The declaration a name at `offset` refers to; `receiverEnd` is set for `receiver.name`. */
function resolveName(doc, name, offset, receiverEnd) {
    if (receiverEnd != null) {
        const cls = classOfReceiver(doc, receiverEnd);
        if (cls) return membersOf(cls).find((m) => m.name === name) ?? null;
        // A receiver of a type the syntax does not say: a member of any project class with that name, if just one.
        const candidates = allDecls().filter((d) => d.container && d.name === name);
        return candidates.length === 1 ? candidates[0] : null;
    }
    return visibleAt(doc, offset).find((d) => d.name === name) ?? null;
}

/** The identifier at an offset, and what it refers to. */
function symbolAt(doc, offset) {
    let node = doc.tree.rootNode.descendantForIndex(offset, offset);
    if (node?.type !== 'identifier' && offset > 0) {
        const left = doc.tree.rootNode.descendantForIndex(offset - 1, offset - 1);
        if (left?.type === 'identifier') node = left;
    }
    if (!node || node.type !== 'identifier') return null;
    const own = doc.decls.find((d) => d.nameNode && d.nameNode.startIndex === node.startIndex && d.nameNode.endIndex === node.endIndex);
    if (own) return { node, decl: own };
    const parent = node.parent;
    let receiverEnd = null;
    if (parent?.type === 'navigation_expression' && parent.namedChild(0)?.id !== node.id) {
        receiverEnd = parent.namedChild(0).endIndex;
    }
    // A type's name (`p: Point`) is a class.
    if (parent?.type === 'user_type' || parent?.type === 'constructor_invocation') {
        return { node, decl: projectClass(node.text) ?? null };
    }
    return { node, decl: resolveName(doc, node.text, node.startIndex, receiverEnd) };
}

const locationOfDecl = (d) => d.nameNode && { uri: d.doc.uri, range: rangeOf(d.doc, d.nameNode.startIndex, d.nameNode.endIndex) };

/** Every identifier in the project that refers to a declaration. */
function referencesTo(decl) {
    const out = [];
    for (const doc of docs.values()) {
        const visit = (n) => {
            if (n.type === 'identifier' && n.text === decl.name) {
                const s = symbolAt(doc, n.startIndex);
                if (s?.decl === decl) out.push({ doc, node: n, decl: decl.nameNode?.startIndex === n.startIndex && decl.doc === doc });
            }
            for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
        };
        visit(doc.tree.rootNode);
    }
    return out;
}

// ---- Diagnostics: syntax errors

function syntaxErrors(doc) {
    const out = [];
    const visit = (n) => {
        if (n.isMissing) {
            out.push({ range: rangeOf(doc, n.startIndex, n.startIndex), severity: 1, source: 'kotlin (syntax)', message: `Syntax error: missing ${n.type === 'identifier' ? 'a name' : JSON.stringify(n.type)}` });
            return;
        }
        if (n.type === 'ERROR') {
            const text = doc.text.slice(n.startIndex, n.endIndex);
            const first = text.trim().split(/\s+/)[0] ?? '';
            out.push({ range: rangeOf(doc, n.startIndex, Math.max(n.endIndex, n.startIndex + 1)), severity: 1, source: 'kotlin (syntax)', message: first ? `Syntax error: unexpected ${JSON.stringify(first.slice(0, 40))}` : 'Syntax error' });
            return;
        }
        if (!n.hasError) return;
        for (let i = 0; i < n.childCount; i++) visit(n.child(i));
    };
    visit(doc.tree.rootNode);
    return out;
}

let timer = 0;
const pending = new Set();
function schedule(uri) {
    pending.add(uri);
    clearTimeout(timer);
    timer = setTimeout(publish, 150);
}
function publish() {
    clearTimeout(timer);
    for (const uri of pending) {
        const doc = docs.get(uri);
        if (doc) send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: doc.version, diagnostics: syntaxErrors(doc) } });
    }
    pending.clear();
}

// ---- Requests

const capabilities = {
    textDocumentSync: { openClose: true, change: 1 },
    completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ['(', ','] },
    definitionProvider: true,
    referencesProvider: true,
    documentHighlightProvider: true,
    documentSymbolProvider: true,
};

class RequestError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const InvalidRequest = -32600;
const InvalidParams = -32602;

function at(p) {
    const uri = p?.textDocument?.uri;
    const line = p?.position?.line;
    const character = p?.position?.character;
    if (typeof uri !== 'string' || !Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0)
        throw new RequestError(InvalidParams, 'expected textDocument.uri and a position { line, character } of non-negative integers');
    const doc = docs.get(uri);
    if (!doc) return null;
    return { uri, doc, offset: offsetOf(doc, line, character) };
}

const KEYWORDS = ('abstract annotation as break by catch class companion const constructor continue crossinline data do else enum expect external ' +
    'false final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator ' +
    'out override package private protected public reified return sealed set super suspend tailrec this throw true try typealias val value var vararg when where while').split(' ');
// The standard library's names a program uses most; their signatures are not known here.
const STDLIB_FUNCTIONS = 'println print readln readLine readlnOrNull listOf mutableListOf arrayListOf emptyList mapOf mutableMapOf hashMapOf emptyMap setOf mutableSetOf emptySet arrayOf intArrayOf doubleArrayOf sequenceOf maxOf minOf require requireNotNull check error repeat lazy buildString buildList run let apply also with takeIf TODO'.split(' ');
const STDLIB_TYPES = 'Any Unit Nothing Int Long Short Byte Double Float Boolean Char String List MutableList Map MutableMap Set MutableSet Array IntArray Pair Triple Sequence Comparable Iterable Collection Exception IllegalArgumentException IllegalStateException'.split(' ');
const ANY_MEMBERS = [['toString', 'fun toString(): String'], ['equals', 'fun equals(other: Any?): Boolean'], ['hashCode', 'fun hashCode(): Int']];

const COMPLETION_KIND = { class: 7, interface: 8, enum: 13, object: 9, fun: 3, method: 2, property: 10, field: 5, variable: 6, enumMember: 20, alias: 7 };
const item = (d, sort) => ({ label: d.name, kind: COMPLETION_KIND[d.kind] ?? 6, detail: d.implicit ? 'it (implicit lambda parameter)' : signatureOf(d.node, d.doc), sortText: `${sort}${d.name}` });

const SYMBOL_KIND = { class: 5, interface: 11, enum: 10, object: 19, fun: 12, method: 6, property: 7, enumMember: 22, alias: 5 };

function documentSymbols(doc) {
    const top = doc.decls.filter((d) => !d.container && !d.scope && d.kind in SYMBOL_KIND);
    const sym = (d) => ({
        name: d.name,
        kind: SYMBOL_KIND[d.kind],
        detail: d.kind === 'class' || d.kind === 'object' ? '' : signatureOf(d.node, d.doc).slice(0, 80),
        range: rangeOf(doc, d.node.startIndex, d.node.endIndex),
        selectionRange: rangeOf(doc, d.nameNode.startIndex, d.nameNode.endIndex),
        ...(d.members?.length ? { children: d.members.filter((m) => m.kind in SYMBOL_KIND).map(sym) } : {}),
    });
    return top.map(sym);
}

/** The call whose argument list the offset is in: callee name, its start, and which argument. */
function callAt(doc, offset) {
    const text = doc.text;
    let depth = 0;
    let commas = 0;
    for (let i = offset - 1; i >= 0 && offset - i < 2000; i--) {
        const c = text[i];
        if (c === ')' || c === ']' || c === '}') depth++;
        else if (c === '[' || c === '{') { if (depth === 0) return null; depth--; }
        else if (c === '(') {
            if (depth === 0) {
                const m = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, i));
                return m ? { name: m[1], start: i - (text.slice(0, i).length - text.slice(0, i).trimEnd().length) - m[1].length, active: commas } : null;
            }
            depth--;
        } else if (c === ',' && depth === 0) commas++;
    }
    return null;
}

function parametersOf(d) {
    if (['class', 'enum'].includes(d.kind)) {
        const ctor = firstOfType(d.node, 'primary_constructor');
        const list = ctor && (firstOfType(ctor, 'class_parameters') ?? ctor);
        return list ? named(list).filter((x) => x.type === 'class_parameter').map((p) => p.text.replace(/\s+/g, ' ').trim()) : [];
    }
    const list = firstOfType(d.node, 'function_value_parameters');
    return list ? named(list).filter((x) => x.type === 'parameter').map((p) => p.text.replace(/\s+/g, ' ').trim()) : null;
}

const requests = {
    initialize: async () => {
        await ready;
        return { capabilities, serverInfo: { name: `tree-sitter-kotlin ${manifest.versions.kotlinGrammar} (syntax only)`, version: manifest.versions.kotlinGrammar } };
    },
    shutdown: async () => { shutDown = true; return null; },
    'textDocument/completion': (p) => {
        const here = at(p);
        if (!here) return null;
        const { doc, offset } = here;
        const before = doc.text.slice(0, offset);
        const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? '';
        const wordStart = offset - word.length;
        const range = rangeOf(doc, wordStart, offset);
        const withRange = (i) => ({ ...i, filterText: i.label, textEdit: { range, newText: i.label } });
        const dot = /\.\s*$/.test(before.slice(0, wordStart)) && !/\.\.\s*$/.test(before.slice(0, wordStart));
        if (dot) {
            const receiverEnd = before.slice(0, wordStart).replace(/\s*\.\s*$/, '').length;
            const cls = classOfReceiver(doc, receiverEnd);
            // A receiver whose class the syntax does not say: nothing, so
            // that the editor falls back to the words of the document.
            if (!cls) return { isIncomplete: false, items: [] };
            const members = membersOf(cls).map((m) => item(m, 0));
            const isData = /\bdata\s+class\b/.test(cls.node.text.slice(0, cls.nameNode.startIndex - cls.node.startIndex));
            const extra = [...ANY_MEMBERS, ...(isData ? [['copy', 'fun copy(...)']] : [])].filter(([n]) => !members.some((m) => m.label === n))
                .map(([label, detail]) => ({ label, kind: 2, detail, sortText: `1${label}` }));
            return { isIncomplete: false, items: [...members, ...extra].map(withRange) };
        }
        const visible = visibleAt(doc, offset).filter((d) => d.nameNode || d.implicit);
        const items = visible.map((d) => item(d, d.scope ? 0 : d.container ? 1 : 2));
        const names = new Set(items.map((i) => i.label));
        for (const k of KEYWORDS) if (!names.has(k)) items.push({ label: k, kind: 14, sortText: `5${k}` });
        for (const f of STDLIB_FUNCTIONS) if (!names.has(f)) items.push({ label: f, kind: 3, detail: 'Kotlin standard library', sortText: `3${f}` });
        for (const t of STDLIB_TYPES) if (!names.has(t)) items.push({ label: t, kind: 7, detail: 'Kotlin standard library', sortText: `4${t}` });
        return { isIncomplete: false, items: items.map(withRange) };
    },
    'completionItem/resolve': (p) => p,
    'textDocument/hover': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here.doc, here.offset);
        if (!s?.decl || s.decl.implicit) return null;
        const d = s.decl;
        const where = d.container ? `\n\n*member of ${d.container.name}*` : d.doc !== here.doc ? `\n\n*in ${pathOf(d.doc.uri)}*` : '';
        const kdoc = kdocOf(d.node);
        return {
            contents: { kind: 'markdown', value: '```kotlin\n' + signatureOf(d.node, d.doc) + '\n```' + (kdoc ? `\n\n${kdoc}` : '') + where },
            range: rangeOf(here.doc, s.node.startIndex, s.node.endIndex),
        };
    },
    'textDocument/signatureHelp': (p) => {
        const here = at(p);
        if (!here) return null;
        const call = callAt(here.doc, here.offset);
        if (!call) return null;
        const recv = here.doc.text.slice(0, call.start).trimEnd();
        const d = recv.endsWith('.') ? resolveName(here.doc, call.name, call.start, recv.length - 1) : (projectClass(call.name) ?? resolveName(here.doc, call.name, call.start, null));
        if (!d) return null;
        const params = parametersOf(d);
        if (!params) return null;
        const label = `${call.name}(${params.join(', ')})` + (d.type && typeof d.type === 'string' ? `: ${d.type}` : '');
        let at2 = call.name.length + 1;
        const parameters = params.map((t) => { const r = [at2, at2 + t.length]; at2 += t.length + 2; return { label: r }; });
        const kdoc = kdocOf(d.node);
        return { signatures: [{ label, parameters, ...(kdoc ? { documentation: { kind: 'markdown', value: kdoc } } : {}) }], activeSignature: 0, activeParameter: Math.min(call.active, Math.max(0, params.length - 1)) };
    },
    'textDocument/definition': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here.doc, here.offset);
        const loc = s?.decl && locationOfDecl(s.decl);
        return loc ? [loc] : [];
    },
    'textDocument/references': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here.doc, here.offset);
        if (!s?.decl || s.decl.implicit) return [];
        const include = !!p.context?.includeDeclaration;
        return referencesTo(s.decl).filter((r) => include || !r.decl).map((r) => ({ uri: r.doc.uri, range: rangeOf(r.doc, r.node.startIndex, r.node.endIndex) }));
    },
    'textDocument/documentHighlight': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here.doc, here.offset);
        if (!s?.decl || s.decl.implicit) return [];
        return referencesTo(s.decl).filter((r) => r.doc === here.doc).map((r) => ({ range: rangeOf(r.doc, r.node.startIndex, r.node.endIndex), kind: r.decl ? 3 : 2 }));
    },
    'textDocument/documentSymbol': (p) => {
        const uri = p?.textDocument?.uri;
        if (typeof uri !== 'string') throw new RequestError(InvalidParams, 'expected textDocument.uri');
        const doc = docs.get(uri);
        return doc ? documentSymbols(doc) : [];
    },
};

// Only Kotlin sources are parsed; the client opens every project file.
const notifications = {
    initialized: () => {},
    exit: () => close(),
    'textDocument/didOpen': (parser, p) => {
        const { uri, version, text } = p.textDocument;
        if (!isKotlin(uri)) return;
        setDoc(parser, uri, version, text);
        schedule(uri);
    },
    'textDocument/didChange': (parser, p) => {
        const text = p.contentChanges.at(-1)?.text;
        const uri = p.textDocument.uri;
        if (text === undefined || !isKotlin(uri)) return;
        setDoc(parser, uri, p.textDocument.version, text);
        schedule(uri);
    },
    'textDocument/didClose': (parser, p) => {
        const uri = p.textDocument.uri;
        const doc = docs.get(uri);
        if (!doc) return;
        doc.tree.delete();
        docs.delete(uri);
        pending.delete(uri);
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
    },
    'workspace/didChangeWatchedFiles': () => {},
};

let chain = Promise.resolve();
let shutDown = false;
self.onmessage = ({ data: msg }) => {
    chain = chain.then(() => handle(msg));
};

async function handle(msg) {
    if (msg.method === undefined) return;
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
        const parser = await ready;
        if (isRequest) {
            const fn = requests[msg.method];
            if (!fn) {
                send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unhandled method ${msg.method}` } });
                return;
            }
            send({ jsonrpc: '2.0', id: msg.id, result: fn(msg.params) ?? null });
        } else {
            notifications[msg.method]?.(parser, msg.params);
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
