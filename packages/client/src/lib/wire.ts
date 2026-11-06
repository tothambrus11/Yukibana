/** What the registry's JSON API answers, as the CLI relies on it.
 *
 *  `cloud/web/src/lib/api.ts` is the other side and says the same in the same
 *  words. Every response is `unknown` until one of the decoders here has
 *  looked at it: a registry of another version answers something else, and
 *  "the registry answered `deadline` as a number" is a better sentence than
 *  a TypeError three calls later. Times are ISO 8601 strings in UTC; a null
 *  means what the field says it means.
 */

import * as z from 'zod';
// The function form of .default(), which zod spells _default, since default is a keyword.
import { _default as withDefault } from 'zod';
import { fieldOf, nameOf } from './issues.js';

/** A person's role in an edition. */
export type EditionRole = 'student' | 'assistant' | 'owner';

/** The person the access token is for. */
export interface Me {
  readonly userId: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly githubLogin: string | null;
  /** `user`, `teacher` or `admin`. */
  readonly platformRole: string;
}

/** An edition the caller is enrolled in. */
export interface Edition {
  readonly editionId: string;
  readonly courseCode: string;
  readonly courseTitle: string;
  readonly label: string;
  readonly archived: boolean;
  /** The caller's role in it. */
  readonly role: EditionRole;
}

/** A project the caller may see, with what it means for them. */
export interface Project {
  readonly projectId: string;
  readonly editionId: string;
  readonly courseCode: string;
  readonly editionLabel: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  /** Null: a draft, which only staff see. */
  readonly availableAfter: string | null;
  /** When work is due. Null: no deadline. Later submissions are accepted
   *  until `closesAt`, and read as late. */
  readonly deadline: string | null;
  /** When the window closes and the project disappears for students. Null:
   *  never. */
  readonly closesAt: string | null;
  /** Whether the deadline has passed: a submission now would be late. */
  readonly late: boolean;
  readonly role: EditionRole;
  /** Whether a starter has been released and the caller may download it. */
  readonly starterReady: boolean;
  /** The newest release whose starter the caller may download now: what an
   *  IDE compares with the folder's `releaseId` to know an update exists,
   *  and the id to download it by (`downloadRelease(id, 'starter')`), so
   *  that a release published meanwhile cannot slip in. Null when the
   *  project has no release, when the caller may not download from it now,
   *  and from a registry older than this field. */
  readonly currentReleaseId: string | null;
  /** Whether the caller may submit right now. Only ever true for a student. */
  readonly canSubmit: boolean;
  /** How many submissions the caller has made to it. */
  readonly mySubmissions: number;
  readonly myLastSubmittedAt: string | null;
}

/** The person a submission is by, as far as the caller may see them. */
export interface Author {
  readonly userId: string;
  readonly fullName: string | null;
  readonly githubLogin: string | null;
  /** The address they were enrolled with; null when the caller may not see
   *  it or the enrolment is gone. */
  readonly email: string | null;
}

/** A submission's record; the archive itself is downloaded separately. */
export interface Submission {
  readonly submissionId: string;
  readonly projectId: string;
  readonly submittedAt: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly author: Author;
  /** Whether this is the author's newest submission to the project: the
   *  one that counts. */
  readonly latest: boolean;
  /** Whether it arrived after the deadline, as the deadline is now. */
  readonly late: boolean;
  /** The release it started from, always one of its project's; null when
   *  unknown (older submissions, hand-made archives, a claim that named no
   *  release of the project, or a registry from before releases had ids). */
  readonly baseReleaseId: string | null;
}

/** A release's record, as staff see it. */
export interface Release {
  readonly releaseId: string;
  readonly label: string;
  readonly commit: string | null;
  readonly starterSize: number;
  readonly teacherSize: number;
  readonly uploadedAt: string;
  readonly uploadedBy: string | null;
  readonly viaToken: boolean;
}

/** An enrolment in an edition. */
export interface Member {
  readonly email: string;
  readonly role: EditionRole;
  readonly source: string;
  /** Null until the address has logged in. */
  readonly userId: string | null;
  readonly fullName: string | null;
  readonly githubLogin: string | null;
}

/** The registry's receipt for a submission it stored. */
export interface Accepted {
  readonly submissionId: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/** The registry's receipt for a release it stored: each archive's size in bytes and SHA-256. */
export interface Published {
  readonly releaseId: string;
  readonly starter: { readonly size: number; readonly sha256: string };
  readonly teacher: { readonly size: number; readonly sha256: string };
}

/** The public half of the registry's Auth configuration: what a browser
 *  login needs, and nothing secret. */
export interface AuthConfig {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  /** The registry's OAuth client on that Auth server, through which a
   *  loopback login goes by way of the website (`/auth/connect`). Null from
   *  a registry that has none, or that is older than the field: the login
   *  then goes to GitHub directly, as it always did. */
  readonly oauthClientId: string | null;
  /** The site's canonical origin (Auth's `site_url`), where the website's
   *  part of the login works; null from a registry older than the field,
   *  which is then its own site. */
  readonly siteUrl: string | null;
}

/** A response that is not what this version expects. */
export class Unexpected extends Error {}

const text = z.string();
const maybeText = withDefault(z.nullable(z.string()), null);
const count = z.number().check(z.refine(Number.isFinite));
const role = z.enum(['student', 'assistant', 'owner']);

// Each schema's output is checked against the documented interface above by
// the decoder's return type, so the two cannot drift apart.
const me = z.object({ userId: text, email: maybeText, fullName: maybeText, githubLogin: maybeText, platformRole: text });
const edition = z.object({ editionId: text, courseCode: text, courseTitle: text, label: text, archived: z.boolean(), role });
const project = z.object({
  projectId: text,
  editionId: text,
  courseCode: text,
  editionLabel: text,
  slug: text,
  title: text,
  kind: text,
  availableAfter: maybeText,
  deadline: maybeText,
  closesAt: maybeText,
  late: z.boolean(),
  role,
  starterReady: z.boolean(),
  currentReleaseId: maybeText,
  canSubmit: z.boolean(),
  mySubmissions: count,
  myLastSubmittedAt: maybeText,
});
const submission = z.object({
  submissionId: text,
  projectId: text,
  submittedAt: text,
  byteSize: count,
  sha256: text,
  latest: z.boolean(),
  late: z.boolean(),
  baseReleaseId: maybeText,
  author: z.object({ userId: text, fullName: maybeText, githubLogin: maybeText, email: maybeText }),
});
const release = z.object({
  releaseId: text,
  label: text,
  commit: maybeText,
  starterSize: count,
  teacherSize: count,
  uploadedAt: text,
  uploadedBy: maybeText,
  viaToken: z.boolean(),
});
const member = z.object({ email: text, role, source: text, userId: maybeText, fullName: maybeText, githubLogin: maybeText });
const accepted = z.object({ submissionId: text, byteSize: count, sha256: text });
const archive = z.object({ size: count, sha256: text });
const published = z.object({ releaseId: text, starter: archive, teacher: archive });
const authConfig = z.object({ supabaseUrl: text, publishableKey: text, oauthClientId: maybeText, siteUrl: maybeText });

/** Returns `v` as `schema` says, or throws `Unexpected` with a sentence for
 *  every field that is wrong, from `where` down, joined by "; ". */
function decode<T>(schema: z.ZodType<T>, v: unknown, where: string): T {
  const parsed = schema.safeParse(v);
  if (parsed.success) return parsed.data;
  throw new Unexpected(parsed.error.issues.map(issue => answered(issue, v, where)).join('; '));
}

/** Returns what `issue` found in `v`, naming the field from `where` down
 *  and what came instead: "the registry answered submissions[0].byteSize
 *  as string, not a number". */
function answered(issue: z.core.$ZodIssue, v: unknown, where: string): string {
  const field = fieldOf(issue.path, where);
  const got = issue.path.reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? (o as Record<PropertyKey, unknown>)[k] : undefined), v);
  if (issue.code === 'invalid_value') return `the registry answered ${field} as ${JSON.stringify(got)}, not a role`;
  const expected = issue.code === 'invalid_type' ? issue.expected : 'value';
  const name = nameOf(expected);
  return expected === 'object' || expected === 'array'
    ? `the registry answered ${field} as something other than ${name}`
    : `the registry answered ${field} as ${typeof got}, not ${name}`;
}

/** Returns `v` as a `Me`, or throws `Unexpected` naming the field. */
export const decodeMe = (v: unknown, where = 'me'): Me => decode(me, v, where);
/** Returns `v` as an `Edition`, or throws `Unexpected` naming the field. */
export const decodeEdition = (v: unknown, where = 'edition'): Edition => decode(edition, v, where);
/** Returns `v` as a `Project`, or throws `Unexpected` naming the field. */
export const decodeProject = (v: unknown, where = 'project'): Project => decode(project, v, where);
/** Returns `v` as a `Submission`, or throws `Unexpected` naming the field. */
export const decodeSubmission = (v: unknown, where = 'submission'): Submission => decode(submission, v, where);
/** Returns `v` as a `Release`, or throws `Unexpected` naming the field. */
export const decodeRelease = (v: unknown, where = 'release'): Release => decode(release, v, where);
/** Returns `v` as a `Member`, or throws `Unexpected` naming the field. */
export const decodeMember = (v: unknown, where = 'member'): Member => decode(member, v, where);
/** Returns `v` as an `Accepted`, or throws `Unexpected` naming the field. */
export const decodeAccepted = (v: unknown, where = 'submission'): Accepted => decode(accepted, v, where);
/** Returns `v` as a `Published`, or throws `Unexpected` naming the field. */
export const decodePublished = (v: unknown, where = 'release'): Published => decode(published, v, where);
/** Returns `v` as an `AuthConfig`, or throws `Unexpected` naming the field. */
export const decodeAuthConfig = (v: unknown, where = 'auth config'): AuthConfig => decode(authConfig, v, where);

/** Returns a decoder of a list whose items `item` decodes, each named
 *  `where[i]` in an error. */
export const decodeList =
  <T>(item: (v: unknown, where: string) => T, where: string) =>
  (v: unknown): T[] => {
    if (!Array.isArray(v)) throw new Unexpected(`the registry answered ${where} as something other than a list`);
    return v.map((x: unknown, i) => item(x, `${where}[${i}]`));
  };
