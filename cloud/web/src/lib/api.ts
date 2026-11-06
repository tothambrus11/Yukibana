/** What the JSON API answers. The CLI and the IDE extension read these
 *  shapes (`packages/client/src/lib/wire.ts` decodes them, field for field), so a
 *  change here is a change to a published contract: add a field, never
 *  rename or retype one. Times are ISO 8601 strings in UTC; ids are uuids;
 *  a null means what the field says it means.
 */

export type EditionRole = 'student' | 'assistant' | 'owner';

export interface MeJson {
  readonly userId: string;
  /** The address in the verified token. */
  readonly email: string | null;
  readonly fullName: string | null;
  readonly githubLogin: string | null;
  /** `user`, `teacher` or `admin`. */
  readonly platformRole: string;
}

export interface EditionJson {
  readonly editionId: string;
  readonly courseCode: string;
  /** The course name this edition runs under, which its owners set; other
   *  editions of the same course may have another. */
  readonly courseTitle: string;
  readonly label: string;
  readonly archived: boolean;
  /** The caller's role in it. */
  readonly role: EditionRole;
}

export interface ProjectJson {
  readonly projectId: string;
  readonly editionId: string;
  readonly courseCode: string;
  readonly editionLabel: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  /** Null: a draft, which only staff see. */
  readonly availableAfter: string | null;
  /** When work is due. Null: no deadline. Submissions after it are still
   *  accepted until `closesAt`, and read as late. */
  readonly deadline: string | null;
  /** When the window closes: after it a student no longer sees the project
   *  and cannot submit. Null: it never closes. */
  readonly closesAt: string | null;
  /** Whether the deadline has passed: a submission now would be late. */
  readonly late: boolean;
  readonly role: EditionRole;
  /** Whether a starter has been released and the caller may download it. */
  readonly starterReady: boolean;
  /** The release whose starter the caller would download now
   *  (`app.current_release`), to compare with the `releaseId` in a
   *  student's `yukibana.json` and to fetch by id. Null exactly when
   *  `starterReady` is false. */
  readonly currentReleaseId: string | null;
  /** Whether the caller may submit right now: only ever true for a student,
   *  between `availableAfter` and `closesAt`, before the deadline or after. */
  readonly canSubmit: boolean;
  /** How many submissions the caller has made to it, and the newest's time. */
  readonly mySubmissions: number;
  readonly myLastSubmittedAt: string | null;
}

export interface SubmissionJson {
  readonly submissionId: string;
  readonly projectId: string;
  readonly submittedAt: string;
  /** Bytes, as stored. */
  readonly byteSize: number;
  /** Hex SHA-256 of the archive, as the server computed it on arrival. */
  readonly sha256: string;
  readonly author: {
    readonly userId: string;
    readonly fullName: string | null;
    readonly githubLogin: string | null;
    /** The address they are enrolled with, when the caller may see it
     *  (themselves, or staff); null otherwise, or after unenrolment. */
    readonly email: string | null;
  };
  /** Whether this is the author's newest submission to the project. */
  readonly latest: boolean;
  /** Whether it arrived after the project's deadline, as the deadline is
   *  now: an extension granted later makes it on time again. */
  readonly late: boolean;
  /** The release the student's folder said it started from, always one of
   *  this project's. Null for a submission from before releases carried
   *  ids, a hand-made archive, one uploaded through the project page (which
   *  does not open the archive to read the id), or a claim that named no
   *  release of this project. A student's claim: it says which release to compare their
   *  read-only files with, and decides nothing about who may do what. */
  readonly baseReleaseId: string | null;
}

export interface ReleaseJson {
  readonly releaseId: string;
  readonly label: string;
  readonly commit: string | null;
  readonly starterSize: number;
  readonly teacherSize: number;
  readonly uploadedAt: string;
  /** Login or name of whoever uploaded it (or whose token did). */
  readonly uploadedBy: string | null;
  readonly viaToken: boolean;
}

export interface MemberJson {
  readonly email: string;
  readonly role: EditionRole;
  /** `manual`, or the roster feed that owns the row. */
  readonly source: string;
  /** Null until the address has logged in. */
  readonly userId: string | null;
  readonly fullName: string | null;
  readonly githubLogin: string | null;
}

/** What a terminal or an IDE needs to log in: the Auth server and its
 *  publishable key. Neither is secret; both are in every page already. */
export interface AuthConfigJson {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  /** The OAuth client a terminal or IDE logs in through, by way of
   *  `/auth/connect` on this site; null when the registry has none, and a
   *  CLI then logs in with GitHub directly. A CLI older than this field
   *  ignores it and does the same. */
  readonly oauthClientId: string | null;
  /** The site's canonical origin, Auth's `site_url`: where a CLI opens
   *  `/auth/connect`, and whose `/auth/connect/return` it names when it
   *  trades the code. */
  readonly siteUrl: string;
}

/** Every refusal and failure under `/api/`, whatever the status and whatever
 *  the caller's `Accept` says: a 400 for a request that cannot mean
 *  anything, 401 for no session, 403 for a session that may not, 404 for no
 *  such thing, 409 for a conflict, 5xx for the server's fault. `message` is
 *  a sentence for a person; a client branches on the status, never on the
 *  wording. A redirect or a 204 has no body at all. */
export interface ErrorJson {
  /** The response's own status, repeated for a client that kept only the body. */
  readonly status: number;
  readonly message: string;
}
