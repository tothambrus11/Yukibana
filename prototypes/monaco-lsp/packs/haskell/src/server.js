// Yukibana Haskell pack: a language server whose answers come from GHC 9.14
// itself, through the GHC API, in a module Web Worker. One JSON-RPC message
// per postMessage, as CONTRACT.md says.
//
// libyuki.so (ghc/Yuki.hs) runs GHC in an editor session: a check type
// checks the whole project as `ghc -fno-code` would, with the flags a
// cabal build of the downloaded project uses (-Wall, GHC2021), and answers
// GHC's diagnostics as GHC's own JSON (-fdiagnostics-as-json). Type errors
// are deferred while checking (-fdefer-type-errors, as HLS does), so every
// error of a module is reported, not the first, and the module still has a
// .hie file: GHC's record of every name in it, where it is bound and its
// type. Hover, definition, references, highlights and rename read the .hie
// files; completion asks GHC's renamer what is in scope. Quick fixes come
// from GHC's messages and hints, as ghcide's code actions do.

import { checkGroups, manifestOf, ROOT, sourceRoots, startGhc } from './ghc.js';
import { hlint, ormolu } from './tools.js';

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
/** The project path of a file in GHC's file system, or null for one outside the workspace (a library's). */
const projectPath = (file) => (typeof file === 'string' && file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : null);

let ghc = null;
const ready = (async () => {
    const t0 = performance.now();
    const report = (p) => send({ jsonrpc: '2.0', method: 'yukibana/loading', params: p });
    ghc = await startGhc({ mode: 'editor', report, log: (s) => log(s), flags: ['-Wall'] });
    log(`GHC ${ghc.versions.ghc} started in ${Math.round(performance.now() - t0)} ms (unpacked ${ghc.timings.unpacked} ms, linked ${ghc.timings.linked} ms)`);
    return ghc;
})();
ready.catch((e) => log(`failed to start: ${e?.stack ?? e}`, 1));

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
 * The UTF-16 character of GHC's 1-based column on a line: GHC counts code
 * points, and a tab moves to the next multiple of 8 (GHC's lexer,
 * advance_tabstop).
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
/** The 1-based GHC column of a UTF-16 character (characterOf's inverse). */
function columnOf(text, character) {
    let c = 1;
    for (let i = 0; i < character && i < text.length; ) {
        const cp = text.codePointAt(i);
        c = cp === 9 ? Math.floor((c - 1) / 8) * 8 + 9 : c + 1;
        i += cp > 0xffff ? 2 : 1;
    }
    return c;
}

/** An LSP range for a GHC span ({file, sl, sc, el, ec}, end exclusive) in a document. */
function rangeOf(doc, s) {
    const sl = Math.max(0, s.sl - 1);
    const el = Math.max(sl, s.el - 1);
    return {
        start: { line: sl, character: characterOf(lineText(doc, sl), s.sc) },
        end: { line: el, character: characterOf(lineText(doc, el), s.ec) },
    };
}

// ---- Checking

/**
 * Per project path, what the last check that type checked the file said:
 * { module, tops } (its top-level declarations), and whether GHC has a
 * .hie file for it (`hie`). A file that did not parse keeps the last one.
 */
const analyses = new Map();
let generation = 0;

const published = new Map();
function publish(path, diagnostics) {
    const before = published.get(path);
    const now = JSON.stringify(diagnostics);
    if (before === now) return;
    published.set(path, now);
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriOf(path), diagnostics } });
}

/**
 * Warnings that are type errors GHC deferred to keep checking (and to
 * write the .hie file): shown as the errors they are, as HLS does.
 */
const DEFERRED = new Set(['deferred-type-errors', 'deferred-out-of-scope-variables', 'typed-holes']);
const UNNECESSARY = /^unused-|^redundant-/;

/**
 * An LSP diagnostic from one of GHC's JSON diagnostics: GHC's message (its
 * bullets on lines of their own, "•" as GHC prints them), its error code
 * linked to the Haskell Error Index, the warning's flag as GHC appends it,
 * and GHC's hints (kept in `data` for quick fixes).
 */
function diagnosticOf(doc, d) {
    const flags = (d.reason?.flags ?? []).filter((f) => typeof f === 'string');
    const deferred = flags.some((f) => DEFERRED.has(f));
    const error = d.severity === 'Error' || deferred;
    const parts = (d.message ?? []).map((m) => String(m).replace(/\s+$/, ''));
    let message = parts.length > 1 ? parts.map((m) => `• ${m.replace(/\n/g, '\n  ')}`).join('\n') : (parts[0] ?? '');
    if (!error && flags.length) message += `\n[-W${flags.join(', -W')}]`;
    const hints = (d.hints ?? []).map(String);
    if (hints.length) message += `\nSuggested fix${hints.length > 1 ? 'es' : ''}:\n${hints.map((h) => `  • ${h.replace(/\n/g, '\n    ')}`).join('\n')}`;
    const out = {
        severity: error ? 1 : 2,
        source: 'GHC',
        message,
        range: rangeOf(doc, d.span),
        data: { message: parts.join('\n'), hints, flags },
    };
    if (d.code) {
        out.code = `GHC-${String(d.code).padStart(5, '0')}`;
        out.codeDescription = { href: `https://errors.haskell.org/messages/${out.code}/` };
    }
    const tags = [];
    if (!error && flags.some((f) => UNNECESSARY.test(f))) tags.push(1);
    if (flags.some((f) => /deprecat/.test(f))) tags.push(2);
    if (tags.length) out.tags = tags;
    return out;
}

async function check() {
    const files = {};
    for (const [path, doc] of docs) files[path] = doc.text;
    const groups = checkGroups(files);
    if (groups.length === 0) return;
    generation++;
    const t0 = performance.now();
    const roots = sourceRoots(files);
    const answer = await ghc.request(['check', ...roots.map((r) => `-i${r}`), '==', ...groups.map((g) => g.join('\t'))]);
    const byPath = new Map([...docs.keys()].filter((p) => p.endsWith('.hs')).map((p) => [p, []]));
    const seen = new Set();
    for (const d of answer.diagnostics) {
        const path = projectPath(d.span?.file);
        const doc = path !== null ? docs.get(path) : null;
        if (!doc) {
            // A driver error with no place in a file (a cycle, a missing
            // module given on the command line): shown on every file.
            if (!d.span && d.message) for (const [p, list] of byPath) list.push(diagnosticOf(docs.get(p), { ...d, span: { sl: 1, sc: 1, el: 1, ec: 1 } }));
            continue;
        }
        const s = d.span;
        const key = `${path}:${s.start?.line}:${s.start?.column}:${d.code}:${(d.message ?? []).join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const span = { sl: s.start.line, sc: s.start.column, el: s.end.line, ec: s.end.column };
        byPath.get(path)?.push(diagnosticOf(doc, { ...d, span }));
    }
    for (const m of answer.modules) {
        const path = projectPath(m.file);
        if (path === null) continue;
        if (m.hie || !analyses.has(path)) analyses.set(path, { module: m.module, tops: m.tops, generation, scope: null });
    }
    for (const [path, list] of byPath) {
        ghcDiagnostics.set(path, list);
        publishFile(path);
    }
    log(`checked ${byPath.size} file(s) in ${Math.round(performance.now() - t0)} ms`);
    void lint();
}

/** GHC's diagnostics of each file at its last check. */
const ghcDiagnostics = new Map();
/** hlint's diagnostics of each file, with the text they are of: { text, list }. */
const hlintDiagnostics = new Map();

/**
 * Publishes a file's diagnostics: GHC's, and hlint's when they are of the
 * file as it is now (an edit makes them wait for the next lint, not move
 * about), in order of position.
 */
function publishFile(path) {
    const doc = docs.get(path);
    const h = hlintDiagnostics.get(path);
    const list = [...(ghcDiagnostics.get(path) ?? []), ...(h && doc && h.text === doc.text ? h.list : [])];
    publish(path, list.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character));
}

/** Whether the pack has ormolu and hlint (their CI build, ghc/build-tools.sh, may be missing). */
const toolsReady = manifestOf().then((m) => ({ ormolu: 'ormolu.wasm' in m.files, hlint: 'hlint.wasm' in m.files && 'hlint-data.json' in m.files }));

let linting = null;
let lintAgain = false;
/**
 * Runs hlint over the open Haskell files, as `hlint .` would, after each
 * check: one run at a time, the last request run once the current is done.
 * Its suggestions and warnings are diagnostics of their own (source
 * "hlint", the hint's name as code); a parse error is GHC's to report.
 */
async function lint() {
    if (!(await toolsReady).hlint) return;
    if (linting) {
        lintAgain = true;
        return;
    }
    linting = (async () => {
        do {
            lintAgain = false;
            const files = {};
            for (const [path, doc] of docs) if (path.endsWith('.hs')) files[path] = doc.text;
            const t0 = performance.now();
            try {
                const ideas = await hlint(files);
                const byPath = new Map(Object.keys(files).map((p) => [p, []]));
                for (const idea of ideas) {
                    const doc = docs.get(idea.file);
                    if (!doc || files[idea.file] !== doc.text || idea.severity === 'Error' || idea.severity === 'Ignore') continue;
                    byPath.get(idea.file)?.push(hlintDiagnostic(doc, idea));
                }
                for (const [path, list] of byPath) {
                    hlintDiagnostics.set(path, { text: files[path], list });
                    publishFile(path);
                }
                log(`hlint: ${ideas.length} idea(s) in ${Math.round(performance.now() - t0)} ms`);
            } catch (e) {
                log(`hlint failed: ${e?.message ?? e}`, 2);
            }
        } while (lintAgain);
        linting = null;
    })();
}

/** An LSP diagnostic from one of hlint's ideas, worded as hlint prints it. */
function hlintDiagnostic(doc, idea) {
    const lines = [idea.hint];
    if (idea.from) lines.push(`Found:\n  ${idea.from.replace(/\n/g, '\n  ')}`);
    if (idea.to !== null && idea.to !== undefined) lines.push(idea.to ? `Why not:\n  ${idea.to.replace(/\n/g, '\n  ')}` : 'Why not: remove it');
    for (const n of idea.note ?? []) lines.push(`Note: ${n}`);
    return {
        severity: idea.severity === 'Warning' ? 2 : 3,
        source: 'hlint',
        code: idea.hint,
        message: lines.join('\n'),
        range: rangeOf(doc, { sl: idea.startLine, sc: idea.startColumn, el: idea.endLine, ec: idea.endColumn }),
        data: { hlint: { hint: idea.hint, to: idea.to ?? null } },
    };
}

let timer = null;
function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
        chain = chain.then(async () => {
            await ready;
            try {
                await check();
            } catch (e) {
                log(`check failed: ${e?.stack ?? e}`, 1);
            }
        });
    }, 250);
}

// ---- Queries

/** A position's document and GHC coordinates, or null for a file GHC has not seen. */
function at(p) {
    const path = pathOf(p?.textDocument?.uri ?? '');
    if (path === null) throw new RequestError(InvalidParams, 'expected a textDocument.uri in the workspace');
    const doc = docs.get(path);
    if (!doc || !analyses.has(path)) return null;
    const line = p.position.line;
    return { doc, path, line: line + 1, col: columnOf(lineText(doc, line), p.position.character) };
}

const ask = (kind, here) => ghc.request([kind, `${ROOT}/${here.path}`, String(here.line), String(here.col)]);

const fence = (code) => '```haskell\n' + code + '\n```';

/**
 * Hover text as HLS shows it: the name with its type at this use, its
 * general type or declaration when that says more, its Haddock comment,
 * and where it is defined (a project file and line, or a library module
 * and package).
 */
function hoverOf(info) {
    const parts = [];
    const name = /^[A-Za-z_]/.test(info.name ?? '') ? info.name : `(${info.name})`;
    if (info.kind === 'module') return fence(`module ${info.name}`);
    if (info.type && info.kind !== 'data' && info.kind !== 'newtype' && info.kind !== 'class' && info.kind !== 'synonym' && info.kind !== 'family' && info.kind !== 'type' && info.kind !== 'tyvar') parts.push(fence(`${name} :: ${info.type}`));
    // A type's declaration as GHC prints it starts with its kind
    // signature (`type Point :: *`), which says nothing for a plain type.
    const decl = info.decl?.replace(/^type \S+ :: (\*|Type)\n/, '');
    if (decl && !(parts.length && decl.replace(/\s+/g, ' ') === `${name} :: ${info.type}`.replace(/\s+/g, ' '))) parts.push(fence(decl));
    if (!parts.length) parts.push(fence(info.type ? `${name} :: ${info.type}` : name));
    if (info.doc) parts.push(haddock(info.doc));
    const defPath = info.def ? projectPath(info.def.file) : null;
    if (defPath) parts.push(`*Defined at ${defPath}:${info.def.sl}:${info.def.sc}*`);
    else if (info.module) parts.push(`*Defined in ‘${info.module}’*${info.package ? ` *(${info.package.replace(/-[0-9a-f]{20,}$/, '').replace(/-inplace$/, '')})*` : ''}`);
    return parts.join('\n\n');
}

/**
 * Haddock markup as Markdown, roughly as HLS shows it: `@code@` and
 * 'identifiers' in backticks (an identifier inside code loses its quotes),
 * "Module" names too, `= Heading` lines as headings, `__bold__` as bold,
 * and each `>>>` example with the lines of its result as a code block.
 */
function haddock(text) {
    const code = [];
    // Code first, kept aside, so the quotes of identifiers inside it go and nothing else touches it.
    const hold = (s) => `\u0000${code.push(s) - 1}\u0000`;
    return text
        .split('\n')
        .map((l) => l.replace(/^ /, ''))
        .join('\n')
        .replace(/^>>> [^\n]*(?:\n(?!>>> )[^\n]+)*/gm, (ex) => hold('```haskell\n' + ex + '\n```'))
        .replace(/@([^@\n]+)@/g, (_, c) => hold('`' + c.replace(/'([^'\s]+)'/g, '$1') + '`'))
        .replace(/'([A-Za-z_][\w'.]*)'/g, '`$1`')
        .replace(/"([A-Z][\w.]*)"/g, '`$1`')
        .replace(/^(=+) +(.*)$/gm, (_, level, title) => `${'#'.repeat(Math.min(level.length + 2, 6))} ${title}`)
        .replace(/__([^_\n]+)__/g, '**$1**')
        .replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)])
        .trim();
}

const toLocation = (s) => {
    const path = projectPath(s.file);
    const doc = path !== null ? docs.get(path) : null;
    return doc ? { uri: uriOf(path), range: rangeOf(doc, s) } : null;
};

async function referencesAt(here) {
    const list = await ask('refs', here);
    const seen = new Set();
    const out = [];
    for (const r of list) {
        const loc = toLocation(r.span);
        if (!loc) continue;
        const k = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ...loc, isDef: r.def });
    }
    return out;
}

// ---- Completion

const KEYWORDS = ['case', 'class', 'data', 'default', 'deriving', 'do', 'else', 'foreign', 'if', 'import', 'in', 'infix', 'infixl', 'infixr', 'instance', 'let', 'module', 'newtype', 'of', 'qualified', 'then', 'type', 'where', 'as', 'hiding', 'forall', 'mdo', 'proc', 'rec'];
const Kind = { Function: 3, Constructor: 4, Field: 5, Variable: 6, Class: 7, Interface: 8, Module: 9, Keyword: 14, Struct: 22, TypeParameter: 25 };

function kindOf(n) {
    switch (n.kind) {
        case 'constructor':
            return Kind.Constructor;
        case 'class':
            return Kind.Interface;
        case 'data':
        case 'newtype':
        case 'family':
            return Kind.Struct;
        case 'synonym':
            return Kind.TypeParameter;
        default:
            return n.type && n.type.includes('->') ? Kind.Function : Kind.Variable;
    }
}

/** A name's type from its declaration (`name :: type`), as completion's detail shows it. */
const detailOf = (n) => (n.type ? n.type.replace(/^\(?[^\s]+?\)?\s*::\s*/, '').replace(/\s+/g, ' ') : undefined);

async function completions(doc, path, line, character) {
    const text = lineText(doc, line).slice(0, character);
    const scope = await ghc.request(['scope', `${ROOT}/${path}`, String(line + 1), String(columnOf(lineText(doc, line), character))]);
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
        const q = qual[1].slice(0, -1);
        for (const n of scope.names) if (n.quals.includes(q)) add({ label: n.name, kind: kindOf(n), detail: detailOf(n), ...(n.module ? { labelDetails: { description: n.module } } : {}) });
        return items;
    }
    for (const l of scope.locals) add({ label: l.name, kind: Kind.Variable, detail: l.type || undefined, sortText: `0${l.name}` });
    for (const n of scope.names) {
        if (!n.unqual || !/^[A-Za-z_]/.test(n.name)) continue;
        add({ label: n.name, kind: kindOf(n), detail: detailOf(n), sortText: `${n.module ? 2 : 1}${n.name}`, ...(n.module ? { labelDetails: { description: n.module } } : {}) });
    }
    for (const k of KEYWORDS) add({ label: k, kind: Kind.Keyword, sortText: `3${k}` });
    return items;
}

// ---- Symbols

const SymbolKind = { Class: 5, Constructor: 9, Interface: 11, Function: 12, Variable: 13, Constant: 14, Struct: 23, TypeParameter: 26, Field: 8 };

function documentSymbols(doc, analysis) {
    const symbols = [];
    for (const t of analysis?.tops ?? []) {
        const range = rangeOf(doc, t.span);
        const kind =
            t.kind === 'class' ? SymbolKind.Interface
            : t.kind === 'constructor' ? SymbolKind.Constructor
            : t.kind === 'synonym' || t.kind === 'family' ? SymbolKind.TypeParameter
            : t.kind === 'data' || t.kind === 'newtype' ? SymbolKind.Struct
            : /->/.test(t.type) ? SymbolKind.Function
            : SymbolKind.Constant;
        symbols.push({ name: t.name, detail: detailOf(t) ?? t.type, kind, range, selectionRange: range });
    }
    return symbols.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

// ---- Quick fixes from GHC's messages and hints (as ghcide's code actions)

/** The names a message or hint quotes, in GHC's ‘quotes’. */
const quoted = (s) => [...s.matchAll(/‘([^’]+)’/g)].map((m) => m[1]);

function codeActions(doc, uri, diagnostics) {
    const actions = [];
    const edit = (title, d, edits, preferred = false) =>
        actions.push({ title, kind: 'quickfix', diagnostics: [d], isPreferred: preferred, edit: { changes: { [uri]: edits } } });
    for (const d of diagnostics) {
        const data = d.data ?? {};
        // hlint's: its replacement, as `hlint --refactor` applies it, and
        // turning the hint off for the module, as HLS offers.
        if (data.hlint) {
            if (data.hlint.to !== null) edit(`Apply hint: ${data.hlint.hint}`, d, [{ range: d.range, newText: data.hlint.to }], true);
            edit(`Ignore hint “${data.hlint.hint}” in this module`, d, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `{- HLINT ignore "${data.hlint.hint}" -}\n` }]);
            continue;
        }
        const message = data.message ?? d.message ?? '';
        const hints = data.hints ?? [];
        const flags = data.flags ?? [];
        const r = d.range;
        const written = lineText(doc, r.start.line).slice(r.start.character, r.start.line === r.end.line ? r.end.character : undefined);
        // "Perhaps use ‘x’" / "Perhaps use one of these: ‘a’ (...), ‘b’ (...)"
        for (const h of hints) {
            if (/^Perhaps use/.test(h) || /^Perhaps you meant/.test(h)) {
                for (const name of quoted(h).filter((n) => n !== written).slice(0, 6)) edit(`Replace with ‘${name}’`, d, [{ range: r, newText: /^[A-Za-z_]/.test(name) || !/^[A-Za-z_(]/.test(written) ? name : `(${name})` }], true);
            }
            const ext = /(?:Perhaps you intended to use|Enable any of the following extensions:|Use)\s+([A-Z][A-Za-z]+(?:,\s*[A-Z][A-Za-z]+)*)/.exec(h);
            if (ext && /extension|intended to use/.test(h)) {
                for (const e of ext[1].split(/,\s*/)) edit(`Add {-# LANGUAGE ${e} #-}`, d, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `{-# LANGUAGE ${e} #-}\n` }]);
            }
        }
        // -Wmissing-signatures: "Top-level binding with no type signature: f :: Int -> Int"
        const sig = /Top-level binding with no type signature:\s*([\s\S]+)$/.exec(message);
        if (sig) {
            const line = r.start.line;
            const indent = /^\s*/.exec(lineText(doc, line))[0];
            edit(`Add type signature: ${sig[1].trim().replace(/\s+/g, ' ')}`, d, [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText: `${indent}${sig[1].trim().replace(/\n\s*/g, '\n' + indent + '  ')}\n` }], true);
        }
        // -Wunused-matches / -Wunused-local-binds / -Wunused-top-binds: "Defined but not used: ‘x’"
        if (/Defined but not used/.test(message) && flags.some((f) => /^unused-/.test(f))) {
            const [name] = quoted(message);
            if (name && /^[a-z]/.test(name) && written === name) edit(`Prefix ‘${name}’ with _`, d, [{ range: r, newText: `_${name}` }], true);
        }
        // -Wunused-imports: "The import of ‘M’ is redundant" (whole import), or "The import of ‘x, y’ from module ‘M’ is redundant"
        if (flags.includes('unused-imports')) {
            if (/^The (?:qualified )?import of ‘[^’]+’ is redundant/.test(message)) {
                const end = Math.min(r.end.line + 1, doc.lines.length);
                edit('Remove redundant import', d, [{ range: { start: { line: r.start.line, character: 0 }, end: { line: end, character: 0 } }, newText: '' }], true);
            }
        }
        // Typed holes: "Valid hole fits include x :: Int (bound at ...)"
        const fits = /Valid (?:hole fits|refinement hole fits) include\s*([\s\S]*)$/.exec(message);
        if (fits && /^_/.test(written)) {
            for (const m of fits[1].matchAll(/^\s+([a-z_][\w'.]*|\([^)]+\))\s*::/gm)) edit(`Replace ${written} with ${m[1]}`, d, [{ range: r, newText: m[1] }]);
        }
    }
    return actions;
}

// ---- Requests

const requests = {
    initialize: async () => ({
        capabilities: {
            documentFormattingProvider: (await toolsReady).ormolu,
            textDocumentSync: { openClose: true, change: 1 },
            hoverProvider: true,
            definitionProvider: true,
            typeDefinitionProvider: false,
            referencesProvider: true,
            documentHighlightProvider: true,
            documentSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            completionProvider: { triggerCharacters: ['.'] },
            codeActionProvider: { codeActionKinds: ['quickfix'] },
        },
        serverInfo: { name: 'GHC', version: ghc?.versions?.ghc ?? '' },
    }),
    shutdown: () => {
        shutDown = true;
        return null;
    },
    // ormolu's style, the whole module: as `ormolu --mode inplace` on a
    // desktop (the editor's tab size and spaces do not change it).
    'textDocument/formatting': async (p) => {
        const path = pathOf(p?.textDocument?.uri ?? '');
        const doc = path !== null ? docs.get(path) : null;
        if (!doc) throw new RequestError(InvalidParams, 'expected an open document in the workspace');
        const text = doc.text;
        let formatted;
        try {
            formatted = await ormolu(path, text);
        } catch (e) {
            throw new RequestError(-32803, `ormolu could not format ${path}: ${e.message}`);
        }
        if (formatted === text) return [];
        const end = lineStarts(text).length - 1;
        return [{ range: { start: { line: 0, character: 0 }, end: { line: end, character: text.length - lineStarts(text)[end] } }, newText: formatted }];
    },
    'textDocument/hover': async (p) => {
        const here = at(p);
        if (!here) return null;
        const info = await ask('info', here);
        if (!info.found) return null;
        return { contents: { kind: 'markdown', value: hoverOf(info) }, range: rangeOf(here.doc, info.span) };
    },
    'textDocument/definition': async (p) => {
        const here = at(p);
        if (!here) return null;
        const info = await ask('info', here);
        const loc = info.found && info.def ? toLocation(info.def) : null;
        return loc ? [loc] : [];
    },
    'textDocument/references': async (p) => {
        const here = at(p);
        if (!here) return null;
        const include = !!p.context?.includeDeclaration;
        return (await referencesAt(here)).filter((r) => include || !r.isDef).map(({ uri, range }) => ({ uri, range }));
    },
    'textDocument/documentHighlight': async (p) => {
        const here = at(p);
        if (!here) return null;
        const uri = uriOf(here.path);
        return (await referencesAt(here)).filter((r) => r.uri === uri).map((r) => ({ range: r.range, kind: r.isDef ? 3 : 2 }));
    },
    'textDocument/prepareRename': async (p) => {
        const here = at(p);
        if (!here) return null;
        const info = await renameTarget(here);
        return { range: rangeOf(here.doc, info.span), placeholder: info.name };
    },
    'textDocument/rename': async (p) => {
        const here = at(p);
        if (!here) return null;
        const info = await renameTarget(here);
        const old = info.name;
        const newName = typeof p.newName === 'string' ? p.newName.trim() : '';
        const ok = /^[A-Z]/.test(old) ? /^[A-Z][\w']*$/.test(newName) : /^[a-z_]/.test(old) ? /^[a-z_][\w']*$/.test(newName) && !KEYWORDS.includes(newName) : /^[!#$%&*+./<=>?@\\^|~:-]+$/.test(newName);
        if (!ok) throw new RequestError(InvalidParams, `${JSON.stringify(newName)} cannot replace \`${old}\`: ${/^[A-Z]/.test(old) ? 'a constructor or type starts with a capital letter' : /^[a-z_]/.test(old) ? 'a variable starts with a lowercase letter or _ (and is not a keyword)' : 'an operator is made of symbols'}`);
        const changes = {};
        for (const r of await referencesAt(here)) {
            // A qualified use (M.name) keeps its qualifier.
            const doc = docs.get(pathOf(r.uri));
            const written = doc ? lineText(doc, r.range.start.line).slice(r.range.start.character, r.range.end.character) : old;
            const start = written.endsWith(old) ? r.range.end.character - old.length : r.range.start.character;
            (changes[r.uri] ??= []).push({ range: { start: { line: r.range.start.line, character: start }, end: r.range.end }, newText: newName });
        }
        return { changes };
    },
    'textDocument/documentSymbol': (p) => {
        const path = pathOf(p?.textDocument?.uri ?? '');
        const doc = path !== null ? docs.get(path) : null;
        return doc ? documentSymbols(doc, analyses.get(path)) : [];
    },
    'textDocument/completion': async (p) => {
        const path = pathOf(p?.textDocument?.uri ?? '');
        const doc = path !== null ? docs.get(path) : null;
        if (!doc) return [];
        return { isIncomplete: false, items: await completions(doc, path, p.position.line, p.position.character) };
    },
    'textDocument/codeAction': (p) => {
        const path = pathOf(p?.textDocument?.uri ?? '');
        const doc = path !== null ? docs.get(path) : null;
        if (!doc) return [];
        return codeActions(doc, p.textDocument.uri, p.context?.diagnostics ?? []);
    },
};

async function renameTarget(here) {
    const info = await ask('info', here);
    if (!info.found || info.kind === 'module') throw new RequestError(InvalidParams, 'Nothing to rename here: put the cursor on a name');
    if (!info.def || !projectPath(info.def.file)) throw new RequestError(InvalidParams, `\`${info.name}\` is defined in a library${info.module ? ` (${info.module})` : ''}, not in this project, so it cannot be renamed`);
    return info;
}

const notifications = {
    initialized: () => {},
    exit: () => close(),
    'textDocument/didOpen': (p) => {
        const { uri, version, text } = p.textDocument;
        const path = pathOf(uri);
        if (path === null) return;
        docs.set(path, { uri, path, version, text, lines: lineStarts(text) });
        ghc.write(path, text);
        if (isHaskell(uri)) schedule();
    },
    'textDocument/didChange': (p) => {
        const text = p.contentChanges.at(-1)?.text;
        const path = pathOf(p.textDocument.uri);
        if (text === undefined || path === null) return;
        docs.set(path, { uri: p.textDocument.uri, path, version: p.textDocument.version, text, lines: lineStarts(text) });
        ghc.write(path, text);
        if (isHaskell(p.textDocument.uri)) schedule();
    },
    'textDocument/didClose': (p) => {
        const path = pathOf(p.textDocument.uri);
        if (path === null || !docs.has(path)) return;
        docs.delete(path);
        analyses.delete(path);
        ghcDiagnostics.delete(path);
        hlintDiagnostics.delete(path);
        ghc.remove(path);
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
            send({ jsonrpc: '2.0', id: msg.id, result: (await fn(msg.params)) ?? null });
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
