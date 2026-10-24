// Test discovery for the browser's XCTest, without macros or reflection:
// the XCTestCase subclasses of a project and their `func test…()` methods
// are found by scanning the source text, and a main.swift calling
// `XCTMain([...])` is generated, which is what `swift test` generates on
// Linux and what a student writes by hand for the real XCTest there.
//
// The scanner removes comments (nested /* */ too) and string literals
// (multi-line, raw, with interpolations) before it looks at anything, then
// follows braces to know which type body a declaration is in. What it
// recognises:
//
//   class Name: XCTestCase { ... }    and subclasses of such classes, nested
//                                     types (as Outer.Name) and extensions
//   func testX() [async] [throws] { } instance methods of those classes and
//                                     their extensions, no parameters, not
//                                     static/class/private/fileprivate, no
//                                     generic parameters, returning nothing;
//                                     inherited ones too, as XCTest runs them
//   static var/let allTests           if a class declares its own list it is
//                                     used instead (testCase(Name.allTests)),
//                                     as the real XCTest on Linux needs it
//
// Generic or private test classes are left out (a generated main cannot
// name them). A main.swift that calls XCTMain itself is used as it is.

const TYPE_KEYWORDS = new Set(['class', 'struct', 'enum', 'actor', 'protocol', 'extension']);
const NOT_A_TYPE_AFTER_CLASS = new Set(['func', 'var', 'let', 'subscript', 'override', 'final', 'static', 'private',
    'fileprivate', 'internal', 'public', 'open', 'required', 'convenience', 'init', 'deinit', 'typealias']);

/**
 * The code tokens of a Swift file: identifiers (backticks removed),
 * `#keywords`, `@attributes` and single punctuation characters. Comments,
 * string literals and numbers are dropped.
 */
export function tokenize(text) {
    const tokens = [];
    let i = 0;
    const n = text.length;
    const isIdStart = (c) => /[A-Za-z_À-￿]/.test(c);
    const isId = (c) => /[A-Za-z0-9_À-￿]/.test(c);

    // Skips a string literal starting at i (at its first `#` or `"`); returns
    // the index after it. Interpolations are skipped with their own strings.
    function skipString(i) {
        let hashes = 0;
        while (text[i] === '#') hashes++, i++;
        const multi = text.startsWith('"""', i);
        i += multi ? 3 : 1;
        const close = (multi ? '"""' : '"') + '#'.repeat(hashes);
        const interp = '\\' + '#'.repeat(hashes) + '(';
        while (i < n) {
            if (text.startsWith(close, i)) return i + close.length;
            if (text.startsWith(interp, i)) {
                i = skipCode(i + interp.length, ')');
                continue;
            }
            if (text[i] === '\\' && hashes === 0) i++;
            else if (text[i] === '\n' && !multi) return i; // unterminated: stop at the line end
            i++;
        }
        return i;
    }
    // Skips code up to and including the `end` that closes it (for interpolations).
    function skipCode(i, end) {
        let depth = 0;
        while (i < n) {
            const c = text[i];
            if (c === '"' || (c === '#' && /^#+"/.test(text.slice(i, i + 8)))) { i = skipString(i); continue; }
            if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return n; continue; }
            if (c === '/' && text[i + 1] === '*') { i = skipComment(i); continue; }
            if (c === '(') depth++;
            else if (c === end && depth-- === 0) return i + 1;
            i++;
        }
        return i;
    }
    function skipComment(i) {
        let depth = 0;
        while (i < n) {
            if (text.startsWith('/*', i)) depth++, i += 2;
            else if (text.startsWith('*/', i)) { i += 2; if (--depth === 0) return i; }
            else i++;
        }
        return i;
    }

    while (i < n) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            const e = text.indexOf('\n', i);
            i = e < 0 ? n : e;
        } else if (c === '/' && text[i + 1] === '*') {
            i = skipComment(i);
        } else if (c === '"' || (c === '#' && /^#+"/.test(text.slice(i, i + 8)))) {
            i = skipString(i);
        } else if (c === '`') {
            const e = text.indexOf('`', i + 1);
            tokens.push(text.slice(i + 1, e < 0 ? n : e));
            i = e < 0 ? n : e + 1;
        } else if ((c === '#' || c === '@') && isIdStart(text[i + 1] ?? '')) {
            let e = i + 1;
            while (e < n && isId(text[e])) e++;
            tokens.push(text.slice(i, e));
            i = e;
        } else if (isIdStart(c)) {
            let e = i + 1;
            while (e < n && isId(text[e])) e++;
            tokens.push(text.slice(i, e));
            i = e;
        } else if (/[0-9]/.test(c)) {
            while (i < n && /[0-9A-Za-z_.]/.test(text[i])) i++;
        } else if (/\s/.test(c)) {
            i++;
        } else {
            tokens.push(c);
            i++;
        }
    }
    return tokens;
}

/** The index after a balanced `<...>` starting at t[i], or i if there is none. */
function skipGenerics(t, i) {
    if (t[i] !== '<') return i;
    let depth = 0;
    for (; i < t.length; i++) {
        if (t[i] === '<') depth++;
        else if (t[i] === '>' && --depth === 0) return i + 1;
    }
    return i;
}

/** A dotted name starting at t[i] (`A`, `A.B`); returns [name, next index]. */
function dotted(t, i) {
    let name = t[i];
    i++;
    while (t[i] === '.' && /^\w/.test(t[i + 1] ?? '')) {
        name += '.' + t[i + 1];
        i += 2;
    }
    return [name, i];
}

/** The modifiers and attributes written before the declaration keyword at t[i]. */
function modifiersBefore(t, i) {
    const out = [];
    for (let j = i - 1; j >= 0; j--) {
        if (/^[a-z]+$/.test(t[j]) && ['static', 'class', 'private', 'fileprivate', 'internal', 'public', 'open', 'final',
            'override', 'nonisolated', 'mutating', 'dynamic', 'required', 'convenience', 'indirect'].includes(t[j])) out.push(t[j]);
        else if (t[j] === ')' ) {
            // an attribute's arguments, e.g. @available(*, deprecated)
            let depth = 0;
            for (; j >= 0; j--) {
                if (t[j] === ')') depth++;
                else if (t[j] === '(' && --depth === 0) break;
            }
            if (!t[j - 1]?.startsWith('@')) break;
        } else if (t[j].startsWith('@')) out.push(t[j]);
        else break;
    }
    return out;
}

/**
 * What one file declares: classes (with their superclass), test methods and
 * `allTests` lists by the (dotted) name of the type they are written in, and
 * whether the file calls XCTMain.
 */
export function scanFile(text) {
    const t = tokenize(text);
    const classes = []; // { name, superclass, generic, private }
    const methods = []; // { type, name, isAsync }
    const allTests = new Set();
    const scopes = []; // { type: dotted name | null, isType: bool }
    let pendingType = null; // the type whose body the next `{` opens
    let callsXCTMain = false;
    const typeScope = () => {
        const s = scopes[scopes.length - 1];
        return s && s.isType ? s.type : null;
    };
    const atTypeLevel = () => scopes.length === 0 || scopes[scopes.length - 1].isType;

    for (let i = 0; i < t.length; i++) {
        const tok = t[i];
        if (tok === '{') {
            scopes.push(pendingType ? { type: pendingType, isType: true } : { type: null, isType: false });
            pendingType = null;
        } else if (tok === '}') {
            scopes.pop();
        } else if (tok === 'XCTMain' && t[i + 1] === '(') {
            callsXCTMain = true;
        } else if (TYPE_KEYWORDS.has(tok) && atTypeLevel() && t[i - 1] !== '.' && /^\w/.test(t[i + 1] ?? '')
            && !(tok === 'class' && NOT_A_TYPE_AFTER_CLASS.has(t[i + 1]))) {
            const outer = scopes.filter((s) => s.isType).map((s) => s.type);
            let [name, j] = dotted(t, i + 1);
            const full = tok === 'extension' ? name : [...outer.slice(-1), name].join('.');
            const generic = t[j] === '<';
            j = skipGenerics(t, j);
            let superclass = null;
            if (t[j] === ':' && /^\w/.test(t[j + 1] ?? '')) [superclass] = dotted(t, j + 1);
            if (tok === 'class') {
                const mods = modifiersBefore(t, i);
                classes.push({ name: full, superclass, generic, private: mods.includes('private') || mods.includes('fileprivate') });
            }
            pendingType = full;
            // Skip to the body; a `{` inside the where clause is not possible.
            while (j < t.length && t[j] !== '{' && t[j] !== ';') j++;
            i = j - 1;
        } else if (tok === 'func' && typeScope()) {
            const mods = modifiersBefore(t, i);
            const name = t[i + 1];
            let j = i + 2;
            if (!/^test/.test(name ?? '') || t[j] === '<' || t[j] !== '(' || t[j + 1] !== ')') continue;
            j += 2;
            let isAsync = false;
            while (j < t.length && !['{', '->', '-', 'where', '}', ';'].includes(t[j])) {
                if (t[j] === 'async') isAsync = true;
                j++;
            }
            if (t[j] === '-' && t[j + 1] === '>') {
                const ret = t[j + 2] === '(' && t[j + 3] === ')' ? 'Void' : t[j + 2];
                if (ret !== 'Void') continue;
            }
            if (mods.some((m) => ['static', 'class', 'private', 'fileprivate'].includes(m))) continue;
            methods.push({ type: typeScope(), name, isAsync });
        } else if ((tok === 'var' || tok === 'let') && t[i + 1] === 'allTests' && typeScope()) {
            const mods = modifiersBefore(t, i);
            if (mods.includes('static') || mods.includes('class')) allTests.add(typeScope());
        }
    }
    return { classes, methods, allTests: [...allTests], callsXCTMain };
}

/**
 * The project's test classes, in file and declaration order: each with its
 * test methods (own and inherited, first declaration wins) and whether it
 * has its own `allTests`.
 */
export function discoverTests(files) {
    const scans = Object.entries(files).filter(([p]) => p.endsWith('.swift')).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, text]) => ({ path, ...scanFile(text) }));
    const classes = new Map();
    for (const s of scans) for (const c of s.classes) if (!classes.has(c.name)) classes.set(c.name, c);
    // A superclass is written as seen from where the class is: try the exact
    // name, then a class whose last component matches.
    const resolve = (name) => classes.get(name) ?? [...classes.values()].find((c) => c.name.split('.').pop() === name.split('.').pop());
    const isTestClass = (c, seen = new Set()) => {
        if (!c?.superclass || seen.has(c.name)) return false;
        if (c.superclass === 'XCTestCase' || c.superclass === 'XCTest.XCTestCase') return true;
        seen.add(c.name);
        return isTestClass(resolve(c.superclass), seen);
    };
    // Extensions may name a nested class by its short name.
    const owner = (type) => classes.has(type) ? type : resolve(type)?.name ?? type;
    const own = new Map();
    const lists = new Set();
    for (const s of scans) {
        for (const m of s.methods) {
            const key = owner(m.type);
            if (!own.has(key)) own.set(key, []);
            if (!own.get(key).some((x) => x.name === m.name)) own.get(key).push(m);
        }
        for (const a of s.allTests) lists.add(owner(a));
    }
    const result = [];
    for (const c of classes.values()) {
        if (!isTestClass(c) || c.generic || c.private) continue;
        const tests = [];
        for (let k = c; k; k = k.superclass ? resolve(k.superclass) : null) {
            for (const m of own.get(k.name) ?? []) if (!tests.some((x) => x.name === m.name)) tests.push(m);
            if (k.superclass === 'XCTestCase' || k.superclass === 'XCTest.XCTestCase') break;
        }
        if (tests.length || lists.has(c.name)) result.push({ name: c.name, tests, ownAllTests: lists.has(c.name) });
    }
    return { classes: result, mainFiles: scans.filter((s) => s.callsXCTMain).map((s) => s.path) };
}

/** The main.swift that runs `classes` (from discoverTests). */
export function generateMain(classes) {
    const entries = classes.map((c) => {
        if (c.ownAllTests) return `    testCase(${c.name}.allTests),`;
        const tests = c.tests.map((m) => `        ("${m.name}", ${m.isAsync ? `asyncTest(${c.name}.${m.name})` : `${c.name}.${m.name}`}),`);
        return `    testCase([\n${tests.join('\n')}\n    ] as [(String, (${c.name}) -> () throws -> Void)]),`;
    });
    return `// Generated by the Swift pack: every XCTestCase subclass of the project.\nimport XCTest\n\nXCTMain([\n${entries.join('\n')}\n])\n`;
}

/** True if the file imports XCTest (and so is a test file, or a hand-written test main). */
export function importsXCTest(text) {
    const t = tokenize(text);
    return t.some((tok, i) => tok === 'import' && t[i + 1] === 'XCTest');
}

// Modules a test may import that are not the project, even where they do not
// exist in the browser (where the import fails, as it should).
const NOT_THE_PROJECT = new Set(['XCTest', 'Testing', 'Foundation', 'FoundationEssentials', 'Dispatch', 'Glibc', 'Musl',
    'Darwin', 'WASILibc', 'Swift', '_Concurrency', 'Synchronization', 'RegexBuilder']);

/**
 * The module name to compile the project as. Tests written for SwiftPM say
 * `@testable import App` to see the code under test; here project and tests
 * are one module, so naming it `App` makes that import refer to the module
 * being compiled, which the compiler ignores with a warning. Returns `main`
 * unless the project's files `@testable import` exactly one such name.
 */
export function projectModuleName(files) {
    const names = new Set();
    for (const [path, text] of Object.entries(files)) {
        if (!path.endsWith('.swift')) continue;
        const t = tokenize(text);
        for (let i = 0; i + 2 < t.length; i++) {
            if (t[i] === '@testable' && t[i + 1] === 'import' && !NOT_THE_PROJECT.has(t[i + 2])) names.add(t[i + 2]);
        }
    }
    return names.size === 1 ? [...names][0] : 'main';
}

/**
 * What a test run compiles. Every .swift file of the project except the
 * program's main.swift files (their top-level code would be a second
 * entry point), plus a generated main.swift; or, if a main.swift calls
 * XCTMain itself, that file instead of the generated one.
 *
 * Returns { sources: project-relative .swift paths to compile, main: text
 * of the generated main.swift or null, classes, moduleName }.
 */
export function planTestRun(files) {
    const swift = Object.keys(files).filter((p) => p.endsWith('.swift'));
    const isMain = (p) => p.split('/').pop() === 'main.swift';
    const { classes, mainFiles } = discoverTests(files);
    const ownMain = mainFiles.find(isMain) ?? null;
    return {
        sources: swift.filter((p) => !isMain(p) || p === ownMain),
        main: ownMain ? null : generateMain(classes),
        classes,
        moduleName: projectModuleName(files),
    };
}

/**
 * True for the message of the compiler's "file 'X.swift' is part of module
 * 'App'; ignoring import" warning (as sourcekitd reports it, without the
 * location): projectModuleName causes it on purpose, see below.
 */
export function isOwnModuleImportWarning(message) {
    return /^file '[^']*' is part of module '[^']*'; ignoring import$/.test(message);
}

/**
 * Removes the compiler's "file 'X.swift' is part of module 'App'; ignoring
 * import" warnings (with their source line and caret) from frontend output:
 * projectModuleName causes them on purpose, and the `@testable import App`
 * they point at has to stay for the real XCTest.
 */
export function dropOwnModuleImportWarnings(text) {
    const header = /^.*:\d+:\d+: (?:error|warning|note|remark): /;
    const out = [];
    let dropping = false;
    for (const line of text.split('\n')) {
        const h = header.exec(line);
        if (h) dropping = h[0].endsWith(': warning: ') && isOwnModuleImportWarning(line.slice(h[0].length));
        else if (line === '' && dropping) {
            dropping = false;
            continue; // the blank line that ends the dropped block
        }
        if (!dropping) out.push(line);
    }
    return out.join('\n');
}

/** True if the source text is a test file: it imports XCTest and is not a main.swift. */
export function isTestFile(path, text) {
    return path.split('/').pop() !== 'main.swift' && importsXCTest(text);
}
