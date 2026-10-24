// Trims swift-toolchain-wasm's swift-sysroot-core.tar (103 MB, 2,997
// entries) to what compiling and linking a Foundation-free Swift program
// needs, and writes a plain ustar archive:
//
//   node tools/trim-sysroot.mjs <in.tar> <out.tar> [extra-dir-to-add prefix]
//
// The rules below come from tracing every path_open/path_filestat_get that
// the compiler and wasm-ld.wasm make (tools/bench.mjs with a trace
// file) while compiling the sample, a program importing WASILibc,
// Synchronization and RegexBuilder, and -typecheck runs; see README.md. The
// .swiftdoc files are kept for sourcekitd, see below.
// What is dropped and why:
//   * Foundation's C modules (CoreFoundation, _FoundationCShims,
//     _foundation_unicode: 2.8 MB of ICU tables alone) and libCoreFoundation.a:
//     the core sysroot has no Foundation.swiftmodule, so nothing can use them;
//     clang still found and parsed their module maps on every compile.
//   * libc++ headers (1,772 files), libxml2, swift-testing, cmake/pkgconfig,
//     the embedded-Swift modules, Cxx/Distributed/_Differentiation modules
//     (C++ interop is off for user code; the other two are rarely used).
//     swift-testing goes because its library needs Foundation (README,
//     "Macros"). Observation stays: its @Observable is one of the macros the
//     compiler expands (SwiftMacroPlugins.wasm), and its module and archive
//     are 0.2 MB.
//   * clang's target-specific intrinsic headers (x86, ARM, PowerPC, Hexagon,
//     RISC-V, CUDA, OpenCL...): their modules `require` another target, so
//     clang never reads them for wasm32.
//   * .swiftinterface files: the binary .swiftmodule is what the compiler
//     loads. Exception: _Concurrency's and _StringProcessing's
//     .private.swiftinterface, which the frontend opens on every compile.
// Kept although the compiler does not need them: the kept modules' .swiftdoc
// files, the standard library's doc comments, which sourcekitd shows in
// hover and completion (5.4 MB raw, about 1 MB brotli; without them a
// stdlib hover is the bare declaration).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [input, output, extraDir, extraPrefix] = process.argv.slice(2);

const KEEP_MODULES = ['Swift', 'SwiftOnoneSupport', '_Concurrency', '_StringProcessing', '_RegexParser',
    'WASILibc', '_Builtin_float', 'Synchronization', 'RegexBuilder', '_Volatile', 'Observation'];
const KEEP_ARCHIVES = ['swiftCore', 'swiftSwiftOnoneSupport', 'swift_Concurrency', 'swift_StringProcessing',
    'swift_RegexParser', 'swiftWASILibc', 'swift_Builtin_float', 'swiftSynchronization', 'swiftRegexBuilder',
    'swift_Volatile', 'swiftObservation'].map((n) => `lib${n}.a`);
const KEEP_LIBC = ['crt1-command.o', 'libc.a', 'libc.imports', 'libdl.a', 'libm.a', 'libc++.a', 'libc++abi.a',
    'libwasi-emulated-mman.a', 'libwasi-emulated-signal.a', 'libwasi-emulated-process-clocks.a',
    'libwasi-emulated-getpid.a', 'libsetjmp.a'];
const PORTABLE_CLANG_HEADER = /^(module\.modulemap|__float_.*|__stdarg_.*|__stddef_.*|availability_domain\.h|bounds_safety_soft_traps\.h|builtins\.h|feature-availability\.h|float\.h|inttypes\.h|iso646\.h|lifetimebound\.h|limits\.h|ptrauth\.h|ptrcheck\.h|std[a-z]*\.h|tgmath\.h|unwind\.h|varargs\.h|wasm_simd128\.h)$/;

/** True for paths (relative, no leading ./) that the trimmed sysroot keeps. */
function keep(path, isDir) {
    const S = 'swift/lib/swift_static/';
    if (isDir) return true; // directories are free; empty ones are pruned below
    if (path.startsWith('wasi-sysroot/include/wasm32-wasip1/')) return true;
    if (path.startsWith('wasi-sysroot/lib/wasm32-wasip1/')) return KEEP_LIBC.includes(path.split('/').pop());
    if (path.startsWith(S + 'shims/') || path.startsWith(S + 'apinotes/')) return true;
    if (path.startsWith(S + 'clang/include/')) {
        const rest = path.slice((S + 'clang/include/').length);
        return !rest.includes('/') && PORTABLE_CLANG_HEADER.test(rest);
    }
    if (path === S + 'clang/lib/wasip1/libclang_rt.builtins-wasm32.a') return true;
    if (path.startsWith(S + 'wasi/wasm32/')) return true;
    if (path.startsWith(S + 'wasi/')) {
        const rest = path.slice((S + 'wasi/').length);
        const m = /^([^/]+)\.swiftmodule\/(.*)$/.exec(rest);
        if (m) {
            if (!KEEP_MODULES.includes(m[1])) return false;
            if (m[2].endsWith('.swiftmodule') || m[2].endsWith('.swiftdoc')) return true;
            return m[2].endsWith('.private.swiftinterface') && (m[1] === '_Concurrency' || m[1] === '_StringProcessing');
        }
        return KEEP_ARCHIVES.includes(rest);
    }
    return false;
}

// ---------------------------------------------------------------- tar in

const tar = readFileSync(input);
const entries = []; // { path, data|null (dir) }
const str = (o, n) => {
    let e = o;
    while (e < o + n && tar[e] !== 0) e++;
    return tar.subarray(o, e).toString('utf8');
};
let off = 0, longName = null, paxPath = null, total = 0;
while (off + 512 <= tar.length && tar[off] !== 0) {
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[off + 156] || 48);
    const pre = str(off + 345, 155);
    const name = longName ?? paxPath ?? (pre ? `${pre}/${str(off, 100)}` : str(off, 100));
    const data = off + 512;
    if (type === 'L') longName = tar.subarray(data, data + size).toString('utf8').replace(/\0+$/, '');
    else if (type === 'x') paxPath = /\d+ path=([^\n]*)\n/.exec(tar.subarray(data, data + size).toString('utf8'))?.[1] ?? null;
    else if (type !== 'g') {
        longName = paxPath = null;
        const path = name.replace(/^\.?\//, '').replace(/\/+$/, '');
        if (type === '1' || type === '2') throw new Error(`links are not expected: ${path}`);
        total++;
        if (path) entries.push({ path, data: type === '5' ? null : tar.subarray(data, data + size) });
    }
    off = data + Math.ceil(size / 512) * 512;
}

let kept = entries.filter((e) => keep(e.path, e.data === null));
if (extraDir) {
    const walk = (dir) => readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? [{ path: `${extraPrefix}/${relative(extraDir, p)}`, data: null }, ...walk(p)]
            : [{ path: `${extraPrefix}/${relative(extraDir, p)}`, data: readFileSync(p) }];
    });
    kept.push({ path: extraPrefix, data: null }, ...walk(extraDir));
}
// Drop directories that end up empty.
const files = kept.filter((e) => e.data);
kept = kept.filter((e) => e.data || files.some((f) => f.path.startsWith(e.path + '/')));

// ---------------------------------------------------------------- tar out (ustar)

const blocks = [];
for (const e of kept) {
    const path = e.data ? e.path : e.path + '/';
    const h = Buffer.alloc(512);
    let name = path, prefix = '';
    if (Buffer.byteLength(path) > 100) {
        // ustar: split at a '/' so that prefix <= 155 and name <= 100 bytes.
        let i = -1;
        for (let j = path.lastIndexOf('/', 155); j > 0; j = path.lastIndexOf('/', j - 1)) {
            if (path.length - j - 1 <= 100) { i = j; break; }
        }
        if (i < 0) throw new Error(`path too long for ustar: ${path}`);
        prefix = path.slice(0, i);
        name = path.slice(i + 1);
    }
    h.write(name, 0, 100);
    h.write(e.data ? '0000444\0' : '0000755\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write((e.data ? e.data.length : 0).toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.data ? '0' : '5', 156);
    h.write('ustar\0' + '00', 257);
    h.write(prefix, 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h);
    if (e.data) {
        blocks.push(e.data);
        if (e.data.length % 512) blocks.push(Buffer.alloc(512 - (e.data.length % 512)));
    }
}
blocks.push(Buffer.alloc(1024));
const out = Buffer.concat(blocks);
writeFileSync(output, out);
console.log(`${input}: ${total} entries, ${tar.length} bytes -> ${output}: ${kept.length} entries (${files.length} files), ${out.length} bytes`);
