/** From a project directory to the two archives a release is made of. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { v7 as uuidv7 } from 'uuid';
import { type Config, gzip, planStarter, planTeacher, readTree, writeTar } from '@yukibana/client';

export interface Built {
  /** gzipped tar of the starter, unpacking into `folder/`. */
  readonly starter: Uint8Array;
  /** gzipped tar of the whole project, unpacking into `folder/`. */
  readonly teacher: Uint8Array;
  readonly config: Config;
  /** Paths the starter dropped because `yukibana.json` hid them. */
  readonly hidden: readonly string[];
  /** What the build noticed and did not fail for, in sentences. */
  readonly warnings: readonly string[];
  /** How many entries the starter holds, folder excluded. */
  readonly starterEntries: number;
}

export type BuildResult = { ok: true; built: Built } | { ok: false; problems: readonly string[] };

/** Builds `dir`. `folder` is what the archives unpack into; `projectId` and
 *  `releaseId` go into the starter's copy of yukibana.json, or are left out
 *  (empty, null) when the build is only a check. The release id must be the
 *  one the release is then published with (`newReleaseId`), or the
 *  student's folder names a release that does not exist. Problems are
 *  sentences for the terminal. */
export async function build(dir: string, folder: string, projectId: string, releaseId: string | null): Promise<BuildResult> {
  const tree = await readTree(dir);
  const plan = planStarter(tree, folder, projectId, releaseId);
  if (plan.problems.length > 0 || plan.config === null) return { ok: false, problems: plan.problems };
  const starter = await gzip(await writeTar(plan.entries));
  const teacher = await gzip(await writeTar(planTeacher(tree, folder, plan.config)));
  return { ok: true, built: { starter, teacher, config: plan.config, hidden: plan.hidden, warnings: plan.warnings, starterEntries: plan.entries.length - 1 } };
}

/** The commit `dir` is at, or null when it is not a git checkout. */
export async function commitOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** A fresh id for a release about to be built and published: chosen here,
 *  before the build, so the starter can carry it. A UUIDv7 (RFC 9562), as
 *  the database's `app.uuidv7()` makes, so it looks and sorts like an id the
 *  database chose. Uniqueness comes from its random bits, not the clock, and
 *  the database refuses a duplicate anyway; ordering between releases is
 *  `project_release.seq`, never this id. Made by the `uuid` package, which
 *  replaced a generator of our own (October 2026). */
export function newReleaseId(): string {
  return uuidv7();
}
