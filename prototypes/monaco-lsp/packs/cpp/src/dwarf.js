// A small DWARF reader for the sanitizers' stack traces (README,
// "Sanitizers"): what llvm-symbolizer tells a sanitizer runtime about a
// program counter, a function, a file, a line and a column for the code at
// that address and, when the compiler inlined it, for each function it was
// inlined into. Enough of DWARF 4 and 5 for what clang 21 writes with
// `-gline-tables-only` or `-g`, for wasm32 (4-byte addresses, addresses
// counted from the start of the code section's contents) and for the
// 64-bit Linux targets (ELF64, little-endian). 32-bit DWARF only, as clang
// writes it. Reads nothing until asked, then one compile unit at a time.
//
// Frames come out as llvm-symbolizer computes them
// (SymbolizableObjectFile::symbolizeInlinedCode): the innermost frame's
// line from the line table, each outer frame's from the call site that the
// inlined subroutine records (DW_AT_call_file/line/column), names from the
// DIEs (a linkage name when there is one, else the plain name, through
// DW_AT_abstract_origin and DW_AT_specification). The caller replaces the
// outermost frame's name with the symbol table's, as llvm-symbolizer does
// (with -gline-tables-only the DIEs have no linkage names, so a frame
// would otherwise read `sum` and not `geo::Grid::sum(int) const`).

const decoder = new TextDecoder();

export function readUleb(bytes, at) {
    let value = 0;
    let shift = 0;
    for (;;) {
        const byte = bytes[at++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (!(byte & 0x80)) return [value, at];
    }
}

export function readSleb(bytes, at) {
    let value = 0;
    let shift = 0;
    let byte;
    do {
        byte = bytes[at++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    if (byte & 0x40) value -= 2 ** shift;
    return [value, at];
}

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const EMPTY = new Uint8Array(0);

/** A NUL-terminated UTF-8 string of `bytes` at `at`, and the offset after its NUL. */
function cstring(bytes, at) {
    const end = bytes.indexOf(0, at);
    const stop = end < 0 ? bytes.length : end;
    return [decoder.decode(bytes.subarray(at, stop)), stop + 1];
}

/** An unsigned little-endian integer of `size` bytes (1 to 8) as a Number. */
function readUint(view, at, size) {
    switch (size) {
        case 1: return view.getUint8(at);
        case 2: return view.getUint16(at, true);
        case 3: return view.getUint16(at, true) + view.getUint8(at + 2) * 0x10000;
        case 4: return view.getUint32(at, true);
        case 8: return view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
        default: throw new Error(`DWARF: a ${size}-byte integer`);
    }
}

/** Whether `address` is a linker's tombstone for discarded code: all ones, or all ones minus one (.debug_ranges). */
const tombstone = (address, size) => address >= 2 ** (size * 8) - 2;

const joinPath = (dir, name) => (name.startsWith('/') || /^[a-z]+:\/\//.test(name) || !dir ? name : `${dir.replace(/\/$/, '')}/${name}`);

// ---- line tables

/**
 * The line program of one unit of `.debug_line` at `offset` (`sections`:
 * the debug sections by name, `.debug_line` among them): `{ files, rows,
 * end }`. `files[i]` is the path that file index i names (DWARF 5 counts
 * from 0, DWARF 4 from 1; the other index is undefined), joined with its
 * directory and with `compDir` when relative; `rows` are `{ address, file,
 * line, column, end }` in program order, `end` marking the row that ends a
 * sequence; `end` is where the next unit starts.
 */
export function lineProgram(sections, offset, { addressSize = 4, compDir = '' } = {}) {
    const section = sections['.debug_line'];
    const lineStr = sections['.debug_line_str'] ?? EMPTY;
    const str = sections['.debug_str'] ?? EMPTY;
    const view = viewOf(section);
    const length = view.getUint32(offset, true);
    if (length >= 0xfffffff0) throw new Error('DWARF: 64-bit .debug_line');
    const end = offset + 4 + length;
    let at = offset + 4;
    const version = view.getUint16(at, true);
    at += 2;
    if (version >= 5) {
        addressSize = section[at];
        at += 2; // address_size, segment_selector_size
    }
    const headerLength = view.getUint32(at, true);
    at += 4;
    const program = at + headerLength;
    const minLength = section[at++];
    if (version >= 4) at++; // maximum_operations_per_instruction
    at++; // default_is_stmt
    const lineBase = view.getInt8(at++);
    const lineRange = section[at++];
    const opcodeBase = section[at++];
    const opcodeLengths = section.subarray(at, at + opcodeBase - 1);
    at += opcodeBase - 1;
    const dirs = [];
    const files = [];
    if (version >= 5) {
        const readForm = (form, pos) => {
            switch (form) {
                case 0x08: return cstring(section, pos); // string
                case 0x1f: return [cstring(lineStr, view.getUint32(pos, true))[0], pos + 4]; // line_strp
                case 0x0e: return [cstring(str, view.getUint32(pos, true))[0], pos + 4]; // strp
                case 0x0b: return [section[pos], pos + 1]; // data1
                case 0x05: return [view.getUint16(pos, true), pos + 2]; // data2
                case 0x06: return [view.getUint32(pos, true), pos + 4]; // data4
                case 0x07: return [0, pos + 8]; // data8
                case 0x1e: return [0, pos + 16]; // data16 (MD5)
                case 0x0f: return readUleb(section, pos); // udata
                case 0x09: { const [n, p] = readUleb(section, pos); return [0, p + n]; } // block
                default: throw new Error(`DWARF: form 0x${form.toString(16)} in .debug_line`);
            }
        };
        const entries = (make) => {
            const formats = [];
            const count = section[at++];
            for (let i = 0; i < count; i++) {
                let type, form;
                [type, at] = readUleb(section, at);
                [form, at] = readUleb(section, at);
                formats.push([type, form]);
            }
            let n;
            [n, at] = readUleb(section, at);
            const out = [];
            for (let i = 0; i < n; i++) {
                const entry = {};
                for (const [type, form] of formats) [entry[type], at] = readForm(form, at);
                out.push(make(entry));
            }
            return out;
        };
        // DW_LNCT_path 1, DW_LNCT_directory_index 2. Directory 0 is the
        // compilation directory itself.
        dirs.push(...entries((e) => e[1] ?? ''));
        files.push(...entries((e) => joinPath(joinPath(compDir, dirs[e[2] ?? 0] ?? ''), e[1] ?? '')));
    } else {
        for (;;) {
            const [dir, next] = cstring(section, at);
            at = next;
            if (!dir) break;
            dirs.push(dir);
        }
        files.push(undefined);
        for (;;) {
            const [name, next] = cstring(section, at);
            at = next;
            if (!name) break;
            let dir;
            [dir, at] = readUleb(section, at);
            [, at] = readUleb(section, at); // mtime
            [, at] = readUleb(section, at); // length
            // Directory 0 is the compilation directory, which DWARF 4 does
            // not list here.
            files.push(joinPath(dir ? joinPath(compDir, dirs[dir - 1]) : compDir, name));
        }
    }
    const rows = [];
    let address = 0, file = 1, line = 1, column = 0;
    const emit = (endSequence = false) => rows.push({ address, file: files[file] ?? '', line, column, end: endSequence });
    for (at = program; at < end; ) {
        const op = section[at++];
        if (op >= opcodeBase) {
            const adjusted = op - opcodeBase;
            address += Math.floor(adjusted / lineRange) * minLength;
            line += lineBase + (adjusted % lineRange);
            emit();
            continue;
        }
        let value;
        switch (op) {
            case 0: {
                let size;
                [size, at] = readUleb(section, at);
                const next = at + size;
                const sub = section[at];
                if (sub === 1) {
                    emit(true);
                    address = 0;
                    file = 1;
                    line = 1;
                    column = 0;
                } else if (sub === 2) {
                    address = readUint(view, at + 1, size - 1);
                }
                at = next;
                break;
            }
            case 1: emit(); break;
            case 2: [value, at] = readUleb(section, at); address += value * minLength; break;
            case 3: [value, at] = readSleb(section, at); line += value; break;
            case 4: [file, at] = readUleb(section, at); break;
            case 5: [column, at] = readUleb(section, at); break;
            case 8: address += Math.floor((255 - opcodeBase) / lineRange) * minLength; break;
            case 9: address += view.getUint16(at, true); at += 2; break;
            case 6: case 7: case 10: case 11: break;
            case 12: [, at] = readUleb(section, at); break; // set_isa
            default:
                // An opcode this reader does not know: skip its operands.
                for (let i = 0; i < (opcodeLengths[op - 1] ?? 0); i++) [, at] = readUleb(section, at);
        }
    }
    return { files, rows, end };
}

/**
 * The rows of every unit of a `.debug_line` section, as lineProgram gives
 * them, one unit after another.
 */
export function lineTable(sections, { addressSize = 4 } = {}) {
    const rows = [];
    const section = sections['.debug_line'];
    if (!section) return rows;
    for (let offset = 0; offset + 4 <= section.length; ) {
        const unit = lineProgram(sections, offset, { addressSize });
        rows.push(...unit.rows);
        offset = unit.end;
    }
    return rows;
}

/**
 * A lookup from an address to `{ file, line, column }`, or null outside
 * every sequence: the row with the greatest address not above it, in the
 * sequence that covers it (as llvm's DWARFDebugLine::LineTable::lookupAddress).
 */
export function lineLookup(rows) {
    const spans = [];
    let start = 0;
    for (let i = 0; i < rows.length; i++) {
        if (!rows[i].end) continue;
        const sequence = rows.slice(start, i + 1);
        start = i + 1;
        if (sequence.length > 1 && sequence[0].address < sequence[sequence.length - 1].address) spans.push(sequence);
    }
    return (address) => {
        for (const sequence of spans) {
            if (address < sequence[0].address || address >= sequence[sequence.length - 1].address) continue;
            let lo = 0;
            let hi = sequence.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (sequence[mid].address <= address) lo = mid;
                else hi = mid - 1;
            }
            const row = sequence[lo];
            return { file: row.file, line: row.line, column: row.column };
        }
        return null;
    };
}

// ---- .debug_info

const TAG = { compile_unit: 0x11, partial_unit: 0x3c, subprogram: 0x2e, inlined_subroutine: 0x1d };
const AT = {
    name: 0x03, stmt_list: 0x10, low_pc: 0x11, high_pc: 0x12, comp_dir: 0x1b, abstract_origin: 0x31,
    specification: 0x47, ranges: 0x55, call_column: 0x57, call_file: 0x58, call_line: 0x59,
    linkage_name: 0x6e, str_offsets_base: 0x72, addr_base: 0x73, rnglists_base: 0x74, mips_linkage_name: 0x2007,
};
// Forms whose value is a reference to another DIE, relative to the unit (ref_addr: to the section).
const UNIT_REFS = new Set([0x11, 0x12, 0x13, 0x14, 0x15]);

/** The abbreviation table at `offset` of `.debug_abbrev`: code -> { tag, children, specs: [attribute, form, implicit] }. */
function abbreviations(section, offset) {
    const table = new Map();
    let at = offset;
    for (;;) {
        let code, tag, attribute, form;
        [code, at] = readUleb(section, at);
        if (code === 0) return table;
        [tag, at] = readUleb(section, at);
        const children = section[at++] === 1;
        const specs = [];
        for (;;) {
            [attribute, at] = readUleb(section, at);
            [form, at] = readUleb(section, at);
            if (attribute === 0 && form === 0) break;
            let implicit = 0;
            if (form === 0x21) [implicit, at] = readSleb(section, at);
            specs.push([attribute, form, implicit]);
        }
        table.set(code, { tag, children, specs });
    }
}

/**
 * The debug information of a program (`sections`: its DWARF sections by
 * name, as bytes) for addresses of `addressSize` bytes. `frames(address)`
 * is the inlining chain at `address`, innermost first, each
 * `{ name, file, line, column }` (`name` the linkage name if the DIE has
 * one, else its name, else null; `file` the path as the compiler saw it,
 * joined with the compilation directory, or null with `line` 0 when the
 * line table does not cover the address); an empty array when no compile
 * unit covers it. Compile units are indexed on the first call and each
 * one's DIEs parsed the first time an address falls in it.
 */
export function createDwarf(sections, { addressSize = 4 } = {}) {
    const info = sections['.debug_info'];
    const abbrev = sections['.debug_abbrev'];
    if (!info || !abbrev) return { frames: () => [] };
    const infoView = viewOf(info);
    const str = sections['.debug_str'] ?? EMPTY;
    const lineStr = sections['.debug_line_str'] ?? EMPTY;
    const strOffsets = sections['.debug_str_offsets'] ?? EMPTY;
    const addr = sections['.debug_addr'] ?? EMPTY;
    const rnglists = sections['.debug_rnglists'] ?? EMPTY;
    const ranges = sections['.debug_ranges'] ?? EMPTY;
    const views = new Map([[str, viewOf(str)], [strOffsets, viewOf(strOffsets)], [addr, viewOf(addr)], [rnglists, viewOf(rnglists)], [ranges, viewOf(ranges)], [lineStr, viewOf(lineStr)]]);

    let units = null; // [{ offset, end, version, addressSize, abbrevs, dieStart, cu (attrs), ranges, parsed }]

    /** One DIE's attributes at `at` of `unit`: a Map attribute -> value, and the offset after it, or null for a null entry. */
    function readDie(unit, at) {
        let code;
        const start = at;
        [code, at] = readUleb(info, at);
        if (code === 0) return { die: null, at };
        const abbr = unit.abbrevs.get(code);
        if (!abbr) throw new Error(`DWARF: abbreviation ${code} at 0x${start.toString(16)}`);
        const attrs = new Map();
        for (const [attribute, form0, implicit] of abbr.specs) {
            let form = form0;
            if (form === 0x16) [form, at] = readUleb(info, at); // indirect
            let value;
            switch (form) {
                case 0x01: value = readUint(infoView, at, unit.addressSize); at += unit.addressSize; break; // addr
                case 0x0b: case 0x11: case 0x0c: case 0x25: case 0x29: value = info[at]; at += 1; break; // data1 ref1 flag strx1 addrx1
                case 0x05: case 0x12: case 0x26: case 0x2a: value = infoView.getUint16(at, true); at += 2; break; // data2 ref2 strx2 addrx2
                case 0x27: case 0x2b: value = readUint(infoView, at, 3); at += 3; break; // strx3 addrx3
                case 0x06: case 0x13: case 0x0e: case 0x1f: case 0x10: case 0x17: case 0x1c: case 0x1d: case 0x28: case 0x2c: case 0x1f20: case 0x1f21:
                    value = infoView.getUint32(at, true); at += 4; break; // data4 ref4 strp line_strp ref_addr sec_offset ref_sup4 strp_sup strx4 addrx4 GNU_ref_alt GNU_strp_alt
                case 0x07: case 0x14: case 0x20: case 0x24: value = readUint(infoView, at, 8); at += 8; break; // data8 ref8 ref_sig8 ref_sup8
                case 0x1e: at += 16; break; // data16
                case 0x0d: [value, at] = readSleb(info, at); break; // sdata
                case 0x0f: case 0x15: case 0x1a: case 0x1b: case 0x22: case 0x23: case 0x1f01: case 0x1f02:
                    [value, at] = readUleb(info, at); break; // udata ref_udata strx addrx loclistx rnglistx GNU_addr_index GNU_str_index
                case 0x08: [value, at] = cstring(info, at); break; // string
                case 0x09: case 0x18: { let n; [n, at] = readUleb(info, at); at += n; break; } // block exprloc
                case 0x0a: at += 1 + info[at]; break; // block1
                case 0x03: at += 2 + infoView.getUint16(at, true); break; // block2
                case 0x04: at += 4 + infoView.getUint32(at, true); break; // block4
                case 0x19: value = 1; break; // flag_present
                case 0x21: value = implicit; break; // implicit_const
                default: throw new Error(`DWARF: form 0x${form.toString(16)} at 0x${start.toString(16)}`);
            }
            if (value === undefined) continue;
            if (UNIT_REFS.has(form)) value = { ref: unit.offset + value };
            else if (form === 0x10) value = { ref: value };
            attrs.set(attribute, { form, value });
        }
        return { die: { offset: start, tag: abbr.tag, children: abbr.children, attrs }, at };
    }

    /** A string attribute's text, through the unit's string forms. */
    function stringOf(unit, entry) {
        if (!entry) return null;
        const { form, value } = entry;
        if (form === 0x08) return value;
        if (form === 0x0e) return cstring(str, value)[0];
        if (form === 0x1f) return cstring(lineStr, value)[0];
        if (form === 0x1a || (form >= 0x25 && form <= 0x28) || form === 0x1f02) {
            const base = unit.strOffsetsBase ?? 8;
            return cstring(str, views.get(strOffsets).getUint32(base + value * 4, true))[0];
        }
        return null;
    }

    /** An address attribute's value, through .debug_addr for the indexed forms. */
    function addressOf(unit, entry) {
        if (!entry) return null;
        const { form, value } = entry;
        if (form === 0x01) return value;
        if (form === 0x1b || (form >= 0x29 && form <= 0x2c) || form === 0x1f01)
            return readUint(views.get(addr), (unit.addrBase ?? 8) + value * unit.addressSize, unit.addressSize);
        return null;
    }

    /** The address ranges, [[low, high), ...], of a DIE: low_pc/high_pc or ranges, tombstones left out. */
    function rangesOf(unit, die) {
        const out = [];
        const size = unit.addressSize;
        const add = (low, high) => {
            if (!tombstone(low, size) && high > low) out.push([low, high]);
        };
        const low = addressOf(unit, die.attrs.get(AT.low_pc));
        const highEntry = die.attrs.get(AT.high_pc);
        if (low !== null && highEntry) {
            const high = highEntry.form === 0x01 || highEntry.form === 0x1b || (highEntry.form >= 0x29 && highEntry.form <= 0x2c)
                ? addressOf(unit, highEntry)
                : low + highEntry.value;
            add(low, high);
        }
        const rangesEntry = die.attrs.get(AT.ranges);
        if (!rangesEntry) return out;
        let base = unit.base ?? 0;
        if (unit.version < 5) {
            const view = views.get(ranges);
            for (let at = rangesEntry.value.ref ?? rangesEntry.value; at + 2 * size <= ranges.length; at += 2 * size) {
                const start = readUint(view, at, size);
                const end = readUint(view, at + size, size);
                if (start === 0 && end === 0) break;
                if (start === 2 ** (size * 8) - 1) base = end;
                else add(base + start, base + end);
            }
            return out;
        }
        const view = views.get(rnglists);
        let at;
        if (rangesEntry.form === 0x23) {
            const listBase = unit.rnglistsBase ?? 12;
            at = listBase + view.getUint32(listBase + rangesEntry.value * 4, true);
        } else {
            at = rangesEntry.value.ref ?? rangesEntry.value;
        }
        const indexed = (i) => readUint(views.get(addr), (unit.addrBase ?? 8) + i * size, size);
        for (;;) {
            const kind = rnglists[at++];
            let a, b;
            switch (kind) {
                case 0: return out; // end_of_list
                case 1: [a, at] = readUleb(rnglists, at); base = indexed(a); break; // base_addressx
                case 2: [a, at] = readUleb(rnglists, at); [b, at] = readUleb(rnglists, at); add(indexed(a), indexed(b)); break; // startx_endx
                case 3: [a, at] = readUleb(rnglists, at); [b, at] = readUleb(rnglists, at); add(indexed(a), indexed(a) + b); break; // startx_length
                case 4: [a, at] = readUleb(rnglists, at); [b, at] = readUleb(rnglists, at); add(base + a, base + b); break; // offset_pair
                case 5: base = readUint(view, at, size); at += size; break; // base_address
                case 6: a = readUint(view, at, size); b = readUint(view, at + size, size); at += 2 * size; add(a, b); break; // start_end
                case 7: a = readUint(view, at, size); at += size; [b, at] = readUleb(rnglists, at); add(a, a + b); break; // start_length
                default: throw new Error(`DWARF: range list entry ${kind}`);
            }
        }
    }

    function index() {
        units = [];
        for (let offset = 0; offset + 11 <= info.length; ) {
            const length = infoView.getUint32(offset, true);
            if (length >= 0xfffffff0) break; // 64-bit DWARF: clang does not write it
            const end = offset + 4 + length;
            const version = infoView.getUint16(offset + 4, true);
            let at = offset + 6;
            let unitType = 1;
            let abbrevOffset;
            let size = addressSize;
            if (version >= 5) {
                unitType = info[at];
                size = info[at + 1];
                abbrevOffset = infoView.getUint32(at + 2, true);
                at += 6;
                if (unitType === 4 || unitType === 5) at += 8; // skeleton, split_compile: dwo_id
                else if (unitType === 2 || unitType === 6) at += 12; // type units
            } else {
                abbrevOffset = infoView.getUint32(at, true);
                size = info[at + 4];
                at += 5;
            }
            const unit = { offset, end, version, addressSize: size, abbrevs: abbreviations(abbrev, abbrevOffset), dieStart: at, ranges: [], tree: null };
            if (unitType === 1 || unitType === 3) {
                const { die } = readDie(unit, at);
                if (die && (die.tag === TAG.compile_unit || die.tag === TAG.partial_unit)) {
                    unit.strOffsetsBase = die.attrs.get(AT.str_offsets_base)?.value;
                    unit.addrBase = die.attrs.get(AT.addr_base)?.value;
                    unit.rnglistsBase = die.attrs.get(AT.rnglists_base)?.value;
                    unit.base = addressOf(unit, die.attrs.get(AT.low_pc)) ?? 0;
                    unit.compDir = stringOf(unit, die.attrs.get(AT.comp_dir)) ?? '';
                    unit.stmtList = die.attrs.get(AT.stmt_list)?.value;
                    unit.ranges = rangesOf(unit, die);
                    units.push(unit);
                }
            }
            offset = end;
        }
    }

    /** The unit's subprograms and inlined subroutines with their ranges, as a tree; DIEs by offset for references. */
    function parse(unit) {
        if (unit.tree) return unit.tree;
        const byOffset = new Map();
        const roots = [];
        const stack = [{ children: roots }];
        for (let at = unit.dieStart; at < unit.end; ) {
            const r = readDie(unit, at);
            at = r.at;
            if (!r.die) {
                stack.pop();
                if (stack.length === 0) break;
                continue;
            }
            const die = r.die;
            byOffset.set(die.offset, die);
            die.kids = [];
            if (die.tag === TAG.subprogram || die.tag === TAG.inlined_subroutine) {
                die.ranges = rangesOf(unit, die);
                stack[stack.length - 1].children.push(die);
            }
            if (die.children) stack.push({ children: die.tag === TAG.subprogram || die.tag === TAG.inlined_subroutine ? die.kids : stack[stack.length - 1].children });
        }
        unit.tree = { roots, byOffset };
        if (unit.stmtList !== undefined && sections['.debug_line']) {
            const { files, rows } = lineProgram(sections, unit.stmtList, { addressSize: unit.addressSize, compDir: unit.compDir });
            unit.files = files;
            unit.lookup = lineLookup(rows);
        } else {
            unit.files = [];
            unit.lookup = () => null;
        }
        return unit.tree;
    }

    /** A DIE elsewhere in the section (a DW_FORM_ref_addr), parsing its unit. */
    function dieAt(offset) {
        for (const unit of units) {
            if (offset < unit.offset || offset >= unit.end) continue;
            return parse(unit).byOffset.get(offset) ?? null;
        }
        return null;
    }

    /** A subprogram's name, as llvm's DWARFDie::getSubroutineName(LinkageName): linkage name, else name, through origins. */
    function nameOf(unit, die, depth = 0) {
        if (!die || depth > 8) return null;
        const linkage = stringOf(unit, die.attrs.get(AT.linkage_name) ?? die.attrs.get(AT.mips_linkage_name));
        if (linkage) return linkage;
        const name = stringOf(unit, die.attrs.get(AT.name));
        if (name) return name;
        for (const at of [AT.specification, AT.abstract_origin]) {
            const ref = die.attrs.get(at)?.value.ref;
            if (ref === undefined) continue;
            const local = unit.tree.byOffset.get(ref);
            if (local) return nameOf(unit, local, depth + 1);
            const other = dieAt(ref);
            const otherUnit = units.find((u) => ref >= u.offset && ref < u.end);
            if (other && otherUnit) return nameOf(otherUnit, other, depth + 1);
        }
        return null;
    }

    const covers = (die, address) => die.ranges.some(([low, high]) => address >= low && address < high);

    function frames(address) {
        if (!units) index();
        const unit = units.find((u) => u.ranges.some(([low, high]) => address >= low && address < high));
        if (!unit) return [];
        const { roots } = parse(unit);
        // The chain of DIEs that contain the address, outermost first.
        const chain = [];
        let level = roots;
        for (;;) {
            const next = level.find((d) => covers(d, address));
            if (!next) break;
            chain.push(next);
            level = next.kids;
        }
        const where = unit.lookup(address);
        const out = [];
        let file = where?.file ?? null;
        let line = where?.line ?? 0;
        let column = where?.column ?? 0;
        if (chain.length === 0) return [{ name: null, file, line, column }];
        for (let i = chain.length - 1; i >= 0; i--) {
            const die = chain[i];
            out.push({ name: nameOf(unit, die), file, line, column });
            if (die.tag !== TAG.inlined_subroutine) break;
            const callFile = die.attrs.get(AT.call_file)?.value;
            file = callFile !== undefined ? unit.files[callFile] ?? null : null;
            line = die.attrs.get(AT.call_line)?.value ?? 0;
            column = die.attrs.get(AT.call_column)?.value ?? 0;
        }
        return out;
    }

    return { frames };
}
