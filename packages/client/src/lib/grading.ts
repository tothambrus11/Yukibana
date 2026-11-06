/** Which release a submission is assembled with, and which it is compared
 *  with.
 *
 *  A submission says which release it started from twice: the registry
 *  recorded it on arrival (`baseReleaseId`, only ever a release of the same
 *  project), and the student's yukibana.json inside the archive says it
 *  too. They differ only for an archive sent some other way than `submit`,
 *  or one whose file was edited. Either way the student's claim decides
 *  nothing on its own: a release counts only when it is one of the
 *  project's.
 *
 *  Pure: lists and ids in, a decision out. `download --assemble` does the
 *  fetching.
 */

/** A release as the decision needs it: the project's list, newest first. */
export interface ReleaseRef {
  readonly releaseId: string;
  readonly label: string;
}

/** What `--release` asked for: each submission's own release (the
 *  default), the newest, or one release of the project by id. */
export type Wanted = 'own' | 'newest' | { readonly releaseId: string };

export interface Choice<R extends ReleaseRef> {
  /** The release whose read-only and hidden files the assembly takes. */
  readonly grade: R;
  /** The release the student started from, which what they changed is
   *  measured against; null when that is unknown, and then `grade` is. */
  readonly base: R | null;
  /** Anything about the claim a teacher should read, in sentences. */
  readonly notes: readonly string[];
}

/** A release's name for a terminal: its label and its whole id, which is
 *  what `--release` takes and the only name that tells two unlabelled
 *  releases apart (the start of a v7 id is only its time). */
export const nameOf = (r: ReleaseRef): string => (r.label === '' ? r.releaseId : `${r.label} (${r.releaseId})`);

/** What `--release` names, checked against the project's releases before
 *  anything is downloaded: an id that is not one of them is refused, never
 *  quietly replaced by another. */
export function wantedRelease(releases: readonly ReleaseRef[], given: string | undefined): { ok: true; wanted: Wanted } | { ok: false; problem: string } {
  if (releases.length === 0) return { ok: false, problem: 'no release to assemble with: publish one first' };
  if (given === undefined) return { ok: true, wanted: 'own' };
  if (given === 'newest') return { ok: true, wanted: 'newest' };
  const id = given.toLowerCase();
  if (!releases.some(r => r.releaseId === id)) return { ok: false, problem: `${given} is not a release of this project; \`yukibana releases\` lists them` };
  return { ok: true, wanted: { releaseId: id } };
}

/** The releases for one submission. `releases` is the project's list,
 *  newest first and not empty (`wantedRelease` refused an empty one);
 *  `recorded` is what the registry kept, `claimed` what the archive's
 *  yukibana.json says. */
export function chooseReleases<R extends ReleaseRef>(releases: readonly R[], wanted: Wanted, recorded: string | null, claimed: string | null): Choice<R> {
  const find = (id: string | null): R | null => (id === null ? null : (releases.find(r => r.releaseId === id.toLowerCase()) ?? null));
  const newest = releases[0];
  if (newest === undefined) throw new Error('chooseReleases: no releases (wantedRelease refuses that first)');
  const notes: string[] = [];
  const fromRegistry = find(recorded);
  const fromArchive = find(claimed);
  const base = fromRegistry ?? fromArchive;
  if (claimed !== null && fromArchive === null) {
    notes.push(`its yukibana.json names release ${claimed}, which is not a release of this project`);
  } else if (fromRegistry !== null && fromArchive !== null && fromRegistry !== fromArchive) {
    notes.push(`it was sent as started from ${nameOf(fromRegistry)}, but its yukibana.json names ${nameOf(fromArchive)}; compared with ${nameOf(fromRegistry)}`);
  }
  const grade = wanted === 'own' ? (base ?? newest) : wanted === 'newest' ? newest : (find(wanted.releaseId) ?? newest);
  return { grade, base, notes };
}

/** Why a submission is not based on the newest release, as a sentence for a
 *  warning, or null when it is (or there are no releases to compare with:
 *  a student's list is empty, since students cannot read releases).
 *  `releases` is the project's list, newest first; `base` the release the
 *  registry recorded for the submission. */
export function behind(releases: readonly ReleaseRef[], base: string | null): string | null {
  const [newest] = releases;
  if (newest === undefined || base === newest.releaseId) return null;
  if (base === null) return `does not say which release it started from, so it may predate the newest, ${nameOf(newest)}`;
  const at = releases.findIndex(r => r.releaseId === base);
  const from = releases[at];
  if (from === undefined) return `started from ${base}, which is not a release of this project`;
  return `started from ${nameOf(from)}, ${at === 1 ? 'one release' : `${at} releases`} behind the newest, ${nameOf(newest)}`;
}
