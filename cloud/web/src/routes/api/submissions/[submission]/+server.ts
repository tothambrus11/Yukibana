import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { uuidOf, type SubmissionId } from '#lib/ids.ts';
import { fromBucket, requireBearer, requireClaims, toBucket, withContext } from '#lib/server/context.ts';
import { removeSubmission, submissionObject, submissionUrl } from '#lib/server/submissions.ts';

/** A submission's body, for its author or the edition's staff: a redirect
 *  to a URL on the bucket that works for a minute, or with `?inline` the
 *  bytes themselves through the Worker (`fromBucket`), for the staff page
 *  that assembles a submission in the browser. */
export const GET: RequestHandler = async event => {
    const claims = requireClaims(event);
    const submission = uuidOf<SubmissionId>(event.params.submission);
    if (submission === null) error(404, 'No such submission.');
    if (event.url.searchParams.has('inline')) return withContext(async ctx => fromBucket(ctx, await submissionObject(ctx, claims, submission)));
    return withContext(async ctx => toBucket(ctx, await submissionUrl(ctx, claims, submission)));
};

/** Removes the submission and its archive (`removeSubmission`), for staff
 *  of its edition, owners and assistants. 204 when it is gone; 404 for one
 *  the caller cannot read; 403, saying why, for a student's own. A bearer only (see
 *  `requireBearer`): the page removes through its own form action. */
export const DELETE: RequestHandler = async event => {
    const claims = requireBearer(event);
    const submission = uuidOf<SubmissionId>(event.params.submission);
    if (submission === null) error(404, 'No such submission.');
    await withContext(ctx => removeSubmission(ctx, claims, submission));
    return new Response(null, { status: 204 });
};
