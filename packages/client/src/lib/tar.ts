/** Tar, read and written in memory, by `modern-tar`.
 *
 *  A course repository is small — sources, a manifest, a few tests — so the
 *  whole archive fits in memory and this stays a function of bytes,
 *  testable without a filesystem. What it must understand is what GitHub
 *  produces (`git archive`: pax format, a global header carrying the commit,
 *  extended headers for long paths), what GNU tar and bsdtar produce for a
 *  teacher or a student who packs by hand, and what a student's tools will
 *  read (ustar, with pax extensions only when a path is too long for it).
 *  This file only translates between the library's headers and `Entry`,
 *  which is what the plans and the extractor are written against.
 *
 *  It replaced a reader and writer of our own (October 2026). Ours was a
 *  quarter of the size, but read 11 of the 64 archives in Go's and
 *  tar-stream's test suites differently from GNU tar: GNU-format headers
 *  turned timestamps into path prefixes, base-256 sizes read as 0, pax
 *  `size` was ignored, and a file cut short came back short without a word.
 *  Of the libraries that get all of that right, `modern-tar` is the smallest
 *  (about 6 KB gzipped in a bundle) and has no dependencies. Its `strict`
 *  mode is not used: it refuses archives GNU tar reads, such as GNU long
 *  paths and ustar files without the trailing zero blocks.
 */

import { packTar, unpackTar, type TarEntry, type TarHeader } from 'modern-tar';

export type EntryType = 'file' | 'dir' | 'symlink';

export interface Entry {
  /** Forward-slash path, no leading `./`, no trailing slash. */
  readonly path: string;
  readonly type: EntryType;
  /** Unix permission bits. Kept, so `sbt`, `gradlew` and scripts stay executable. */
  readonly mode: number;
  /** Seconds since the epoch. */
  readonly mtime: number;
  readonly data: Uint8Array;
  /** For a symlink: where it points. */
  readonly linkTarget?: string;
}

const clean = (path: string): string => path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

const NONE = new Uint8Array(0);

/** Every entry of the archive, in order. Global and extended headers are
 *  folded in by the library and never appear. Types other than file,
 *  directory and symlink (hard links, devices, fifos) are dropped: none
 *  belongs in a source tree, and a student's tar would refuse them anyway.
 *  An archive that ends between entries gives the entries before the end;
 *  one that ends inside a file throws, rather than hand back part of it. */
export async function readTar(bytes: Uint8Array): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const { header: h, data } of await unpackTar(bytes)) {
    // An old (v7) archive marks a directory only by its trailing slash.
    const isDir = h.type === 'directory' || (h.type === 'file' && h.name.endsWith('/'));
    const path = clean(h.name);
    if (path === '') continue;
    const mode = (h.mode ?? 0) & 0o7777;
    const mtime = Math.floor((h.mtime?.getTime() ?? 0) / 1000);
    if (isDir) {
      entries.push({ path, type: 'dir', mode, mtime, data: NONE });
    } else if (h.type === 'symlink') {
      entries.push({ path, type: 'symlink', mode, mtime, data: NONE, linkTarget: h.linkname ?? '' });
    } else if (h.type === 'file') {
      // The library returns what there was of a file the archive cut short.
      if ((data?.length ?? 0) !== h.size) throw new Error(`the archive ends inside ${path} (${data?.length ?? 0} of ${h.size} bytes)`);
      entries.push({ path, type: 'file', mode, mtime, data: data ?? NONE });
    }
  }
  return entries;
}

const TYPE = { file: 'file', dir: 'directory', symlink: 'symlink' } as const satisfies Record<EntryType, TarHeader['type']>;

/** The archive for these entries, ustar with a pax extended header wherever a
 *  path, link target or number does not fit. Entries are written in the
 *  order given; callers put a directory before its contents. Owners are 0
 *  and unnamed, so the archive says nothing about the machine it was made
 *  on. */
export function writeTar(entries: readonly Entry[]): Promise<Uint8Array<ArrayBuffer>> {
  return packTar(
    entries.map((e): TarEntry => {
      // The ustar field holds 0 to 8^11 - 1 seconds, and the library writes
      // anything else as garbage; outside that, a pax record carries the date.
      const fits = e.mtime >= 0 && e.mtime < 8 ** 11;
      const header: TarHeader = {
        name: e.type === 'dir' ? `${e.path}/` : e.path,
        type: TYPE[e.type],
        size: e.type === 'file' ? e.data.length : 0,
        mode: e.mode,
        mtime: new Date((fits ? e.mtime : 0) * 1000),
        uid: 0,
        gid: 0,
        uname: '',
        gname: '',
      };
      if (!fits) header.pax = { mtime: String(e.mtime) };
      if (e.linkTarget !== undefined) header.linkname = e.linkTarget;
      return e.type === 'file' ? { header, body: e.data } : { header };
    }),
  );
}
