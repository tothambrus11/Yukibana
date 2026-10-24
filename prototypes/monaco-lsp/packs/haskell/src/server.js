// Yukibana Haskell pack: a language server whose answers come from MicroHs's
// type checker, in a module Web Worker. One JSON-RPC message per
// postMessage, as CONTRACT.md says.
//
// yuki.wasm (build.sh) is MicroHs with an entry point for editors: a check
// request type checks every Haskell file of the project and answers, per
// file, its first error or what the type checker knows: each name used
// (where, what it resolved to and where that is defined, its type) and the
// module's top-level values. Diagnostics, hover, go to definition,
// references, highlights, rename and document symbols are read from that;
// completion asks for the names in scope of the file at its last good check.
// MicroHs stops at a module's first error, so a file shows one error at a
// time, and while it has one the editor answers from its last good check.

import { ROOT, sourceRoots, startYuki, versions, writeProjectFile } from './project.js';

const send = (msg) => postMessage(msg);
const log = (message, type = 3) => send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type, message } });

class RequestError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const InvalidParams = -32602;
const InvalidRequest = -32600;

const PREFIX = 'file:///workspace/';
const pathOf = (uri) => (uri.startsWith(PREFIX) ? decodeURIComponent(uri.slice(PREFIX.length)) : null);
const uriOf = (path) => PREFIX + path.split('/').map(encodeURIComponent).join('/');
const isHaskell = (uri) => /\.hs$/i.test(uri) && pathOf(uri) !== null;
/** The project path of a file in Emscripten's file system, or null for one outside the workspace (a package's). */
const projectPath = (file) => (file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : null);

let yuki = null;
const ready = (async () => {
    const t0 = performance.now();
    const report = (p) => send({ jsonrpc: '2.0', method: 'yukibana/loading', params: p });
    yuki = await startYuki(report, {
        print: (s) => log(s),
        printErr: (s) => log(s, 2),
    });
    yuki._mhs_init();
    const v = await versions();
    log(`MicroHs ${v.microhs} (containers ${v.containers}) loaded in ${Math.round(performance.now() - t0)} ms`);
    return yuki;
})();
ready.catch((e) => log(`failed to start: ${e?.stack ?? e}`, 1));

/** Sends a request to yuki.wasm and parses its JSON answer. */
function ask(lines) {
    const p = yuki.stringToNewUTF8(lines.join('\n'));
    try {
        const r = yuki._yuki_request(p);
        const text = yuki.UTF8ToString(r);
        yuki._free(r);
        const answer = JSON.parse(text);
        if (answer.failure) throw new Error(answer.failure);
        return answer;
    } finally {
        yuki._free(p);
    }
}

// ---- Documents and positions

/** Open documents by project path: { uri, path, version, text, lines }. */
const docs = new Map();

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
}
function lineText(doc, line) {
    if (line < 0 || line >= doc.lines.length) return '';
    const start = doc.lines[line];
    const end = line + 1 < doc.lines.length ? doc.lines[line + 1] - 1 : doc.text.length;
    return doc.text.slice(start, end).replace(/\r$/, '');
}

/**
 * The UTF-16 character of MicroHs's 1-based column on a line: MicroHs
 * counts code points, and a tab moves to the next multiple of 8.
 */
function characterOf(text, col) {
    let c = 1;
    let i = 0;
    while (c < col && i < text.length) {
        const cp = text.codePointAt(i);
        c = cp === 9 ? Math.floor((c - 1) / 8) * 8 + 9 : c + 1;
        i += cp > 0xffff ? 2 : 1;
    }
    return i;
}
/** The 1-based MicroHs column of a UTF-16 character (characterOf's inverse). */
function columnOf(text, character) {
    let c = 1;
    for (let i = 0; i < character && i < text.length; ) {
        const cp = text.codePointAt(i);
        c = cp === 9 ? Math.floor((c - 1) / 8) * 8 + 9 : c + 1;
        i += cp > 0xffff ? 2 : 1;
    }
    return c;
}

const IDENT = /^[A-Za-z_][\w']*/;
const OPERATOR = /^[!#$%&*+./<=>?@\\^|~:\-←-⋿]+/;
/** The length of the name or operator written at a character of a line (0 if none). */
function tokenLength(text, character) {
    const rest = text.slice(character);
    const m = /^(?:[A-Z][\w']*\.)*(?:[A-Za-z_][\w']*|[!#$%&*+./<=>?@\\^|~:\-←-⋿]+)/.exec(rest) ?? IDENT.exec(rest) ?? OPERATOR.exec(rest);
    return m ? m[0].length : 0;
}

// ---- Analysis
//
// Per project path, the last good check: { text, module, uses, tops, scope }.
// A use is { line, character, length, name, resolved, def: { path, line,
// character } | null, type, typeHere, isType } in LSP positions (0-based).

const analyses = new Map();
let generation = 0;

/** A use from yuki's array, if the document still has its name where it says. */
function useOf(doc, a) {
    const [l, c, written, resolved, defFile, defLine, defCol, type, typeHere, mode] = a;
    const text = lineText(doc, l - 1);
    const character = characterOf(text, c);
    const name = written.startsWith('B@.') ? written.slice(3) : written;
    // The type checker also checks code that deriving and desugaring make up,
    // with names no one wrote; only what is written in the file is kept.
    if (!text.startsWith(name, character) || /^\$\d/.test(name)) return null;
    let def = null;
    const defPath = projectPath(defFile);
    if (defPath !== null && defLine > 0) {
        const defDoc = docs.get(defPath);
        const dt = defDoc ? lineText(defDoc, defLine - 1) : '';
        def = { path: defPath, line: defLine - 1, character: characterOf(dt, defCol) };
        if (defDoc) def = equationOf(defDoc, def, name.split('.').pop());
    }
    return {
        line: l - 1,
        character,
        length: name.length,
        name,
        resolved,
        def,
        // A pattern's variable is declared with a type the checker solves
        // later: its type here says more. Variables it never solved print as
        // _a123; they show as _, as GHC's holes do.
        ...(/_a\d+/.test(type) && typeHere && !/_a\d+/.test(typeHere) ? { type: typeHere, typeHere: '' } : { type: type.replace(/_a\d+/g, '_'), typeHere: /_a\d+/.test(typeHere) ? '' : typeHere }),
        isType: mode === 't',
    };
}

function analyse(path, file) {
    const doc = docs.get(path);
    if (!doc) return;
    const uses = [];
    const seen = new Set();
    for (const a of file.uses ?? []) {
        const u = useOf(doc, a);
        if (!u) continue;
        const key = `${u.line}:${u.character}:${u.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uses.push(u);
    }
    const tops = [];
    for (const [name, type, l, c] of file.tops ?? []) {
        const text = lineText(doc, l - 1);
        const at = equationOf(doc, { path, line: l - 1, character: characterOf(text, c) }, name);
        tops.push({ name, type, line: at.line, character: at.character });
    }
    analyses.set(path, { text: doc.text, module: file.module, uses, tops, scope: null, generation });
}

/**
 * Where a top-level value is defined: MicroHs places it at its type
 * signature, and an editor goes to its first equation (`name args = ...`).
 * Anything else (a local, a constructor) is where MicroHs says.
 */
function equationOf(doc, def, name) {
    const text = lineText(doc, def.line);
    if (def.character !== 0 || !isSignatureOf(text, name)) return def;
    for (let l = def.line + 1; l < doc.lines.length; l++) {
        const t = lineText(doc, l);
        if (startsWithName(t, name) && !isSignatureOf(t, name)) return { path: def.path, line: l, character: 0 };
        if (/^\S/.test(t) && !/^--/.test(t) && !startsWithName(t, name)) break;
    }
    return def;
}
const escapeRegExp = (s) => s.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&');
/** Whether a line starts (at column 0) with a name: `name` or `(op)`, then not more of a name. */
function startsWithName(text, name) {
    const n = /^[A-Za-z_]/.test(name) ? name : `(${name})`;
    return text.startsWith(n) && !/^[\w']/.test(text.slice(n.length));
}
/** Whether a line is a type signature that declares a name (`name ::`, `a, name :: ...`). */
function isSignatureOf(text, name) {
    const m = /^([^=]*?)::/.exec(text);
    if (!m || /^\s/.test(text)) return false;
    return m[1].split(',').some((n) => n.trim() === name || n.trim() === `(${name})`);
}

/**
 * The places a top-level value of the project is named that are not uses
 * the type checker saw: its type signature, each equation, the module's
 * export list and the import lists that name it. References and rename add
 * them to the uses.
 */
function declarationSites(s) {
    const name = s.name.split('.').pop();
    const mod = s.def && analyses.get(s.def.path)?.module;
    if (!mod || s.resolved !== `${mod}.${name}`) return [];
    const word = new RegExp(`(?<![\\w'.])${escapeRegExp(name)}(?![\\w'])`, 'g');
    const out = [];
    const defDoc = docs.get(s.def.path);
    for (let l = 0; defDoc && l < defDoc.lines.length; l++) {
        const t = lineText(defDoc, l);
        if (isSignatureOf(t, name)) {
            for (const m of t.slice(0, t.indexOf('::')).matchAll(word)) out.push({ path: s.def.path, line: l, character: m.index, length: name.length });
        } else if (startsWithName(t, name)) out.push({ path: s.def.path, line: l, character: /^[A-Za-z_]/.test(name) ? 0 : 1, length: name.length, isDef: l === s.def.line });
    }
    for (const [path, doc] of docs) {
        if (!path.endsWith('.hs')) continue;
        for (const [from, to] of headerRanges(doc, path === s.def.path ? null : mod)) {
            for (let l = from; l <= to; l++) {
                for (const m of lineText(doc, l).matchAll(word)) out.push({ path, line: l, character: m.index, length: name.length });
            }
        }
    }
    return out;
}

/**
 * The lines of a file's export list (`mod` null) or of its imports of
 * module `mod` that list names: from the keyword to the line that closes
 * the list.
 */
function headerRanges(doc, mod) {
    const ranges = [];
    const head = mod === null ? /^module\s/ : new RegExp(`^import\\s+(?:qualified\\s+)?${escapeRegExp(mod)}(?![\\w.])[^(]*\\(`);
    for (let l = 0; l < doc.lines.length; l++) {
        const t = lineText(doc, l);
        if (!head.test(t) || (mod !== null && /\bhiding\b/.test(t))) continue;
        let depth = 0;
        let end = l;
        for (let k = l; k < doc.lines.length; k++) {
            const u = lineText(doc, k).replace(/--.*$/, '');
            for (const ch of u) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
            end = k;
            if ((mod === null && /\bwhere\b/.test(u)) || (mod !== null && depth <= 0 && u.includes(')'))) break;
        }
        ranges.push([l, end]);
        if (mod === null) break;
    }
    return ranges;
}

/** The key that tells one definition from another: what it resolved to, and where. */
const keyOf = (u) => `${u.resolved}@${u.def ? `${u.def.path}:${u.def.line}:${u.def.character}` : ''}`;

// ---- Diagnostics

/**
 * MicroHs's error, located: `"file": line L, col C: message`. A parse error
 * says what it found and what it expected; the layout's own tokens (`;`, `}`)
 * are named for what they are.
 */
function located(error) {
    const m = /^"([^"]*)": line (\d+), col (\d+):\s*([\s\S]*)$/.exec(error);
    if (!m) return { file: null, line: 0, col: 1, message: error.trim() };
    return { file: m[1], line: Number(m[2]), col: Number(m[3]), message: tidy(m[4].trim()) };
}
function tidy(message) {
    const found = /^found:\s*(.*)\n\s*expected:\s*([\s\S]*)$/.exec(message);
    if (found) {
        const token = found[1].trim();
        const what = token === ';' ? 'the start of a new line at this indentation (layout)' : token === '}' ? 'the end of a block (layout)' : `\`${token}\``;
        const expected = found[2].trim().split(/\s+/).slice(0, 12).join(' ');
        return `Parse error: unexpected ${what}\nexpected one of: ${expected}`;
    }
    return message;
}

function rangeAt(doc, line, col) {
    const l = Math.max(0, Math.min(line - 1, doc.lines.length - 1));
    const text = lineText(doc, l);
    let start = characterOf(text, col);
    if (start >= text.length && l > 0 && line - 1 >= doc.lines.length) start = text.length;
    let length = tokenLength(text, start);
    if (length === 0) {
        // Nothing to underline at the end of a line (an expected but missing
        // token): underline the line's last character.
        if (start >= text.length) start = Math.max(0, text.length - 1);
        length = Math.max(1, Math.min(1, text.length - start));
    }
    return { start: { line: l, character: start }, end: { line: l, character: start + length } };
}

const published = new Map();
function publish(path, diagnostics) {
    const before = published.get(path);
    const now = JSON.stringify(diagnostics);
    if (before === now) return;
    published.set(path, now);
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriOf(path), diagnostics } });
}

function check() {
    const paths = [...docs.keys()].filter((p) => p.endsWith('.hs')).sort();
    if (paths.length === 0) return;
    generation++;
    const t0 = performance.now();
    const roots = rootsOf();
    const answer = ask(['check', ...roots, '--', ...paths.map((p) => `${ROOT}/${p}`)]);
    const errors = new Map(paths.map((p) => [p, []]));
    const seen = new Set();
    for (const file of answer.files) {
        const path = projectPath(file.file);
        if (path === null) continue;
        if (!file.error) {
            analyse(path, file);
            continue;
        }
        const e = located(file.error);
        // An error in a module this one imports is reported once, where it is.
        const at = (e.file && projectPath(e.file)) ?? (e.file ? null : path);
        if (at === null) {
            errors.get(path)?.push({ severity: 1, source: 'MicroHs', message: e.message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
            continue;
        }
        const key = `${at}:${e.line}:${e.col}:${e.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const doc = docs.get(at);
        if (!doc) continue;
        errors.get(at)?.push({ severity: 1, source: 'MicroHs', message: e.message, range: rangeAt(doc, e.line, e.col) });
    }
    for (const [path, diagnostics] of errors) publish(path, diagnostics);
    log(`checked ${paths.length} file(s) in ${Math.round(performance.now() - t0)} ms`);
}

/** The project's source roots, as the runner computes them (project.js). */
function rootsOf() {
    const files = {};
    for (const [path, doc] of docs) files[path] = doc.text;
    return sourceRoots(files);
}

let timer = null;
function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
        chain = chain.then(async () => {
            await ready;
            try {
                check();
            } catch (e) {
                log(`check failed: ${e?.stack ?? e}`, 1);
            }
        });
    }, 250);
}

// ---- Queries

function at(p) {
    const path = pathOf(p?.textDocument?.uri ?? '');
    if (path === null) throw new RequestError(InvalidParams, 'expected a textDocument.uri in the workspace');
    const doc = docs.get(path);
    const analysis = analyses.get(path);
    if (!doc || !analysis) return null;
    return { doc, path, analysis, line: p.position.line, character: p.position.character };
}

/** The use at a position (the innermost, when they nest). */
function useAt(here) {
    let best = null;
    const text = lineText(here.doc, here.line);
    for (const u of here.analysis.uses) {
        if (u.line !== here.line || here.character < u.character || here.character > u.character + u.length) continue;
        // From the last good check: the text may have moved since.
        if (!text.startsWith(u.name, u.character)) continue;
        if (!best || u.length < best.length) best = u;
    }
    return best;
}

/**
 * What is at a position: a use, or the place a name is defined (a top-level
 * value, a local the file uses), presented as a use of itself.
 */
function symbolAt(here) {
    const u = useAt(here);
    if (u) return u;
    const text = lineText(here.doc, here.line);
    for (const t of here.analysis.tops) {
        // On its equation, any of them, or on its signature.
        const onIt = here.character <= t.name.length + (/^[A-Za-z_]/.test(t.name) ? 0 : 2) && (startsWithName(text, t.name) || isSignatureOf(text, t.name) && text.startsWith(t.name));
        if (onIt) {
            const resolved = `${here.analysis.module}.${t.name}`;
            const def = { path: here.path, line: t.line, character: t.character };
            return { line: here.line, character: /^[A-Za-z_]/.test(t.name) ? 0 : 1, length: t.name.length, name: t.name, resolved, def, type: t.type, typeHere: '', isType: false, top: true };
        }
    }
    for (const a of analyses.values()) {
        for (const x of a.uses) {
            const d = x.def;
            if (d && d.path === here.path && d.line === here.line && here.character >= d.character && here.character <= d.character + x.name.length && text.startsWith(x.name, d.character)) {
                return { ...x, line: d.line, character: d.character };
            }
        }
    }
    return null;
}

/** Every place a definition is used or defined, across the project. */
function referencesTo(s) {
    const key = keyOf(s);
    const out = [];
    const seen = new Set();
    const add = (path, line, character, length, isDef) => {
        const k = `${path}:${line}:${character}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ path, line, character, length, isDef });
    };
    if (s.def) add(s.def.path, s.def.line, s.def.character, s.name.split('.').pop().length, true);
    for (const d of declarationSites(s)) add(d.path, d.line, d.character, d.length, !!d.isDef);
    for (const [path, a] of analyses) {
        for (const u of a.uses) if (keyOf(u) === key) {
            const qual = u.name.lastIndexOf('.');
            const short = qual > 0 && /^[A-Z]/.test(u.name) && !/^[A-Z][\w']*$/.test(u.name) ? u.name.slice(qual + 1) : u.name;
            const isDef = !!u.def && u.def.path === path && u.def.line === u.line && u.def.character === u.character;
            add(path, u.line, u.character + (u.name.length - short.length), short.length, isDef);
        }
    }
    return out;
}

/**
 * The Haddock comment (`-- |` and the `--` lines after it) right above a
 * definition in the project, or above its type signature.
 */
function haddockOf(def, name) {
    const doc = def && docs.get(def.path);
    if (!doc) return '';
    let l = def.line - 1;
    const sig = new RegExp(`^\\(?${name.replace(/[^\w']/g, (c) => `\\${c}`)}\\)?\\s*::`);
    // A signature that spans lines: its indented continuation, then its start.
    let k = l;
    while (k >= 0 && /^\s+\S/.test(lineText(doc, k)) && !/^\s*--/.test(lineText(doc, k))) k--;
    if (k >= 0 && sig.test(lineText(doc, k))) l = k - 1;
    const out = [];
    for (; l >= 0; l--) {
        const m = /^\s*--\s?(.*)$/.exec(lineText(doc, l));
        if (!m) break;
        out.unshift(m[1]);
        if (/^\|/.test(m[1])) break;
    }
    if (!out.length || !/^\|/.test(out[0])) return '';
    out[0] = out[0].replace(/^\|\s?/, '');
    return out.join('\n').trim();
}

/** The declaration line of a type in the project (`data Point = ...`), for hovering over the type. */
function declarationOf(def) {
    const doc = def && docs.get(def.path);
    if (!doc) return '';
    let text = lineText(doc, def.line).trim();
    for (let l = def.line + 1; l < doc.lines.length && text.length < 300; l++) {
        const next = lineText(doc, l);
        if (!/^\s/.test(next) || next.trim() === '') break;
        text += `\n${next}`;
    }
    return text;
}

function moduleOf(s) {
    if (s.def) return null;
    const i = s.resolved.lastIndexOf('.', s.resolved.length - s.name.split('.').pop().length - 1);
    if (i <= 0 || !/^[A-Z]/.test(s.resolved)) return null;
    return s.resolved.slice(0, i);
}

const fence = (code) => '```haskell\n' + code + '\n```';

function hoverOf(s) {
    const name = s.name.split('.').pop();
    const shown = /^[A-Za-z_]/.test(name) ? name : `(${name})`;
    const parts = [];
    if (s.isType) {
        const decl = s.def ? declarationOf(s.def) : '';
        parts.push(fence(decl || `${/^[A-Z]/.test(name) ? 'type' : 'type variable'} ${name}${s.type && s.type !== 'Type' ? ` :: ${s.type}` : ''}`));
    } else {
        parts.push(fence(`${shown} :: ${s.type}`));
        if (s.typeHere && s.typeHere !== s.type) parts.push(`Here: \`${s.typeHere}\``);
    }
    const doc = haddockOf(s.def, name);
    if (doc) parts.push(doc);
    const mod = moduleOf(s);
    if (mod) parts.push(`*${mod}*`);
    else if (s.def && s.def.path !== null && !s.top && s.resolved.includes('.')) parts.push(`*Defined in ${s.def.path}*`);
    return parts.join('\n\n');
}

// ---- Completion

const KEYWORDS = ['case', 'class', 'data', 'default', 'deriving', 'do', 'else', 'foreign', 'if', 'import', 'in', 'infix', 'infixl', 'infixr', 'instance', 'let', 'module', 'newtype', 'of', 'qualified', 'then', 'type', 'where', 'as', 'hiding', 'forall'];
const Kind = { Function: 3, Constructor: 4, Variable: 6, Class: 7, Module: 9, Keyword: 14, Struct: 22, TypeParameter: 25 };

function scopeOf(path, analysis) {
    if (analysis.scope) return analysis.scope;
    const answer = ask(['scope', `${ROOT}/${path}`]);
    analysis.scope = answer;
    return answer;
}

function completions(here) {
    const text = lineText(here.doc, here.line).slice(0, here.character);
    const scope = scopeOf(here.path, here.analysis);
    const items = [];
    const seen = new Set();
    const add = (item) => {
        if (seen.has(item.label)) return;
        seen.add(item.label);
        items.push(item);
    };
    const imp = /^\s*import\s+(?:qualified\s+)?([\w.]*)$/.exec(text);
    if (imp) {
        for (const m of scope.modules) add({ label: m, kind: Kind.Module });
        return items;
    }
    const qual = /(?:^|[^\w'.])((?:[A-Z][\w']*\.)+)([\w']*)$/.exec(text);
    if (qual) {
        const prefix = qual[1];
        for (const q of scope.qualified) {
            if (!q.startsWith(prefix)) continue;
            const rest = q.slice(prefix.length);
            if (!rest || rest.includes('.') && /^[A-Z]/.test(rest)) continue;
            add({ label: rest, kind: /^[A-Z]/.test(rest) ? Kind.Constructor : Kind.Function });
        }
        return items;
    }
    for (const [name, type, mod] of scope.values) {
        if (!/^[A-Za-z_]/.test(name)) continue;
        add({ label: name, kind: /^[A-Z]/.test(name) ? Kind.Constructor : type.includes('->') ? Kind.Function : Kind.Variable, detail: type, ...(mod ? { labelDetails: { description: mod } } : {}) });
    }
    // Locals the file binds (parameters, let and where bindings, do binds).
    for (const u of here.analysis.uses) {
        if (u.def && u.def.path === here.path && !u.resolved.includes('.') && /^[a-z_]/.test(u.name) && !u.isType) {
            add({ label: u.name, kind: Kind.Variable, detail: u.typeHere || u.type });
        }
    }
    for (const t of scope.types) if (/^[A-Z]/.test(t)) add({ label: t, kind: Kind.Struct });
    for (const k of KEYWORDS) add({ label: k, kind: Kind.Keyword });
    return items;
}

// ---- Symbols

const SymbolKind = { Module: 2, Class: 5, Function: 12, Variable: 13, Constant: 14, Struct: 23, Interface: 11, TypeParameter: 26 };

function documentSymbols(doc, analysis) {
    const symbols = [];
    const lines = doc.lines.length;
    for (let l = 0; l < lines; l++) {
        const t = lineText(doc, l);
        const m = /^(data|newtype|type|class)\s+(?:family\s+)?(?:[^=]*=>\s*)?([A-Z][\w']*)/.exec(t);
        if (!m) continue;
        const character = t.indexOf(m[2], m[1].length);
        const range = { start: { line: l, character: 0 }, end: { line: l, character: t.length } };
        symbols.push({ name: m[2], detail: m[1], kind: m[1] === 'class' ? SymbolKind.Interface : SymbolKind.Struct, range, selectionRange: { start: { line: l, character }, end: { line: l, character: character + m[2].length } } });
    }
    for (const t of analysis?.tops ?? []) {
        // Constructors and record fields are part of their type's declaration.
        if (/^[A-Z]/.test(t.name)) continue;
        const range = { start: { line: t.line, character: t.character }, end: { line: t.line, character: t.character + t.name.length } };
        symbols.push({ name: t.name, detail: t.type, kind: t.type.includes('->') ? SymbolKind.Function : SymbolKind.Constant, range, selectionRange: range });
    }
    return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
}

const toLocation = (r) => ({ uri: uriOf(r.path), range: { start: { line: r.line, character: r.character }, end: { line: r.line, character: r.character + r.length } } });

function renameTarget(here) {
    const s = symbolAt(here);
    if (!s) throw new RequestError(InvalidParams, 'Nothing to rename here: put the cursor on a name');
    if (!s.def) throw new RequestError(InvalidParams, `\`${s.name}\` is defined in a library${moduleOf(s) ? ` (${moduleOf(s)})` : ''}, not in this project, so it cannot be renamed`);
    return s;
}

const requests = {
    initialize: () => ({
        capabilities: {
            textDocumentSync: { openClose: true, change: 1 },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            documentSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            completionProvider: { triggerCharacters: ['.'] },
        },
        serverInfo: { name: 'MicroHs', version: '0.16.0.0' },
    }),
    shutdown: () => {
        shutDown = true;
        return null;
    },
    'textDocument/hover': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here);
        if (!s) return null;
        return {
            contents: { kind: 'markdown', value: hoverOf(s) },
            range: { start: { line: s.line, character: s.character }, end: { line: s.line, character: s.character + s.length } },
        };
    },
    'textDocument/definition': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here);
        if (!s?.def) return [];
        return [toLocation({ path: s.def.path, line: s.def.line, character: s.def.character, length: s.name.split('.').pop().length })];
    },
    'textDocument/references': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here);
        if (!s) return [];
        const include = !!p.context?.includeDeclaration;
        return referencesTo(s).filter((r) => include || !r.isDef).map(toLocation);
    },
    'textDocument/documentHighlight': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = symbolAt(here);
        if (!s) return [];
        return referencesTo(s).filter((r) => r.path === here.path).map((r) => ({ range: toLocation(r).range, kind: r.isDef ? 3 : 2 }));
    },
    'textDocument/prepareRename': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = renameTarget(here);
        const name = s.name.split('.').pop();
        const start = s.character + s.name.length - name.length;
        return { range: { start: { line: s.line, character: start }, end: { line: s.line, character: start + name.length } }, placeholder: name };
    },
    'textDocument/rename': (p) => {
        const here = at(p);
        if (!here) return null;
        const s = renameTarget(here);
        const old = s.name.split('.').pop();
        const newName = typeof p.newName === 'string' ? p.newName.trim() : '';
        const ok = /^[A-Z]/.test(old) ? /^[A-Z][\w']*$/.test(newName) : /^[a-z_]/.test(old) ? /^[a-z_][\w']*$/.test(newName) && !KEYWORDS.includes(newName) : /^[!#$%&*+./<=>?@\\^|~:-]+$/.test(newName);
        if (!ok) throw new RequestError(InvalidParams, `${JSON.stringify(newName)} cannot replace \`${old}\`: ${/^[A-Z]/.test(old) ? 'a constructor or type starts with a capital letter' : /^[a-z_]/.test(old) ? 'a variable starts with a lowercase letter or _ (and is not a keyword)' : 'an operator is made of symbols'}`);
        const changes = {};
        for (const r of referencesTo(s)) (changes[uriOf(r.path)] ??= []).push({ range: toLocation(r).range, newText: newName });
        return { changes };
    },
    'textDocument/documentSymbol': (p) => {
        const path = pathOf(p?.textDocument?.uri ?? '');
        const doc = path !== null ? docs.get(path) : null;
        return doc ? documentSymbols(doc, analyses.get(path)) : [];
    },
    'textDocument/completion': (p) => {
        const path = pathOf(p?.textDocument?.uri ?? '');
        const doc = path !== null ? docs.get(path) : null;
        if (!doc) return [];
        const analysis = analyses.get(path) ?? { uses: [], tops: [], scope: null };
        const items = completions({ doc, path, analysis, line: p.position.line, character: p.position.character });
        return { isIncomplete: false, items };
    },
};

const notifications = {
    initialized: () => {},
    exit: () => close(),
    'textDocument/didOpen': (p) => {
        const { uri, version, text } = p.textDocument;
        const path = pathOf(uri);
        if (path === null) return;
        docs.set(path, { uri, path, version, text, lines: lineStarts(text) });
        writeProjectFile(yuki, path, text);
        if (isHaskell(uri)) schedule();
    },
    'textDocument/didChange': (p) => {
        const text = p.contentChanges.at(-1)?.text;
        const path = pathOf(p.textDocument.uri);
        if (text === undefined || path === null) return;
        docs.set(path, { uri: p.textDocument.uri, path, version: p.textDocument.version, text, lines: lineStarts(text) });
        writeProjectFile(yuki, path, text);
        if (isHaskell(p.textDocument.uri)) schedule();
    },
    'textDocument/didClose': (p) => {
        const path = pathOf(p.textDocument.uri);
        if (path === null || !docs.has(path)) return;
        docs.delete(path);
        analyses.delete(path);
        try {
            yuki.FS.unlink(`${ROOT}/${path}`);
        } catch {
            // already gone
        }
        published.delete(path);
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: p.textDocument.uri, diagnostics: [] } });
        schedule();
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
        if (msg.method === 'initialize') await ready;
        if (msg.method === 'initialize' || msg.method === 'shutdown' || msg.method === 'exit') {
            const r = await (requests[msg.method] ?? notifications[msg.method])();
            if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result: r });
            return;
        }
        await ready;
        if (isRequest) {
            const fn = requests[msg.method];
            if (!fn) {
                send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unhandled method ${msg.method}` } });
                return;
            }
            send({ jsonrpc: '2.0', id: msg.id, result: fn(msg.params) ?? null });
        } else {
            notifications[msg.method]?.(msg.params);
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
