// Reads `swift-frontend -dump-ast` (the default S-expression format) into
// what the language server needs to answer hover, definition, references,
// inlay hints and member completion from the real type checker:
//
//   exprs  every typed expression the user wrote: its range and its type
//          ("[Int]", "Point?", "(key: String, value: Int)")
//   refs   every reference to a declaration: where it is written, the type
//          it has there, and which declaration it names, as the compiler
//          prints it ("main.(file).total@/workspace/main.swift:3:5",
//          "Swift.(file).Sequence extension.reduce(into:_:)")
//   decls  the declarations in the project's files: name, kind, interface
//          type, where the name is written, parameters, and for a type,
//          its members and what it conforms to
//
// Why the text format: `-dump-ast-format json` exists in 6.3.3, but it
// prints types mangled ("$sSaySiGD"), and the language server would need a
// demangler to show them. The text format prints them as Swift spells them.
// Its layout is not a stable interface ("no format is guaranteed stable
// across different compiler versions"), which is acceptable because the
// compiler is pinned to swift-6.3.3-wasm (build.sh). A different compiler
// version needs this file checked against its dump.
//
// The dump has one node per line, children indented two spaces deeper:
//
//   (declref_expr type="[Int]" location=/workspace/main.swift:16:13
//      range=[/workspace/main.swift:16:13 - line:16:13] decl="main.(file).xs@/workspace/main.swift:11:5" ...)
//
// Positions are 1-based lines and 1-based UTF-8 byte columns. A range's end
// is the *start* of its last token (a SourceRange in the compiler is
// token-based), so `xs.reduce(0, +)` ends at the `)`.
//
// Everything here is positions in the text the compiler saw; server.js
// converts them with the same snapshot's tables.

/** Declarations whose range starts at the name itself. */
const NAMED_AT_START = new Set(['var_decl', 'enum_element_decl', 'param_decl']);
const TYPE_DECLS = new Set(['struct_decl', 'class_decl', 'enum_decl', 'protocol', 'extension_decl', 'actor_decl']);
const MEMBER_DECLS = new Set(['var_decl', 'func_decl', 'constructor_decl', 'enum_element_decl', 'subscript_decl']);

/**
 * Splits the rest of a node's line into its quoted name, its `key=value`
 * attributes and its bare flags (`implicit`, `let`, `static`). Values are
 * quoted strings, bracketed ranges, parenthesised lists or bare words; the
 * line's closing parentheses are not part of the last one.
 */
function attributes(rest) {
    const attrs = {};
    const flags = new Set();
    let name = null;
    let i = 0;
    const n = rest.length;
    const quoted = () => {
        let j = i + 1, out = '';
        while (j < n && rest[j] !== '"') {
            if (rest[j] === '\\' && j + 1 < n) j++;
            out += rest[j++];
        }
        i = j + 1;
        return out;
    };
    const nested = (open, close) => {
        let depth = 0, j = i;
        for (; j < n; j++) {
            if (rest[j] === '"') { // skip a quoted string inside
                for (j++; j < n && rest[j] !== '"'; j++) if (rest[j] === '\\') j++;
            } else if (rest[j] === open) depth++;
            else if (rest[j] === close && --depth === 0) break;
        }
        const out = rest.slice(i + 1, j);
        i = j + 1;
        return out;
    };
    while (i < n) {
        const c = rest[i];
        if (c === ' ' || c === ')' || c === '(') { i++; continue; }
        if (c === '"') {
            const s = quoted();
            name ??= s;
            continue;
        }
        let j = i;
        while (j < n && rest[j] !== ' ' && rest[j] !== '=' && rest[j] !== ')' && rest[j] !== '"') j++;
        const key = rest.slice(i, j);
        if (j < n && rest[j] === '=') {
            i = j + 1;
            const v = rest[i];
            if (v === '"') attrs[key] = quoted();
            else if (v === '[') attrs[key] = nested('[', ']');
            else if (v === '(') attrs[key] = nested('(', ')');
            else {
                let k = i;
                while (k < n && rest[k] !== ' ') k++;
                attrs[key] = rest.slice(i, k).replace(/\)+$/, '');
                i = k;
            }
        } else {
            if (key) flags.add(key);
            i = j > i ? j : i + 1;
        }
    }
    return { name, attrs, flags };
}

/** `/workspace/main.swift:3:5` -> ['main.swift', 3, 5], or null outside the workspace. */
function place(text, root) {
    const m = /^(.*):(\d+):(\d+)$/.exec(text ?? '');
    if (!m || !m[1].startsWith(root)) return null;
    return [m[1].slice(root.length), +m[2], +m[3]];
}

/** `[/w/a.swift:1:2 - line:3:4]` -> [file, l1, c1, l2, c2] (the end is its last token's start). */
function span(text, root) {
    const m = /^(.*):(\d+):(\d+) - (?:line|.*):(\d+):(\d+)$/.exec(text ?? '');
    if (!m || !m[1].startsWith(root)) return null;
    return [m[1].slice(root.length), +m[2], +m[3], +m[4], +m[5]];
}

/**
 * A declaration reference as the compiler prints it, split into the part
 * that names the declaration (`key`, the same for every use, without the
 * generic substitutions) and where it is declared (`at`, for declarations in
 * the project). `with` is the substitution map, e.g.
 * `<Self, Result where ...> Self -> [Int] Result -> Int`, for the hover.
 */
export function declRef(decl, root) {
    const w = decl.indexOf(' [with ');
    const key = w >= 0 ? decl.slice(0, w) : decl;
    const sub = w >= 0 ? /\(substitution_map generic_signature=(.*)\)\]$/.exec(decl.slice(w))?.[1] ?? null : null;
    const m = /@(\/[^@]*):(\d+):(\d+)$/.exec(key);
    return { key, at: m ? place(`${m[1]}:${m[2]}:${m[3]}`, root) : null, sub };
}

/** UTF-16 index in `line` of a 1-based UTF-8 byte column. */
function indexOfColumn(line, col) {
    let bytes = 0, i = 0;
    while (i < line.length && bytes < col - 1) {
        const c = line.charCodeAt(i);
        bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
        i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
    }
    return i;
}
/** 1-based UTF-8 byte column of UTF-16 index `i` in `line`. */
const columnOfIndex = (line, i) => new TextEncoder().encode(line.slice(0, i)).length + 1;

const identifierChar = /[\p{L}\p{N}_$`]/u;

/**
 * Where a declaration's name is written, when its range starts somewhere
 * else (`func`, `struct`, `init`, attributes): the first whole-word
 * occurrence of the base name after the range's start, within the range.
 */
function nameLocation(lines, start, end, name) {
    if (!lines || !name) return null;
    const base = name.replace(/\(.*$/, '');
    for (let l = start[0]; l <= Math.min(end[0], lines.length); l++) {
        const line = lines[l - 1];
        let from = l === start[0] ? indexOfColumn(line, start[1]) : 0;
        for (;;) {
            const i = line.indexOf(base, from);
            if (i < 0) break;
            const before = line[i - 1], after = line[i + base.length];
            const word = /^[\p{L}_]/u.test(base);
            if (!word || ((!before || !identifierChar.test(before)) && (!after || !identifierChar.test(after)))) return [l, columnOfIndex(line, i)];
            from = i + 1;
        }
    }
    return null;
}

/**
 * Parses a dump. `files` maps workspace paths to the texts compiled (for
 * declaration names), `root` is the directory they were written under,
 * with its trailing slash. Returns { exprs, refs, decls } (see above).
 */
export function parseDump(text, files, root = '/workspace/') {
    const lines = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, t.split('\n')]));
    const exprs = [], refs = [], decls = [];
    const seenExpr = new Set(), seenRef = new Set();
    /** The open nodes, by depth: { kind, decl (index into decls) }. */
    const stack = [];

    for (const raw of text.split('\n')) {
        let indent = 0;
        while (raw.charCodeAt(indent) === 32) indent++;
        if (raw[indent] !== '(') continue;
        const m = /^\((?:[\w-]+=)?([\w]+)/.exec(raw.slice(indent));
        if (!m) continue;
        const kind = m[1];
        const depth = indent >> 1;
        stack.length = depth;
        const { name, attrs, flags } = attributes(raw.slice(indent + m[0].length));
        const parent = stack[depth - 1];
        const node = { kind, decl: -1 };
        stack[depth] = node;
        const implicit = flags.has('implicit');

        const range = span(attrs.range, root);
        const loc = place(attrs.location, root);
        if (attrs.type !== undefined && range && !implicit && (kind.endsWith('_expr'))) {
            const key = `${range.join(':')}|${kind}|${attrs.type}`;
            if (!seenExpr.has(key)) {
                seenExpr.add(key);
                exprs.push({ f: range[0], s: [range[1], range[2]], e: [range[3], range[4]], t: attrs.type, k: kind });
            }
        }
        if (attrs.decl !== undefined && loc && !implicit) {
            const key = `${loc.join(':')}|${attrs.decl}`;
            if (!seenRef.has(key)) {
                seenRef.add(key);
                const d = declRef(attrs.decl, root);
                refs.push({ f: loc[0], l: loc[1], c: loc[2], t: attrs.type ?? null, k: kind, d: d.key, at: d.at, sub: d.sub });
            }
        }

        // Declarations in the project's files.
        const isType = TYPE_DECLS.has(kind);
        // An enum's cases are listed twice: inside their enum_case_decl, then as members.
        const caseClause = kind === 'enum_element_decl' && parent?.kind === 'enum_case_decl';
        if ((isType || MEMBER_DECLS.has(kind) || kind === 'typealias') && range && name !== null && !name.startsWith('$') && !caseClause) {
            let at = NAMED_AT_START.has(kind) ? [range[1], range[2]] : null;
            if (!at && kind !== 'extension_decl') at = nameLocation(lines[range[0]], [range[1], range[2]], [range[3], range[4]], kind === 'constructor_decl' ? 'init' : name);
            // A member is a declaration directly inside a type.
            const direct = parent && parent.decl >= 0 && TYPE_DECLS.has(decls[parent.decl].k);
            const d = {
                k: kind, n: name, f: range[0], l: at?.[0] ?? range[1], c: at?.[1] ?? range[2],
                t: attrs.interface_type ?? null,
                flags: [...flags].filter((x) => /^(let|static|class|final|mutating|implicit|throws|async)$/.test(x)),
                ...(attrs.result ? { result: attrs.result } : {}),
                ...(attrs.readImpl ? { computed: attrs.readImpl !== 'stored' } : {}),
                ...(attrs.inherits ? { inherits: attrs.inherits.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
                ...(isType ? { members: [] } : {}),
                owner: direct ? parent.decl : -1,
            };
            node.decl = decls.length;
            decls.push(d);
            if (direct) decls[parent.decl].members.push(node.decl);
        }
        // A function's parameters, with their argument labels, for snippets and signatures.
        if (kind === 'parameter' && parent?.kind === 'parameter_list') {
            const fn = stack[depth - 2];
            if (fn?.decl >= 0 && name !== null) (decls[fn.decl].params ??= []).push({ label: attrs.apiName ?? '_', name, type: attrs.interface_type ?? '' });
        }
    }
    return { exprs, refs, decls };
}
