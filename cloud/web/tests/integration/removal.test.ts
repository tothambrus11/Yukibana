import { test, expect, afterAll } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { asUser, connect } from '../../src/lib/server/db.js';
import { s3Bucket } from '../../src/lib/server/storage.js';
import { acceptSubmission, removeSubmission } from '../../src/lib/server/submissions.js';
import { submissions } from '../../src/lib/server/catalogue.js';
import { submissionKey, trustId, type ProjectId, type SubmissionId } from '../../src/lib/ids.js';
import type { Context } from '../../src/lib/server/context.js';
import { ALICE, ASSISTANT, BOB, TEACHER, claimsOf, config } from './env.js';

const sql = connect(config.databaseUrl);
const ctx: Context = { config, sql, bucket: s3Bucket(config.s3) };
afterAll(() => sql.end({ timeout: 5 }));

const gz = (n: number) => new Uint8Array([0x1f, 0x8b, n]);

async function warmup(): Promise<ProjectId> {
    const [row] = await asUser(sql, claimsOf(TEACHER), tx => tx<{ project_id: string }[]>`select project_id from project where slug = 'warmup'`);
    if (row === undefined) throw new Error('no seeded project');
    return trustId<ProjectId>(row.project_id);
}

/** The status and the sentence a call answered with: 200 and '' when it
 *  did not throw an HTTP error. */
const outcome = async (p: Promise<unknown>): Promise<{ status: number; message: string }> => {
    try {
        await p;
        return { status: 200, message: '' };
    } catch (e) {
        if (isHttpError(e)) return { status: e.status, message: e.body.message };
        throw e;
    }
};

test('a student cannot remove a submission of their own, and a classmate cannot learn one exists', async () => {
    const id = await warmup();
    const sent = await acceptSubmission(ctx, claimsOf(ALICE), id, gz(70), null);

    const own = await outcome(removeSubmission(ctx, claimsOf(ALICE), sent.submissionId));
    expect(own.status).toBe(403);
    expect(own.message).toMatch(/^Only the course staff can remove a submission\./);
    expect(await outcome(removeSubmission(ctx, claimsOf(BOB), sent.submissionId))).toEqual({ status: 404, message: 'No such submission.' });
    expect(await ctx.bucket.head(submissionKey(sent.submissionId))).not.toBeNull();
    const still = await submissions(ctx, claimsOf(ALICE), id, { latest: false, author: null });
    expect(still.map(s => s.submissionId)).toContain(sent.submissionId);
});

test("an assistant removes a student's submission, and its archive leaves the bucket with the row", async () => {
    const id = await warmup();
    const sent = await acceptSubmission(ctx, claimsOf(ALICE), id, gz(71), null);
    expect(await ctx.bucket.head(submissionKey(sent.submissionId))).not.toBeNull();

    await removeSubmission(ctx, claimsOf(ASSISTANT), sent.submissionId);

    const left = await submissions(ctx, claimsOf(ALICE), id, { latest: false, author: null });
    expect(left.map(s => s.submissionId)).not.toContain(sent.submissionId);
    expect(await ctx.bucket.head(submissionKey(sent.submissionId))).toBeNull();
    expect(await outcome(removeSubmission(ctx, claimsOf(ASSISTANT), sent.submissionId))).toEqual({ status: 404, message: 'No such submission.' });
});

test("an owner removes a student's submission, and an id that names nothing is a 404", async () => {
    const id = await warmup();
    const sent = await acceptSubmission(ctx, claimsOf(BOB), id, gz(72), null);

    await removeSubmission(ctx, claimsOf(TEACHER), sent.submissionId);

    expect(await ctx.bucket.head(submissionKey(sent.submissionId))).toBeNull();
    const all = await submissions(ctx, claimsOf(TEACHER), id, { latest: false, author: null });
    expect(all.map(s => s.submissionId)).not.toContain(sent.submissionId);
    expect((await outcome(removeSubmission(ctx, claimsOf(TEACHER), trustId<SubmissionId>(crypto.randomUUID())))).status).toBe(404);
});
