/** A directory as tar entries, the way `git archive` would see it minus the
 *  history: every file and directory under `dir`, symlinks kept as links,
 *  sorted so two runs over the same tree give the same archive. The
 *  excludes are applied later by the plans; this walks everything except
 *  `.git`, which is never wanted and can be enormous, and what the caller
 *  says it will drop anyway. */

import { readdir, readFile, readlink, stat, lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { GITIGNORE } from './lib/pack.js';
import type { Entry } from './lib/tar.js';

/** What a walk may leave unread, for a caller that will drop it anyway. */
export interface TreeOptions {
  /** `true` iff `path` (a folder iff `folder`) is dropped by the caller. A
   *  folder it names is listed but not entered, and a file listed without
   *  its contents, so a large `target/` costs one entry. A `.gitignore` is
   *  read even then: the plans take the rules from the tree, and a blank
   *  one once made them keep, as empty files, what it ignores. */
  readonly skip?: (path: string, folder: boolean) => boolean;
  /** Called with each entered folder's `.gitignore` (folder `''` for the
   *  root) before `skip` is asked about anything in that folder. */
  readonly gitignore?: (folder: string, patterns: string) => void;
}

/** Returns the entries under `dir`, a folder before anything in it, each
 *  folder's contents sorted by name.
 *
 *  Reads every file it lists into memory, except those `options.skip`
 *  names. */
export async function readTree(dir: string, options: TreeOptions = {}): Promise<Entry[]> {
  const root = await stat(dir);
  if (!root.isDirectory()) throw new Error(`${dir} is not a directory`);
  const out: Entry[] = [];
  await walk(dir, '', out, options);
  return out;
}

/** Lists the folder `folder` (an archive path, `''` for `root`) into `out`.
 *  Archive paths are built with `posix.join` as the walk goes down, rather
 *  than by turning a Windows path's backslashes round afterwards. */
async function walk(root: string, folder: string, out: Entry[], options: TreeOptions): Promise<void> {
  const here = join(root, folder);
  const names = (await readdir(here)).toSorted();
  if (options.gitignore !== undefined && names.includes(GITIGNORE)) {
    const s = await lstat(join(here, GITIGNORE));
    if (s.isFile()) options.gitignore(folder, await readFile(join(here, GITIGNORE), 'utf8'));
  }
  for (const name of names) {
    const full = join(here, name);
    const path = posix.join(folder, name);
    if (path === '.git') continue;
    const s = await lstat(full);
    const mtime = Math.floor(s.mtimeMs / 1000);
    const skipped = options.skip?.(path, s.isDirectory()) ?? false;
    if (s.isSymbolicLink()) {
      out.push({ path, type: 'symlink', mode: 0o777, mtime, data: new Uint8Array(0), linkTarget: await readlink(full) });
    } else if (s.isDirectory()) {
      out.push({ path, type: 'dir', mode: s.mode & 0o7777, mtime, data: new Uint8Array(0) });
      if (!skipped) await walk(root, path, out, options);
    } else if (s.isFile()) {
      out.push({ path, type: 'file', mode: s.mode & 0o7777, mtime, data: skipped && name !== GITIGNORE ? new Uint8Array(0) : new Uint8Array(await readFile(full)) });
    }
  }
}
