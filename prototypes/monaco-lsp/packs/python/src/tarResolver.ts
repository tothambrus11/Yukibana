/*
 * A read-only, lazily materialised view of a ustar archive held in memory,
 * shaped as pyright's own vfs `FileSystemResolver` so that
 * `TestFileSystem.mountSync` can mount it.
 *
 * Why this exists: the upstream browser build inlines all of typeshed (stdlib
 * and every third-party stub package) into the worker bundle as one JSON
 * object, which makes `pyright.worker.js` 18 MB. This pack ships only the
 * stdlib stubs as a separate gzipped tar (fetched by the worker, decompressed
 * with the browser's native `DecompressionStream`), indexes the headers once,
 * and hands out file bytes as zero-copy `Buffer` views only when pyright
 * actually reads a file. Pyright's vfs caches what it has read.
 */

import { Buffer } from 'buffer';
import { FileSystemResolver, FileSystemResolverDirEntry } from 'pyright-internal/tests/harness/vfs/filesystem';

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

interface FileEntry {
    readonly offset: number;
    readonly size: number;
}

function enoent(path: string): Error {
    const error = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
    error.code = 'ENOENT';
    return error;
}

const decoder = new TextDecoder();

/** Reads a NUL-terminated ASCII field of a tar header. */
function field(bytes: Uint8Array, start: number, length: number): string {
    let end = start;
    while (end < start + length && bytes[end] !== 0) {
        end++;
    }
    return decoder.decode(bytes.subarray(start, end));
}

/**
 * Parses a POSIX ustar archive (as written by Python's `tarfile` with
 * `format=USTAR_FORMAT`, which refuses names it cannot store, so there are no
 * pax or GNU long-name records to follow). Paths are exposed as absolute,
 * `/`-separated, without a trailing slash: `/stdlib/os/__init__.pyi`.
 */
export class TarResolver implements FileSystemResolver {
    private readonly _files = new Map<string, FileEntry>();
    private readonly _dirs = new Map<string, Map<string, FileSystemResolverDirEntry>>();

    constructor(private readonly _bytes: Uint8Array) {
        this._dirs.set('/', new Map());
        let offset = 0;
        while (offset + 512 <= _bytes.length) {
            const header = _bytes.subarray(offset, offset + 512);
            if (header.every((b) => b === 0)) {
                break; // end-of-archive marker
            }
            const magic = field(header, 257, 6);
            if (magic !== 'ustar') {
                throw new Error(`typeshed archive: unexpected tar header at byte ${offset} (magic '${magic}')`);
            }
            const name = field(header, 0, 100);
            const prefix = field(header, 345, 155);
            const size = parseInt(field(header, 124, 12).trim() || '0', 8);
            const type = String.fromCharCode(header[156] || 0x30);
            const path = normalise((prefix ? prefix + '/' : '') + name);
            const dataStart = offset + 512;
            if (type === '0' || type === '\0') {
                this._addFile(path, dataStart, size);
            } else if (type === '5') {
                this._addDir(path);
            } else {
                throw new Error(`typeshed archive: unsupported entry type '${type}' for ${path}`);
            }
            offset = dataStart + Math.ceil(size / 512) * 512;
        }
    }

    /** Number of files in the archive (for logging). */
    get fileCount(): number {
        return this._files.size;
    }

    statSync(path: string): { mode: number; size: number } {
        const key = normalise(path);
        const file = this._files.get(key);
        if (file) {
            return { mode: S_IFREG | 0o444, size: file.size };
        }
        if (this._dirs.has(key)) {
            return { mode: S_IFDIR | 0o555, size: 0 };
        }
        throw enoent(path);
    }

    readdirSync(path: string): ReadonlyArray<FileSystemResolverDirEntry> {
        const dir = this._dirs.get(normalise(path));
        if (!dir) {
            throw enoent(path);
        }
        return [...dir.values()];
    }

    readFileSync(path: string): Buffer {
        const file = this._files.get(normalise(path));
        if (!file) {
            throw enoent(path);
        }
        return Buffer.from(this._bytes.buffer, this._bytes.byteOffset + file.offset, file.size);
    }

    private _addFile(path: string, offset: number, size: number) {
        this._files.set(path, { offset, size });
        this._link(path, 'file', size);
    }

    private _addDir(path: string) {
        if (this._dirs.has(path)) {
            return;
        }
        this._dirs.set(path, new Map());
        this._link(path, 'directory');
    }

    /** Records `path` in its parent directory, creating missing parents. */
    private _link(path: string, kind: 'file' | 'directory', size?: number) {
        const slash = path.lastIndexOf('/');
        const parent = slash <= 0 ? '/' : path.slice(0, slash);
        const name = path.slice(slash + 1);
        if (!this._dirs.has(parent)) {
            this._addDir(parent);
        }
        this._dirs.get(parent)!.set(name, size === undefined ? { name, kind } : { name, kind, size });
    }
}

function normalise(path: string): string {
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    return '/' + parts.join('/');
}
