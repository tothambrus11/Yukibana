/** A student's submission put back together with the teacher's project.
 *
 *  A student receives the starter: the project minus what `hidden` names,
 *  with `readOnly` files they are asked not to touch. What they send back
 *  lacks the hidden tests (they never had them) and may have changed,
 *  deleted or added to a read-only file (the IDE stops the honest, nothing
 *  stops the rest). An assembly is what a teacher grades: the student's
 *  files, except that every read-only path, every hidden path and
 *  `yukibana.json` itself are deleted from the submission and taken from the
 *  teacher archive instead. What the student had changed there is undone
 *  and reported, never silently.
 *
 *  Two releases can be involved. The assembly takes its protected files
 *  from the release it grades with (usually the newest, so a fixed hidden
 *  test applies to everyone), but asks what the student changed of the
 *  release they started from: a read-only file fixed in a later release is
 *  not something the student did. When the two releases protect different
 *  paths, nothing is lost in silence either way: a student's file replaced
 *  only because the grading release protects it is `overridden`, and a
 *  change the grading release no longer protects stays and is `unrestored`.
 *
 *  Pure: entries in, entries out. `yukibana download --assemble` and
 *  `yukibana assemble` do the reading and the writing.
 */

import { matcher } from './glob.js';
import { escapes, unwrap } from './starter.js';
import type { Entry } from './tar.js';
import { CONFIG_FILE, excludes, parseConfig, protectedPaths, sameStudentConfig, type Config } from './yukibana.js';

/** What the student did to files they were not meant to touch. Every list
 *  is sorted and empty when they did nothing. */
export interface Tampering {
  /** Read-only files (or `yukibana.json`) the submission has with other
   *  contents than the starter had. All three lists are against the release
   *  the student started from, whatever the assembly grades with. */
  readonly modified: readonly string[];
  /** Read-only files (or `yukibana.json`) the starter had and the
   *  submission does not. */
  readonly deleted: readonly string[];
  /** Files the submission has under a read-only or hidden path that the
   *  teacher's project does not: a test a student wrote into the hidden
   *  folder, say. Dropped. */
  readonly added: readonly string[];
}

export interface Assembly {
  /** The assembled project, paths relative to its root, sorted so that a
   *  directory comes before what is in it. */
  readonly entries: readonly Entry[];
  readonly tampering: Tampering;
  /** Paths in `tampering` that the grading release does not protect, so the
   *  student's version (or its absence) is what the assembly holds. Empty
   *  when the student started from the release being graded with. Sorted. */
  readonly unrestored: readonly string[];
  /** Student files the release they started from let them change, which the
   *  grading release protects and so replaced or dropped: not tampering, but
   *  their work is not in the assembly. Empty when both releases are one.
   *  Sorted. */
  readonly overridden: readonly string[];
  /** Symlinks in the submission that pointed out of the project, dropped. */
  readonly refused: readonly string[];
}

export type Assembled = { ok: true; assembly: Assembly; config: Config } | { ok: false; problem: string };

/** Whether an assembly found anything a teacher should look at. */
export const tampered = (t: Tampering): boolean => t.modified.length + t.deleted.length + t.added.length > 0;

/** The project root of a submission's entries.
 *
 *  `yukibana submit` packs paths relative to the project root, with
 *  `yukibana.json` at the top. A student who made the archive by hand may
 *  have packed the folder instead, so when there is no config at the top but
 *  exactly one directory holds everything and has one, that directory is the
 *  root. Anything else is taken as it is: guessing harder would guess wrong
 *  for a project that happens to have one top-level folder. */
export function submissionRoot(entries: readonly Entry[]): Entry[] {
  if (entries.some(e => e.path === CONFIG_FILE)) return [...entries];
  const tops = new Set(entries.map(e => e.path.split('/')[0]));
  const [only] = tops;
  if (tops.size === 1 && only !== undefined && entries.some(e => e.path === `${only}/${CONFIG_FILE}`)) {
    return unwrap(entries);
  }
  return [...entries];
}

/** The teacher archive's entries relative to the project root, and the
 *  config it was built with. A teacher archive always unpacks into one
 *  folder (see `planTeacher`). */
export function teacherRoot(entries: readonly Entry[]): { ok: true; entries: Entry[]; config: Config } | { ok: false; problem: string } {
  const root = unwrap(entries);
  const cfg = root.find(e => e.path === CONFIG_FILE && e.type === 'file');
  if (cfg === undefined) return { ok: false, problem: `the teacher archive has no ${CONFIG_FILE}` };
  const parsed = parseConfig(new TextDecoder().decode(cfg.data));
  if (!parsed.ok) return { ok: false, problem: `the teacher archive's ${parsed.error}` };
  return { ok: true, entries: root, config: parsed.config };
}

/** Assembles a submission (as unpacked; see `submissionRoot`) with a teacher
 *  archive (as read, still in its folder). The teacher's config decides
 *  what is protected: the student's copy of the file is one of the things a
 *  student could have changed.
 *
 *  `baseArchive` is the teacher archive of the release the student started
 *  from, when that is known and is not `teacherArchive`: what they changed
 *  is measured against it, under its config. Left out, both are the same
 *  release, which is all an assembly could do before releases had ids. */
export function assemble(submission: readonly Entry[], teacherArchive: readonly Entry[], baseArchive: readonly Entry[] = teacherArchive): Assembled {
  const teacher = teacherRoot(teacherArchive);
  if (!teacher.ok) return teacher;
  const base = baseArchive === teacherArchive ? teacher : teacherRoot(baseArchive);
  if (!base.ok) return { ok: false, problem: `the release the student started from: ${base.problem}` };
  const config = teacher.config;
  const isProtected = matcher(protectedPaths(config));
  const wasProtected = matcher(protectedPaths(base.config));
  // What the starter had: a file the student never received cannot have
  // been deleted by them.
  const notInStarter = matcher(excludes(base.config));

  const theirs = new Map<string, Entry>();
  for (const e of teacher.entries) {
    if (isProtected(e.path)) theirs.set(e.path, e);
  }
  const before = new Map<string, Entry>();
  for (const e of base.entries) {
    if (wasProtected(e.path)) before.set(e.path, e);
  }
  const out = new Map<string, Entry>();
  const mine = new Map<string, Entry>();
  const refused: string[] = [];
  const overridden: string[] = [];
  for (const e of submissionRoot(submission)) {
    if (wasProtected(e.path) && e.type !== 'dir') mine.set(e.path, e);
    if (isProtected(e.path)) {
      const t = theirs.get(e.path);
      if (!wasProtected(e.path) && e.type !== 'dir' && (t === undefined || !same(e, t))) overridden.push(e.path);
      continue;
    }
    if (e.type === 'symlink' && (e.linkTarget === undefined || escapes(e.path, e.linkTarget))) {
      refused.push(e.path);
      continue;
    }
    out.set(e.path, e);
  }

  const modified: string[] = [];
  const deleted: string[] = [];
  const added: string[] = [];
  for (const [path, e] of mine) {
    const t = before.get(path);
    if (path === CONFIG_FILE) {
      if (e.type !== 'file' || !sameStudentConfig(base.config, new TextDecoder().decode(e.data))) modified.push(path);
    } else if (t === undefined || notInStarter(path)) {
      added.push(path);
    } else if (!same(e, t)) {
      modified.push(path);
    }
  }
  for (const [path, t] of before) {
    if (t.type === 'dir' || mine.has(path)) continue;
    if (path === CONFIG_FILE || !notInStarter(path)) deleted.push(path);
  }

  for (const [path, e] of theirs) out.set(path, e);
  const entries = [...out.values()].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const unrestored = [...modified, ...deleted, ...added].filter(p => !isProtected(p)).toSorted();
  return {
    ok: true,
    config,
    assembly: {
      entries,
      refused,
      unrestored,
      overridden: overridden.toSorted(),
      tampering: { modified: modified.toSorted(), deleted: deleted.toSorted(), added: added.toSorted() },
    },
  };
}

/** Whether a student's entry is the teacher's, byte for byte. */
function same(mine: Entry, theirs: Entry): boolean {
  if (theirs.type !== mine.type) return false;
  if (mine.type === 'symlink') return mine.linkTarget === theirs.linkTarget;
  if (mine.data.length !== theirs.data.length) return false;
  return mine.data.every((b, i) => b === theirs.data[i]);
}
