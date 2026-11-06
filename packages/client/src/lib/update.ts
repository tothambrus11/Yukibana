/** What bringing a student's folder up to a newer release does to each file.
 *
 *  A student's folder started from one release's starter (its `yukibana.json`
 *  says which: the stamp). The teacher has since published another. The
 *  IDE's update, and any other host, asks `planUpdate` what to do with every
 *  path, and gets one of four answers:
 *
 *  * `write` / `delete`: decided. Either the path is protected (read-only in
 *    either release, or `yukibana.json`), and protected files are the
 *    teacher's, or only the teacher changed it, so taking their version
 *    loses nothing the student wrote.
 *  * `merge`: an editable text file that both changed. The host keeps the
 *    student's version and offers a three-way merge (base, theirs, the
 *    student's file); this library does not merge.
 *  * `choose`: both did something no line merge can join (a binary file, a
 *    file one of them deleted, two different files created at one path).
 *    The host keeps the student's state and offers the teacher's.
 *
 *  "Protected in either release" is the rule, rather than "in the newest",
 *  because the stamp moves with the update: before it, grading measures the
 *  folder against the old release, after it against the new one, and a path
 *  protected in either is one where the student's copy would read as
 *  tampering on one side of that move. Matching uses `matcher`, the same as
 *  the assembly, so the update and grading agree on what is protected; the
 *  patterns come from the two starters' configs, never from the folder's
 *  copy, which the student can edit. A starter's config has no `hidden`
 *  (`starterConfig` drops it), so a file the teacher moved into `hidden`
 *  looks deleted here: a protected or untouched one is deleted, which is
 *  right, and one the student changed is a `choose`, where keeping it may
 *  be reported at grading. That is a limit of what a student may know.
 *
 *  "Same" means the same bytes and the same executable bit, so a script the
 *  teacher made executable is updated. Only regular files are compared.
 *  Something that is not a regular file in the folder where a starter has
 *  one (a symlink, a directory) is never the same as anything.
 *
 *  Pure: two starters' entries and a snapshot of the folder in, decisions
 *  out. `wantedPaths` says which folder paths the snapshot must hold.
 */

import { submissionRoot } from './assemble.js';
import { matcher } from './glob.js';
import type { Entry } from './tar.js';
import { CONFIG_FILE, parseConfig, type Config } from './yukibana.js';

/** One version of a file. `mode` holds the permission bits, as in `Entry`. */
export interface Version {
  readonly data: Uint8Array;
  readonly mode: number;
}

/** What the folder holds at a path: a regular file, or `other` for a
 *  symlink, a directory or anything else where a file could be. A path
 *  that is not in the map is absent. */
export type FolderEntry = ({ readonly kind: 'file' } & Version) | { readonly kind: 'other' };

/** The folder's paths the plan needs (see `wantedPaths`), relative to the
 *  folder's root with forward slashes. */
export type Folder = ReadonlyMap<string, FolderEntry>;

/** Why a `choose` cannot be a line merge. */
export type ChooseReason =
  /** Both changed it, and one of the versions is not text (or not a file). */
  | 'binary'
  /** Both created a file at a path the base did not have, differently. */
  | 'bothAdded'
  /** The student deleted it; the teacher changed it. */
  | 'deletedByStudent'
  /** The teacher deleted it (or made it hidden); the student changed it. */
  | 'deletedByTeacher';

/** One path's fate.
 *
 *  `protected`: read-only in either release, or `yukibana.json`.
 *  `editedByStudent`: the folder's copy differs from the base release's, so
 *  writing or deleting it replaces something the student did; a host warns
 *  before, and keeps the old copy. `newlyProtected`: protected in the newest
 *  release and editable in the base, so what the student did there was
 *  their work until now. Both are only ever true on a protected path.
 *
 *  `base` and `theirs` on `merge` and `choose` are the two releases'
 *  versions, null where that release has no file. */
export type Change =
  | {
      readonly kind: 'write';
      readonly path: string;
      readonly theirs: Version;
      readonly protected: boolean;
      readonly editedByStudent: boolean;
      readonly newlyProtected: boolean;
    }
  | {
      readonly kind: 'delete';
      readonly path: string;
      readonly protected: boolean;
      readonly editedByStudent: boolean;
      readonly newlyProtected: boolean;
    }
  | { readonly kind: 'merge'; readonly path: string; readonly base: Version | null; readonly theirs: Version }
  | { readonly kind: 'choose'; readonly path: string; readonly reason: ChooseReason; readonly base: Version | null; readonly theirs: Version | null };

export interface UpdatePlan {
  /** The release the folder is updated to, as the newest starter's config
   *  says; null for a starter built without one. */
  readonly to: string | null;
  /** The release the folder started from, as the base starter's config says. */
  readonly from: string | null;
  /** The newest release's config. */
  readonly config: Config;
  /** One change per path that differs, in the order a host applies the
   *  decided ones: deletes, then writes, `yukibana.json` last, each group by
   *  path. Deletes go first so that a rename that only changes case does not
   *  delete the new file on a case-insensitive disk. `yukibana.json` goes
   *  last because it carries the stamp: a host that stops halfway leaves a
   *  folder that still says it is on the old release. `merge` and `choose`
   *  come after, by path. A path where nothing is to be done is not listed. */
  readonly changes: readonly Change[];
}

export type Planned = { readonly ok: true; readonly plan: UpdatePlan } | { readonly ok: false; readonly problem: string };

/** The paths of `folderPaths` (every file in the folder, relative) whose
 *  contents `planUpdate` needs, together with every path either starter
 *  has. A folder file that neither starter has matters only when it is
 *  protected: an update deletes it, as the assembly would ignore or flag it. */
export function wantedPaths(base: readonly Entry[], newest: readonly Entry[], folderPaths: Iterable<string>): string[] {
  const configs = bothConfigs(base, newest);
  const wanted = new Set<string>([...filesOf(base).keys(), ...filesOf(newest).keys()]);
  if (configs.ok) {
    const isProtected = protectedIn(configs.base, configs.newest);
    for (const p of folderPaths) if (isProtected(p)) wanted.add(p);
  }
  return [...wanted].toSorted();
}

/** Classifies every path of either starter, and every protected path of
 *  the folder. `base` and `newest` are the two releases' starters as read
 *  (`readArchive`), wrapped in a folder or not; `folder` is the student's
 *  folder at least at `wantedPaths`. */
export function planUpdate(base: readonly Entry[], newest: readonly Entry[], folder: Folder): Planned {
  const configs = bothConfigs(base, newest);
  if (!configs.ok) return configs;
  const isProtected = protectedIn(configs.base, configs.newest);
  const wasProtected = protectedIn(configs.base);
  const before = filesOf(base);
  const after = filesOf(newest);
  const paths = new Set([...before.keys(), ...after.keys(), ...[...folder.keys()].filter(isProtected)]);

  const changes: Change[] = [];
  for (const path of paths) {
    const change = decide(path, before.get(path) ?? null, after.get(path) ?? null, folder.get(path) ?? null, isProtected(path), wasProtected(path));
    if (change !== null) changes.push(change);
  }
  changes.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, plan: { from: configs.base.releaseId, to: configs.newest.releaseId, config: configs.newest, changes } };
}

/** Whether the plan changes nothing but `yukibana.json`, which the student
 *  never edits: the newest release differs from the base only in what the
 *  student does not receive (hidden tests, the teacher archive) or in the
 *  config itself. A host can then move the stamp without asking. */
export function onlyTheStamp(plan: UpdatePlan): boolean {
  return plan.changes.every(c => c.path === CONFIG_FILE && c.kind === 'write' && !c.editedByStudent);
}

function decide(path: string, b: Version | null, t: Version | null, m: FolderEntry | null, isProtected: boolean, wasProtected: boolean): Change | null {
  if (m !== null && t !== null && same(m, t)) return null;
  if (m === null && t === null) return null;

  const studentChanged = m === null ? b !== null : b === null || !same(m, b);
  if (!isProtected) {
    if (sameVersion(b, t)) return null;
    if (studentChanged) return toSettle(path, b, t, m);
  }
  // Protected, or only the teacher changed it: the teacher's version
  const flags = { protected: isProtected, editedByStudent: isProtected && m !== null && studentChanged, newlyProtected: isProtected && !wasProtected && path !== CONFIG_FILE };
  return t === null ? { kind: 'delete', path, ...flags } : { kind: 'write', path, theirs: t, ...flags };
}

/** A path both changed, which the student settles: merged when it can be, else chosen. */
function toSettle(path: string, b: Version | null, t: Version | null, m: FolderEntry | null): Change {
  if (m === null) return { kind: 'choose', path, reason: 'deletedByStudent', base: b, theirs: t };
  if (t === null) return { kind: 'choose', path, reason: 'deletedByTeacher', base: b, theirs: t };
  if (b === null) return { kind: 'choose', path, reason: 'bothAdded', base: b, theirs: t };
  if (m.kind !== 'file' || !isText(m.data) || !isText(b.data) || !isText(t.data)) return { kind: 'choose', path, reason: 'binary', base: b, theirs: t };
  return { kind: 'merge', path, base: b, theirs: t };
}

function rank(c: Change): number {
  if (c.kind === 'delete') return 0;
  if (c.kind === 'write') return c.path === CONFIG_FILE ? 2 : 1;
  return 3;
}

/** The regular files of a starter, by path relative to its root (a
 *  starter `git archive` made is wrapped in one folder). */
function filesOf(entries: readonly Entry[]): Map<string, Version> {
  const files = new Map<string, Version>();
  for (const e of submissionRoot(entries)) if (e.type === 'file') files.set(e.path, { data: e.data, mode: e.mode });
  return files;
}

type Configs = { ok: true; base: Config; newest: Config } | { ok: false; problem: string };

function bothConfigs(base: readonly Entry[], newest: readonly Entry[]): Configs {
  const b = configOf(base, 'the release this folder started from');
  if (!b.ok) return b;
  const n = configOf(newest, 'the newest release');
  if (!n.ok) return n;
  return { ok: true, base: b.config, newest: n.config };
}

function configOf(entries: readonly Entry[], which: string): { ok: true; config: Config } | { ok: false; problem: string } {
  const file = filesOf(entries).get(CONFIG_FILE);
  if (file === undefined) return { ok: false, problem: `${which} has no ${CONFIG_FILE}` };
  const parsed = parseConfig(new TextDecoder().decode(file.data));
  return parsed.ok ? { ok: true, config: parsed.config } : { ok: false, problem: `${which}: ${parsed.error}` };
}

function protectedIn(...configs: readonly Config[]): (path: string) => boolean {
  // Not protectedPaths: hidden paths are the teacher's to grade, but a student's own file there is not the update's to delete
  const matches = configs.map(c => matcher(c.readOnly));
  return path => path === CONFIG_FILE || matches.some(m => m(path));
}

function same(m: FolderEntry, v: Version): boolean {
  return m.kind === 'file' && sameVersion(m, v);
}

function sameVersion(a: Version | null, b: Version | null): boolean {
  if (a === null || b === null) return a === b;
  return (a.mode & 0o111) === (b.mode & 0o111) && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);
}

/** Whether a person would merge the bytes line by line: UTF-8, and no NUL,
 *  which is how git tells too. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
