/** Archives onto the disk: what `starter` and `download` unpack.
 *
 *  A submission is whatever a student sent, so unpacking one is treating
 *  hostile input. A path is written only if it stays inside the target; a
 *  symlink only if it points inside the tree, and only after every file is
 *  written, so no write can pass through a link the archive made.
 */

import { lstat, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { submissionRoot } from './lib/assemble.js';
import { escapes } from './lib/starter.js';
import { readTar, type Entry } from './lib/tar.js';
import { gunzip } from './lib/gzip.js';

/** Returns the entries of `bytes`, a `.tar.gz`, the one format every
 *  archive is in. */
export async function readArchive(bytes: Uint8Array): Promise<Entry[]> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('not a .tar.gz');
  return readTar(await gunzip(bytes));
}

/** Whether `dir` is missing or empty: the only places this writes into. */
export async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw e;
  }
}

/** Writes `entries` under `dir`, which is created. Returns the paths it
 *  refused, with why; the rest are written. Permission bits are kept, minus
 *  anything beyond 0o777, so a script stays executable and nothing becomes
 *  setuid.
 *
 *  Adds to `wrote`, before writing under it, the top-level path in `dir` of
 *  every entry it accepts, so a caller can remove exactly those when a
 *  write fails. Refused entries are never added. */
export async function writeEntries(dir: string, entries: readonly Entry[], wrote = new Set<string>()): Promise<string[]> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const refused: string[] = [];
  const target = (path: string): string | null => {
    if (path === '' || path.startsWith('/') || path.split('/').some(s => s === '..' || s === '') || path.includes('\\')) return null;
    const full = resolve(root, ...path.split('/'));
    return full.startsWith(root + sep) ? full : null;
  };
  const links: Entry[] = [];
  for (const e of entries) {
    const full = target(e.path);
    if (full === null) {
      refused.push(`${e.path}: outside the folder`);
      continue;
    }
    if (e.type !== 'symlink') wrote.add(join(root, e.path.split('/')[0] ?? ''));
    if (e.type === 'dir') {
      await mkdir(full, { recursive: true });
    } else if (e.type === 'file') {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, e.data, { mode: e.mode & 0o777 || 0o644 });
    } else {
      links.push(e);
    }
  }
  for (const e of links) {
    if (e.linkTarget === undefined || escapes(e.path, e.linkTarget)) {
      refused.push(`${e.path}: a symlink out of the folder`);
      continue;
    }
    const full = join(root, ...e.path.split('/'));
    wrote.add(join(root, e.path.split('/')[0] ?? ''));
    try {
      await mkdir(dirname(full), { recursive: true });
      await symlink(e.linkTarget, full);
    } catch (err) {
      refused.push(`${e.path}: ${(err as NodeJS.ErrnoException).code ?? 'not created'}`);
    }
  }
  return refused;
}

/** Unpacks `archive`, a starter as the registry serves it (a `.tar.gz`),
 *  into `folder`, creating it, and returns the entries left out, each as
 *  `path: reason`.
 *
 *  When the archive is a single folder containing a `yukibana.json`, that
 *  folder's contents are unpacked, whatever its name; otherwise the
 *  archive's contents are unpacked as they are. Entries left out are those
 *  that would land outside `folder` and links that point out of it or
 *  could not be made.
 *
 *  Throws, having written nothing, when `archive` is not a whole
 *  `.tar.gz`, or when `folder` exists and is not an empty folder (a file
 *  or a link is not). Throws when a write fails, after removing what was
 *  written: the folders created, or, when `folder` already existed, the
 *  starter's top-level entries in it and nothing else. When that removal
 *  fails too, the error names what remains.
 *
 *  Holds the whole archive and its contents in memory.
 *
 *  Writing straight into `folder` replaces the IDE's staging folder and
 *  copy, which was a second way to fail and once deleted the system's
 *  temporary directory. */
export async function unpackStarter(archive: Uint8Array, folder: string): Promise<string[]> {
  const entries = submissionRoot(await readArchive(archive));
  const root = resolve(folder);
  // lstat, not stat: a link to a folder elsewhere would unpack there.
  const found = await lstat(root).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  if (found !== null && !found.isDirectory()) throw new Error(`${root} is not a folder; nothing was unpacked`);
  if (found !== null && !(await isEmptyDir(root))) throw new Error(`${root} already has files in it; nothing was unpacked`);
  // The first folder this had to create, or undefined when `root` was there.
  const created = await mkdir(root, { recursive: true });
  const wrote = new Set<string>();
  try {
    return await writeEntries(root, entries, wrote);
  } catch (e) {
    // Only what writeEntries accepted. This once took the top level of every
    // entry, refused ones included: `../notes` made it remove the parent of
    // `folder`, and `/etc/x` made it loop for ever.
    const written = created !== undefined ? [created] : [...wrote];
    const left: string[] = [];
    for (const path of written) await rm(path, { recursive: true, force: true }).catch(() => left.push(path));
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(left.length === 0 ? why : `${why}; and could not remove what was written: ${left.join(', ')}`, { cause: e });
  }
}
