// Reads a serialized diagnostics file (`-serialize-diagnostics-path`): the
// format clang defined and the Swift frontend writes, an LLVM bitstream with
// one DIAG block per diagnostic (notes nested inside their parent's block),
// each with its message, location, ranges and fix-its. It is the only place
// the frontend reports fix-its (`add stubs for conformance`, `insert '!'`):
// the text output drops any fix-it whose text spans lines.
//
//   readDiagnostics(bytes) -> [{ severity, file, line, column, offset,
//                                message, ranges, fixits, notes }]
//
// Locations are { file, line, column, offset }, with offset the UTF-8 byte
// offset into that file; a fix-it replaces [start.offset, end.offset) with
// its text. Severities as clang numbers them: 1 note, 2 warning, 3 error,
// 4 fatal, 5 remark.
//
// The bitstream format: https://llvm.org/docs/BitCodeFormat.html. Record and
// block ids: clang/include/clang/Frontend/SerializedDiagnostics.h.

const BLOCKINFO = 0;
const BLOCK_DIAG = 9;
const RECORD = { DIAG: 2, SOURCE_RANGE: 3, FILENAME: 6, FIXIT: 7 };
const END_BLOCK = 0, ENTER_SUBBLOCK = 1, DEFINE_ABBREV = 2, UNABBREV_RECORD = 3;
const ENC = { FIXED: 1, VBR: 2, ARRAY: 3, CHAR6: 4, BLOB: 5 };

class Bits {
    constructor(bytes) {
        this.bytes = bytes;
        this.pos = 0; // in bits
    }
    get done() {
        return this.pos >= this.bytes.length * 8;
    }
    fixed(width) {
        let value = 0;
        for (let i = 0; i < width; i++, this.pos++) {
            const byte = this.bytes[this.pos >> 3];
            if (byte === undefined) throw new Error('serialized diagnostics: truncated');
            if (byte & (1 << (this.pos & 7))) value += 2 ** i;
        }
        return value;
    }
    vbr(width) {
        const high = 1 << (width - 1);
        let value = 0;
        for (let shift = 0; ; shift += width - 1) {
            const chunk = this.fixed(width);
            value += (chunk & (high - 1)) * 2 ** shift;
            if (!(chunk & high)) return value;
        }
    }
    align32() {
        this.pos = Math.ceil(this.pos / 32) * 32;
    }
}

function readAbbrev(bits) {
    const ops = [];
    for (let n = bits.vbr(5); n > 0; n--) {
        if (bits.fixed(1)) ops.push({ literal: bits.vbr(8) });
        else {
            const encoding = bits.fixed(3);
            const width = encoding === ENC.FIXED || encoding === ENC.VBR ? bits.vbr(5) : 0;
            ops.push({ encoding, width });
        }
    }
    return ops;
}

function readScalar(bits, op) {
    if ('literal' in op) return op.literal;
    switch (op.encoding) {
        case ENC.FIXED: return bits.fixed(op.width);
        case ENC.VBR: return bits.vbr(op.width);
        case ENC.CHAR6: return 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._'.charCodeAt(bits.fixed(6));
        default: throw new Error(`serialized diagnostics: unexpected operand encoding ${op.encoding}`);
    }
}

/** One abbreviated record: [code, ...operands], with a trailing blob as a Uint8Array. */
function readAbbreviated(bits, ops) {
    const values = [];
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (op.encoding === ENC.ARRAY) {
            const element = ops[++i];
            for (let n = bits.vbr(6); n > 0; n--) values.push(readScalar(bits, element));
        } else if (op.encoding === ENC.BLOB) {
            const length = bits.vbr(6);
            bits.align32();
            const start = bits.pos >> 3;
            values.push(bits.bytes.subarray(start, start + length));
            bits.pos += length * 8;
            bits.align32();
        } else values.push(readScalar(bits, op));
    }
    return values;
}

/** Every record of the stream, with the id of the block it is in and its nesting. */
function* records(bytes) {
    const bits = new Bits(bytes);
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'DIAG') throw new Error('serialized diagnostics: bad magic');
    bits.pos = 32;
    const blockInfo = new Map(); // block id -> abbreviations from BLOCKINFO
    const stack = [{ id: -1, width: 2, abbrevs: [] }];
    let infoTarget = null;
    while (!bits.done) {
        const block = stack.at(-1);
        const id = bits.fixed(block.width);
        if (id === END_BLOCK) {
            bits.align32();
            stack.pop();
            yield { end: true, block: block.id };
            if (stack.length === 0) return;
        } else if (id === ENTER_SUBBLOCK) {
            const blockId = bits.vbr(8);
            const width = bits.vbr(4);
            bits.align32();
            bits.fixed(32); // length in words
            stack.push({ id: blockId, width, abbrevs: [...(blockInfo.get(blockId) ?? [])] });
            yield { enter: true, block: blockId };
        } else if (id === DEFINE_ABBREV) {
            const abbrev = readAbbrev(bits);
            if (block.id === BLOCKINFO) {
                if (infoTarget === null) throw new Error('serialized diagnostics: abbreviation before SETBID');
                if (!blockInfo.has(infoTarget)) blockInfo.set(infoTarget, []);
                blockInfo.get(infoTarget).push(abbrev);
            } else block.abbrevs.push(abbrev);
        } else if (id === UNABBREV_RECORD) {
            const code = bits.vbr(6);
            const values = [];
            for (let n = bits.vbr(6); n > 0; n--) values.push(bits.vbr(6));
            if (block.id === BLOCKINFO && code === 1) infoTarget = values[0];
            else yield { block: block.id, code, values };
        } else {
            const abbrev = block.abbrevs[id - 4];
            if (!abbrev) throw new Error(`serialized diagnostics: unknown abbreviation ${id}`);
            const [code, ...values] = readAbbreviated(bits, abbrev);
            if (block.id === BLOCKINFO && code === 1) infoTarget = values[0];
            else yield { block: block.id, code, values };
        }
        if (stack.length === 1 && bits.done) return;
    }
}

const utf8 = new TextDecoder();
const text = (v) => (v instanceof Uint8Array ? utf8.decode(v) : String.fromCharCode(...v));

/** The diagnostics in a serialized diagnostics file, notes inside their parents. */
export function readDiagnostics(bytes) {
    const files = new Map();
    const top = [];
    const open = [];
    const location = (v, i, file = files.get(v[i])) => ({ file: file ?? '', line: v[i + 1], column: v[i + 2], offset: v[i + 3] });
    for (const r of records(bytes)) {
        if (r.enter && r.block === BLOCK_DIAG) {
            const d = { severity: 0, file: '', line: 0, column: 0, offset: 0, message: '', ranges: [], fixits: [], notes: [] };
            (open.at(-1)?.notes ?? top).push(d);
            open.push(d);
        } else if (r.end && r.block === BLOCK_DIAG) {
            open.pop();
        } else if (r.block === BLOCK_DIAG) {
            const d = open.at(-1);
            const v = r.values;
            if (r.code === RECORD.FILENAME) files.set(v[0], text(v.at(-1)));
            else if (!d) continue;
            else if (r.code === RECORD.DIAG) Object.assign(d, { severity: v[0], ...location(v, 1), message: text(v.at(-1)) });
            else if (r.code === RECORD.SOURCE_RANGE) d.ranges.push({ start: location(v, 0), end: location(v, 4) });
            else if (r.code === RECORD.FIXIT) d.fixits.push({ start: location(v, 0), end: location(v, 4), text: text(v.at(-1)) });
        }
    }
    return top;
}
