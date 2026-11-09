/** Where each student of a project stands: who has handed something in,
 *  who handed it in late, and what each hand-in was built on.
 *
 *  The staff's Submissions tab is one row per student, not one per
 *  submission: a teacher's question is "who still owes me this?", and a
 *  list of submissions cannot answer it, because the students who sent
 *  nothing are not in it. This module turns the two lists the page loads
 *  (the edition's students and the project's submissions) into those rows.
 *  It decides nothing the database decides: who is late and which release
 *  is the newest come from the rows as the database wrote them.
 */

import type { ReleaseId, SubmissionId, UserId } from './ids';

/** A student enrolled in the project's edition, as the page loads them. */
export interface EnrolledStudent {
    /** The address they were enrolled with, lowercase. The one name every
     *  enrolment has, so the order and the fallback label. */
    readonly email: string;
    /** Their account, or null while nobody has logged in with `email`: such
     *  a student cannot have submitted anything. */
    readonly userId: UserId | null;
    /** Their name, as their login provider gave it; null when it gave none
     *  or they have not logged in. */
    readonly fullName: string | null;
    /** Their GitHub login, without the `@`; null for an email login. */
    readonly githubLogin: string | null;
}

/** One submission of the project, as the page loads them for staff. */
export interface HandIn {
    readonly submissionId: SubmissionId;
    readonly authorId: UserId;
    /** When the server received it. */
    readonly submittedAt: Date;
    /** The archive's size, in bytes. */
    readonly byteSize: number;
    /** The archive's SHA-256, 64 lowercase hex digits. */
    readonly sha256: string;
    /** Whether it arrived after the project's deadline, as the database
     *  compared them. A project without a deadline has no late work. */
    readonly late: boolean;
    /** Whether the caller may remove it, as `app.may_remove_submission`
     *  answered: true for staff of the edition, false for a student, their
     *  own submissions included. Decides only whether
     *  the page draws a remove button; the removal asks the database again. */
    readonly removable: boolean;
    /** The release the student's folder said it started from, or null when
     *  it said none (an upload through the page, a folder from before
     *  starters carried their release) or named a release that is not this
     *  project's, which the database does not keep. */
    readonly base: Base | null;
    /** The author's name and login, for a submission whose author is no
     *  longer enrolled; the same as their enrolment's otherwise. */
    readonly fullName: string | null;
    readonly githubLogin: string | null;
}

/** A release of the project, as the page knows every one of them. */
export interface Release {
    readonly releaseId: ReleaseId;
    /** The release's label, or '' when it was published without one. */
    readonly label: string;
}

/** The release a submission was built on, and where it stands. */
export interface Base extends Release {
    /** Its place among the project's releases, counting from 1 for the
     *  first: what the page calls its version, since a label is optional
     *  and two releases may carry the same one. */
    readonly version: number;
    /** Whether it is the project's newest release. */
    readonly latest: boolean;
}

/** How a student stands with the project, judged by their newest
 *  submission alone: an early on-time hand-in followed by a late one is
 *  late, because the newest is the one assessed. */
export type Standing = 'missing' | 'on-time' | 'late';

/** One student's line on the Submissions tab. */
export interface StudentHandIns {
    /** A stable key for the line: the account when there is one, else the
     *  enrolment address. */
    readonly key: string;
    /** What to call them: their name, else their login, else their address. */
    readonly name: string;
    /** Their GitHub login, or null. */
    readonly githubLogin: string | null;
    /** Their enrolment address, or null for an author who is no longer
     *  enrolled, whose address the page cannot read. */
    readonly email: string | null;
    /** False for an author of submissions who is no longer one of the
     *  edition's students (unenrolled, or made staff): their work stays
     *  evidence and stays on the list. */
    readonly enrolled: boolean;
    /** Every submission of theirs, newest first; empty for none. */
    readonly submissions: readonly HandIn[];
    /** `submissions[0]`, or null: the one assessed, shown by default. */
    readonly latest: HandIn | null;
    readonly standing: Standing;
}

/** Whether `h` was built on a release other than the newest. A submission
 *  that names no release is not called outdated: nothing says it is. */
export const outdated = (h: HandIn): boolean => h.base !== null && !h.base.latest;

/** The line under a student's name: their login, else their address
 *  when it is not already their name, and whether they have left the
 *  edition, joined by " · "; '' when there is nothing to add. One handle,
 *  not both: the line is for telling two Alices apart, not a contact card. */
export function subtitle(l: StudentHandIns): string {
    const handle = l.githubLogin !== null ? `@${l.githubLogin}` : l.email !== null && l.email !== l.name ? l.email : '';
    return [handle, l.enrolled ? '' : 'no longer enrolled'].filter(p => p !== '').join(' · ');
}

/** What to call a release in a sentence: "v3 (week 2)", or "v3" when it
 *  has no label. */
export const versionName = (b: Base): string => (b.label === '' ? `v${b.version}` : `v${b.version} (${b.label})`);

/** One line per student of `students`, and one more for every other author
 *  in `submissions`, each with their submissions newest first.
 *
 *  Order: students who have submitted nothing first, then late, then on
 *  time, each group by name, because that is the order a teacher chases
 *  them in. Authors no longer enrolled come last of their group.
 *
 *  - Requires: every submission's `authorId` is an account; `students`
 *    holds each address once (the enrolment's primary key). */
export function handInsOf(students: readonly EnrolledStudent[], submissions: readonly HandIn[]): StudentHandIns[] {
    const byAuthor = new Map<UserId, HandIn[]>();
    for (const s of submissions) {
        const list = byAuthor.get(s.authorId);
        if (list === undefined) byAuthor.set(s.authorId, [s]);
        else list.push(s);
    }
    for (const list of byAuthor.values()) list.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

    const lines: StudentHandIns[] = [];
    const seen = new Set<UserId>();
    for (const st of students) {
        const own = st.userId === null ? [] : (byAuthor.get(st.userId) ?? []);
        if (st.userId !== null) seen.add(st.userId);
        lines.push(line(st.userId ?? st.email, st.fullName ?? st.githubLogin ?? st.email, st.githubLogin, st.email, true, own));
    }
    for (const [author, own] of byAuthor) {
        if (seen.has(author)) continue;
        const first = own[0];
        lines.push(line(author, first?.fullName ?? first?.githubLogin ?? 'Unknown student', first?.githubLogin ?? null, null, false, own));
    }
    const rank: Record<Standing, number> = { missing: 0, late: 1, 'on-time': 2 };
    return lines.toSorted(
        (a, b) => rank[a.standing] - rank[b.standing] || Number(b.enrolled) - Number(a.enrolled) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
}

function line(key: string, name: string, githubLogin: string | null, email: string | null, enrolled: boolean, submissions: HandIn[]): StudentHandIns {
    const latest = submissions[0] ?? null;
    const standing: Standing = latest === null ? 'missing' : latest.late ? 'late' : 'on-time';
    return { key, name, githubLogin, email, enrolled, submissions, latest, standing };
}

/** `text` lowercased and without accents, so "émile" is found by "emile". */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** How well one search word matches `text` (already folded), or null when
 *  it does not: every letter of `word` must appear in `text` in order. A
 *  run of letters as typed counts for more than letters spread apart, a
 *  letter that starts a word for more than one inside it, and the word
 *  appearing whole for most, earlier being better. Only the order of the
 *  scores means anything. */
function wordScore(word: string, text: string): number | null {
    const at = text.indexOf(word);
    if (at !== -1) return 1000 + (at === 0 || /[^\p{L}\p{N}]/u.test(text[at - 1] ?? '') ? 100 : 0) - at;
    let score = 0;
    let from = 0;
    let previous = -2;
    for (const ch of word) {
        const i = text.indexOf(ch, from);
        if (i === -1) return null;
        score += 1 + (i === previous + 1 ? 10 : 0) + (i === 0 || /[^\p{L}\p{N}]/u.test(text[i - 1] ?? '') ? 5 : 0);
        previous = i;
        from = i + 1;
    }
    return score;
}

/** How well `query` matches a student's name, login or address, or null
 *  when it does not. Every word of `query` (split on spaces) must match one
 *  of them, typos of omission included ("crla mrau" finds Carla Moreau),
 *  ignoring case and accents. An empty query matches everyone, equally. */
export function searchScore(l: StudentHandIns, query: string): number | null {
    const words = fold(query)
        .split(/\s+/)
        .filter(w => w !== '');
    const fields = [l.name, l.githubLogin ?? '', l.email ?? ''].map(fold);
    let total = 0;
    for (const w of words) {
        let best: number | null = null;
        for (const f of fields) {
            const s = wordScore(w, f);
            if (s !== null && (best === null || s > best)) best = s;
        }
        if (best === null) return null;
        total += best;
    }
    return total;
}

/** The lines of `lines` that `query` matches (`searchScore`), best match
 *  first, ties keeping `handInsOf`'s order; all of them, in that order,
 *  for an empty query. */
export function search(lines: readonly StudentHandIns[], query: string): StudentHandIns[] {
    return lines
        .map((l, i) => ({ l, i, s: searchScore(l, query) }))
        .filter((x): x is { l: StudentHandIns; i: number; s: number } => x.s !== null)
        .toSorted((a, b) => b.s - a.s || a.i - b.i)
        .map(x => x.l);
}
