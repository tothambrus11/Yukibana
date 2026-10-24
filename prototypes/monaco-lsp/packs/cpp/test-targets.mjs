// Tests the C/C++ pack's targets (README, "Targets") with the shipped files
// in app/static/packs/cpp:
//
//   1. which target a compile_flags.txt names (src/targets.js), on the
//      cases in tests/fixtures/target-cases.json, which the app's copy of
//      the rule must also pass, and the message for an unsupported one;
//   2. the arguments Run and the views compile with (toolchain.js
//      compileArgs): the default target's exactly as before targets existed;
//   3. per Linux target, in Node, with cc-cross.wasm and targets/<arch>/:
//      the include search order clang prints with -v; the app's sample, a
//      C program, exceptions caught and uncaught, and four threads compiled,
//      linked (toolchain.js linkLinux: clang -### then ld.lld) into a static
//      ELF for the right machine, and run by an oracle, the host for x86-64
//      and QEMU's user mode (qemu-<arch>-static, QEMU_USER_DIR or PATH; on
//      Debian and Ubuntu, `apt install qemu-user-static`) for the others,
//      which must print what the program should; and the views' flags
//      (-gline-tables-only -fno-discard-value-names) leave the object's
//      code and data sections and their relocations byte-for-byte as Run's
//      compile makes them (for WebAssembly, the assembly's code and data
//      lines);
//   4. the explorer worker (explorer.js) in headless Chromium: IR and
//      assembly for every target, demangled, only the newest request
//      answered, errors as results.
//
//   node --test test-targets.mjs
//
// Parts 3 and 4 skip, saying why, when cc-cross.wasm or targets/ are not
// built. A missing oracle is a failure, naming what to install, unless
// ALLOW_SKIP=1, which skips those runs instead: a pass must not hide that
// half of the programs never ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TARGETS, DEFAULT_TARGET, targetOf, unsupportedMessage } from './src/targets.js';
import { compileArgs, createToolchain, linkLinux } from './src/toolchain.js';
import { PROPERTIES } from './tests/fixtures/properties.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const OUT = join(STATIC, 'packs/cpp');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const SAMPLE = JSON.parse(readFileSync(join(HERE, 'tests/fixtures/sample.json'), 'utf8'));
const CASES = JSON.parse(readFileSync(join(HERE, 'tests/fixtures/target-cases.json'), 'utf8'));
const LINUX = TARGETS.filter((t) => t.runtime === 'linux');
const MACHINE = { x86_64: 62, aarch64: 183, riscv64: 243 }; // ELF e_machine

const missing = ['cc-cross.js', 'cc-cross.wasm', ...LINUX.flatMap((t) => [`targets/${t.arch}/include.tar`, `targets/${t.arch}/lib.tar`])]
    .filter((f) => !existsSync(join(OUT, f)));
const notBuilt = missing.length ? `not built yet: ${missing.join(', ')}` : false;
/** Why a target's test frameworks cannot be linked: build-test-frameworks-linux.sh has not run. */
const frameworksMissing = (target) => {
    const gone = ['gtest.tar', 'rapidcheck.tar'].map((f) => `targets/${target.arch}/${f}`).filter((f) => !existsSync(join(OUT, f)));
    return gone.length ? `not built yet: ${gone.join(', ')} (build-test-frameworks-linux.sh)` : false;
};

const withTarget = (files, target) => ({ ...files, 'compile_flags.txt': `--target=${target.triple}\n${files['compile_flags.txt'] ?? ''}` });

// 1. Which target.

test('compile_flags.txt names the target the way clang reads it: every case of target-cases.json', () => {
    for (const c of CASES) {
        const r = targetOf(c.flags === null ? {} : { 'compile_flags.txt': c.flags });
        const got = r.kind === 'unsupported' ? { kind: r.kind, triple: r.triple } : { kind: r.kind, id: r.target.id };
        assert.deepEqual(got, c.expect, c.name);
    }
    assert.equal(DEFAULT_TARGET.id, 'wasm32-wasi');
    assert.deepEqual(targetOf(undefined), { kind: 'default', target: DEFAULT_TARGET });
});

test('a target nobody built is refused by name, with the list of those there are', () => {
    assert.equal(unsupportedMessage('armv7-linux-musleabihf'),
        'Unsupported target "armv7-linux-musleabihf" in compile_flags.txt; supported: wasm32-wasip1, x86_64-linux-musl, aarch64-linux-musl, riscv64-linux-musl (or no --target).\n');
});

test('every target row is complete, and the triples are the ones clang normalises to the multiarch names', () => {
    const ids = new Set();
    for (const t of TARGETS) {
        assert.ok(!ids.has(t.id), t.id);
        ids.add(t.id);
        assert.ok(t.label && t.triple && t.compiler, t.id);
        if (t.runtime === 'linux') {
            assert.equal(t.triple, `${t.arch}-linux-musl`);
            assert.equal(t.multiarch, `${t.arch}-linux-gnu`);
            assert.equal(t.compiler, 'cc-cross');
            assert.equal(t.asm, `asm-${t.arch}`);
        }
    }
    assert.equal(TARGETS.filter((t) => t.default).length, 1);
});

// 2. The arguments.

test('the default target compiles exactly as it did before targets existed', () => {
    assert.deepEqual(compileArgs(DEFAULT_TARGET, SAMPLE, 'main.cpp'), [
        '--target=wasm32-wasip1', '--sysroot=/wasi', '-resource-dir=/usr/lib/clang/21', '-O2', '-fwasm-exceptions',
        '-mllvm', '-wasm-use-legacy-eh=false', '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST',
        '-std=c++20', '-Wall', '-Wextra', '-I.',
    ]);
    // C: no exceptions, no libc++ hardening, no -std=c++.
    assert.deepEqual(compileArgs(DEFAULT_TARGET, { 'compile_flags.txt': '-std=c++20\n-O0\n' }, 'a.c'),
        ['--target=wasm32-wasip1', '--sysroot=/wasi', '-resource-dir=/usr/lib/clang/21', '-O0']);
});

test('a Linux target compiles with its triple, the same optimisation and hardening, and the views only add line tables', () => {
    const [x86] = LINUX;
    const files = withTarget(SAMPLE, x86);
    assert.deepEqual(compileArgs(x86, files, 'main.cpp'), [
        '--target=x86_64-linux-musl', '-resource-dir=/usr/lib/clang/21', '-O2', '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST',
        '--target=x86_64-linux-musl', '-std=c++20', '-Wall', '-Wextra', '-I.',
    ]);
    assert.deepEqual(compileArgs(x86, files, 'main.cpp', { view: true }), [...compileArgs(x86, files, 'main.cpp'), '-gline-tables-only', '-fno-discard-value-names']);
    assert.ok(!compileArgs(x86, { 'compile_flags.txt': '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_NONE\n' }, 'a.cpp').includes('-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST'));
});

// 3. Compile, link and run, per Linux target.

const toolchain = createToolchain({
    base: pathToFileURL(OUT + '/'),
    fetch: async (url) => new Response(readFileSync(fileURLToPath(url)), {
        headers: { 'content-type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' },
    }),
});

/**
 * Compiles every source of `files` for `target` and links them, with `libs`
 * from the toolchain `archives` named (a test framework's); resolves to the
 * ELF bytes.
 */
async function build(target, files, { libs = [], archives = [] } = {}) {
    const objects = {};
    const sources = Object.keys(files).filter((p) => /\.(c|cc|cpp|cxx)$/.test(p));
    for (const source of sources) {
        const object = `.yukibana/obj/${source}.o`;
        const r = await toolchain.tool(target, /\.c$/.test(source) ? 'clang' : 'clang++',
            [...compileArgs(target, files, source), '-c', source, '-o', object], files, [object], { quiet: true });
        assert.equal(r.code, 0, `${target.id} ${source}: ${r.text}`);
        objects[object] = r.out[object];
    }
    let stderr = '';
    const linked = await linkLinux({ ...toolchain, post: (m) => (stderr += m.text ?? '') }, objects, target,
        { cxx: sources.some((s) => !/\.c$/.test(s)), libs, archives });
    assert.equal(linked.code, 0, `${target.id} link: ${stderr}`);
    return linked.program;
}

/** The ELF header's facts a test checks: class, machine, type, and whether it asks for an interpreter. */
function elf(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46], 'ELF magic');
    const phoff = Number(view.getBigUint64(0x20, true));
    const phentsize = view.getUint16(0x36, true);
    const phnum = view.getUint16(0x38, true);
    let interp = false;
    for (let i = 0; i < phnum; i++) if (view.getUint32(phoff + i * phentsize, true) === 3) interp = true; // PT_INTERP
    return { class64: bytes[4] === 2, machine: view.getUint16(0x12, true), type: view.getUint16(0x10, true), interp };
}

/**
 * The sections of an ELF64 little-endian relocatable object, by name, as
 * `{ type, flags, bytes, info }` (`bytes` empty for SHT_NOBITS; `info` the
 * section a relocation section applies to). A relocation section's `bytes`
 * are replaced by its entries as text, each with its symbol's name (or, for
 * a section symbol, its section's), since debug sections add symbols and so
 * renumber the symbol table without changing what a relocation means.
 */
function sections(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const shoff = Number(view.getBigUint64(0x28, true));
    const shentsize = view.getUint16(0x3a, true);
    const shnum = view.getUint16(0x3c, true);
    const shstrndx = view.getUint16(0x3e, true);
    const header = (i) => {
        const at = shoff + i * shentsize;
        return {
            name: view.getUint32(at, true), type: view.getUint32(at + 4, true), flags: Number(view.getBigUint64(at + 8, true)),
            offset: Number(view.getBigUint64(at + 0x18, true)), size: Number(view.getBigUint64(at + 0x20, true)),
            link: view.getUint32(at + 0x28, true), info: view.getUint32(at + 0x2c, true),
        };
    };
    const cstring = (at) => new TextDecoder().decode(bytes.subarray(at, bytes.indexOf(0, at)));
    const names = header(shstrndx);
    const nameAt = (n) => {
        const start = names.offset + n;
        return new TextDecoder().decode(bytes.subarray(start, bytes.indexOf(0, start)));
    };
    /** Symbol `i` of the symbol table in section `symtab`, by name. */
    const symbol = (symtab, i) => {
        const tab = header(symtab);
        const at = tab.offset + i * 24;
        const info = bytes[at + 4];
        if ((info & 0xf) === 3) return `section ${nameAt(header(view.getUint16(at + 6, true)).name)}`; // STT_SECTION
        return cstring(header(tab.link).offset + view.getUint32(at, true));
    };
    const out = {};
    for (let i = 1; i < shnum; i++) {
        const h = header(i);
        let content = h.type === 8 ? new Uint8Array() : bytes.subarray(h.offset, h.offset + h.size);
        if (h.type === 4) {
            // SHT_RELA: r_offset, r_info (symbol << 32 | type), r_addend.
            const lines = [];
            for (let at = h.offset; at < h.offset + h.size; at += 24) {
                const rInfo = view.getBigUint64(at + 8, true);
                lines.push(`${view.getBigUint64(at, true)} ${rInfo & 0xffffffffn} ${symbol(h.link, Number(rInfo >> 32n))} ${view.getBigInt64(at + 16, true)}`);
            }
            content = new TextEncoder().encode(lines.join('\n'));
        }
        out[nameAt(h.name)] = { type: h.type, flags: h.flags, info: h.info, bytes: content };
    }
    return out;
}

/** How the host runs a program for `arch`: directly, or through QEMU's user mode; null when it cannot. */
function oracle(arch) {
    if (arch === process.arch.replace('x64', 'x86_64').replace('arm64', 'aarch64')) return [];
    const dirs = [process.env.QEMU_USER_DIR, ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
    for (const dir of dirs) for (const name of [`qemu-${arch}-static`, `qemu-${arch}`]) if (existsSync(join(dir, name))) return [join(dir, name)];
    return null;
}

const work = mkdtempSync(join(tmpdir(), 'yk-targets-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

/**
 * Runs `program` with the oracle. Without one it fails the test, or with
 * ALLOW_SKIP=1 marks it skipped and returns null.
 */
function run(t, target, program, stdin = '', env = process.env) {
    const via = oracle(target.arch);
    if (!via) {
        const why = `no way to run ${target.arch} programs on this host: put qemu-${target.arch}-static (apt install qemu-user-static) in PATH or QEMU_USER_DIR`;
        if (process.env.ALLOW_SKIP !== '1') assert.fail(`${why}, or set ALLOW_SKIP=1 to skip these runs`);
        t.skip(why);
        return null;
    }
    const file = join(work, `${target.id}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, program);
    chmodSync(file, 0o755);
    const [cmd, ...args] = [...via, file];
    const r = spawnSync(cmd, args, { input: stdin, encoding: 'utf8', timeout: 60_000, env });
    rmSync(file);
    return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

const PROGRAMS = {
    c: { 'hello.c': '#include <stdio.h>\nint main(void) { char name[32]; if (scanf("%31s", name) != 1) return 2; printf("hello %s from C\\n", name); return 0; }\n' },
    caught: {
        'main.cpp': '#include <cstdio>\n#include <stdexcept>\n#include <string>\nint parse(const std::string &s) { return std::stoi(s); }\n'
            + 'int main() { try { parse("x"); } catch (const std::invalid_argument &e) { std::printf("caught %s\\n", e.what()); return 3; } return 0; }\n',
    },
    uncaught: { 'main.cpp': '#include <stdexcept>\nint main() { throw std::runtime_error("boom"); }\n' },
    threads: {
        'main.cpp': '#include <atomic>\n#include <cstdio>\n#include <thread>\n#include <vector>\nint main() {\n    std::atomic<long> n{0};\n    std::vector<std::thread> pool;\n'
            + '    for (int t = 0; t < 4; t++) pool.emplace_back([&] { for (int i = 0; i < 100000; i++) n++; });\n    for (auto &t : pool) t.join();\n    std::printf("%ld\\n", n.load());\n}\n',
    },
    hardened: { 'main.cpp': '#include <vector>\nint main(int argc, char **) { std::vector<int> v(3); return v[argc + 5]; }\n' },
};

for (const target of LINUX) {
    test(`${target.label}: clang searches libc++'s headers, then the target's bits/, musl's, and clang's own`, { skip: notBuilt }, async (t) => {
        const r = await toolchain.tool(target, 'clang++', [...compileArgs(target, withTarget(SAMPLE, target), 'main.cpp'), '-v', '-fsyntax-only', 'main.cpp'],
            withTarget(SAMPLE, target), [], { quiet: true });
        assert.equal(r.code, 0, r.text);
        const list = r.text.split('#include <...> search starts here:\n')[1]?.split('End of search list.')[0].trim().split('\n').map((l) => l.trim());
        // As clang's Linux driver orders them for a musl triple: clang's own
        // headers last, after musl's (glibc triples put them before).
        const order = ['/usr/include/c++/v1', `/usr/include/${target.multiarch}`, '/usr/include', '/usr/lib/clang/21/include'];
        assert.deepEqual(list?.filter((dir) => order.includes(dir)), order, r.text);
        assert.match(r.text, new RegExp(`Target: ${target.triple.replace('-linux', '-unknown-linux')}`));
    });

    test(`${target.label}: the sample links into a static ELF for the right machine, which prints the distances`, { skip: notBuilt }, async (t) => {
        const program = await build(target, withTarget(SAMPLE, target));
        const header = elf(program);
        assert.deepEqual(header, { class64: true, machine: MACHINE[target.arch], type: header.type, interp: false });
        assert.ok(header.type === 2 || header.type === 3, `ET_EXEC or static-pie ET_DYN, got ${header.type}`);
        const r = run(t, target, program);
        if (r) assert.deepEqual([r.status, r.stdout], [0, '5.000000\n5.000000\n'], r.stderr);
    });

    test(`${target.label}: a C program links with clang, not clang++, and reads stdin`, { skip: notBuilt }, async (t) => {
        const program = await build(target, withTarget({ ...PROGRAMS.c, 'compile_flags.txt': '-std=c17\n' }, target));
        const r = run(t, target, program, 'Ada\n');
        if (r) assert.deepEqual([r.status, r.stdout], [0, 'hello Ada from C\n'], r.stderr);
    });

    test(`${target.label}: an exception is caught by its handler, and an uncaught one aborts with libc++abi's message`, { skip: notBuilt }, async (t) => {
        const caught = run(t, target, await build(target, withTarget({ ...PROGRAMS.caught, 'compile_flags.txt': '-std=c++20\n' }, target)));
        if (caught) assert.deepEqual([caught.status, caught.stdout], [3, 'caught stoi: no conversion\n'], caught.stderr);
        const uncaught = run(t, target, await build(target, withTarget({ ...PROGRAMS.uncaught, 'compile_flags.txt': '-std=c++20\n' }, target)));
        if (uncaught) {
            assert.equal(uncaught.signal ?? (uncaught.status === 134 ? 'SIGABRT' : uncaught.status), 'SIGABRT', uncaught.stderr);
            assert.match(uncaught.stderr, /terminating due to uncaught exception of type std::runtime_error: boom/);
        }
    });

    test(`${target.label}: GoogleTest and RapidCheck from targets/${target.arch}/ link, a property holds and a false one is shrunk to (1, 1)`, { skip: notBuilt || frameworksMissing(target) }, async (t) => {
        // As the runner links a Test on a Linux target: the framework's main,
        // RapidCheck, the framework (build-test-frameworks-linux.sh's archives).
        const sample = { ...SAMPLE };
        delete sample['main.cpp'];
        const linkWith = { libs: ['-lgtest_main', '-lrapidcheck', '-lgtest'], archives: [`targets/${target.arch}/gtest.tar`, `targets/${target.arch}/rapidcheck.tar`] };
        const env = { ...process.env, GTEST_COLOR: 'no' };
        const ok = run(t, target, await build(target, withTarget({ ...sample, 'tests/properties_test.cpp': PROPERTIES.gtest(false) }, target), linkWith), '', env);
        if (ok) assert.ok(ok.status === 0 && /\[  PASSED  \] 2 tests\./.test(ok.stdout), `${ok.status} ${ok.stdout} ${ok.stderr}`);
        const bad = run(t, target, await build(target, withTarget({ ...sample, 'tests/properties_test.cpp': PROPERTIES.gtest(true) }, target), linkWith), '', env);
        if (bad) {
            assert.equal(bad.status, 1, bad.stdout + bad.stderr);
            assert.match(bad.stdout, /Falsifiable after \d+ tests? and \d+ shrinks?\s+std::tuple<int, int>:\s+\(1, 1\)/);
            assert.match(bad.stdout, /\[  FAILED  \] GeometryProperties\.NormIsAWholeNumber/);
        }
    });

    test(`${target.label}: four threads count to 400000`, { skip: notBuilt }, async (t) => {
        const r = run(t, target, await build(target, withTarget({ ...PROGRAMS.threads, 'compile_flags.txt': '-std=c++20\n' }, target)));
        if (r) assert.deepEqual([r.status, r.stdout], [0, '400000\n'], r.stderr);
    });

    test(`${target.label}: the views' flags change no byte of the code or data clang emits, at -O0 and -O2`, { skip: notBuilt }, async () => {
        // The views compile with Run's arguments plus -gline-tables-only and
        // -fno-discard-value-names (compileArgs { view: true }). Both must
        // leave codegen alone: every allocated section (code, read-only and
        // writable data, exception tables, init arrays) and every relocation
        // against it must be identical; only debug sections may be added.
        for (const opt of ['-O0', '-O2']) {
            const files = withTarget({ ...SAMPLE, 'compile_flags.txt': `${opt}\n${SAMPLE['compile_flags.txt'] ?? ''}` }, target);
            for (const source of Object.keys(SAMPLE).filter((p) => /\.cpp$/.test(p))) {
                const objects = {};
                for (const view of [false, true]) {
                    const object = `.yukibana/${view ? 'view' : 'run'}.o`;
                    const r = await toolchain.tool(target, 'clang++', [...compileArgs(target, files, source, { view }), '-c', source, '-o', object], files, [object], { quiet: true });
                    assert.equal(r.code, 0, r.text);
                    objects[view] = sections(r.out[object]);
                }
                const kept = (all) => Object.fromEntries(Object.entries(all).filter(([name, sec]) => {
                    const SHF_ALLOC = 2;
                    if (name.startsWith('.debug') || name.startsWith('.rela.debug') || name.startsWith('.rel.debug')) return false;
                    if (sec.flags & SHF_ALLOC) return true;
                    // Relocations (SHT_RELA 4, SHT_REL 9) for allocated sections.
                    return sec.type === 4 || sec.type === 9;
                }).map(([name, sec]) => [name, sec.type === 4 || sec.type === 9 ? new TextDecoder().decode(sec.bytes) : Buffer.from(sec.bytes).toString('hex')]));
                const run = kept(objects[false]);
                const view = kept(objects[true]);
                assert.ok(Object.keys(run).some((n) => n.startsWith('.text')), `${target.id} ${opt} ${source}: no .text found`);
                assert.deepEqual(Object.keys(view).sort(), Object.keys(run).sort(), `${target.id} ${opt} ${source}: the same sections`);
                for (const name of Object.keys(run)) assert.equal(view[name], run[name], `${target.id} ${opt} ${source}: ${name} differs with the views' flags`);
            }
        }
    });

    test(`${target.label}: libc++'s hardening stops an out-of-range vector index`, { skip: notBuilt }, async (t) => {
        const r = run(t, target, await build(target, withTarget({ ...PROGRAMS.hardened, 'compile_flags.txt': '-std=c++20\n' }, target)));
        if (r) assert.ok(['SIGILL', 'SIGTRAP'].includes(r.signal), `${r.signal} ${r.status} ${r.stderr}`);
    });
}

/**
 * WebAssembly assembly without what -gline-tables-only adds around the code:
 * comments, .loc/.file/.cfi_* directives, the labels debug info refers to
 * (.Ltmp, .Lfunc_begin/_end, .Ldebug_*, ...) and the data of .debug_*
 * sections. Returns `{ code, trailer }`: the lines up to `.ident`, exactly,
 * and the module's trailing metadata after it (symbol sizes, target
 * features; not the producers section, which -g extends with the source
 * language) sorted, as -g reorders it, and without its section switches.
 */
function wasmCodeOnly(text) {
    const lines = [];
    let debug = false;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
        if (!line.trim()) continue;
        const section = /^\s*\.section\s+([^,\s]+)/.exec(line);
        if (section) {
            debug = section[1].startsWith('.debug');
            if (debug) continue;
        }
        if (debug && !/^\s*\.(ident|size|no_dead_strip|globl|type|hidden|weak|functype|globaltype|tagtype|import_module|import_name|export_name)\b/.test(line)) continue;
        if (/^\s*\.(loc|file|cfi_\w+)\b/.test(line)) continue;
        if (/^\.L(tmp\d+|func_begin\d+|func_end\d+|debug_\w+|line_table_start\d+|cu_begin\d+|names_\w+|section_\w+|info_string\d+)\s*:/.test(line)) continue;
        lines.push(line);
    }
    const end = lines.findIndex((l) => /^\s*\.ident\b/.test(l));
    const code = end < 0 ? lines : lines.slice(0, end);
    const trailer = [];
    let producers = false;
    for (const line of lines.slice(code.length)) {
        const section = /^\s*\.section\s+([^,\s]+)/.exec(line);
        if (section) {
            producers = section[1] === '.custom_section.producers';
            continue;
        }
        if (!producers) trailer.push(line);
    }
    return { code, trailer: trailer.sort() };
}

test('WebAssembly: the views\' flags change none of the code or data clang emits, at -O0 and -O2', async () => {
    // A wasm object has no ELF sections to compare, so this compares the
    // assembly: every line of every function and data section must be the
    // same once what line tables add around them is taken out.
    for (const opt of ['-O0', '-O2']) {
        const files = { ...SAMPLE, 'compile_flags.txt': `${opt}\n${SAMPLE['compile_flags.txt'] ?? ''}` };
        for (const source of Object.keys(SAMPLE).filter((p) => /\.cpp$/.test(p))) {
            const out = {};
            for (const view of [false, true]) {
                const r = await toolchain.tool(DEFAULT_TARGET, 'clang++', [...compileArgs(DEFAULT_TARGET, files, source, { view }), '-S', source, '-o', 'out.s'], files, ['out.s'], { quiet: true });
                assert.equal(r.code, 0, r.text);
                out[view] = wasmCodeOnly(new TextDecoder().decode(r.out['out.s']));
            }
            assert.ok(out[false].code.some((l) => /^\s*end_function\b/.test(l)), `${opt} ${source}: no function found`);
            assert.deepEqual(out[true].code, out[false].code, `${opt} ${source}: code and data`);
            assert.deepEqual(out[true].trailer, out[false].trailer, `${opt} ${source}: symbol sizes and target features`);
        }
    }
});

// 4. The explorer worker, in a browser.

test('the explorer shows IR and assembly for every target, demangled, and only answers the newest request', { skip: notBuilt || (!existsSync(CHROMIUM) && `no Chromium at ${CHROMIUM}`) }, async () => {
    const { chromium } = await import('playwright-core');
    const requested = [];
    const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
    const server = createServer((req, res) => {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        requested.push(path);
        if (path === '/__test.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>explorer test</title>');
        const file = normalize(join(STATIC, path));
        if (!file.startsWith(STATIC) || !existsSync(file)) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/__test.html`);
        await page.evaluate(() => {
            window.worker = new Worker('/packs/cpp/explorer.js', { type: 'module' });
            window.results = [];
            window.worker.onmessage = ({ data }) => data.type === 'result' && window.results.push(data);
            window.emit = (request) => new Promise((done) => {
                const before = window.results.length;
                window.worker.postMessage({ type: 'emit', ...request });
                const poll = () => (window.results.slice(before).find((r) => r.id === request.id) ? done(window.results.find((r) => r.id === request.id)) : setTimeout(poll, 20));
                poll();
            });
        });
        let id = 0;
        for (const target of TARGETS) {
            const files = target.default ? SAMPLE : withTarget(SAMPLE, target);
            const ir = await page.evaluate((r) => window.emit(r), { id: ++id, emit: 'llvm-ir', files, path: 'geometry.cpp', options: {} });
            assert.equal(ir.ok, true, ir.error);
            assert.equal(ir.target, target.id);
            assert.match(ir.text, /^define .*@_Z8distanceRK5PointS1_\(/m);
            assert.equal(ir.lines.length, ir.text.split('\n').length);
            const asm = await page.evaluate((r) => window.emit(r), { id: ++id, emit: 'asm', files, path: 'main.cpp', options: { demangle: true } });
            assert.equal(asm.ok, true, asm.error);
            assert.match(asm.text, /distance\(Point const&, Point const&\)/, target.id);
            assert.ok(asm.lines.some((m) => m && m.file === 'main.cpp' && m.line === 8), target.id);
            if (target.default) assert.match(asm.text, /end_function/);
            else assert.ok(!requested.includes(`/packs/cpp/targets/${target.arch}/lib.tar`), `${target.id}: compiling only, no libraries`);
        }
        // Errors come back as results, with project paths.
        const broken = await page.evaluate((r) => window.emit(r), { id: ++id, emit: 'asm', files: { ...SAMPLE, 'main.cpp': 'int main() { return x; }\n' }, path: 'main.cpp', options: {} });
        assert.equal(broken.ok, false);
        assert.match(broken.error, /^main\.cpp:1:21: error: use of undeclared identifier 'x'/m);
        const unsupported = await page.evaluate((r) => window.emit(r), { id: ++id, emit: 'asm', files: { ...SAMPLE, 'compile_flags.txt': '--target=armv7-linux-musleabihf\n' }, path: 'main.cpp', options: {} });
        assert.deepEqual([unsupported.ok, unsupported.error], [false, unsupportedMessage('armv7-linux-musleabihf')]);
        const header = await page.evaluate((r) => window.emit(r), { id: ++id, emit: 'asm', files: SAMPLE, path: 'geometry.h', options: {} });
        assert.equal(header.ok, false);
        // Three requests at once: only the newest is answered.
        const newest = await page.evaluate(async ({ base, files }) => {
            const before = window.results.length;
            for (const n of [1, 2]) window.worker.postMessage({ type: 'emit', id: base + n, emit: 'llvm-ir', files, path: 'geometry.cpp', options: {} });
            await window.emit({ id: base + 3, emit: 'llvm-ir', files, path: 'geometry.cpp', options: {} });
            await new Promise((r) => setTimeout(r, 200));
            return window.results.slice(before).map((r) => r.id);
        }, { base: id + 10, files: SAMPLE });
        assert.ok(newest.includes(id + 13) && !newest.includes(id + 12), JSON.stringify(newest));
    } finally {
        await browser.close();
        server.close();
    }
});
