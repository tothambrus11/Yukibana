// What llvm-symbolizer would say about an address of a program, for the
// sanitizers' reports (README, "Sanitizers"), from the program's own bytes:
// a WebAssembly module (the default target; dwarf.js for the lines and
// inlined frames, the name section for function names) or an ELF64
// executable or shared library (the Linux targets; dwarf.js, and .symtab or
// .dynsym for names).
//
// `symbolize(address)` returns the frames at `address`, innermost first,
// each `{ name, file, line, column }`: what llvm-symbolizer prints for one
// address with --inlines, the outermost frame named from the symbol table
// as llvm-symbolizer does by default (--use-symbol-table), the inlined ones
// from DWARF. `file` is null (and `line`, `column` 0) where there are no
// line tables; `name` null where nothing names the code. An address no
// function covers gives `[]`. Names are as the binary has them: a wasm name
// section holds demangled names (wasm-ld writes them so), an ELF symbol
// table mangled ones, which the caller demangles, as llvm-symbolizer does.

import { createDwarf, readSleb, readUleb } from './dwarf.js';

const decoder = new TextDecoder();

/**
 * A WebAssembly module's sections: `code`, the offset of the code section's
 * contents (DWARF addresses count from there), `bodies`, each defined
 * function's `[start, end, body]` in module offsets (`body` after its size,
 * where its locals and code start), `imported`, the number of imported
 * functions (function index = imported + body index), `table`, the
 * function index at each index of the table that active element segments
 * with a constant offset fill (what a C function pointer holds), and
 * `custom`, each custom section's bytes by name.
 */
export function wasmSections(bytes) {
    const custom = {};
    let code = 0;
    let imported = 0;
    const bodies = [];
    const table = new Map();
    for (let at = 8; at < bytes.length; ) {
        const id = bytes[at];
        const [size, start] = readUleb(bytes, at + 1);
        if (id === 0) {
            const [length, name] = readUleb(bytes, start);
            custom[decoder.decode(bytes.subarray(name, name + length))] = bytes.subarray(name + length, start + size);
        } else if (id === 2) {
            let [count, p] = readUleb(bytes, start);
            for (let i = 0; i < count; i++) {
                for (let s = 0; s < 2; s++) { // module, field
                    let n;
                    [n, p] = readUleb(bytes, p);
                    p += n;
                }
                const kind = bytes[p++];
                if (kind === 0) {
                    imported++;
                    [, p] = readUleb(bytes, p);
                } else if (kind === 1) { // table: reftype, limits
                    p++;
                    const flags = bytes[p++];
                    [, p] = readUleb(bytes, p);
                    if (flags & 1) [, p] = readUleb(bytes, p);
                } else if (kind === 2) { // memory: limits
                    const flags = bytes[p++];
                    [, p] = readUleb(bytes, p);
                    if (flags & 1) [, p] = readUleb(bytes, p);
                } else if (kind === 3) { // global: valtype, mutability
                    p += 2;
                } else if (kind === 4) { // tag: attribute, type
                    p++;
                    [, p] = readUleb(bytes, p);
                } else {
                    throw new Error(`wasm: import kind ${kind}`);
                }
            }
        } else if (id === 10) {
            code = start;
            let [count, p] = readUleb(bytes, start);
            for (let i = 0; i < count; i++) {
                const [length, body] = readUleb(bytes, p);
                bodies.push([p, body + length, body]);
                p = body + length;
            }
        } else if (id === 9) {
            // Element segments: flags 0 (table 0) and 2 (a table index),
            // active, offset `i32.const n`, function indices; wasm-ld writes
            // these. Other forms say nothing a function pointer needs.
            let [count, p] = readUleb(bytes, start);
            for (let i = 0; i < count; i++) {
                let flags, offset, n;
                [flags, p] = readUleb(bytes, p);
                if (flags !== 0 && flags !== 2) break;
                if (flags === 2) [, p] = readUleb(bytes, p);
                if (bytes[p++] !== 0x41) break; // i32.const
                [offset, p] = readSleb(bytes, p);
                if (bytes[p++] !== 0x0b) break; // end
                if (flags === 2 && bytes[p++] !== 0) break; // elemkind funcref
                [n, p] = readUleb(bytes, p);
                for (let j = 0; j < n; j++) {
                    let index;
                    [index, p] = readUleb(bytes, p);
                    table.set(offset + j, index);
                }
            }
        }
        at = start + size;
    }
    return { code, bodies, imported, table, custom };
}

/** The function names of a wasm "name" section: function index -> name. */
function wasmNames(section) {
    const names = new Map();
    if (!section) return names;
    for (let at = 0; at < section.length; ) {
        const id = section[at];
        const [size, start] = readUleb(section, at + 1);
        if (id === 1) {
            let [count, p] = readUleb(section, start);
            for (let i = 0; i < count; i++) {
                let index, length;
                [index, p] = readUleb(section, p);
                [length, p] = readUleb(section, p);
                names.set(index, decoder.decode(section.subarray(p, p + length)));
                p += length;
            }
        }
        at = start + size;
    }
    return names;
}

/**
 * A symbolizer for a WebAssembly module's bytes. Addresses are module byte
 * offsets, what the engine's stack traces print (`wasm-function[7]:0x1a3`)
 * and what compiler-rt's Emscripten port calls a program counter.
 *
 * Names are llvm-symbolizer's, but for one: clang compiles a `main` without
 * parameters as `__original_main` on WASI (wasi-libc's `__main_void` calls
 * it), and llvm-symbolizer would print that name, which the program does not
 * have; it is `main` here, as natively.
 */
export function wasmSymbolizer(bytes) {
    const { code, bodies, imported, custom } = wasmSections(bytes);
    const dwarf = createDwarf(custom, { addressSize: 4 });
    let names = null;
    return (address) => {
        names ??= wasmNames(custom.name);
        let lo = 0;
        let hi = bodies.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (bodies[mid][0] <= address) lo = mid;
            else hi = mid - 1;
        }
        const body = bodies[lo];
        const named = body && address >= body[0] && address < body[1] ? names.get(imported + lo) ?? null : null;
        const symbol = named === '__original_main' ? 'main' : named;
        const frames = address >= code ? dwarf.frames(address - code) : [];
        if (frames.length === 0) return symbol ? [{ name: symbol, file: null, line: 0, column: 0 }] : [];
        if (symbol) frames[frames.length - 1].name = symbol;
        return frames;
    };
}

/**
 * Where the code of the function a C function pointer of a WebAssembly
 * module (`bytes`) points to starts, as a module offset: on WebAssembly a
 * function's address is its index in the indirect function table, not the
 * place of its code. 0 for an index no element segment fills.
 */
export function wasmFunctionCode(bytes) {
    let sections = null;
    return (pointer) => {
        sections ??= wasmSections(bytes);
        const index = sections.table.get(pointer);
        return index === undefined ? 0 : sections.bodies[index - sections.imported]?.[2] ?? 0;
    };
}

/**
 * An ELF64 little-endian file's sections by name (bytes) and its function
 * symbols, `[{ address, size, name }]` by address, from .symtab or, when
 * there is none (a stripped shared library), .dynsym.
 */
export function elfSections(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, false) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) throw new Error('not an ELF64 little-endian file');
    const shoff = Number(view.getBigUint64(0x28, true));
    const shentsize = view.getUint16(0x3a, true);
    const shnum = view.getUint16(0x3c, true);
    const shstrndx = view.getUint16(0x3e, true);
    const headers = [];
    for (let i = 0; i < shnum; i++) {
        const at = shoff + i * shentsize;
        headers.push({
            name: view.getUint32(at, true),
            type: view.getUint32(at + 4, true),
            offset: Number(view.getBigUint64(at + 0x18, true)),
            size: Number(view.getBigUint64(at + 0x20, true)),
            link: view.getUint32(at + 0x28, true),
            flags: Number(view.getBigUint64(at + 8, true)),
            entsize: Number(view.getBigUint64(at + 0x38, true)),
        });
    }
    const contents = (h) => (h.type === 8 ? new Uint8Array(0) : bytes.subarray(h.offset, h.offset + h.size)); // SHT_NOBITS
    const shstr = contents(headers[shstrndx]);
    const cname = (table, at) => decoder.decode(table.subarray(at, table.indexOf(0, at)));
    const sections = {};
    for (const h of headers) sections[cname(shstr, h.name)] = contents(h);
    const symbols = [];
    const table = headers.find((h) => h.type === 2) ?? headers.find((h) => h.type === 11); // SHT_SYMTAB, SHT_DYNSYM
    if (table) {
        const strings = contents(headers[table.link]);
        // A local symbol belongs to the file the last STT_FILE symbol
        // names, which llvm-symbolizer prints (with line 0) for code that
        // has no line table.
        let file = null;
        for (let at = table.offset; at + 24 <= table.offset + table.size; at += 24) {
            const info = bytes[at + 4];
            const type = info & 0xf;
            const local = info >> 4 === 0;
            const shndx = view.getUint16(at + 6, true);
            if (type === 4) file = cname(strings, view.getUint32(at, true)) || null;
            // STT_FUNC and STT_GNU_IFUNC, defined, and STT_NOTYPE in code
            // (an assembly label), as llvm-symbolizer counts them.
            if (shndx === 0 || shndx >= 0xff00) continue;
            if (type !== 2 && type !== 10 && !(type === 0 && (headers[shndx]?.flags & 4))) continue;
            const name = cname(strings, view.getUint32(at, true));
            // AArch64's and RISC-V's mapping symbols ($x code, $d data)
            // mark where instructions start, and name nothing.
            if (/^\$[xdatv](?:\.|$)/.test(name)) continue;
            const address = Number(view.getBigUint64(at + 8, true));
            const size = Number(view.getBigUint64(at + 16, true));
            symbols.push({ address, size, name, file: local ? file : null });
        }
    }
    // As llvm's SymbolizableObjectFile: of the symbols at one address, the
    // largest, and of those the last in the table (a stable sort).
    symbols.sort((a, b) => a.address - b.address || a.size - b.size);
    const unique = symbols.filter((s, i) => i + 1 === symbols.length || symbols[i + 1].address !== s.address);
    return { sections, symbols: unique };
}

/**
 * A symbolizer for an ELF64 file's bytes. Addresses are offsets from where
 * it was loaded, which is what a sanitizer prints as `(module+0x...)`: the
 * virtual address for a position-independent executable or library.
 * Function names are as the symbol table has them, mangled.
 */
export function elfSymbolizer(bytes) {
    const { sections, symbols } = elfSections(bytes);
    const dwarf = createDwarf(sections, { addressSize: 8 });
    // As llvm's SymbolizableObjectFile::getNameFromSymbolTable: the last
    // symbol at or below the address, unless it is sized and ends before it.
    const symbolAt = (address) => {
        let lo = 0;
        let hi = symbols.length - 1;
        if (hi < 0 || symbols[0].address > address) return null;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (symbols[mid].address <= address) lo = mid;
            else hi = mid - 1;
        }
        const s = symbols[lo];
        return s.size !== 0 && address >= s.address + s.size ? null : s;
    };
    return (address) => {
        const symbol = symbolAt(address);
        const frames = dwarf.frames(address);
        if (frames.length === 0) return symbol ? [{ name: symbol.name, file: symbol.file, line: 0, column: 0 }] : [];
        const outer = frames[frames.length - 1];
        if (symbol) outer.name = symbol.name;
        if (symbol && outer.file === null) outer.file = symbol.file;
        return frames;
    };
}
