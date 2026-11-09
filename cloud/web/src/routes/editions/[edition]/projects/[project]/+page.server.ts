import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { trustId, uuidOf, type EditionId, type ProjectId, type ReleaseId, type SubmissionId, type TokenId, type UserId } from '#lib/ids.ts';
import type { EnrolledStudent, HandIn, Release } from '#lib/hand-ins.ts';
import { asUser, refusalOf } from '#lib/server/db.ts';
import { text } from '#lib/server/form.ts';
import { requireClaims, withContext } from '#lib/server/context.ts';
import { acceptSubmission, removeSubmission } from '#lib/server/submissions.ts';
import { instantOf, isZone, type Reading } from '#lib/wall-time.ts';

interface ProjectRow {
    project_id: ProjectId;
    edition_id: string;
    course_code: string;
    edition_label: string;
    slug: string;
    title: string;
    kind: string;
    available_after: Date | null;
    deadline: Date | null;
    closes_at: Date | null;
    role: string | null;
    /** app.may_edit_projects: whether the settings and publishing controls
     *  would be accepted, so whether to draw them. */
    can_edit: boolean;
    ready: boolean;
    can_submit: boolean;
}

interface SubmissionRow {
    submission_id: string;
    submitted_at: Date;
    byte_size: number;
    sha256: string;
    author_id: string;
    full_name: string | null;
    github_login: string | null;
    late: boolean;
    /** app.may_remove_submission: whether to draw a remove button. */
    removable: boolean;
    /** The release the registry recorded the submission as started from,
     *  or null when it said none. */
    base_id: string | null;
}

interface StudentRow {
    email: string;
    user_id: string | null;
    full_name: string | null;
    github_login: string | null;
}

/** `r` as the page reads it (#lib/hand-ins), its base found among
 *  `releases` (the project's, newest first; empty for a student, who cannot
 *  read releases and so sees no base). */
function handInOf(r: SubmissionRow, releases: readonly Release[]): HandIn {
    const at = releases.findIndex(x => x.releaseId === r.base_id);
    const found = releases[at];
    return {
        submissionId: trustId<SubmissionId>(r.submission_id),
        authorId: trustId<UserId>(r.author_id),
        submittedAt: r.submitted_at,
        byteSize: r.byte_size,
        sha256: r.sha256,
        late: r.late,
        removable: r.removable,
        base: found === undefined ? null : { ...found, version: releases.length - at, latest: at === 0 },
        fullName: r.full_name,
        githubLogin: r.github_login,
    };
}

interface ReleaseRow {
    release_id: string;
    label: string;
    commit_sha: string | null;
    starter_size: number;
    teacher_size: number;
    uploaded_at: Date;
    uploader: string | null;
    via_token: boolean;
}

interface TokenRow {
    token_id: string;
    label: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
}

function ids(params: { edition: string; project: string }): { edition: EditionId; project: ProjectId } {
    const edition = uuidOf<EditionId>(params.edition);
    const project = uuidOf<ProjectId>(params.project);
    if (edition === null || project === null) error(404, 'No such project.');
    return { edition, project };
}

/** A project as the caller sees it: the project with the database's
 *  answers to "may this person edit it" and "may they submit now", every
 *  submission they may read (their own for a student, everyone's for
 *  staff), newest first (#lib/hand-ins `HandIn`), for staff the edition's
 *  students and every release by id (`allReleases`, newest first), the
 *  newest 20 releases in full for staff, and the tokens
 *  for an owner (never their secrets, which are not stored). A 404 for a
 *  project the caller cannot see, for one that is not in the edition the
 *  address names, and for parameters that are not uuids; the login page
 *  for nobody. */
export const load: PageServerLoad = async event => {
    const claims = requireClaims(event);
    const { edition, project } = ids(event.params);
    return withContext(ctx =>
        asUser(ctx.sql, claims, async tx => {
            const [p] = await tx<ProjectRow[]>`
        select p.project_id, p.edition_id, c.code as course_code, e.label as edition_label, p.slug, p.title, p.kind::text as kind, p.available_after, p.deadline, p.closes_at,
               app.role_in(p.edition_id)::text as role,
               app.may_edit_projects(p.edition_id) as can_edit,
               app.current_starter(p.project_id) is not null as ready,
               app.can_submit(p.project_id) as can_submit
        from project p
        join course_edition e on e.edition_id = p.edition_id
        join course c on c.course_id = e.course_id
        where p.project_id = ${project} and p.edition_id = ${edition}`;
            if (p === undefined) error(404, 'No such project.');
            const staff = p.role === 'owner' || p.role === 'assistant';
            const owner = p.role === 'owner';
            const rows = await tx<SubmissionRow[]>`
        select s.submission_id, s.submitted_at, s.byte_size, encode(s.sha256, 'hex') as sha256, s.author_id, u.full_name, u.github_login,
               coalesce(s.submitted_at > ${p.deadline}::timestamptz, false) as late, s.base_release_id as base_id,
               app.may_remove_submission(s.submission_id) as removable
        from submission s
        left join app_user u on u.user_id = s.author_id
        where s.project_id = ${project}
        order by s.submitted_at desc`;
            const releases = staff
                ? await tx<ReleaseRow[]>`
            select r.release_id, r.label, r.commit_sha, r.starter_size, r.teacher_size, r.uploaded_at,
                   coalesce(u.github_login, u.full_name) as uploader, r.token_id is not null as via_token
            from project_release r left join app_user u on u.user_id = r.uploaded_by
            where r.project_id = ${project} order by r.seq desc limit 20`
                : [];
            const tokens = owner
                ? await tx<TokenRow[]>`
            select token_id, label, created_at, last_used_at, revoked_at from project_token
            where project_id = ${project} order by created_at desc`
                : [];
            // Every student of the edition, whether or not they have sent
            // anything: the Submissions tab is about who still owes work.
            // The enrolment policy shows staff their edition's rows.
            const students = staff
                ? (
                      await tx<StudentRow[]>`
            select en.email, en.user_id, u.full_name, u.github_login
            from enrollment en left join app_user u on u.user_id = en.user_id
            where en.edition_id = ${p.edition_id} and en.role = 'student'
            order by en.email`
                  ).map((r): EnrolledStudent => ({
                      email: r.email,
                      userId: r.user_id === null ? null : trustId<UserId>(r.user_id),
                      fullName: r.full_name,
                      githubLogin: r.github_login,
                  }))
                : [];
            // Every release, newest first, by id and label: what a submission's
            // version is counted in, and what an assembly in the browser chooses
            // from (#lib/hand-ins/assembled). Empty for a student.
            const all = staff
                ? (
                      await tx<{ release_id: string; label: string }[]>`
            select release_id, label from project_release where project_id = ${project} order by seq desc`
                  ).map((r): Release => ({ releaseId: trustId<ReleaseId>(r.release_id), label: r.label }))
                : [];
            const submissions = rows.map(r => handInOf(r, all));
            return { project: p, staff, owner, submissions, students, allReleases: all, releases, tokens, origin: event.url.origin };
        }),
    );
};

/** A `fail` for a failure of an action's database work: the database's
 *  status and sentence for a refusal, a 500 with a fixed sentence for
 *  anything else (`refusalOf`, which reports it). */
const failing = (e: unknown) => {
    const { status, message } = refusalOf('projects', e);
    return fail(status, { error: message });
};
const httpFailing = (e: unknown) => {
    if (typeof e === 'object' && e !== null && 'status' in e && 'body' in e) {
        const err = e as { status: number; body: { message: string } };
        return fail(err.status, { error: err.body.message });
    }
    return failing(e);
};
/** The form's three times as instants, read in the zone the page wrote them
 *  in (its hidden `zone` field), each keeping the instant it was rendered
 *  from (its hidden `…_was` field) when its text is unchanged
 *  (#lib/wall-time). A form without a zone is a page from before times
 *  carried one, written in the browser's zone, which the Worker cannot
 *  know: it is refused rather than read as UTC, which is the bug it was. */
function timesOf(form: FormData): { ok: true; availableAfter: Date | null; deadline: Date | null; closesAt: Date | null } | { ok: false; why: string } {
    const zone = text(form, 'zone');
    if (!isZone(zone)) return { ok: false, why: 'This page is out of date: reload it and save again.' };
    const read = (name: string): Reading => {
        const was = new Date(text(form, `${name}_was`));
        return instantOf(text(form, name), zone, Number.isNaN(was.getTime()) ? null : was);
    };
    const availableAfter = read('available_after');
    if (!availableAfter.ok) return availableAfter;
    const deadline = read('deadline');
    if (!deadline.ok) return deadline;
    const closesAt = read('closes_at');
    if (!closesAt.ok) return closesAt;
    return { ok: true, availableAfter: availableAfter.at, deadline: deadline.at, closesAt: closesAt.at };
}

/** The project page's forms. Every action requires a signed-in caller and
 *  parameters that are uuids (else a 404), and leaves the decision of who
 *  may to the database. A refusal is a `fail` whose `error` is a sentence
 *  for the person; a failure that is not one is a 500 with a fixed
 *  sentence, reported and not shown (`refusalOf`).
 *
 *  Of the actions, only `update` checks that the project is in the edition the address
 *  names. `submit`, `removeSubmission`, `createToken` and `revokeToken` check only that the
 *  `edition` parameter is a uuid and act on the project (or submission, or token) by its
 *  own id, so under another edition's address they do what they would do
 *  under the right one; `load` answers that address with a 404. Nothing is
 *  widened by it: the database decides by the project, not the address. */
export const actions: Actions = {
    /** The page's upload form: the `archive` file, through
     *  `acceptSubmission`, with no base release. Answers `{ submitted }`
     *  with what was recorded, or a `fail` with the status
     *  `acceptSubmission` threw. The API route does the same for an IDE. */
    submit: async event => {
        const claims = requireClaims(event);
        const { project } = ids(event.params);
        const form = await event.request.formData();
        const file = form.get('archive');
        if (!(file instanceof File)) return fail(400, { error: 'Choose a .tar.gz file.' });
        const bytes = new Uint8Array(await file.arrayBuffer());
        try {
            const accepted = await withContext(ctx => acceptSubmission(ctx, claims, project, bytes, null));
            return { submitted: accepted };
        } catch (e) {
            return httpFailing(e);
        }
    },
    /** A remove button: the submission `submission_id`, through
     *  `removeSubmission`, which asks the database whether the caller may
     *  (staff only) and then deletes the archive. The staff's Submissions
     *  tab posts here. An id that is not a uuid is a
     *  404. Answers `{ removed: true }`, or a `fail` with the status and
     *  sentence `removeSubmission` threw. */
    removeSubmission: async event => {
        const claims = requireClaims(event);
        ids(event.params);
        const form = await event.request.formData();
        const submission = uuidOf<SubmissionId>(text(form, 'submission_id'));
        if (submission === null) return fail(404, { error: 'No such submission.' });
        try {
            await withContext(ctx => removeSubmission(ctx, claims, submission));
        } catch (e) {
            return httpFailing(e);
        }
        return { removed: true };
    },
    /** The Settings form: the title and the three times (`timesOf`). Under
     *  the project policy, which lets only those who may edit the edition's
     *  projects change one. A project the policy hides from the caller, or
     *  that is not in this edition, is a 403 that says nothing changed: an
     *  update that matched no row used to answer `{ ok: true }`. Answers
     *  `{ ok: true }`. */
    update: async event => {
        const claims = requireClaims(event);
        const { edition, project } = ids(event.params);
        const form = await event.request.formData();
        const title = text(form, 'title');
        if (title === '') return fail(400, { error: 'A project needs a title.' });
        const times = timesOf(form);
        if (!times.ok) return fail(400, { error: times.why });
        const { availableAfter, deadline, closesAt } = times;
        let updated: number;
        try {
            updated = await withContext(ctx =>
                asUser(ctx.sql, claims, async tx => {
                    const rows = await tx`
          update project set title = ${title}, available_after = ${availableAfter}, deadline = ${deadline}, closes_at = ${closesAt}
          where project_id = ${project} and edition_id = ${edition}
          returning project_id`;
                    return rows.length;
                }),
            );
        } catch (e) {
            return failing(e);
        }
        if (updated === 0) return fail(403, { error: 'You may not change this project; nothing was saved.' });
        return { ok: true };
    },
    /** A new project token labelled `label` (`ci` when empty), through
     *  `app.create_project_token`, owners only. Answers `{ token }` with the
     *  label and the secret, which is shown this once and stored nowhere. */
    createToken: async event => {
        const claims = requireClaims(event);
        const { project } = ids(event.params);
        const form = await event.request.formData();
        const label = text(form, 'label') || 'ci';
        try {
            const secret = await withContext(ctx =>
                asUser(ctx.sql, claims, async tx => {
                    const [row] = await tx<{ secret: string }[]>`select app.create_project_token(${project}, ${label}) as secret`;
                    if (row === undefined) throw new Error('no token returned');
                    return row.secret;
                }),
            );
            return { token: { label, secret } };
        } catch (e) {
            return failing(e);
        }
    },
    /** Revokes the token `token_id` through `app.revoke_project_token`,
     *  which takes it from an owner of the token's own project. That need
     *  not be the project in the address: the function decides by the
     *  token. An id that is not a uuid is a 400. Answers `{ ok: true }`. */
    revokeToken: async event => {
        const claims = requireClaims(event);
        ids(event.params);
        const form = await event.request.formData();
        const token = uuidOf<TokenId>(text(form, 'token_id'));
        if (token === null) return fail(400, { error: 'No such token.' });
        try {
            await withContext(ctx => asUser(ctx.sql, claims, tx => tx`select app.revoke_project_token(${token})`));
        } catch (e) {
            return failing(e);
        }
        return { ok: true };
    },
};
