/** Accepting, removing and handing out submissions. Shared by the API
 *  routes (what an IDE extension calls) and the page's upload form, so both
 *  make exactly the same decisions.
 */

import { error, isHttpError } from '@sveltejs/kit';
import type { Claims } from '#lib/claims.ts';
import { isGzip, sha256 } from '#lib/bytes.ts';
import { submissionKey, trustId, trustKey, type ObjectKey, type ProjectId, type ReleaseId, type SubmissionId } from '#lib/ids.ts';
import { report } from '#lib/report.ts';
import { NOT_ACCEPTING, refusalMessage, type RefusalRow } from '#lib/refusal.ts';
import { asUser, Misconfigured, statusOf } from './db';
import type { BucketObject, Context } from './context';

/** A submission the database has recorded. */
export interface Accepted {
    /** Its id, which also names its object (`submissionKey`). */
    readonly submissionId: SubmissionId;
    /** The body's size in bytes. */
    readonly byteSize: number;
    /** The body's SHA-256, as 64 lowercase hex digits. */
    readonly sha256: string;
}

/** Stores `body` as a new submission by the caller to `project`, or throws
 *  the HTTP error that says why not: 400 for an empty body, 413 for one over
 *  `submissionMaxBytes`, 415 for one that is not gzip, 403 for a refusal,
 *  500 for a failure of the server's (the database or the bucket), which is
 *  reported and answered with a fixed sentence, or with the operator's
 *  sentence when the connection cannot become its role (`Misconfigured`).
 *  Nothing else is thrown. The order matters: the cheap checks
 *  first, so a late student is told before uploading; the object before the
 *  row, so every row has a body; the row inside the caller's policies, so
 *  the deadline is the database's decision (see `recordSubmission`).
 *  A refusal is a 403 that says why, as far as the caller may know (see
 *  `refusal`).
 *
 *  `base` is the release the student's folder says it started from. It is
 *  their claim and decides nothing: the database keeps it only when it is a
 *  release of `project`, and records none otherwise (see
 *  20261021130000_release_ids_in_starters.sql), so a wrong id never costs a
 *  student their hand-in. */
export async function acceptSubmission(ctx: Context, claims: Claims, project: ProjectId, body: Uint8Array, base: ReleaseId | null): Promise<Accepted> {
    if (body.byteLength === 0) error(400, 'The submission is empty.');
    if (body.byteLength > ctx.config.submissionMaxBytes) error(413, `The submission is larger than ${ctx.config.submissionMaxBytes} bytes.`);
    if (!isGzip(body)) error(415, 'A submission is a .tar.gz archive.');

    let refused: string | null;
    try {
        refused = await refusal(ctx, claims, project);
    } catch (e) {
        failed(e);
    }
    if (refused !== null) error(403, refused);
    return recordSubmission(ctx, claims, project, body, base);
}

/** Answers a failure that is not a refusal, always by throwing an HTTP
 *  error. A SvelteKit error passes through; a connection that cannot
 *  become its role is a 500 that says so, for the operator; anything else
 *  is reported and answered with a fixed sentence, since its message may
 *  quote a query or a value. */
function failed(e: unknown): never {
    if (isHttpError(e)) throw e;
    if (e instanceof Misconfigured) error(500, e.message);
    report('submissions', e instanceof Error ? e.message : String(e));
    error(500, 'The submission could not be recorded.');
}

/** The second half of `acceptSubmission`, after its checks: writes the
 *  object, then inserts the row as the caller, and answers with the row's
 *  id only once the database has said it exists. Exported so a test can
 *  reach the insert with the window already shut, which in production is
 *  the race between the check and the upload.
 *
 *  The insert reads the project through the caller's policies, and a
 *  student does not see a project outside its window: when it closed in
 *  between, the insert inserts nothing and raises nothing. So "no row
 *  came back" is a refusal, the object is deleted, and the 403 says why.
 *  The insert policy's own error (42501) is reached by a change of role in
 *  between: unenrolled, or made staff. A failure to delete the object is
 *  reported, not swallowed. Throws only HTTP errors, as `acceptSubmission`
 *  does.
 *
 *  - Requires: `body` passed `acceptSubmission`'s emptiness, size and gzip
 *    checks. Not checked here: a body that did not is stored and recorded
 *    as it is. `app.can_submit` is not asked first either; the insert's
 *    policies are the only check. */
export async function recordSubmission(ctx: Context, claims: Claims, project: ProjectId, body: Uint8Array, base: ReleaseId | null): Promise<Accepted> {
    const digest = await sha256(body);
    const id = crypto.randomUUID() as SubmissionId; // a v4 is fine here: the key needs to be unguessable, not sortable
    const key = submissionKey(id);
    try {
        await ctx.bucket.put(key, body, 'application/gzip');
    } catch (e) {
        // No row refers to it yet; a put that failed half-way is deleted, if
        // there is anything to delete, so nothing is left unaccounted for.
        await forget(ctx, key);
        failed(e);
    }

    let stored: boolean;
    try {
        stored = await asUser(ctx.sql, claims, async tx => {
            const rows = await tx<{ submission_id: string }[]>`
        insert into submission (submission_id, edition_id, project_id, author_id, object_key, byte_size, sha256, base_release_id)
        select ${id}, p.edition_id, p.project_id, ${claims.sub}, ${key}, ${body.byteLength}, ${digest as Uint8Array<ArrayBuffer>}, ${base}::uuid
        from project p where p.project_id = ${project}
        returning submission_id`;
            return rows.length === 1;
        });
    } catch (e) {
        await forget(ctx, key);
        if (statusOf(e).status === 500) failed(e);
        error(403, (await reason(ctx, claims, project)) ?? NOT_ACCEPTING);
    }
    if (!stored) {
        await forget(ctx, key);
        error(403, (await reason(ctx, claims, project)) ?? NOT_ACCEPTING);
    }
    return { submissionId: id, byteSize: body.byteLength, sha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') };
}

/** `refusal`, for a row the database has already refused: a failure to
 *  ask is reported and answered as a 500 (`failed`) rather than thrown as
 *  it is. */
async function reason(ctx: Context, claims: Claims, project: ProjectId): Promise<string | null> {
    try {
        return await refusal(ctx, claims, project);
    } catch (e) {
        failed(e);
    }
}

/** Deletes the object of a submission whose row was refused or removed,
 *  reporting rather than throwing when it cannot. */
async function forget(ctx: Context, key: ObjectKey): Promise<void> {
    try {
        await ctx.bucket.delete(key);
    } catch (inner) {
        report('submissions', `orphaned ${key}: ${inner instanceof Error ? inner.message : String(inner)}`);
    }
}

/** Null when the caller may submit to `project` now; otherwise the
 *  sentence that says why not. `app.can_submit` decides; only when it says
 *  no is `app.submit_refusal` asked for the reason, in the same transaction
 *  so both see the same `now()`. It tells people enrolled in the project's
 *  edition which condition failed, and nobody else anything.
 *
 *  The reason is best effort: if asking for it fails (the function not
 *  there yet because the Worker deployed before the migration, a timeout),
 *  the refusal still stands, with the sentence everyone used to get, and
 *  the failure is reported. A savepoint keeps that failure from taking the
 *  decision down with it. */
async function refusal(ctx: Context, claims: Claims, project: ProjectId): Promise<string | null> {
    return asUser(ctx.sql, claims, async tx => {
        const [ok] = await tx<{ ok: boolean }[]>`select app.can_submit(${project}) as ok`;
        if (ok?.ok === true) return null;
        try {
            const [r] = await tx.savepoint(sp => sp<RefusalRow[]>`select * from app.submit_refusal(${project})`);
            return refusalMessage(r ?? null);
        } catch (e) {
            report('submissions', `no reason for refusing ${project}: ${e instanceof Error ? e.message : String(e)}`);
            return NOT_ACCEPTING;
        }
    });
}

/** The object of `submission`, if the caller may read it, and the name a
 *  download of it is saved as: `<slug>-<github login or "student">-<time>.tar.gz`.
 *  The policy on the table is the check: a row the caller cannot read is a
 *  404, the same as an id that names nothing. */
export async function submissionObject(ctx: Context, claims: Claims, submission: SubmissionId): Promise<BucketObject> {
    const row = await asUser(ctx.sql, claims, async tx => {
        const [r] = await tx<{ object_key: string; slug: string; submitted_at: Date; login: string | null }[]>`
      select s.object_key, p.slug, s.submitted_at, u.github_login as login
      from submission s
      join project p on p.project_id = s.project_id
      left join app_user u on u.user_id = s.author_id
      where s.submission_id = ${submission}`;
        return r ?? null;
    });
    if (row === null) error(404, 'No such submission.');
    const stamp = row.submitted_at.toISOString().replace(/[:.]/g, '-');
    return { key: trustKey(row.object_key), filename: `${row.slug}-${row.login ?? 'student'}-${stamp}.tar.gz` };
}

/** Returns a presigned URL, valid for 60 seconds, for the caller to
 *  download `submission`, if they may (`submissionObject`). */
export async function submissionUrl(ctx: Context, claims: Claims, submission: SubmissionId): Promise<URL> {
    const o = await submissionObject(ctx, claims, submission);
    return ctx.bucket.presignGet(o.key, 60, o.filename);
}

/** Removes `submission` for the caller, if they may, and then its archive
 *  from the bucket. `app.remove_submission` decides who may (staff of the
 *  edition, owners and assistants, at any time; never a student, not even
 *  the author) and writes the audit row. It raises P0002 for a submission
 *  the caller cannot read and 42501, with the reason, for one they may not
 *  remove (a student's own); this throws them as a 404 or a 403 with the
 *  database's sentence. Anything else is a 500 with a fixed sentence,
 *  reported (`failed`).
 *
 *  The row first, then the object: once the row is gone nothing hands the
 *  archive out, and a bucket that fails to delete it leaves an orphan that
 *  is reported, never a row without a body. The removal stands either way,
 *  so a failed object delete does not fail the call. */
export async function removeSubmission(ctx: Context, claims: Claims, submission: SubmissionId): Promise<void> {
    let key: ObjectKey;
    try {
        key = await asUser(ctx.sql, claims, async tx => {
            const [r] = await tx<{ key: string }[]>`select app.remove_submission(${submission}) as key`;
            if (r === undefined) throw new Error('app.remove_submission answered no row');
            return trustKey(r.key);
        });
    } catch (e) {
        const { status, message } = statusOf(e);
        if (!isHttpError(e) && (status === 403 || status === 404)) error(status, message);
        failed(e);
    }
    await forget(ctx, key);
}

/** Returns a presigned URL, valid for 60 seconds, for the caller to
 *  download `project`'s starter, if they may and one has been published,
 *  named after the project's slug. `app.current_starter` decides both; no
 *  starter for the caller is a 404, whichever the reason. */
export async function starterUrl(ctx: Context, claims: Claims, project: ProjectId): Promise<URL> {
    const row = await asUser(ctx.sql, claims, async tx => {
        const [r] = await tx<{ key: string | null; slug: string | null }[]>`
      select app.current_starter(${project}) as key, (select slug from project where project_id = ${project}) as slug`;
        return r ?? null;
    });
    if (row === null || row.key === null) error(404, 'No starter is available for this project.');
    return ctx.bucket.presignGet(trustKey(row.key), 60, `${row.slug ?? trustId<ProjectId>(project)}.tar.gz`);
}
