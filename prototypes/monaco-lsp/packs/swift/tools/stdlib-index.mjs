// Builds swift-stdlib-index.json, the language server's knowledge of the
// standard library: the members of the types students use (Array, String,
// Int, Dictionary, ...), the protocols those members come from, and the free
// functions (print, min, max, ...), each with its declaration and doc comment.
//
//   node tools/stdlib-index.mjs <symbol-graph-dir> <out.json>
//
// <symbol-graph-dir> holds Swift.symbols.json and its extension graphs
// (_StringProcessing@Swift.symbols.json, ...), written by the native
// `swift-symbolgraph-extract` from the *6.3.3* stdlib's .swiftinterface (see
// build.sh), so the list is exactly what the in-browser 6.3.3 compiler
// accepts. The compiler answers "what type is this expression"; this index
// answers "what can follow its dot" for library types, which the frontend
// cannot list as a batch tool (that is sourcekitd's code completion).
//
// Synthesized members (`...::SYNTHESIZED::s:Sa`, a protocol extension's
// method as a member of Array) are what make a type's list complete: Array
// gets map, filter, reduce, sorted from Sequence and Collection that way.
// Their generic constraints are kept (`Element:Comparable`), so the server
// can leave out `sorted()` on an array of a type that is not Comparable.
//
// Size is the point of most choices here: one doc string table (a protocol
// default implementation is documented once, however many types inherit
// it), members as arrays, unsafe/underscored/deprecated API left out.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
    console.error('usage: node tools/stdlib-index.mjs <symbol-graph-dir> <out.json>');
    process.exit(2);
}

/** The types whose members are listed, by their path in the stdlib. */
const TYPES = [
    'Array', 'ArraySlice', 'Dictionary', 'Dictionary.Keys', 'Dictionary.Values', 'Set', 'String', 'Substring', 'Character',
    'String.Index', 'Unicode.Scalar', 'Int', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
    'Double', 'Float', 'Bool', 'Optional', 'Result', 'Range', 'ClosedRange', 'EnumeratedSequence', 'ReversedCollection',
    'Zip2Sequence', 'StrideTo', 'StrideThrough', 'FloatingPointSign', 'Never', 'Slice',
];
/** Protocols: for user types that conform to them, and for generic code. */
const PROTOCOLS = [
    'Sequence', 'Collection', 'BidirectionalCollection', 'RandomAccessCollection', 'MutableCollection',
    'RangeReplaceableCollection', 'StringProtocol', 'IteratorProtocol', 'Equatable', 'Hashable', 'Comparable', 'Identifiable',
    'CustomStringConvertible', 'CustomDebugStringConvertible', 'Error', 'CaseIterable', 'RawRepresentable', 'Numeric',
    'SignedNumeric', 'AdditiveArithmetic', 'BinaryInteger', 'SignedInteger', 'UnsignedInteger', 'FixedWidthInteger',
    'FloatingPoint', 'BinaryFloatingPoint', 'Strideable', 'OptionSet', 'SetAlgebra', 'LosslessStringConvertible', 'Sendable',
    'Encodable', 'Decodable', 'ExpressibleByArrayLiteral', 'ExpressibleByStringLiteral', 'ExpressibleByIntegerLiteral',
];
/** Free functions students call. Everything else top-level is left out. */
const FUNCTIONS = new Set([
    'print', 'debugPrint', 'dump', 'min', 'max', 'abs', 'zip', 'stride', 'readLine', 'swap', 'precondition',
    'preconditionFailure', 'assert', 'assertionFailure', 'fatalError', 'repeatElement', 'sequence', 'type',
    'numericCast', 'withExtendedLifetime', 'isKnownUniquelyReferenced',
]);

/** API a student does not reach for, and that would crowd the list. */
const hidden = (title) =>
    title.startsWith('_') || /Unsafe|unsafe|[sS]pan\b|Span\(|^span$|^mutableSpan$|^utf8Span$|ContiguousStorage|withContiguous|^customMirror$|^customPlaygroundQuickLook$|^encode\(to:\)$|^init\(from:\)$|^init\(_builtin|^init\(unicodeScalarLiteral|^init\(extendedGraphemeClusterLiteral|^init\(nilLiteral|^init\(integerLiteral|^init\(floatLiteral|^init\(booleanLiteral|^init\(stringLiteral|^init\(arrayLiteral|^init\(dictionaryLiteral|^init\(stringInterpolation|^init\(_?legacy|Atomic|_[a-z]+:\)/.test(title);

const graphs = readdirSync(dir).filter((f) => f.endsWith('.symbols.json')).sort((a, b) => (a === 'Swift.symbols.json' ? -1 : b === 'Swift.symbols.json' ? 1 : a < b ? -1 : 1));
const symbols = new Map();
const memberOf = new Map(); // target id -> [source ids]
const fromExtensionGraph = new Set(); // ids of symbols declared by another module (_StringProcessing)
const conformsTo = new Map(); // type id -> [protocol names]
const inherits = new Map(); // protocol id -> [protocol names]
for (const file of graphs) {
    const g = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    for (const s of g.symbols) {
        symbols.set(s.identifier.precise, s);
        if (file !== 'Swift.symbols.json') fromExtensionGraph.add(s.identifier.precise);
    }
    for (const r of g.relationships) {
        const add = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);
        // A protocol's requirements are `requirementOf` it, its extension's members `memberOf` it.
        if (r.kind === 'memberOf' || r.kind === 'requirementOf') add(memberOf, r.target, r.source);
        else if (r.kind === 'conformsTo') add(conformsTo, r.source, r.targetFallback ?? symbols.get(r.target)?.names.title ?? r.target);
        else if (r.kind === 'inheritsFrom') add(inherits, r.source, r.targetFallback ?? r.target);
    }
}
const byPath = new Map();
for (const s of symbols.values()) {
    if (!/^swift\.(struct|enum|protocol|class)$/.test(s.kind.identifier) || s.identifier.precise.includes('::SYNTHESIZED::')) continue;
    byPath.set(s.pathComponents.join('.'), s);
}

const text = (fragments) => (fragments ?? []).map((f) => f.spelling).join('');
const docs = [];
const docIndex = new Map();
/** A doc comment as markdown (its indented examples are already code blocks), by index into `docs`. */
function doc(s) {
    const lines = s.docComment?.lines?.map((l) => l.text);
    if (!lines?.length) return -1;
    const md = lines.join('\n').trim();
    if (!docIndex.has(md)) {
        docIndex.set(md, docs.length);
        docs.push(md);
    }
    return docIndex.get(md);
}

const unavailable = (s) => (s.availability ?? []).some((a) => a.isUnconditionallyUnavailable || a.isUnconditionallyDeprecated || a.obsoleted ||
    (a.deprecated && !a.domain) || a.domain === 'Swift' && a.introduced && (a.introduced.major > 6 || (a.introduced.major === 6 && a.introduced.minor > 3)));
const KIND = {
    'swift.method': 'm', 'swift.property': 'p', 'swift.init': 'i', 'swift.type.method': 'M', 'swift.type.property': 'P',
    'swift.enum.case': 'c', 'swift.subscript': 's', 'swift.func': 'f', 'swift.associatedtype': 't', 'swift.typealias': 't',
};

/**
 * A constraint as `lhs:Protocol` or `lhs==Type`, with `Self.` dropped
 * (`Self.Element:Comparable` -> `Element:Comparable`), which is how the
 * server substitutes the type's own generic arguments.
 */
const constraint = (c) => `${c.lhs.replace(/^Self\./, '')}${c.kind === 'conformance' ? ':' : c.kind === 'sameType' ? '==' : ':'}${c.rhs}`;

/**
 * One member: [title, kind, declaration, doc, constraints?]. The parameters'
 * types for a completion snippet are read from the declaration by the server.
 */
function member(s, own) {
    const kind = KIND[s.kind.identifier];
    if (!kind || kind === 't' || hidden(s.names.title) || unavailable(s)) return null;
    let decl = text(s.declarationFragments).replace(/\s+/g, ' ');
    if (/Unsafe|Span\b|Span</.test(decl)) return null; // raw memory and spans: not for a first course
    // `@inlinable public func` -> `func`: the attributes say nothing to a reader of a hover.
    decl = decl.replace(/^(@\w+(\([^)]*\))? )+/, '');
    // A synthesized member's constraints are on its extension (`extension
    // Sequence where Element: Sequence`), a generic method's on itself.
    const where = [...new Map([...(s.swiftExtension?.constraints ?? []), ...(s.swiftGenerics?.constraints ?? [])].map((c) => [constraint(c), c])).values()]
        .filter((c) => !/^(Copyable|Escapable|BitwiseCopyable)$/.test(c.rhs))
        // A method's own generic parameters (`<T>` in map) constrain nothing about the receiver.
        .filter((c) => !own || /^Self\b/.test(c.lhs) || !/^[A-Z]\w*$/.test(c.lhs) || own.includes(c.lhs.replace(/^Self\./, '').split('.')[0]))
        .map(constraint);
    const row = [s.names.title, kind, decl, doc(s)];
    if (where.length) row.push(where);
    return row;
}

/** Every protocol a type conforms to, directly or through other protocols, by name. */
function conformanceClosure(id) {
    const out = new Set();
    const visit = (x) => {
        for (const p of [...(conformsTo.get(x) ?? []), ...(inherits.get(x) ?? [])]) {
            if (out.has(p)) continue;
            out.add(p);
            const ps = byPath.get(p);
            if (ps) visit(ps.identifier.precise);
        }
    };
    visit(id);
    return out;
}

/**
 * The members of a type or protocol, overloads included, in title order.
 * Another module's extensions of a protocol (_StringProcessing's
 * `contains(_:)`, `split(separator:)`, `replacing(_:with:)` on Collection)
 * are not synthesized into the conforming types by the symbol graph, so a
 * concrete type gets them here, from every protocol it conforms to.
 */
function members(id, generics, concrete) {
    const seen = new Set();
    const rows = [];
    const sources = [...(memberOf.get(id) ?? [])];
    if (concrete) {
        for (const p of conformanceClosure(id)) {
            const ps = byPath.get(p);
            for (const m of (ps && memberOf.get(ps.identifier.precise)) ?? []) if (fromExtensionGraph.has(m)) sources.push(m);
        }
    }
    for (const m of sources) {
        const s = symbols.get(m);
        if (!s) continue;
        const row = member(s, generics);
        if (!row) continue;
        const key = `${row[0]}|${row[2]}|${(row[4] ?? []).join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
    }
    return rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const types = {};
for (const path of [...TYPES, ...PROTOCOLS]) {
    const s = byPath.get(path);
    if (!s) {
        console.error(`stdlib-index: no ${path} in the symbol graph`);
        continue;
    }
    const id = s.identifier.precise;
    const generics = (s.swiftGenerics?.parameters ?? []).map((p) => p.name);
    const protocol = s.kind.identifier === 'swift.protocol';
    types[path] = {
        kind: s.kind.identifier.slice(6),
        decl: text(s.declarationFragments).replace(/^(@\w+(\([^)]*\))? )+/, ''),
        doc: doc(s),
        ...(generics.length ? { generics } : {}),
        conforms: [...new Set([...(conformsTo.get(id) ?? []), ...(inherits.get(id) ?? [])])].filter((p) => !p.startsWith('_')).sort(),
        members: members(id, protocol ? ['Self'] : generics, !protocol),
    };
}

const globals = [];
const seenGlobal = new Set();
for (const s of symbols.values()) {
    if (s.kind.identifier !== 'swift.func' || s.pathComponents.length !== 1) continue;
    const name = s.names.title.replace(/\(.*$/, '');
    if (!FUNCTIONS.has(name)) continue;
    const row = member(s, null);
    if (!row) continue;
    const key = `${row[0]}|${row[2]}`;
    if (seenGlobal.has(key)) continue;
    seenGlobal.add(key);
    globals.push(row);
}
globals.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const index = { swift: '6.3.3', docs, types, globals };
writeFileSync(out, JSON.stringify(index));
const count = Object.values(types).reduce((n, t) => n + t.members.length, 0);
console.log(`stdlib-index: ${Object.keys(types).length} types and protocols, ${count} members, ${globals.length} functions, ${docs.length} doc comments, ${JSON.stringify(index).length} bytes`);
