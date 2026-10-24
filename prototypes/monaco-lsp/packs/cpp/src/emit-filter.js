// What the compiler output views show (README, "Compiler output views"):
// clang's assembly (-S) and LLVM IR (-S -emit-llvm), compiled with
// -gline-tables-only, filtered the way Compiler Explorer filters them, with
// each output line mapped to the source line it came from. Pure functions of
// strings, no I/O; explorer.js calls them, test-emit.mjs checks them on the
// fixtures in tests/fixtures/.
//
// Source locations. The project is compiled in /workspace, so clang names a
// project file /workspace/x, ./x or x, and a header outside the project by
// its absolute path (/usr/include/c++/v1/__vector/vector.h). A mapped line
// is `{ file, line }` with `file` the project path (x) or that absolute
// path. Code inlined from a header maps to the innermost place in the
// project it was inlined into, when there is one: std::vector's
// construction inlined into main maps to main.cpp's line that constructs the
// vector, which is the line a student's cursor is on. Line 0 (code that
// belongs to no line) maps to null.

/**
 * The project path of a path clang printed (relative to /workspace, the
 * compilation's directory), or the absolute path itself for a file outside
 * the project. `.` and `..` segments are resolved.
 */
export function projectPath(path, dir = '') {
    let full = path.startsWith('/') ? path : `${dir || '/workspace'}/${path}`;
    if (!full.startsWith('/')) full = `/workspace/${full}`;
    const parts = [];
    for (const part of full.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') parts.pop();
        else parts.push(part);
    }
    const resolved = '/' + parts.join('/');
    return resolved.startsWith('/workspace/') ? resolved.slice('/workspace/'.length) : resolved;
}

/** Whether a mapped file is one of the project's (a relative project path). */
export const inProject = (file) => !file.startsWith('/');

const DATA = /^\s*\.(byte|short|long|quad|int8|int16|int32|int64|word|hword|xword|dword|half|ascii|asciz|string|zero|space|skip|fill|float|double|single|uleb128|sleb128|octa|2byte|4byte|8byte)\b/;
const DIRECTIVE = /^\s*\.[A-Za-z_]/;
const LABEL = /^("[^"]+"|[^\s#;/"][^\s:]*):/;
const COMMENT_ONLY = /^\s*(#|\/\/|;|@)/;
const ALWAYS_HIDDEN = /^\s*\.(loc|file|cfi_[a-z_]+|addrsig(_sym)?|ident)\b/;
const SECTION = /^\s*\.(section|text|data|bss)\b(.*)$/;
const TOKEN = /[A-Za-z_.$][\w.$]*/g;

/**
 * Filters clang's assembly (`-S`, with `-gline-tables-only`) for reading,
 * and maps each line it keeps to its source line.
 *
 * Always removed: `.loc`, `.file`, `.cfi_*`, `.addrsig*` and `.ident`
 * directives; whole `.section .debug_*` blocks; lines that are only a
 * comment (`#`, `//`) or empty; local labels (`.L...`) nothing kept refers
 * to (`.Ltmp3`, `.Lfunc_begin0`, an unused `.LBB0_2`).
 *
 * - `directives: false` also removes every other directive (`.globl`,
 *   `.type`, `.p2align`, `.section`, `.size`, `.functype`, ...), except the
 *   data (`.asciz`, `.quad`, `.zero`, ...) under a label something refers
 *   to; a label nothing refers to goes with its data (an exception table,
 *   say), unless it starts a function.
 * - `library: false` hides each function (clang's `-- Begin function` to
 *   `-- End function`) none of whose lines maps to a project file: a
 *   function from a header, such as a std::vector member at -O0.
 *
 * Returns `{ text, lines }`: the kept lines joined with `\n`, and for each
 * one `{ file, line }` or null (labels, directives, data, and code with no
 * line); `lines.length` is the number of lines in `text` (0, with `text`
 * '', when nothing is kept). Never throws.
 */
export function filterAsm(text, { directives = false, library = false } = {}) {
    const files = new Map();
    const out = []; // { text, map, kind: 'label'|'code'|'data'|'directive', name?, fn }
    let loc = null;
    let inDebug = false;
    let owner = null;
    let fn = -1; // index of the current function block, or -1
    let functions = 0;
    const functionLabels = new Set();
    for (const line of text.split('\n')) {
        const section = SECTION.exec(line);
        if (section) {
            owner = null;
            inDebug = section[1] === 'section' && /^\s*"?\.debug_/.test(section[2]);
            loc = null;
            if (inDebug) continue;
        } else if (inDebug) continue;
        const file = /^\s*\.file\s+(\d+)\s+"((?:[^"\\]|\\.)*)"(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
        if (file) {
            files.set(file[1], file[3] !== undefined ? projectPath(file[3], file[2]) : projectPath(file[2]));
            continue;
        }
        const dotLoc = /^\s*\.loc\s+(\d+)\s+(\d+)\s+\d+[^#/]*(?:(?:#|\/\/)\s*(.*))?$/.exec(line);
        if (dotLoc) {
            loc = locationOf(files.get(dotLoc[1]), Number(dotLoc[2]), dotLoc[3] ?? '');
            continue;
        }
        if (/-- Begin function/.test(line)) {
            fn = functions++;
            const name = /-- Begin function\s+(\S+)/.exec(line)?.[1];
            if (name) functionLabels.add(name);
        }
        const ending = /-- End function/.test(line);
        if (ALWAYS_HIDDEN.test(line) || COMMENT_ONLY.test(line) || line.trim() === '') {
            if (ending) (fn = -1), (loc = null);
            continue;
        }
        // Each data line belongs to the label above it in the same section,
        // if no code came between.
        const label = LABEL.exec(line);
        if (label) out.push((owner = { text: line, map: null, kind: 'label', name: label[1], fn }));
        else if (DATA.test(line)) out.push({ text: line, map: null, kind: 'data', fn, owner });
        else if (DIRECTIVE.test(line) || /^\s*[\w.$]+\s*=/.test(line)) out.push({ text: line, map: null, kind: 'directive', fn });
        else out.push({ text: line, map: loc, kind: 'code', fn }), (owner = null);
        if (ending) (fn = -1), (loc = null);
    }

    let kept = out;
    if (!library) {
        const project = new Set();
        for (const l of out) if (l.fn >= 0 && l.map && inProject(l.map.file)) project.add(l.fn);
        kept = kept.filter((l) => l.fn < 0 || project.has(l.fn));
    }
    if (!directives) kept = kept.filter((l) => l.kind !== 'directive');
    // A label stays when something kept refers to it: code (an instruction's
    // trailing comment, `# xmm0 = mem[0],zero`, refers to nothing), every
    // directive when directives are shown, and the data of labels that stay,
    // to a fixed point (a jump table's entries keep the blocks they name; an
    // exception table nothing refers to keeps nothing). A function's own
    // label always stays, and with directives so does every global label.
    const referenced = new Set();
    const refer = (text) => {
        for (const token of text.match(TOKEN) ?? []) referenced.add(token);
    };
    for (const l of kept) {
        if (l.kind === 'code') refer(l.text.replace(/\s(#\s|\/\/).*$/, ''));
        else if (l.kind === 'directive' || (l.kind === 'data' && directives)) refer(l.text);
    }
    const stays = (l) => referenced.has(l.name) || functionLabels.has(l.name) || (directives && !l.name.startsWith('.L'));
    for (let size = -1; size !== referenced.size; ) {
        size = referenced.size;
        for (const l of kept) if (l.kind === 'data' && l.owner && stays(l.owner)) refer(l.text);
    }
    const result = kept.filter((l) =>
        l.kind === 'label' ? stays(l) : l.kind === 'data' ? directives || (l.owner !== null && stays(l.owner)) : true);
    return { text: result.map((l) => l.text).join('\n'), lines: result.map((l) => l.map) };
}

/**
 * The mapped location of a `.loc`: its file and line, or, for a file outside
 * the project, the innermost project location in the inlining chain the
 * `.loc`'s comment spells out (`allocate.h:43:28 @[ main.cpp:7:24 ]`).
 */
function locationOf(file, line, comment) {
    if (!file || line === 0) return null;
    if (inProject(file)) return { file, line };
    for (const m of comment.matchAll(/@\[\s*([^\s:]+):(\d+):\d+/g)) {
        const at = projectPath(m[1]);
        if (inProject(at) && Number(m[2]) > 0) return { file: at, line: Number(m[2]) };
    }
    return { file, line };
}

const METADATA = /^(!\d+) = (distinct )?!(\w*)/;
const NAMED_METADATA = /^(![A-Za-z_.][\w.]*) = !\{(.*)\}$/;
const DEBUG_FLAGS = /^!\{i32 \d+, !"(Dwarf Version|Debug Info Version)"/;

/**
 * Filters clang's LLVM IR (`-S -emit-llvm`, with `-gline-tables-only`) for
 * reading, and maps each line it keeps to its source line.
 *
 * Removed: every `!dbg !N` attachment, `#dbg_*` records, the debug info
 * metadata (`DI*` nodes and `!llvm.dbg.cu`), the "Dwarf Version" and "Debug
 * Info Version" module flags (and their entries in `!llvm.module.flags`),
 * and any metadata node only those referred to. Everything else stays as
 * clang printed it, numbering included.
 *
 * Each instruction maps through its `!dbg` DILocation (and its `inlinedAt`
 * chain, as filterAsm does) to its scope's DIFile and line; a `define`
 * maps to its DISubprogram's line; an instruction printed on several lines
 * (`invoke ... to label ...`) maps on each of them.
 *
 * - `library: false` hides each function definition (`define` to `}`) none
 *   of whose lines maps to a project file.
 *
 * Returns `{ text, lines }` as filterAsm does. Never throws.
 */
export function filterIr(text, { library = false } = {}) {
    const input = text.split('\n');
    const nodes = new Map(); // '!N' -> body text after '= '
    for (const line of input) {
        const m = /^(!\d+) = (.*)$/.exec(line);
        if (m) nodes.set(m[1], m[2]);
    }
    const field = (body, name) => new RegExp(`\\b${name}: (![0-9]+|"(?:[^"\\\\]|\\\\.)*"|-?\\d+)`).exec(body ?? '')?.[1];
    const unquote = (s) => (s ?? '').replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
    const fileOf = (scope) => {
        for (let s = scope, guard = 0; s && guard < 100; guard++) {
            const body = nodes.get(s) ?? '';
            if (/!DIFile\(/.test(body)) return projectPath(unquote(field(body, 'filename')), unquote(field(body, 'directory')));
            const f = field(body, 'file');
            if (f) return fileOf(f);
            s = field(body, 'scope');
        }
        return null;
    };
    // A DILocation's file and line; through its inlinedAt chain, the
    // innermost one in the project when it is itself outside.
    const locationOfNode = (id) => {
        let first;
        for (let n = id, guard = 0; n && guard < 100; guard++) {
            const body = nodes.get(n) ?? '';
            const line = Number(field(body, 'line') ?? 0);
            const file = fileOf(field(body, 'scope'));
            const here = file && line > 0 ? { file, line } : null;
            if (first === undefined) {
                first = here;
                if (!here) return null;
            }
            if (here && inProject(here.file)) return here;
            n = field(body, 'inlinedAt');
        }
        return first ?? null;
    };
    const subprogramLine = (id) => {
        const body = nodes.get(id) ?? '';
        const line = Number(field(body, 'line') ?? 0);
        const file = fileOf(field(body, 'file') ?? field(body, 'scope'));
        return file && line > 0 ? { file, line } : null;
    };

    // Which metadata goes: DI* nodes, the two debug module flags.
    const removed = new Set();
    for (const [id, body] of nodes) {
        const kind = /^(?:distinct )?!(\w+)\(/.exec(body)?.[1] ?? '';
        if (kind.startsWith('DI') || DEBUG_FLAGS.test(body)) removed.add(id);
    }

    const kept = []; // { text, map, fn }
    let fn = -1;
    let functions = 0;
    for (const line of input) {
        if (/^\s*#dbg_\w+\(/.test(line)) continue;
        if (/^!llvm\.dbg\.cu = /.test(line)) continue;
        const meta = METADATA.exec(line);
        if (meta && removed.has(meta[1])) continue;
        let map = null;
        let shown = line;
        const dbg = /(?:,\s*)?!dbg (!\d+)/.exec(line);
        if (dbg) {
            shown = line.replace(/,?\s*!dbg !\d+/g, '');
            map = /^define\b/.test(line) ? subprogramLine(dbg[1]) : locationOfNode(dbg[1]);
        }
        const named = NAMED_METADATA.exec(shown);
        if (named && named[1] === '!llvm.module.flags')
            shown = `${named[1]} = !{${named[2].split(/,\s*/).filter((r) => !removed.has(r)).join(', ')}}`;
        if (/^define\b/.test(line)) fn = functions++;
        kept.push({ text: shown, map, fn });
        // An instruction continued on this line (indented deeper than two
        // spaces) maps on the lines it started on, too.
        if (map && /^ {3,}\S/.test(line))
            for (let j = kept.length - 2; j >= 0 && !kept[j].map; j--) {
                const first = /^ {2}\S/.test(kept[j].text);
                if (!first && !/^ {3,}\S/.test(kept[j].text)) break;
                kept[j].map = map;
                if (first) break;
            }
        if (fn >= 0 && line === '}') fn = -1;
    }

    // A function's `; Function Attrs:` comment goes with it.
    for (let i = 0; i + 1 < kept.length; i++)
        if (kept[i].fn < 0 && /^; Function Attrs:/.test(kept[i].text) && /^define\b/.test(kept[i + 1].text)) kept[i].fn = kept[i + 1].fn;
    let result = kept;
    if (!library) {
        const project = new Set();
        for (const l of result) if (l.fn >= 0 && l.map && inProject(l.map.file)) project.add(l.fn);
        result = result.filter((l) => l.fn < 0 || project.has(l.fn));
    }

    // Metadata nothing shown refers to any more (a DISubroutineType's empty
    // !{}, a hidden function's !tbaa), transitively.
    const live = new Set();
    const refs = (s) => s.match(/!\d+/g) ?? [];
    const pending = [];
    for (const l of result) if (!METADATA.test(l.text)) pending.push(...refs(l.text));
    while (pending.length) {
        const id = pending.pop();
        if (live.has(id) || !nodes.has(id) || removed.has(id)) continue;
        live.add(id);
        pending.push(...refs(nodes.get(id)));
    }
    result = result.filter((l) => {
        const m = METADATA.exec(l.text);
        return !m || live.has(m[1]);
    });
    // Attribute groups and comdats only hidden functions used.
    const used = new Set();
    for (const l of result) if (!/^(attributes #|\$)/.test(l.text)) for (const r of l.text.match(/#\d+\b|\$[\w.$]+/g) ?? []) used.add(r);
    result = result.filter((l) => {
        const m = /^(?:attributes (#\d+)|(\$[\w.$]+) = comdat)/.exec(l.text);
        return !m || used.has(m[1] ?? m[2]);
    });
    // Blank lines left where removed ones were, at most one in a row.
    result = result.filter((l, i) => l.text.trim() !== '' || (i > 0 && result[i - 1].text.trim() !== ''));
    while (result.length && result[result.length - 1].text.trim() === '') result.pop();
    return { text: result.map((l) => l.text).join('\n'), lines: result.map((l) => l.map) };
}

const MANGLED = /(?<![\w.$])_Z[\w.$]+/g;

/**
 * Replaces every Itanium-mangled symbol (`_Z...`) in `text` by its
 * demangled name, through `demangle`, which takes the distinct names in one
 * batch (an array) and returns their demangled forms in the same order
 * (a name it cannot demangle comes back as it was). Demangled names have no
 * newline, so the text keeps its line count; returns the new text.
 */
export function demangleLines(text, demangle) {
    const names = [...new Set(text.match(MANGLED) ?? [])];
    if (!names.length) return text;
    const plain = demangle(names);
    const table = new Map(names.map((name, i) => [name, typeof plain[i] === 'string' && !plain[i].includes('\n') ? plain[i] : name]));
    return text.replace(MANGLED, (name) => table.get(name) ?? name);
}
