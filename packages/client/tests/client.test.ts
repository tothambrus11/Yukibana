import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RegistryError, YukibanaClient } from '../src/client.js';
import { bundleOf } from '../src/bundle.js';
import type { Entry } from '../src/lib/tar.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recording(answer: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    seen.push(req);
    return answer(req);
  };
  return { seen, client: new YukibanaClient({ url: 'https://cloud.example/x', accessToken: async () => 'tok', fetch: fetchFn }) };
}

const submission = {
  submissionId: 's-1',
  projectId: '01a0b563-aeff-7c42-ae73-5aab2f2b5a01',
  submittedAt: '2026-10-07T10:00:00.000Z',
  byteSize: 10,
  sha256: 'ab',
  latest: true,
  late: false,
  author: { userId: 'u-1', fullName: 'Ada', githubLogin: 'ada', email: 'ada@uni.example' },
};

test("every request carries the person's token, and a list asks for what it was told", async () => {
  const { seen, client } = recording(() => json([submission]));
  const rows = await client.submissions('01a0b563-aeff-7c42-ae73-5aab2f2b5a01', { latest: true, author: 'u-1' });
  assert.equal(rows[0]?.author.githubLogin, 'ada');
  assert.equal(seen[0]?.url, 'https://cloud.example/api/projects/01a0b563-aeff-7c42-ae73-5aab2f2b5a01/submissions?latest=true&author=u-1');
  assert.equal(seen[0]?.headers.get('authorization'), 'Bearer tok');
});

test('a registry that answers another shape is named as such, not a crash three calls later', async () => {
  const { client } = recording(() => json([{ ...submission, byteSize: '10' }]));
  await assert.rejects(client.submissions('01a0b563-aeff-7c42-ae73-5aab2f2b5a01'), /submissions\[0\]\.byteSize as string, not a number/);
});

test("a refusal carries the registry's status and sentence", async () => {
  const { client } = recording(() => json({ message: 'Log in first.' }, 401));
  await assert.rejects(client.me(), (e: unknown) => e instanceof RegistryError && e.status === 401 && /Log in first/.test(e.message));
});

test("a download follows the redirect itself and does not hand the person's token to the bucket", async () => {
  const { seen, client } = recording(req =>
    req.url.startsWith('https://bucket.example')
      ? new Response(new Uint8Array([1, 2, 3]))
      : new Response(null, { status: 302, headers: { location: 'https://bucket.example/obj?sig=1' } }),
  );
  assert.deepEqual(await client.downloadSubmission('s-1'), new Uint8Array([1, 2, 3]));
  assert.equal(seen[1]?.url, 'https://bucket.example/obj?sig=1');
  assert.equal(seen[1]?.headers.get('authorization'), null);
});

test('a bundle is sent as a gzip body with an origin; one with problems is not sent at all', async () => {
  const file = (path: string, body: string): Entry => ({ path, type: 'file', mode: 0o644, mtime: 1, data: new TextEncoder().encode(body) });
  const made = bundleOf([file('yukibana.json', '{"version":1,"kind":"rust-cargo","projectId":"01a0b563-aeff-7c42-ae73-5aab2f2b5a01"}'), file('src/lib.rs', '')]);
  assert.ok(made.ok);
  const { seen, client } = recording(() => json({ submissionId: 's-9', byteSize: 3, sha256: 'cd' }, 201));
  assert.equal((await client.submit(made.bundle)).submissionId, 's-9');
  assert.equal(seen[0]?.url, 'https://cloud.example/api/projects/01a0b563-aeff-7c42-ae73-5aab2f2b5a01/submissions');
  assert.equal(seen[0]?.headers.get('content-type'), 'application/gzip');
  assert.equal(seen[0]?.headers.get('origin'), 'https://cloud.example');
  const sent = seen[0];
  assert.ok(sent);
  const body = new Uint8Array(await sent.arrayBuffer());
  assert.deepEqual([...body.subarray(0, 2)], [0x1f, 0x8b]);

  const broken = bundleOf([file('yukibana.json', '{"version":1,"kind":"rust-cargo","submission":{"maxBytes":1}}'), file('a', 'too big')]);
  assert.ok(broken.ok);
  await assert.rejects(client.submit(broken.bundle, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01'), /not submitted/);
  assert.equal(seen.length, 1);
});

test('a submission says which release its folder started from, and the list says it back', async () => {
  const file = (path: string, body: string): Entry => ({ path, type: 'file', mode: 0o644, mtime: 1, data: new TextEncoder().encode(body) });
  const made = bundleOf([
    file('yukibana.json', '{"version":1,"kind":"rust-cargo","projectId":"01a0b563-aeff-7c42-ae73-5aab2f2b5a01","releaseId":"01a0b563-aeff-7c42-ae73-5aab2f2b5a5c"}'),
    file('src/lib.rs', ''),
  ]);
  assert.ok(made.ok);
  assert.equal(made.bundle.releaseId, '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
  const { seen, client } = recording(req =>
    req.method === 'POST'
      ? json({ submissionId: 's-9', byteSize: 3, sha256: 'cd' }, 201)
      : json([{ ...submission, baseReleaseId: '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c' }, submission]),
  );
  await client.submit(made.bundle);
  assert.equal(seen[0]?.url, 'https://cloud.example/api/projects/01a0b563-aeff-7c42-ae73-5aab2f2b5a01/submissions?release=01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
  const [based, older] = await client.submissions('01a0b563-aeff-7c42-ae73-5aab2f2b5a01');
  assert.equal(based?.baseReleaseId, '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
  assert.equal(older?.baseReleaseId, null, 'a registry that does not say is read as unknown');
});
