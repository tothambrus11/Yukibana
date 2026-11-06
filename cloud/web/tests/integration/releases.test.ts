import { test, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { asPublisher, asUser, connect } from '../../src/lib/server/db.js';
import { s3Bucket } from '../../src/lib/server/storage.js';
import { publishRelease, releaseUrl } from '../../src/lib/server/releases.js';
import { project as projectOf } from '../../src/lib/server/catalogue.js';
import { sha256 } from '../../src/lib/bytes.js';
import { trustId, type ProjectId, type ReleaseId } from '../../src/lib/ids.js';
import type { Context } from '../../src/lib/server/context.js';
import { ALICE, ASSISTANT, TEACHER, claimsOf, config } from './env.js';

const sql = connect(config.databaseUrl);
const bucket = s3Bucket(config.s3);
const ctx: Context = { config, sql, bucket };
afterAll(() => sql.end({ timeout: 5 }));

// Any two gzip files will do for the registry: it stores, it does not look inside.
const archive = new Uint8Array(readFileSync(new URL('../../../../packages/client/tests/fixtures/repo.tar.gz', import.meta.url)));
const other = new Uint8Array([...archive, 0]);

async function warmup(): Promise<ProjectId> {
  const [row] = await asUser(sql, claimsOf(TEACHER), tx => tx<{ project_id: string }[]>`select project_id from project where slug = 'warmup'`);
  if (row === undefined) throw new Error('no seeded project');
  return trustId<ProjectId>(row.project_id);
}

test('an owner publishes with their own login; the newest release is what a student downloads', async () => {
  const project = await warmup();
  const published = await publishRelease(ctx, { kind: 'user', claims: claimsOf(TEACHER) }, project, archive, other, 'manual v1', null, null);
  expect(published.starter.size).toBe(archive.byteLength);
  expect(published.teacher.size).toBe(other.byteLength);
  const [seen] = await asUser(sql, claimsOf(ALICE), tx => tx<{ key: string | null }[]>`select app.current_starter(${project}) as key`);
  const [row] = await asUser(sql, claimsOf(TEACHER), tx => tx<{ starter_key: string }[]>`select starter_key from project_release where release_id = ${published.releaseId}`);
  expect(seen?.key).toBe(row?.starter_key);
  expect(seen?.key).toMatch(new RegExp(`^starters/${project}/`));
  expect(await bucket.get(seen?.key as never)).toEqual(archive);
  const url = await releaseUrl(ctx, claimsOf(TEACHER), published.releaseId, 'teacher');
  expect((await fetch(url)).status).toBe(200);
});

test('an assistant publishes with their login as well; the release names them', async () => {
  const project = await warmup();
  const published = await publishRelease(ctx, { kind: 'user', claims: claimsOf(ASSISTANT) }, project, archive, other, 'by the assistant', null, null);
  const [row] = await asUser(sql, claimsOf(TEACHER), tx => tx<{ by: string }[]>`select uploaded_by::text as by from project_release where release_id = ${published.releaseId}`);
  expect(row?.by).toBe(claimsOf(ASSISTANT).sub);
});

test('a token publishes to its own project and to no other; a bad token stores nothing', async () => {
  const project = await warmup();
  const secret = await asUser(sql, claimsOf(TEACHER), async tx => {
    const [row] = await tx<{ secret: string }[]>`select app.create_project_token(${project}, 'test') as secret`;
    return row?.secret ?? '';
  });
  expect(secret).toMatch(/^yk_[0-9a-f]{64}$/);
  const published = await publishRelease(ctx, { kind: 'token', secret }, project, archive, other, 'ci', 'abc1234', null);
  const [row] = await asUser(
    sql,
    claimsOf(TEACHER),
    tx => tx<{ label: string; commit_sha: string; via: boolean; by: string }[]>`
    select label, commit_sha, token_id is not null as via, uploaded_by::text as by from project_release where release_id = ${published.releaseId}`,
  );
  expect(row).toEqual({ label: 'ci', commit_sha: 'abc1234', via: true, by: claimsOf(TEACHER).sub });

  const otherProject = trustId<ProjectId>('01a0b47d-0000-7000-8000-000000000000');
  await expect(publishRelease(ctx, { kind: 'token', secret }, otherProject, archive, other, 'x', null, null)).rejects.toMatchObject({ status: 403 });
  await expect(publishRelease(ctx, { kind: 'token', secret: 'yk_' + '0'.repeat(64) }, project, archive, other, 'x', null, null)).rejects.toMatchObject({ status: 403 });

  await asUser(
    sql,
    claimsOf(TEACHER),
    tx => tx`select app.revoke_project_token((select token_id from project_token where label = 'test' and revoked_at is null order by created_at desc limit 1))`,
  );
  await expect(publishRelease(ctx, { kind: 'token', secret }, project, archive, other, 'x', null, null)).rejects.toMatchObject({ status: 403 });
});

test('a student cannot publish, and the archives must be gzip', async () => {
  const project = await warmup();
  await expect(publishRelease(ctx, { kind: 'user', claims: claimsOf(ALICE) }, project, archive, other, 'x', null, null)).rejects.toMatchObject({ status: 403 });
  await expect(publishRelease(ctx, { kind: 'user', claims: claimsOf(TEACHER) }, project, new Uint8Array([1, 2, 3]), other, 'x', null, null)).rejects.toMatchObject({ status: 415 });
  const hash = await sha256(new TextEncoder().encode('yk_' + '1'.repeat(64)));
  const [named] = await asPublisher(sql, tx => tx<{ p: string | null }[]>`select app.project_for_token(${hash as Uint8Array<ArrayBuffer>}) as p`);
  expect(named?.p).toBeNull();
});

test('a release gets the id its publisher wrote into the starter, and an id already taken stores nothing, not even its objects', async () => {
  const project = await warmup();
  const chosen = trustId<ReleaseId>(crypto.randomUUID());
  const published = await publishRelease(ctx, { kind: 'user', claims: claimsOf(TEACHER) }, project, archive, other, 'stamped', null, chosen);
  expect(published.releaseId).toBe(chosen);

  // A bucket that remembers what it was given and what it was told to drop.
  const put: string[] = [];
  const deleted: string[] = [];
  const recording: Context = {
    ...ctx,
    bucket: {
      ...bucket,
      put: async (key, body, type) => {
        put.push(key);
        await bucket.put(key, body, type);
      },
      delete: async key => {
        deleted.push(key);
        await bucket.delete(key);
      },
    },
  };
  const count = async () => {
    const [row] = await asUser(sql, claimsOf(TEACHER), tx => tx<{ n: number }[]>`select count(*)::int as n from project_release where project_id = ${project}`);
    return row?.n;
  };
  const before = await count();
  await expect(publishRelease(recording, { kind: 'user', claims: claimsOf(TEACHER) }, project, archive, other, 'again', null, chosen)).rejects.toMatchObject({
    status: 409,
    body: { message: expect.stringMatching(/already been published/) },
  });
  expect(await count()).toBe(before);
  expect(put).toHaveLength(2);
  expect(deleted.toSorted()).toEqual(put.toSorted());
  for (const key of put) expect(await bucket.head(key as never)).toBeNull();
});

test('a token cannot take an id another project already has', async () => {
  const project = await warmup();
  const taken = await publishRelease(ctx, { kind: 'user', claims: claimsOf(TEACHER) }, project, archive, other, 'first', null, trustId<ReleaseId>(crypto.randomUUID()));
  const elsewhere = await asUser(sql, claimsOf(TEACHER), async tx => {
    const [row] = await tx<{ project_id: string }[]>`
      insert into project (edition_id, slug, title, kind)
      select edition_id, ${`ids-${Date.now()}`}, 'Another project, a draft', 'rust-cargo' from project where project_id = ${project}
      returning project_id`;
    return trustId<ProjectId>(row?.project_id ?? '');
  });
  const secret = await asUser(sql, claimsOf(TEACHER), async tx => {
    const [row] = await tx<{ secret: string }[]>`select app.create_project_token(${elsewhere}, 'ids') as secret`;
    return row?.secret ?? '';
  });
  await expect(publishRelease(ctx, { kind: 'token', secret }, elsewhere, archive, other, 'ci', null, taken.releaseId)).rejects.toMatchObject({ status: 409 });
  const [still] = await asUser(sql, claimsOf(TEACHER), tx => tx<{ project_id: string }[]>`select project_id from project_release where release_id = ${taken.releaseId}`);
  expect(still?.project_id).toBe(project);
  const fresh = trustId<ReleaseId>(crypto.randomUUID());
  expect((await publishRelease(ctx, { kind: 'token', secret }, elsewhere, archive, other, 'ci', null, fresh)).releaseId).toBe(fresh);
});

test("a student downloads any release's starter of their open project by id, the base of an update, and never a teacher archive", async () => {
  const project = await warmup();
  const older = await publishRelease(ctx, { kind: 'user', claims: claimsOf(TEACHER) }, project, archive, other, 'older', null, null);
  const newerStarter = new Uint8Array([...archive, 1]);
  const newer = await publishRelease(ctx, { kind: 'user', claims: claimsOf(TEACHER) }, project, newerStarter, other, 'newer', null, null);

  expect((await projectOf(ctx, claimsOf(ALICE), project)).currentReleaseId).toBe(newer.releaseId);
  const base = await fetch(await releaseUrl(ctx, claimsOf(ALICE), older.releaseId, 'starter'));
  expect(base.status).toBe(200);
  expect(new Uint8Array(await base.arrayBuffer())).toEqual(archive);
  const newest = await fetch(await releaseUrl(ctx, claimsOf(ALICE), newer.releaseId, 'starter'));
  expect(new Uint8Array(await newest.arrayBuffer())).toEqual(newerStarter);

  await expect(releaseUrl(ctx, claimsOf(ALICE), older.releaseId, 'teacher')).rejects.toMatchObject({ status: 404 });
  await expect(releaseUrl(ctx, claimsOf(ALICE), trustId<ReleaseId>(crypto.randomUUID()), 'starter')).rejects.toMatchObject({ status: 404 });
  // Staff still get the archive named after the project and the label.
  const staff = await fetch(await releaseUrl(ctx, claimsOf(TEACHER), older.releaseId, 'starter'));
  expect(staff.headers.get('content-disposition') ?? '').toContain('warmup-starter-older');
});

test('a student gets no release of a project that is not open to them, by id or as the newest', async () => {
  const draft = await asUser(sql, claimsOf(TEACHER), async tx => {
    const [row] = await tx<{ project_id: string }[]>`
      insert into project (edition_id, slug, title, kind, available_after)
      select edition_id, ${'draft-' + crypto.randomUUID().slice(0, 8)}, 'Draft', 'rust-cargo', null from project where slug = 'warmup'
      returning project_id`;
    return trustId<ProjectId>(row?.project_id ?? '');
  });
  const release = await publishRelease(ctx, { kind: 'user', claims: claimsOf(TEACHER) }, draft, archive, other, 'draft', null, null);
  await expect(releaseUrl(ctx, claimsOf(ALICE), release.releaseId, 'starter')).rejects.toMatchObject({ status: 404 });
  await expect(projectOf(ctx, claimsOf(ALICE), draft)).rejects.toMatchObject({ status: 404 });
  expect((await projectOf(ctx, claimsOf(TEACHER), draft)).currentReleaseId).toBe(release.releaseId);
  expect((await fetch(await releaseUrl(ctx, claimsOf(TEACHER), release.releaseId, 'starter'))).status).toBe(200);
});
