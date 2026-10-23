// Proves that the browser's XCTest (xctest/XCTest) is a subset of the real
// one, swift-corelibs-xctest as the Swift 6.4.1 Linux toolchain ships it:
// every public declaration of ours exists there with the same signature, so
// a test that compiles in the browser compiles on a grading server.
//
//   node tools/xctest-subset.mjs        (after ./build.sh; npm run test:xctest)
//
// Five checks, each able to fail on its own:
//
//  1. api-digester: `swift-api-digester -dump-sdk` of our module (built
//     natively) and of the toolchain's XCTest, then `-diagnose-sdk` with ours
//     as the baseline: any declaration of ours that is missing or changed in
//     the real one (type, generic signature, throws/rethrows, static, open,
//     superclass, conformance) is reported as a breaking change.
//  2. Symbols: every declaration in our dump must have one in the real dump
//     with the same USR (the mangled name: catches @autoclosure, @escaping,
//     @Sendable, which the digester's diagnosis does not compare) and the same
//     printed name, parameter types, default-argument flags, attributes,
//     availability and deprecation.
//  3. Source: the declaration text of every public declaration of ours
//     (attributes, modifiers, labels, types, default values such as `#file`)
//     must equal, whitespace aside, one in swift-corelibs-xctest's
//     Sources/XCTest at the toolchain's tag (both #if branches), fetched with
//     git into the pack cache. This is what catches `#filePath` for `#file`.
//  4. Conformance corpus (xctest/conformance/API.swift, which spells out the
//     type of every public declaration): type-checks against ours natively,
//     against the real XCTest natively, and against ours as the browser has
//     it (swift-xctest.tar) with the pack's swift-frontend.wasm 6.3.3; and
//     every public name of ours must appear in it.
//  5. Behaviour (xctest/conformance/Behaviour.swift): built natively against
//     both, run, and the two reports compared line by line with dates, times
//     and the bundle name blanked; the real one must also equal
//     xctest/conformance/Behaviour.expected, which test-run.mjs compares the
//     browser's report with (UPDATE=1 rewrites it from the real XCTest).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CACHE = join(process.env.PACK_CACHE ?? join(homedir(), '.cache/yukibana-packs'), 'swift');
const BIN = join(CACHE, 'toolchain/usr/bin');
const OURS = join(HERE, 'xctest/XCTest');
const CORPUS = join(HERE, 'xctest/conformance');
const STATIC = resolve(HERE, '../../app/static/packs/swift');
const TAG = 'swift-6.4.1-RELEASE'; // the native toolchain's release (build.sh SWIFT_VERSION)
const TARGET = 'x86_64-unknown-linux-gnu';

const tmp = mkdtempSync(join(tmpdir(), 'xctest-subset-'));
const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}` };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 1 << 28, ...opts });
let failed = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '\n      ' + detail.trim().replaceAll('\n', '\n      ') : ''}`);
};

const ourSources = readdirSync(OURS).filter((n) => n.endsWith('.swift')).sort().map((n) => join(OURS, n));
const mod = join(tmp, 'ours');
mkdirSync(mod);
let r = sh('swiftc', ['-parse-as-library', '-module-name', 'XCTest', '-emit-module', '-emit-library', '-static', '-enable-experimental-feature', 'Extern',
    '-emit-module-path', join(mod, 'XCTest.swiftmodule'), '-o', join(mod, 'libOursXCTest.a'), ...ourSources]);
if (r.status !== 0) {
    console.log(r.stderr);
    process.exit(1);
}

// ------------------------------------------------------------ 1. api-digester

const dump = (out, extra) => {
    const d = sh('swift-api-digester', ['-dump-sdk', '-module', 'XCTest', '-target', TARGET, '-o', out, ...extra]);
    if (d.status !== 0) throw new Error(d.stderr);
    return JSON.parse(readFileSync(out, 'utf8'));
};
const ours = dump(join(tmp, 'ours.json'), ['-I', mod]);
const real = dump(join(tmp, 'real.json'), []);
r = sh('swift-api-digester', ['-diagnose-sdk', '-input-paths', join(tmp, 'ours.json'), '-input-paths', join(tmp, 'real.json')]);
const breaking = (r.stdout + r.stderr).split('\n').filter((l) => l.trim() && !/^\/\*.*\*\/$/.test(l.trim()));
check('api-digester: no declaration of ours is removed or changed in the real XCTest', r.status === 0 && breaking.length === 0, breaking.join('\n'));

// ------------------------------------------------------------ 2. symbols

const decls = (root) => {
    const out = new Map();
    const walk = (n, parent) => {
        if (n.declKind && n.usr) out.set(n.usr, { node: n, parent });
        for (const c of n.children ?? []) walk(c, n.declKind ? n.printedName : parent);
    };
    walk(root.ABIRoot, '');
    return out;
};
// A declaration as its users see it: everything but its members and the
// conformances it has (the real one may add conformances and members).
const shape = (n) => {
    const { children, conformances, accessors, ...rest } = n;
    const types = (children ?? []).filter((c) => !c.declKind).map(function type(t) {
        const { children: tc, ...tr } = t;
        return { ...tr, ...(tc ? { children: tc.map(type) } : {}) };
    });
    const acc = (accessors ?? []).map((a) => a.accessorKind ?? a.name);
    return JSON.stringify({ ...rest, types, acc });
};
const ourDecls = decls(ours);
const realDecls = decls(real);
const symbolProblems = [];
const apiList = [];
let compared = 0;
for (const [usr, { node, parent }] of ourDecls) {
    if (node.implicit) continue;
    compared++;
    const full = `${parent ? parent + '.' : ''}${node.printedName}`;
    const other = realDecls.get(usr);
    if (!other) symbolProblems.push(`${node.declKind} ${full}: no declaration with USR ${usr} in the real XCTest`);
    else if (shape(node) !== shape(other.node)) symbolProblems.push(`${node.declKind} ${full} differs:\n  ours ${shape(node)}\n  real ${shape(other.node)}`);
    else {
        const missing = (node.conformances ?? []).map((c) => c.usr).filter((u) => !(other.node.conformances ?? []).some((c) => c.usr === u));
        if (missing.length) symbolProblems.push(`${full}: conformances missing in the real XCTest: ${missing.join(', ')}`);
    }
    if (!['Accessor'].includes(node.declKind)) apiList.push(`${node.declKind.padEnd(11)} ${full}`);
}
check(`symbols: all ${compared} declarations of ours have the same USR and shape in the real XCTest`, symbolProblems.length === 0, symbolProblems.join('\n'));

// ------------------------------------------------------------ 3. source

const corelibs = join(CACHE, `swift-corelibs-xctest-${TAG}`);
if (!existsSync(join(corelibs, 'Sources/XCTest'))) {
    rmSync(corelibs, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', TAG, '-c', 'advice.detachedHead=false',
        'https://github.com/swiftlang/swift-corelibs-xctest.git', corelibs], { stdio: 'inherit' });
}
const swiftFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? swiftFiles(join(dir, e.name)) : e.name.endsWith('.swift') ? [join(dir, e.name)] : []);
const realHeaders = new Set(swiftFiles(join(corelibs, 'Sources/XCTest')).flatMap((f) => publicHeaders(readFileSync(f, 'utf8'))));
const ourHeaders = ourSources.flatMap((f) => publicHeaders(readFileSync(f, 'utf8')));
const unmatched = ourHeaders.filter((h) => !realHeaders.has(h));
check(`source: all ${ourHeaders.length} public declarations of ours are written exactly so in swift-corelibs-xctest ${TAG}`,
    unmatched.length === 0 && ourHeaders.length > 0, unmatched.join('\n'));

// ------------------------------------------------------------ 4. corpus

const api = join(CORPUS, 'API.swift');
const tc = (args) => sh('swiftc', ['-typecheck', '-warnings-as-errors', '-target', TARGET, ...args, api]);
r = tc(['-I', mod]);
check('corpus: API.swift type-checks against ours (native Swift 6.4.1)', r.status === 0, r.stderr);
r = tc([]);
check('corpus: API.swift type-checks against the real XCTest (native Swift 6.4.1)', r.status === 0, r.stderr);
r = await typecheckInBrowserToolchain(api);
check('corpus: API.swift type-checks against ours as the browser has it (swift-frontend.wasm 6.3.3, swift-xctest.tar)', r.code === 0, r.out);
const corpusTokens = new Set(readFileSync(api, 'utf8').match(/[A-Za-z_]\w*/g));
const names = [...new Set([...ourDecls.values()].filter(({ node }) => !node.implicit && node.declKind !== 'Accessor')
    .map(({ node }) => node.name).filter((n) => /^[A-Za-z_]/.test(n) && n !== 'init'))];
const uncovered = names.filter((n) => !corpusTokens.has(n));
check(`corpus: API.swift uses all ${names.length} public names of ours`, uncovered.length === 0, uncovered.join(', '));

// ------------------------------------------------------------ 5. behaviour

const run = (label, args, libs = []) => {
    const dir = join(tmp, `behaviour-${label}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'main.swift'), 'import XCTest\nXCTMain(behaviourTests)\n');
    const b = sh('swiftc', ['-module-name', 'main', ...args, 'Behaviour.swift', join(dir, 'main.swift'), ...libs, '-o', join(dir, 'tests')], { cwd: CORPUS });
    if (b.status !== 0) return { code: -1, out: b.stderr };
    const p = sh(join(dir, 'tests'), [], { cwd: CORPUS });
    return { code: p.status, out: p.stdout };
};
// Relative paths, so #file is the same in both; then dates, times and the bundle blanked.
const normal = (text) => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/g, 'DATE').replace(/\(\d+(\.\d+)? seconds\)/g, '(T seconds)')
    .replace(/in \d+(\.\d+)? \(\d+(\.\d+)?\) seconds/g, 'in T (T) seconds').replace(/^Test Suite '[^']*\.xctest'/gm, "Test Suite 'BUNDLE.xctest'");
const mine = run('ours', ['-I', mod], [join(mod, 'libOursXCTest.a'), '-lm']); // libm: the module imports no libc, wasm-ld links -lm anyway
const theirs = run('real', []);
const a = normal(theirs.out).split('\n');
const b = normal(mine.out).split('\n');
const diff = [];
for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(`line ${i + 1}\n  real ${a[i]}\n  ours ${b[i]}`);
check(`behaviour: Behaviour.swift prints the same ${a.length - 1} lines and exits the same with both`,
    mine.code === theirs.code && diff.length === 0 && a.length > 10, `exit real ${theirs.code} ours ${mine.code}\n${diff.slice(0, 10).join('\n')}`);

const golden = join(CORPUS, 'Behaviour.expected');
if (process.env.UPDATE) writeFileSync(golden, normal(theirs.out));
check('behaviour: the real XCTest\'s report is xctest/conformance/Behaviour.expected (which test-run.mjs checks the browser against)',
    existsSync(golden) && readFileSync(golden, 'utf8') === normal(theirs.out), 'rewrite it with UPDATE=1 if the real XCTest changed');

console.log(`\nThe public API of the browser's XCTest (${apiList.length} declarations, from swift-api-digester):`);
for (const line of apiList.sort()) console.log(`  ${line}`);
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed: the browser\'s XCTest is a subset of the real one');
process.exit(failed ? 1 : 0);

// ------------------------------------------------------------ helpers

/**
 * The public and open declarations of a Swift source file, as normalised
 * header text: attributes and modifiers through the signature, up to the
 * body's `{` (or the end of the line for a property or typealias), with
 * comments removed, whitespace collapsed, and the enclosing type's name in
 * front ("XCTestCase: open override var name: String"). `#if` lines are
 * dropped so that both branches count.
 */
function publicHeaders(source) {
    // Comments out (strings kept: default values and attribute arguments are
    // compared), #if/#else/#endif lines out.
    let text = '';
    for (let i = 0; i < source.length;) {
        if (source[i] === '"') {
            const multi = source.startsWith('"""', i);
            const close = multi ? '"""' : '"';
            let j = i + close.length;
            while (j < source.length && !source.startsWith(close, j)) j += source[j] === '\\' ? 2 : 1;
            text += source.slice(i, j + close.length);
            i = j + close.length;
        } else if (source.startsWith('//', i)) {
            while (i < source.length && source[i] !== '\n') i++;
        } else if (source.startsWith('/*', i)) {
            const e = source.indexOf('*/', i + 2);
            i = e < 0 ? source.length : e + 2;
        } else text += source[i++];
    }
    text = text.split('\n').filter((l) => !/^\s*#(if|elseif|else|endif)\b/.test(l)).join('\n');

    const headers = [];
    const scopes = []; // names of enclosing types ('' for other braces); `public extension` marks members public
    let pending = null;
    const KEYWORDS = /^(func|init|var|let|class|struct|enum|protocol|typealias|subscript|extension)$/;
    const words = [...text.matchAll(/"(?:[^"\\\n]|\\.)*"|[A-Za-z_]\w*|@\w+|[{}()\[\]<>]|\n|./g)];
    let depth = 0; // ( [ nesting, to find the body's { (not < >: `->` would count)
    for (let k = 0; k < words.length; k++) {
        const w = words[k][0];
        if (w === '{') {
            scopes.push(pending ?? { name: '', isPublic: false });
            pending = null;
        } else if (w === '}') scopes.pop();
        else if (KEYWORDS.test(w) && (scopes.length === 0 || scopes[scopes.length - 1].name)) {
            if (w === 'class' && /^(func|var|let|subscript|override|final)$/.test(nextWord(words, k))) continue;
            // Back over modifiers and attributes (with their arguments).
            let s = k;
            const mods = [];
            for (let j = k - 1; j >= 0; j--) {
                const p = words[j][0];
                if (/^\s$/.test(p)) continue;
                if (/^(public|open|private|fileprivate|internal|static|class|final|override|required|convenience|mutating|nonisolated|dynamic)$/.test(p) || p.startsWith('@')) {
                    mods.push(p);
                    s = j;
                } else if (p === ')') {
                    let d = 0, q = j;
                    for (; q >= 0; q--) {
                        if (words[q][0] === ')') d++;
                        else if (words[q][0] === '(' && --d === 0) break;
                    }
                    const before = words.slice(0, q).reverse().find((x) => !/^\s$/.test(x[0]))?.[0];
                    if (!before || !(before.startsWith('@') || /^(private|fileprivate|internal|public|open|nonisolated)$/.test(before))) break;
                    j = q;
                    s = q;
                } else break;
            }
            const scope = scopes[scopes.length - 1];
            const isPublic = mods.includes('public') || mods.includes('open') || (scope?.isPublic && !mods.some((m) => /private|internal/.test(m)));
            // The header ends at the body's { or, for a property or typealias, at the line end.
            let e = k + 1;
            depth = 0;
            for (; e < words.length; e++) {
                const x = words[e][0];
                if (x === '(' || x === '[') depth++;
                else if (x === ')' || x === ']') depth--;
                else if (depth <= 0 && (x === '{' || (x === '\n' && /^(var|let|typealias)$/.test(w) && !/[,:=]\s*$/.test(text.slice(words[s].index, words[e].index))))) break;
            }
            const header = text.slice(words[s].index, words[e]?.index ?? text.length).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/,\)/g, ')').trim();
            if (/^(class|struct|enum|protocol|extension)$/.test(w)) {
                pending = { name: nextWord(words, k), isPublic: w === 'extension' && mods.includes('public') };
            }
            if (isPublic) headers.push(`${scopes.map((x) => x.name).filter(Boolean).join('.') || '(top level)'}: ${header}`);
            k = e - 1;
        }
    }
    return headers;
}

function nextWord(words, k) {
    for (let j = k + 1; j < words.length; j++) if (!/^\s$/.test(words[j][0])) return words[j][0];
    return '';
}

/** `swift-frontend.wasm -typecheck` of one file with the browser's XCTest, under Node, as typecheck.js runs it. */
async function typecheckInBrowserToolchain(file) {
    const tcjs = await import('../src/toolchain.js');
    const frontend = await WebAssembly.compile(readFileSync(join(STATIC, 'swift-frontend.wasm')));
    const root = new tcjs.Directory(new Map());
    tcjs.untar(root, new Uint8Array(readFileSync(join(STATIC, 'swift-sysroot.tar'))), tcjs.SYSROOT);
    tcjs.untar(root, new Uint8Array(readFileSync(join(STATIC, 'swift-xctest.tar'))), tcjs.SYSROOT);
    tcjs.mkdirp(root, '/tmp');
    tcjs.writeFile(root, '/workspace/API.swift', readFileSync(file));
    const out = tcjs.textSink();
    const code = await tcjs.runWasi(frontend, { args: [...tcjs.typecheckArgs(['/workspace/API.swift']), '-warnings-as-errors'], root, stdout: out, stderr: out });
    return { code, out: out.text };
}
