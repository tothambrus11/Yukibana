// The compiler-backed half of the language server's answers: what the real
// Swift 6.3.3 type checker said about the project (src/ast.js reads its
// -dump-ast in the type checker's worker), and what the standard library
// offers (swift-stdlib-index.json, built from the 6.3.3 stdlib's symbol
// graph by tools/stdlib-index.mjs, fetched on first use).
//
// The compiler gives types and declarations; it cannot list "what can
// follow this dot" (that is sourcekitd's code completion, which does not
// exist for wasm). So member completion is: the compiler's type for the
// expression before the dot, then that type's members, from the compiler's
// own declarations for the project's types and from the index for library
// types, with the index's generic constraints checked against the actual
// type arguments (`[Point]` has no `sorted()` unless Point is Comparable).
//
// Positions: the AST describes the text it was computed on (a snapshot). The
// user keeps typing, so every lookup maps between the snapshot and the
// current text through their common prefix and suffix (`Mapping`); a
// position inside the edited stretch has no answer from that AST, and the
// caller falls back to swift-syntax-ls.

/** Where the index is served: next to server.js. */
const STDLIB_URL = new URL('./swift-stdlib-index.json', import.meta.url);

let stdlibLoad = null;

/** The standard library index, fetched once (about 110 KB brotli); a failed fetch is tried again on the next call. */
export function stdlib() {
    stdlibLoad ??= fetch(STDLIB_URL)
        .then((r) => {
            if (!r.ok) throw new Error(`swift-stdlib-index.json: HTTP ${r.status}`);
            return r.json();
        })
        .then((j) => new Stdlib(j))
        .catch((e) => {
            stdlibLoad = null; // try again next time
            throw e;
        });
    return stdlibLoad;
}

// ---------------------------------------------------------------- types as the compiler prints them

/** Splits `s` at top-level occurrences of `sep` (outside (), [], <>, and not the `>` of `->`). */
export function splitTop(s, sep) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(' || c === '[' || c === '<') depth++;
        else if (c === ')' || c === ']' || (c === '>' && s[i - 1] !== '-')) depth--;
        else if (depth === 0 && s.startsWith(sep, i)) {
            out.push(s.slice(start, i));
            start = i + sep.length;
            i += sep.length - 1;
        }
    }
    out.push(s.slice(start));
    return out;
}

/** Whether `s[0]` opens a bracket that closes exactly at its last character. */
function wraps(s, open, close) {
    if (s[0] !== open || s[s.length - 1] !== close) return false;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(' || s[i] === '[' || s[i] === '<') depth++;
        else if (s[i] === ')' || s[i] === ']' || (s[i] === '>' && s[i - 1] !== '-')) depth--;
        if (depth === 0 && i < s.length - 1) return false;
    }
    return true;
}

/**
 * A type as the compiler prints it (`[Int]`, `[String : Int]`, `Point?`,
 * `Dictionary<String, Int>.Keys`, `(key: String, value: Int)`,
 * `Point.Type`, `(Int) -> Bool`) as { text, name, args, meta, tuple, fn }.
 * Sugar becomes its nominal type (`[Int]` is Array with args ['Int']).
 * Ownership and lvalue markers are dropped: `@lvalue Int` is Int.
 */
export function parseType(text) {
    let t = (text ?? '').trim().replace(/^(?:@lvalue |inout |__owned |__shared |sending |borrowing |consuming |some |any )+/, '');
    const result = (o) => ({ text: t, name: null, args: [], meta: false, tuple: null, fn: false, ...o });
    if (!t || /<<error type>>|<null>/.test(t)) return result({});
    if (/\.(Type|Protocol)$/.test(t)) {
        const inner = parseType(t.replace(/\.(Type|Protocol)$/, '').replace(/^\((.*)\)$/, '$1'));
        return { ...inner, text: t, meta: true };
    }
    if (splitTop(t, ' -> ').length > 1) return result({ fn: true });
    if (/[?!]$/.test(t)) return result({ name: 'Optional', args: [t.slice(0, -1)] });
    if (wraps(t, '[', ']')) {
        const parts = splitTop(t.slice(1, -1), ' : ');
        return parts.length === 2 ? result({ name: 'Dictionary', args: parts.map((p) => p.trim()) }) : result({ name: 'Array', args: [t.slice(1, -1).trim()] });
    }
    if (wraps(t, '(', ')')) {
        const parts = splitTop(t.slice(1, -1), ', ');
        if (parts.length === 1 && !/^\w+: /.test(parts[0])) return { ...parseType(parts[0]), text: t };
        return result({
            tuple: parts.map((p, i) => {
                const m = /^(\w+): (.*)$/.exec(p);
                return m ? { label: m[1], type: m[2] } : { label: String(i), type: p };
            }),
        });
    }
    // Name<Args>.Nested, Name.Nested, Name
    const lt = t.indexOf('<');
    if (lt > 0) {
        let depth = 0, gt = -1;
        for (let i = lt; i < t.length; i++) {
            if (t[i] === '<') depth++;
            else if (t[i] === '>' && t[i - 1] !== '-' && --depth === 0) { gt = i; break; }
        }
        if (gt > 0) {
            const args = splitTop(t.slice(lt + 1, gt), ', ').map((a) => a.trim());
            return result({ name: t.slice(0, lt) + t.slice(gt + 1), args });
        }
    }
    return result({ name: t });
}

/**
 * The associated types of a library type, from its generic arguments: what
 * `Element`, `Index`, `SubSequence`, ... are for this instance. The index
 * keeps declarations as the stdlib spells them (`Self.Element`); these fill
 * them in for display and decide constraints such as `Element: Comparable`.
 */
function associated(p) {
    const [a = 'Element', b = 'Value'] = p.args;
    switch (p.name) {
        case 'Array': case 'ArraySlice':
            return { Element: a, Index: 'Int', Indices: 'Range<Int>', SubSequence: `ArraySlice<${a}>` };
        case 'Set': return { Element: a, Index: `Set<${a}>.Index`, SubSequence: `Slice<Set<${a}>>` };
        case 'Dictionary':
            return { Key: a, Value: b, Element: `(key: ${a}, value: ${b})`, Index: `Dictionary<${a}, ${b}>.Index`, Keys: `Dictionary<${a}, ${b}>.Keys`, Values: `Dictionary<${a}, ${b}>.Values` };
        case 'Dictionary.Keys': return { Key: a, Value: b, Element: a };
        case 'Dictionary.Values': return { Key: a, Value: b, Element: b };
        case 'String': case 'Substring':
            return { Element: 'Character', Index: 'String.Index', SubSequence: 'Substring' };
        case 'Optional': return { Wrapped: a };
        case 'Range': return { Bound: a, Element: a, Index: a, SubSequence: `Range<${a}>` };
        case 'ClosedRange': return { Bound: a, Element: a };
        case 'Result': return { Success: a, Failure: p.args[1] ?? 'Error' };
        case 'StrideTo': case 'StrideThrough': return { Element: a };
        case 'EnumeratedSequence': return { Base: a, Element: `(offset: Int, element: ${elementOf(a)})` };
        case 'ReversedCollection': case 'Slice': return { Base: a, Element: elementOf(a) };
        case 'Zip2Sequence': return { Element: `(${elementOf(a)}, ${elementOf(p.args[1] ?? '')})` };
        default: return {};
    }
}
const elementOf = (t) => associated(parseType(t)).Element ?? 'Element';

/** A declaration from the index with this type's generic arguments filled in. */
function substitute(text, typeText, env) {
    let out = text.replace(/\bSelf\.(\w+)/g, (all, name) => env[name] ?? all);
    for (const [name, value] of Object.entries(env)) out = out.replace(new RegExp(`(?<![.\\w])${name}\\b(?!:)`, 'g'), value);
    return out.replace(/\bSelf\b(?!\.)/g, typeText);
}

// ---------------------------------------------------------------- the standard library index

const KIND = { m: 2, p: 10, i: 4, M: 2, P: 10, c: 20, s: 2, f: 3 };
const STATIC = new Set(['M', 'P', 'i', 'c']);

class Stdlib {
    constructor(j) {
        this.docs = j.docs;
        this.types = j.types;
        this.globals = j.globals;
        this.closures = new Map();
    }
    /** Every protocol `name` conforms to, directly or through other protocols; null for an unknown type. */
    conformances(name) {
        if (this.closures.has(name)) return this.closures.get(name);
        const t = this.types[name];
        if (!t) return null;
        const set = new Set();
        const visit = (n) => {
            for (const p of this.types[n]?.conforms ?? []) {
                if (set.has(p)) continue;
                set.add(p);
                visit(p);
            }
        };
        visit(name);
        this.closures.set(name, set);
        return set;
    }
    doc(i) { return i >= 0 ? this.docs[i] : ''; }
    /**
     * The members of a library type or protocol. A type's list already
     * includes its protocols' default implementations (tools/stdlib-index.mjs).
     */
    membersOf(name) {
        return this.types[name]?.members ?? [];
    }
    /** A declaration the compiler named (`Swift.(file).Sequence extension.reduce`) as an index entry, or null. */
    lookup(key, refType) {
        const m = /^\w+\.\(file\)\.(.*)$/.exec(key);
        if (!m) return null;
        const path = /^((?:[A-Z]\w*(?: extension)?\.)*)(.+)$/.exec(m[1]);
        const owner = path[1].replace(/ extension/g, '').replace(/\.$/, '');
        let title = path[2];
        // The compiler leaves out labels when every one is `_`: `reduce` is reduce(_:_:).
        const fn = parseType(refType);
        if (!title.includes('(') && fn.fn) {
            const parts = splitTop(refType.replace(/^<[^>]*> /, ''), ' -> ');
            // `(Int, (Int, Int) throws -> Int) throws`: the parameter list without its effects.
            const params = (parts[owner ? 1 : 0] ?? '()').trim().replace(/(?: (?:async|throws|rethrows)(?:\([^)]*\))?)+$/, '');
            const inner = params.replace(/^\((.*)\)$/, '$1');
            const arity = inner ? splitTop(inner, ', ').length : 0;
            title = `${title}(${'_:'.repeat(arity)})`;
        }
        const find = (list) => list.find((x) => x[0] === title) ?? null;
        if (!owner) {
            const g = find(this.globals);
            return g ? { owner: null, row: g } : null;
        }
        const own = find(this.membersOf(owner));
        if (own) return { owner, row: own };
        for (const [name, t] of Object.entries(this.types)) {
            const row = find(t.members);
            if (row) return { owner: name, row };
        }
        return null;
    }
}

/**
 * A library declaration's parameters, from its declaration text:
 * [{ label, type, defaulted, text }], with `rest` (as a property of the
 * array) the text after the parameter list, where the result type is.
 */
function parametersOf(decl, title) {
    const base = title.replace(/\(.*$/, '');
    const none = Object.assign([], { rest: '' });
    let i = decl.indexOf(base);
    if (i < 0) return none;
    i += base.length;
    if (decl[i] === '<') {
        let depth = 0;
        for (; i < decl.length; i++) {
            if (decl[i] === '<') depth++;
            else if (decl[i] === '>' && decl[i - 1] !== '-' && --depth === 0) { i++; break; }
        }
    }
    if (decl[i] === '?') i++;
    if (decl[i] !== '(') return none;
    let depth = 0, end = i;
    for (; end < decl.length; end++) {
        if (decl[end] === '(' || decl[end] === '[') depth++;
        else if ((decl[end] === ')' || decl[end] === ']') && --depth === 0) break;
    }
    const inner = decl.slice(i + 1, end);
    const params = inner.trim() ? splitTop(inner, ', ').map((p) => {
        const text = p.trim();
        const m = /^(?:(\S+) )?(\S+): (.*?)(?: = (.*))?$/.exec(text);
        if (!m) return { label: '_', type: text, defaulted: false, text };
        return { label: m[1] ?? m[2], type: m[3], defaulted: m[4] !== undefined, text };
    }) : [];
    return Object.assign(params, { rest: decl.slice(end + 1) });
}

/** The result type in the text after a parameter list (` rethrows -> [T] where ...`), or ''. */
const resultAfter = (rest) => /^\s*(?:(?:async|throws(?:\([^)]*\))?|rethrows) )*-> (.+?)(?: where .*)?$/.exec(rest)?.[1] ?? '';

/** A completion snippet for a call: `name(label: ${1:Type}, ${2:Type})`, leaving out defaulted parameters. */
function snippet(base, params) {
    const needed = params.filter((p) => !p.defaulted);
    if (!needed.length) return params.length ? `${base}(\${1})` : `${base}()`;
    const esc = (s) => s.replace(/[$}\\]/g, '\\$&');
    return `${base}(${needed.map((p, i) => `${p.label === '_' ? '' : `${p.label}: `}\${${i + 1}:${esc(p.type)}}`).join(', ')})`;
}

// ---------------------------------------------------------------- snapshot <-> current text

/**
 * Maps UTF-16 indices between the text an AST was computed on and the
 * current text, through their common prefix and suffix. Edits are usually
 * one contiguous change, so everything outside it maps; inside it, -1.
 */
export class Mapping {
    constructor(before, after) {
        const max = Math.min(before.length, after.length);
        let p = 0;
        while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
        let s = 0;
        while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
        this.p = p;
        this.beforeTail = before.length - s;
        this.afterTail = after.length - s;
        this.same = before === after;
    }
    toBefore(i) { return this.same || i < this.p ? i : i >= this.afterTail ? i - this.afterTail + this.beforeTail : -1; }
    toAfter(i) { return this.same || i < this.p ? i : i >= this.beforeTail ? i - this.beforeTail + this.afterTail : -1; }
}

const identifierAt = /[\p{L}\p{N}_$]/u;

/** The identifier around UTF-16 index `i` of `text`, as [start, end), or null. */
export function wordAt(text, i) {
    let s = i, e = i;
    while (s > 0 && identifierAt.test(text[s - 1])) s--;
    while (e < text.length && identifierAt.test(text[e])) e++;
    if (s === e) return null;
    if (/^[0-9]/.test(text.slice(s, e))) return null;
    return [s, e];
}

// ---------------------------------------------------------------- the project as the compiler saw it

/**
 * One type checker run's view of the project. `data` is ast.js's
 * { exprs, refs, decls }; `then` maps URIs to the documents (server.js's
 * Doc) the run compiled; `uriOf` turns a workspace path into a URI.
 */
export class Ast {
    constructor(data, then, uriOf) {
        this.then = then;
        this.uriOf = uriOf;
        this.exprs = data.exprs;
        this.decls = data.decls;
        this.refsAt = new Map();
        this.refsTo = new Map(); // "file:line:col" of a project declaration -> its references
        this.refsNamed = new Map(); // the compiler's name of a declaration -> its references
        for (const r of data.refs) {
            const k = `${r.f}:${r.l}:${r.c}`;
            (this.refsAt.get(k) ?? this.refsAt.set(k, []).get(k)).push(r);
            (this.refsNamed.get(r.d) ?? this.refsNamed.set(r.d, []).get(r.d)).push(r);
            if (r.at) {
                const t = r.at.join(':');
                (this.refsTo.get(t) ?? this.refsTo.set(t, []).get(t)).push(r);
            }
        }
        // An implicit memberwise initialiser is placed at its struct's name: the struct wins.
        this.declAt = new Map();
        for (const d of this.decls) {
            const k = `${d.f}:${d.l}:${d.c}`;
            if (!this.declAt.has(k) || this.declAt.get(k).flags.includes('implicit')) this.declAt.set(k, d);
        }
        this.types = new Map();
        for (const d of this.decls) {
            if (!d.members) continue;
            const name = d.n.replace(/<.*$/, '');
            (this.types.get(name) ?? this.types.set(name, []).get(name)).push(d);
        }
        this.mappings = new Map();
    }

    /** The snapshot document of a workspace path, or null. */
    docThen(f) { return this.then.get(this.uriOf(f)) ?? null; }

    /** The mapping from this snapshot's text of `doc.uri` to `doc`'s, or null if the file was not compiled. */
    mapping(doc) {
        const then = this.then.get(doc.uri);
        if (!then) return null;
        let m = this.mappings.get(doc.uri);
        if (!m || m.doc !== doc) {
            m = { doc, map: new Mapping(then.text, doc.text) };
            this.mappings.set(doc.uri, m);
        }
        return m.map;
    }

    /** UTF-16 index in the snapshot text of `f` of a 1-based line and UTF-8 column, or -1. */
    indexThen(f, l, c) {
        const d = this.docThen(f);
        if (!d || l < 1 || l > d.lineStarts.length) return -1;
        const pos = d.position(d.u8[d.lineStarts[l - 1]] + c - 1);
        return d.lineStarts[pos.line] + pos.character;
    }

    /** [line, column] (1-based, UTF-8) in the snapshot of a current document's UTF-16 index, or null. */
    placeThen(doc, i) {
        const map = this.mapping(doc);
        const j = map?.toBefore(i) ?? -1;
        if (j < 0) return null;
        const d = this.then.get(doc.uri);
        const pos = d.position(d.u8[j]);
        return [pos.line + 1, d.u8[j] - d.u8[d.lineStarts[pos.line]] + 1];
    }

    /**
     * The current location of a name written at (f, l, c) in the snapshot,
     * `length` UTF-16 units long, given the current documents; null if that
     * spot was edited since or the file is gone.
     */
    location(docs, f, l, c, length) {
        const uri = this.uriOf(f);
        const now = docs.get(uri);
        const i = this.indexThen(f, l, c);
        if (!now || i < 0) return null;
        const j = this.mapping(now).toAfter(i);
        if (j < 0 || j + length > now.text.length) return null;
        const then = this.then.get(uri);
        if (then.text.slice(i, i + length) !== now.text.slice(j, j + length)) return null;
        const start = now.position(now.u8[j]);
        return { uri, range: { start, end: { line: start.line, character: start.character + length } } };
    }

    /**
     * What the compiler knows about the identifier at UTF-16 index `i` of a
     * current document: { word: [s, e], refs, decl, key } where `refs` are
     * the references written there and `decl` the declaration whose name is
     * there; `key` is "file:line:col" of the declaration they name. Null when
     * that stretch changed since the snapshot.
     */
    at(doc, i) {
        const w = wordAt(doc.text, i);
        if (!w) return null;
        const map = this.mapping(doc);
        const s = map?.toBefore(w[0]) ?? -1;
        if (s < 0 || map.toBefore(w[1] - 1) !== w[1] - 1 - w[0] + s) return null;
        const then = this.then.get(doc.uri);
        if (then.text.slice(s, s + w[1] - w[0]) !== doc.text.slice(w[0], w[1])) return null;
        const place = this.placeThen(doc, w[0]);
        const f = pathOfUri(doc.uri);
        const k = `${f}:${place[0]}:${place[1]}`;
        const refs = this.refsAt.get(k) ?? [];
        const decl = this.declAt.get(k) ?? null;
        const key = decl ? k : refs.find((r) => r.at)?.at.join(':') ?? (this.refsTo.has(k) ? k : null);
        return { word: w, text: doc.text.slice(w[0], w[1]), refs, decl, key, here: k };
    }

    /**
     * The type of the expression spanning [s, last] of a current document
     * (UTF-16; `last` is the start of its last token, as the compiler's
     * ranges end), or null. The outermost such expression wins (the dump is
     * in pre-order), which is the whole `ps[0]` rather than `ps`.
     */
    typeOfSpan(doc, s, last) {
        const a = this.placeThen(doc, s), b = this.placeThen(doc, last);
        if (!a || !b) return null;
        const f = pathOfUri(doc.uri);
        for (const x of this.exprs) {
            if (x.f !== f || x.s[0] !== a[0] || x.s[1] !== a[1] || x.e[0] !== b[0] || x.e[1] !== b[1]) continue;
            const t = parseType(x.t);
            if (t.name || t.tuple) return x.t;
        }
        return null;
    }

    /** The project's declarations of a type (its declaration and extensions), [] if it is not the project's. */
    typeDecls(name) { return this.types.get(name.replace(/^.*\./, '')) ?? []; }
}

const WORKSPACE = 'file:///workspace/';
const pathOfUri = (uri) => decodeURIComponent(uri.slice(WORKSPACE.length));

// ---------------------------------------------------------------- members of a type

/** `<Self where ...> (Self) -> () -> Double` -> `() -> Double`: the type a member has on an instance. */
function memberType(t) {
    const parts = splitTop((t ?? '').replace(/^<[^>]*> /, ''), ' -> ');
    return parts.length > 2 ? parts.slice(1).join(' -> ') : parts.join(' -> ');
}
const resultOf = (t) => splitTop((t ?? '').replace(/^<[^>]*> /, ''), ' -> ').at(-1)?.trim() ?? '';

/** The protocols a project type conforms to, with what they inherit; null when unknown. */
function projectConformances(ast, std, name, seen = new Set()) {
    const out = new Set();
    for (const d of ast.typeDecls(name)) {
        if (d.k === 'enum_decl') ['Equatable', 'Hashable'].forEach((p) => out.add(p)); // cases without payloads
        for (const p of d.inherits ?? []) {
            if (seen.has(p)) continue;
            seen.add(p);
            out.add(p);
            for (const q of std?.conformances(p) ?? []) out.add(q);
            for (const q of projectConformances(ast, std, p, seen)) out.add(q);
            if (d.k === 'enum_decl' && std?.types[p]?.kind === 'struct') out.add('RawRepresentable');
        }
    }
    return out;
}

/** Whether `typeText` conforms to `proto`; true when it cannot be told (a generic parameter). */
function conforms(ast, std, typeText, proto) {
    const p = parseType(typeText);
    if (p.tuple || p.fn) return false;
    if (!p.name) return true;
    if (p.name === proto) return true;
    if (ast?.typeDecls(p.name).length) return projectConformances(ast, std, p.name).has(proto);
    const set = std?.conformances(p.name);
    return set ? set.has(proto) : true;
}

/**
 * Whether a library member's constraints (`Element:Comparable`,
 * `Element==String`, `Element==C.Element`) hold for this instance. A side
 * naming one of the method's own generic parameters (`C.Element`) cannot be
 * decided here and does not exclude the member.
 */
function applies(ast, std, row, typeText, env) {
    const resolve = (side) => {
        if (side === 'Self') return typeText;
        const [head, ...rest] = side.split('.');
        if (!(head in env)) return /^[A-Z]\w*$/.test(side) && !rest.length && (std?.types[side] || ast?.typeDecls(side).length) ? side : null;
        return rest.reduce((t, part) => t && associated(parseType(t))[part], env[head]) ?? null;
    };
    for (const c of row[4] ?? []) {
        const m = /^(.+?)(==|:)(.+)$/.exec(c);
        if (!m) continue;
        const lhs = resolve(m[1]);
        if (!lhs) continue;
        if (m[2] === ':') {
            if (!conforms(ast, std, lhs, m[3])) return false;
        } else {
            const rhs = resolve(m[3]);
            if (rhs && parseType(lhs).text !== parseType(rhs).text) return false;
        }
    }
    return true;
}

/**
 * The completion items after `base.` for a base of type `typeText`:
 * { items, optional } where `optional` means the members of the wrapped
 * type need `?.` (server.js makes that edit). Empty when the type is not
 * one the project declares or the index lists.
 */
export function membersOf(ast, std, typeText) {
    const p = parseType(typeText);
    const items = [];
    const seen = new Set();
    const push = (item) => {
        const key = `${item.label}|${item.labelDetails?.detail ?? ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push(item);
    };
    if (p.tuple) {
        for (const e of p.tuple) push({ label: e.label, kind: 5, detail: e.type, sortText: `0${e.label}` });
        return { items, wrapped: null };
    }
    if (!p.name) return { items, wrapped: null };
    projectMembers(ast, std, p, push, new Set());
    libraryMembers(ast, std, p, push);
    return { items, wrapped: p.name === 'Optional' && !p.meta ? p.args[0] : null };
}

/** Members the project declares for `p` (its type, its extensions, its protocols' extensions). */
function projectMembers(ast, std, p, push, seen) {
    if (!ast || seen.has(p.name)) return;
    seen.add(p.name);
    const decls = ast.typeDecls(p.name);
    for (const t of decls) {
        for (const i of t.members) {
            const d = ast.decls[i];
            const isStatic = d.flags.includes('static') || d.flags.includes('class') || d.k === 'enum_element_decl' || d.k === 'constructor_decl';
            if (d.k === 'subscript_decl' || isStatic !== p.meta) continue;
            if (d.flags.includes('implicit') && /^(init\(from:\)|encode\(to:\)|hash\(into:\)|__derived)/.test(d.n)) continue;
            push(projectItem(d, t.n));
        }
        // Inherited: a superclass's members, a protocol's requirements and extensions.
        for (const parent of t.inherits ?? []) {
            if (ast.typeDecls(parent).length) projectMembers(ast, std, { ...p, name: parent }, push, seen);
            else if (std?.types[parent]?.kind === 'protocol') libraryMembers(ast, std, { ...p, name: parent, viaProtocol: true }, push);
        }
    }
    // Extensions of protocols the type conforms to (`extension Shape { ... }`).
    if (decls.length) {
        for (const proto of projectConformances(ast, std, p.name)) if (!seen.has(proto) && ast.typeDecls(proto).length) projectMembers(ast, std, { ...p, name: proto }, push, seen);
    }
}

/** A completion item for a project declaration; `owner` is the type it is declared in. */
function projectItem(d, owner) {
    const base = d.n.replace(/\(.*$/, '');
    const data = { k: 'project', f: d.f, l: d.l, c: d.c };
    if (d.k === 'var_decl') {
        return { label: base, kind: 10, detail: `${d.flags.includes('let') ? 'let' : 'var'} ${base}: ${d.t}`, labelDetails: { description: d.t }, sortText: `0${base}`, data };
    }
    if (d.k === 'enum_element_decl') {
        const payload = memberType(d.t).includes(' -> ') ? splitTop(memberType(d.t), ' -> ')[0] : '';
        return { label: base, kind: 20, detail: `case ${base}${payload}`, sortText: `0${base}`, data };
    }
    const params = d.params ?? [];
    const result = resultOf(d.t);
    const sig = `(${params.map((x) => (x.label === x.name ? `${x.name}: ${x.type}` : `${x.label} ${x.name}: ${x.type}`)).join(', ')})`;
    if (d.k === 'constructor_decl') {
        return { label: 'init', kind: 4, detail: `init${sig}`, labelDetails: { detail: sig }, insertText: snippet('init', params), insertTextFormat: 2, sortText: `0init`, data };
    }
    return {
        label: base, kind: 2, detail: `func ${base}${sig}${result && result !== '()' ? ` -> ${result}` : ''}`, labelDetails: { detail: sig, ...(result && result !== '()' ? { description: result } : {}) },
        insertText: snippet(base, params), insertTextFormat: 2, sortText: `0${base}`, data, owner,
    };
}

/** Members the index lists for a library type or protocol, checked against `p`'s generic arguments. */
function libraryMembers(ast, std, p, push) {
    if (!std) return;
    const name = std.types[p.name] ? p.name : null;
    const extensionsOf = [];
    if (name) {
        const env = p.viaProtocol ? {} : associated(p);
        const self = p.viaProtocol ? null : p.text;
        for (const row of std.membersOf(name)) {
            if (STATIC.has(row[1]) !== p.meta || row[1] === 's') continue;
            if (self && !applies(ast, std, row, self, env)) continue;
            push(libraryItem(std, row, self ?? 'Self', env));
        }
        extensionsOf.push(name, ...(std.conformances(name) ?? []));
    }
    // The project's own extensions of library types and protocols (`extension Array { ... }`).
    for (const ext of extensionsOf) if (ast?.typeDecls(ext).length) projectMembers(ast, std, { ...p, name: ext }, push, new Set([p.name === ext ? '' : p.name]));
}

/** A completion item for an index row, with the instance's types filled in. */
function libraryItem(std, row, self, env) {
    const [title, kind, rawDecl, doc] = row;
    const decl = substitute(rawDecl, self, env);
    const base = title.replace(/\(.*$/, '');
    const data = { k: 'std', doc };
    if (kind === 'p' || kind === 'P' || kind === 'c') {
        const type = /: ([^{=]+?)(?: \{.*\}| = .*)?$/.exec(decl)?.[1] ?? '';
        return { label: base, kind: KIND[kind], detail: decl, ...(type ? { labelDetails: { description: type } } : {}), sortText: `1${base}`, data };
    }
    const params = parametersOf(decl, title);
    const ret = resultAfter(params.rest);
    const sig = `(${params.map((x) => `${x.label === '_' ? '_' : x.label}: ${x.type}`).join(', ')})`;
    return {
        label: base, kind: KIND[kind] ?? 2, detail: decl, labelDetails: { detail: sig, ...(ret ? { description: ret } : {}) },
        insertText: snippet(base, params), insertTextFormat: 2, sortText: `1${base}`, data,
    };
}

/** Free functions and type names of the standard library, for completion of a plain name. */
export function libraryGlobals(std) {
    const items = [];
    const seen = new Set();
    for (const row of std.globals) {
        const item = libraryItem(std, row, 'Self', {});
        const key = `${item.label}|${item.labelDetails?.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...item, sortText: `2${item.label}` });
    }
    for (const [name, t] of Object.entries(std.types)) {
        if (name.includes('.')) continue;
        items.push({ label: name, kind: t.kind === 'protocol' ? 8 : t.kind === 'enum' ? 13 : 22, detail: t.decl, sortText: `2${name}`, data: { k: 'std', doc: t.doc } });
    }
    return items;
}

// ---------------------------------------------------------------- hover

/** `<Self, Result where ...> Self -> [Int] Result -> Int` -> [['Self', '[Int]'], ['Result', 'Int']]. */
export function substitutions(sub) {
    if (!sub) return [];
    const m = /^<([^>]*?)(?: where [^>]*)?> (.*)$/.exec(sub);
    if (!m) return [];
    const names = m[1].split(',').map((s) => s.trim());
    const out = [];
    let rest = m[2];
    for (let i = 0; i < names.length; i++) {
        if (!rest.startsWith(`${names[i]} -> `)) break;
        rest = rest.slice(names[i].length + 4);
        const next = i + 1 < names.length ? rest.indexOf(` ${names[i + 1]} -> `) : -1;
        out.push([names[i], next >= 0 ? rest.slice(0, next) : rest]);
        rest = next >= 0 ? rest.slice(next + 1) : '';
    }
    return out;
}

/**
 * Markdown for a library declaration the compiler resolved a name to:
 * the declaration (with the use site's generic arguments filled in when the
 * receiver is known), the substitutions, and the doc comment.
 */
export function libraryHover(std, ref) {
    const hit = std.lookup(ref.d, ref.t ?? '');
    if (!hit) return null;
    const [, , decl, doc] = hit.row;
    const subs = substitutions(ref.sub);
    // `Self` is the receiver's type when the compiler names it, else the owner if it is a concrete type.
    const self = subs.find(([n]) => n === 'Self')?.[1] ?? (hit.owner && std.types[hit.owner]?.kind !== 'protocol' ? hit.owner : null);
    const shown = self ? substitute(decl, self, associated(parseType(self))) : decl;
    const context = hit.owner ? `// ${hit.owner}\n` : '';
    const generic = subs.filter(([n]) => n !== 'Self' && !/^τ_/.test(n)).map(([n, t]) => `\`${n}\` = \`${t}\``);
    return `\`\`\`swift\n${context}${shown}\n\`\`\`` + (generic.length ? `\n\n${generic.join(', ')}` : '') + (doc >= 0 ? `\n\n---\n\n${std.doc(doc)}` : '');
}

/** Markdown for a library type named by `word` (a type annotation, which the dump does not locate). */
export function libraryTypeHover(std, word) {
    const t = std.types[word];
    if (!t) return null;
    return `\`\`\`swift\n${t.decl}\n\`\`\`` + (t.doc >= 0 ? `\n\n---\n\n${std.doc(t.doc)}` : '');
}

/** Signatures of the library functions or methods named `base` (on `typeText` when known), for signature help. */
export function librarySignatures(ast, std, base, typeText) {
    const rows = [];
    if (typeText) {
        const p = parseType(typeText);
        const env = associated(p);
        for (const row of std.membersOf(p.name ?? '')) {
            if (row[0].replace(/\(.*$/, '') === base && /[miMf]/.test(row[1]) && applies(ast, std, row, p.text, env)) rows.push([row, substitute(row[2], p.text, env)]);
        }
    } else {
        for (const row of std.globals) if (row[0].replace(/\(.*$/, '') === base) rows.push([row, row[2]]);
    }
    return rows.map(([row, decl]) => ({
        label: decl,
        // Parameter labels must be substrings of the signature's label.
        params: parametersOf(decl, row[0]).map((x) => x.text),
        doc: std.doc(row[3]).split('\n\n')[0],
    }));
}

// ---------------------------------------------------------------- the text around the cursor

const isIdentifier = (c) => c !== undefined && identifierAt.test(c);

/** Index of the bracket opening the one closing at `k` (`)`, `]` or `}`), skipping string literals; -1 if none. */
function openerOf(text, k) {
    const pairs = { ')': '(', ']': '[', '}': '{' };
    const stack = [];
    for (let i = k; i >= 0; i--) {
        const c = text[i];
        if (c === '"') {
            for (i--; i >= 0 && !(text[i] === '"' && text[i - 1] !== '\\'); i--);
            continue;
        }
        if (pairs[c]) stack.push(pairs[c]);
        else if (c === '(' || c === '[' || c === '{') {
            if (stack.pop() !== c) return -1;
            if (!stack.length) return i;
        }
    }
    return -1;
}

/**
 * The expression that ends just before index `end` (exclusive), read
 * backwards as a postfix chain: names, calls, subscripts, trailing closures,
 * `?`/`!`, member accesses, a literal or a parenthesised expression at its
 * head. Returns [start, last] with `last` the start of its last token, which
 * is how the compiler's ranges end; null if there is none.
 */
export function expressionBefore(text, end) {
    let k = end - 1, last = -1;
    for (;;) {
        if (k < 0) return null;
        const c = text[k];
        if (c === ')' || c === ']' || c === '}') {
            const open = openerOf(text, k);
            if (open < 0) return null;
            if (last < 0) last = k;
            let j = open - 1;
            if (c === '}') while (j >= 0 && text[j] === ' ') j--; // a trailing closure: `xs.map { ... }`
            if (j >= 0 && (isIdentifier(text[j]) || ')]}?!'.includes(text[j]))) { k = j; continue; }
            return c === '}' ? null : [open, last];
        }
        if (c === '?' || c === '!') { k--; continue; }
        if (c === '"') {
            let open = k - 1;
            while (open >= 0 && !(text[open] === '"' && text[open - 1] !== '\\')) open--;
            if (open < 0) return null;
            return [open, last < 0 ? open : last];
        }
        if (isIdentifier(c)) {
            let b = k;
            while (b > 0 && isIdentifier(text[b - 1])) b--;
            if (last < 0) last = b;
            if (text[b - 1] === '.' && b >= 2 && (isIdentifier(text[b - 2]) || ')]}?!'.includes(text[b - 2]))) { k = b - 2; continue; }
            return [b, last];
        }
        return null;
    }
}

/**
 * Member completion at UTF-16 index `i`: the cursor is after `base.` and
 * maybe part of a name. Returns { dot, start, last, end, unwrap } where
 * [start, last] is the base (see expressionBefore), `end` where it ends
 * (the `?`, `!` or `.` after it) and `unwrap` whether `?.` or `!.` follows
 * it; null for anything else (a plain name, `.member` with no base, a
 * number's decimal point).
 */
export function memberContext(text, i) {
    let s = i;
    while (s > 0 && isIdentifier(text[s - 1])) s--;
    const dot = s - 1;
    if (text[dot] !== '.') return null;
    let end = dot;
    const unwrap = text[end - 1] === '?' || text[end - 1] === '!';
    if (unwrap) end--;
    if (/[0-9]/.test(text[end - 1] ?? '') && !/[\p{L}_$]/u.test(text.slice(0, end).match(/[\p{L}\p{N}_$]*$/u)[0][0] ?? '')) return null; // `1.5`
    const base = expressionBefore(text, end);
    if (!base) return null;
    return { dot, start: base[0], last: base[1], end, unwrap };
}

/**
 * The call the cursor is in the arguments of: { name, base, active } where
 * `name` is the called name, `base` the receiver as [start, last] or null,
 * and `active` the index of the argument the cursor is in. Null outside a
 * call's parentheses.
 */
export function callContext(text, i) {
    let depth = 0, commas = 0;
    for (let k = i - 1; k >= 0 && i - k < 4000; k--) {
        const c = text[k];
        if (c === '"') {
            for (k--; k >= 0 && !(text[k] === '"' && text[k - 1] !== '\\'); k--);
            continue;
        }
        if (c === ')' || c === ']' || c === '}') depth++;
        else if (c === '[' || c === '{') {
            if (depth === 0) return null;
            depth--;
        } else if (c === '(') {
            if (depth > 0) { depth--; continue; }
            let e = k, b = k;
            while (b > 0 && isIdentifier(text[b - 1])) b--;
            if (b === e) return null;
            const name = text.slice(b, e);
            const base = text[b - 1] === '.' ? expressionBefore(text, text[b - 2] === '?' || text[b - 2] === '!' ? b - 2 : b - 1) : null;
            return { name, base, active: commas };
        } else if (c === ',' && depth === 0) commas++;
    }
    return null;
}
