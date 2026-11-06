/** From a repository snapshot to the archive a student downloads.
 *
 *  Pure: entries in, entries out, plus what was removed and what was wrong.
 *  The builder (../build.ts) reads the tree and writes the archives; this is
 *  the part worth testing in a table.
 */

import { matcher } from './glob.js';
import type { Entry } from './tar.js';
import { CONFIG_FILE, IDE_STATE, buildOutput, excludes, manifestProblems, parseConfig, starterConfig, type Config } from './yukibana.js';

export interface Plan {
  /** What goes in the starter, under `folder/`, a directory entry first. */
  readonly entries: readonly Entry[];
  /** Paths dropped because `yukibana.json` hid them (not the always-dropped
   *  ones: those are noise in a log). For the staff log. */
  readonly hidden: readonly string[];
  /** The parsed contract, when it parsed. */
  readonly config: Config | null;
  /** Reasons the build should fail, in sentences. Empty means build. */
  readonly problems: readonly string[];
  /** Things worth saying that do not stop the build, in sentences. */
  readonly warnings: readonly string[];
}

/** Drops the top-level directory GitHub wraps a tarball in (`org-repo-sha/`). */
export function unwrap(entries: readonly Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const e of entries) {
    const slash = e.path.indexOf('/');
    if (slash < 0) continue; // the wrapper directory itself
    out.push({ ...e, path: e.path.slice(slash + 1) });
  }
  return out;
}

/** Returns the starter for `snapshot`, whose paths are relative to the
 *  repository root.
 *
 *  Every entry is inside one folder named `folder`, so `tar -x` creates a
 *  single folder. Clients unpack that folder's contents and ignore its
 *  name, which therefore promises nothing, not even the project's slug.
 *  `projectId` and `releaseId` are written into the starter's
 *  `yukibana.json`. */
export function planStarter(snapshot: readonly Entry[], folder: string, projectId: string, releaseId: string | null): Plan {
  const byPath = new Map(snapshot.map(e => [e.path, e] as const));
  const configEntry = byPath.get(CONFIG_FILE);
  if (configEntry === undefined || configEntry.type !== 'file') {
    return { entries: [], hidden: [], config: null, problems: [`${CONFIG_FILE} is missing at the repository root`], warnings: [] };
  }
  const parsed = parseConfig(new TextDecoder().decode(configEntry.data));
  if (!parsed.ok) return { entries: [], hidden: [], config: null, problems: [parsed.error], warnings: [] };
  const config = parsed.config;

  const read = (path: string): string | undefined => {
    const e = byPath.get(path);
    return e !== undefined && e.type === 'file' ? new TextDecoder().decode(e.data) : undefined;
  };
  const problems = manifestProblems(config, read);

  const dropAlways = matcher(excludes({ ...config, hidden: [] }));
  const dropHidden = matcher(config.hidden);
  const hidden: string[] = [];
  const mtime = Math.max(0, ...snapshot.map(e => e.mtime));
  const entries: Entry[] = [{ path: folder, type: 'dir', mode: 0o755, mtime, data: new Uint8Array(0) }];
  for (const e of snapshot) {
    if (dropAlways(e.path)) continue;
    if (dropHidden(e.path)) {
      if (e.type !== 'dir') hidden.push(e.path);
      continue;
    }
    if (e.type === 'symlink' && e.linkTarget !== undefined && escapes(e.path, e.linkTarget)) {
      problems.push(`${e.path} is a symlink out of the repository (${e.linkTarget})`);
      continue;
    }
    entries.push({ ...e, path: `${folder}/${e.path}` });
  }
  entries.push({
    path: `${folder}/${CONFIG_FILE}`,
    type: 'file',
    mode: 0o644,
    mtime,
    data: new TextEncoder().encode(starterConfig(config, projectId, releaseId)),
  });
  if (config.hidden.length > 0 && hidden.length === 0) {
    problems.push(`"hidden" names ${config.hidden.join(', ')} but nothing in the repository matches; check the paths`);
  }
  return { entries, hidden, config, problems, warnings: parsed.warnings };
}

/** Whether a symlink at `path` points outside the tree. A link to a hidden
 *  file would otherwise carry it out of the starter by another name, and a
 *  link in a student's submission would otherwise point a teacher's editor
 *  anywhere on their disk. */
export function escapes(path: string, target: string): boolean {
  if (target.startsWith('/')) return true;
  const parts = path.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') {
      if (parts.length === 0) return true;
      parts.pop();
    } else if (seg !== '.' && seg !== '') {
      parts.push(seg);
    }
  }
  return false;
}

/** The teacher archive: the whole project as it is, hidden tests and the
 *  original `yukibana.json` included, minus the history, the IDE's state
 *  and the build output. Staff download it to see exactly what a release was built from,
 *  and an assembly takes the read-only and hidden files from it; students
 *  never can. */
export function planTeacher(snapshot: readonly Entry[], folder: string, config: Config): Entry[] {
  const drop = matcher(['.git', IDE_STATE, ...buildOutput(config.kind)]);
  const mtime = Math.max(0, ...snapshot.map(e => e.mtime));
  const entries: Entry[] = [{ path: folder, type: 'dir', mode: 0o755, mtime, data: new Uint8Array(0) }];
  for (const e of snapshot) {
    if (drop(e.path)) continue;
    entries.push({ ...e, path: `${folder}/${e.path}` });
  }
  return entries;
}
