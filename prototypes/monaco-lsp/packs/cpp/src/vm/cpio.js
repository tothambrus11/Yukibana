// SPDX-License-Identifier: MIT
// A writer for the "newc" cpio format, the one the Linux kernel unpacks as an
// initramfs (Documentation/driver-api/early-userspace/buffer-format.rst).
// The kernel accepts several archives one after another, each ending in its own
// TRAILER!!! entry and padded to 4 bytes, so a run's program is appended to a
// prebuilt base initramfs by concatenation; nothing is decompressed or rebuilt.

/**
 * One entry of an archive.
 * - `name`: the path inside the archive, without a leading "/" (the kernel
 *   accepts one, but `cpio -t` lists it differently).
 * - `mode`: the full st_mode: type bits and permissions, e.g. 0o100755 for an
 *   executable file, 0o040755 for a directory, 0o020600 for a character device.
 * - `data`: a file's contents; ignored for directories and devices.
 * - `rdev`: [major, minor] of a device node.
 * Directories must come before what they contain; the kernel creates nothing
 * implicitly (a file in a missing directory is dropped with a log line).
 * @typedef {{ name: string, mode: number, data?: Uint8Array, rdev?: [number, number] }} CpioEntry
 */

const enc = new TextEncoder();

/** Rounds n up to a multiple of 4, the alignment of every header and body in newc. */
const pad4 = (n) => (n + 3) & ~3;

/**
 * Builds one newc archive from `entries`, terminated by TRAILER!!!, as bytes.
 * Every entry is owned by root, has mtime 0 and a unique inode number, so the
 * output depends only on the input (byte-for-byte what GNU cpio reads back).
 * Throws on a name that is empty, absolute, or contains a NUL, and on a file
 * over 4 GiB - 1 (newc's size field is 32 bits).
 * @param {CpioEntry[]} entries
 * @returns {Uint8Array}
 */
export function cpio(entries) {
    const all = [...entries, { name: 'TRAILER!!!', mode: 0 }];
    const parts = [];
    all.forEach((e, i) => {
        if (!e.name || e.name.startsWith('/') || e.name.includes('\0')) throw new Error(`cpio: bad name ${JSON.stringify(e.name)}`);
        const isFile = (e.mode & 0o170000) === 0o100000;
        const data = isFile ? (e.data ?? new Uint8Array(0)) : new Uint8Array(0);
        if (data.length > 0xffffffff) throw new Error(`cpio: ${e.name} is too large`);
        const name = enc.encode(e.name + '\0');
        const [maj, min] = e.rdev ?? [0, 0];
        const fields = [
            e.name === 'TRAILER!!!' ? 0 : i + 1, // c_ino
            e.mode, 0, 0, // c_mode, c_uid, c_gid
            (e.mode & 0o170000) === 0o040000 ? 2 : 1, // c_nlink
            0, data.length, 0, 0, maj, min, // c_mtime, c_filesize, c_devmajor/minor, c_rdevmajor/minor
            name.length, 0, // c_namesize, c_check
        ];
        // Upper-case hex, as GNU cpio and the kernel's own usr/gen_init_cpio write it.
        const header = '070701' + fields.map((f) => (f >>> 0).toString(16).toUpperCase().padStart(8, '0')).join('');
        const headerLen = pad4(110 + name.length);
        const block = new Uint8Array(headerLen + pad4(data.length));
        block.set(enc.encode(header), 0);
        block.set(name, 110);
        block.set(data, headerLen);
        parts.push(block);
    });
    return concat(parts);
}

/**
 * The archive a run appends to the base initramfs, which is what
 * vm/guest/init.c reads:
 * - `/yk/prog`, the program (mode 0755); init always executes this path;
 * - `/yk/argv`, the program's argv, each argument NUL-terminated, `argv[0]`
 *   first (normally "main"; it need not name a file);
 * - `/yk/env`, the environment, "NAME=value" strings NUL-terminated, when
 *   `env` is given (without it init uses its own default environment);
 * - `/yk/strace`, when `strace` is given: strace's own options,
 *   NUL-terminated. An empty array still means "trace", with no options;
 * - every entry of `files`, `{ path, data }` with a relative path such as
 *   "lib/ld-musl-x86_64.so.1" (mode 0755, its directories created first):
 *   what a dynamically linked program needs besides itself, its
 *   interpreter (the runner's sanitizer builds; README "Sanitizers").
 * Throws if any string contains a NUL (it could not be represented) or argv
 * is empty.
 * @param {Uint8Array} program a static executable for the guest's architecture
 * @param {string[]} argv the program's whole argv, argv[0] included
 * @param {string[] | null} env "NAME=value" strings, or null for init's default
 * @param {string[] | null} strace strace's options, or null for no tracing
 * @param {{ path: string, data: Uint8Array }[]} files more files for the guest
 * @returns {Uint8Array}
 */
export function runArchive(program, argv, env = null, strace = null, files = []) {
    if (argv.length === 0) throw new Error('cpio: argv is empty');
    for (const a of [...argv, ...(env ?? []), ...(strace ?? [])]) if (a.includes('\0')) throw new Error('cpio: an argument contains a NUL');
    const z = (list) => enc.encode(list.map((s) => s + '\0').join(''));
    const entries = [
        { name: 'yk', mode: 0o040755 },
        { name: 'yk/prog', mode: 0o100755, data: program },
        { name: 'yk/argv', mode: 0o100644, data: z(argv) },
    ];
    if (env) entries.push({ name: 'yk/env', mode: 0o100644, data: z(env) });
    if (strace) entries.push({ name: 'yk/strace', mode: 0o100644, data: z(strace) });
    const dirs = new Set();
    for (const { path, data } of files) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (!dirs.has(dir)) entries.push({ name: dir, mode: 0o040755 });
            dirs.add(dir);
        }
        entries.push({ name: path, mode: 0o100755, data });
    }
    return cpio(entries);
}

/**
 * Concatenates byte arrays (initramfs segments, download chunks) into one new
 * array; the inputs are not changed.
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
