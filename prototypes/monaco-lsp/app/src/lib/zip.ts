/**
 * A zip archive of text files, written in the browser without a library:
 * PKZIP 2.0 (no zip64, no encryption), every name UTF-8 and flagged so, each
 * file deflated with the browser's `CompressionStream('deflate-raw')` when
 * that makes it smaller and stored otherwise. Every unzip tool, the
 * operating systems' own and every IDE's "open archive", reads it.
 *
 * Imports nothing, so `node` can load this file directly (tests/export.mjs).
 */

/** One entry: a file with its text, or a folder (a path ending in `/`, no text). */
export interface ZipEntry {
	path: string;
	text?: string;
}

/** CRC-32 (ISO 3309, the one zip uses) of the bytes, as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

/** Raw deflate of the bytes, or `null` where the runtime has no `CompressionStream`. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
	if (typeof CompressionStream === 'undefined') return null;
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** MS-DOS date and time, local time, to two seconds, as zip stores them; 1980 at the earliest. */
function dosTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getFullYear());
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** Bit 11 of the general purpose flags: names are UTF-8. */
const UTF8 = 0x0800;
const STORE = 0;
const DEFLATE = 8;

/**
 * The archive of the entries, in the order given, each modified at
 * `modified`. Paths are relative and `/`-separated, as zip requires. Only an
 * empty folder needs an entry of its own: unzipping a file creates its
 * folders. Throws if the archive would
 * need zip64 (4 GiB, 65535 entries), which a project never comes near.
 */
export async function zip(entries: readonly ZipEntry[], modified: Date = new Date()): Promise<Blob> {
	const encoder = new TextEncoder();
	const { time, date } = dosTime(modified);
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	if (entries.length > 0xffff) throw new Error('too many files for a zip archive');
	for (const entry of entries) {
		const name = encoder.encode(entry.path);
		const data = encoder.encode(entry.text ?? '');
		const deflated = data.length ? await deflateRaw(data) : null;
		const method = deflated && deflated.length < data.length ? DEFLATE : STORE;
		const body = method === DEFLATE ? deflated! : data;
		const crc = crc32(data);
		if (offset + body.length > 0xfffffffe) throw new Error('the project is too large for a zip archive');

		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true); // local file header
		local.setUint16(4, 20, true); // version needed: 2.0
		local.setUint16(6, UTF8, true);
		local.setUint16(8, method, true);
		local.setUint16(10, time, true);
		local.setUint16(12, date, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, body.length, true);
		local.setUint32(22, data.length, true);
		local.setUint16(26, name.length, true);
		local.setUint16(28, 0, true); // no extra field
		parts.push(new Uint8Array(local.buffer), name, body);

		const folder = entry.path.endsWith('/');
		const header = new DataView(new ArrayBuffer(46));
		header.setUint32(0, 0x02014b50, true); // central directory header
		header.setUint16(4, (3 << 8) | 20, true); // made by: Unix, 2.0, so the mode below is read
		header.setUint16(6, 20, true);
		header.setUint16(8, UTF8, true);
		header.setUint16(10, method, true);
		header.setUint16(12, time, true);
		header.setUint16(14, date, true);
		header.setUint32(16, crc, true);
		header.setUint32(20, body.length, true);
		header.setUint32(24, data.length, true);
		header.setUint16(28, name.length, true);
		// 30 extra, 32 comment, 34 disk, 36 internal attributes: 0
		// External attributes: Unix mode rw-r--r-- (rwxr-xr-x for a folder) in the
		// high half, the MS-DOS directory bit in the low one.
		header.setUint32(38, (((folder ? 0o40755 : 0o100644) << 16) | (folder ? 0x10 : 0)) >>> 0, true);
		header.setUint32(42, offset, true);
		central.push(new Uint8Array(header.buffer), name);
		offset += 30 + name.length + body.length;
	}
	const size = central.reduce((n, part) => n + part.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true); // end of central directory
	// 4 this disk, 6 the directory's disk: 0
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, size, true);
	end.setUint32(16, offset, true);
	// 20 comment length: 0
	return new Blob([...parts, ...central, new Uint8Array(end.buffer)].map((part) => part as Uint8Array<ArrayBuffer>), { type: 'application/zip' });
}
