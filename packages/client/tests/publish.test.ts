import { test } from 'vitest';
import assert from 'node:assert/strict';
import { publish, type PublishInput } from '../src/publish.js';

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  url: 'https://cloud.yukibana.dev',
  token: `yk_${'a'.repeat(64)}`,
  projectId: '01a0b563-aeff-7c42-ae73-5aab2f2b5a5a',
  starter: new Uint8Array([1, 2, 3]),
  teacher: new Uint8Array([4, 5, 6, 7]),
  label: 'v1',
  commit: null,
  releaseId: null,
  ...over,
});

/** Records the one request `publish` makes and answers whatever it is told. */
const recorder = (answer: Response) => {
  const seen: { request?: Request } = {};
  const fetchFn: typeof fetch = async (url, init) => {
    seen.request = new Request(url, init);
    return answer.clone();
  };
  return { seen, fetchFn };
};

const accepted = () =>
  new Response(
    JSON.stringify({
      releaseId: '01a0b563-aeff-7c42-ae73-5aab2f2b5a5b',
      starter: { size: 3, sha256: 'aa' },
      teacher: { size: 4, sha256: 'bb' },
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );

test('a publish says where it is posting, or the registry refuses it as a forged form', async () => {
  // This was the bug: the CLI sent the multipart body with no `origin`, and
  // SvelteKit's cross-site check rejected it before the route ran — "403
  // Cross-site POST form submissions are forbidden" out of a CI job that had
  // built both archives correctly. A browser always sends the header; a
  // command line tool has to say so itself.
  const { seen, fetchFn } = recorder(accepted());
  await publish(input(), fetchFn);
  assert.equal(seen.request?.headers.get('origin'), 'https://cloud.yukibana.dev');
});

test('the origin is the registry it is posting to, whatever path the teacher gave', async () => {
  const { seen, fetchFn } = recorder(accepted());
  await publish(input({ url: 'https://cloud.yukibana.dev/projects/abc/' }), fetchFn);
  assert.equal(seen.request?.headers.get('origin'), 'https://cloud.yukibana.dev');
  assert.equal(seen.request?.url, 'https://cloud.yukibana.dev/api/projects/01a0b563-aeff-7c42-ae73-5aab2f2b5a5a/releases');
});

test('the token travels as a bearer, which is the only thing the endpoint accepts', async () => {
  const { seen, fetchFn } = recorder(accepted());
  await publish(input(), fetchFn);
  assert.equal(seen.request?.method, 'POST');
  assert.equal(seen.request?.headers.get('authorization'), `Bearer yk_${'a'.repeat(64)}`);
});

test('both archives and the label go in one multipart body', async () => {
  const { seen, fetchFn } = recorder(accepted());
  await publish(input({ commit: 'deadbeef' }), fetchFn);
  assert.ok(seen.request);
  const form = await seen.request.formData();
  const starter = form.get('starter');
  const teacher = form.get('teacher');
  assert.ok(starter instanceof File && teacher instanceof File);
  assert.deepEqual(new Uint8Array(await starter.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await teacher.arrayBuffer()), new Uint8Array([4, 5, 6, 7]));
  assert.equal(form.get('label'), 'v1');
  assert.equal(form.get('commit'), 'deadbeef');
});

test('a refusal reaches the teacher in the words the registry used, not as a status code', async () => {
  const { fetchFn } = recorder(new Response(JSON.stringify({ message: 'unknown or revoked token' }), { status: 401 }));
  await assert.rejects(publish(input(), fetchFn), /the registry answered 401: unknown or revoked token/);
});

test('the release id the starter carries goes with the upload, so the row gets the same one', async () => {
  const { seen, fetchFn } = recorder(accepted());
  await publish(input({ releaseId: '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c' }), fetchFn);
  assert.equal((await seen.request?.formData())?.get('release'), '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
  const none = recorder(accepted());
  await publish(input(), none.fetchFn);
  assert.equal((await none.seen.request?.formData())?.get('release'), null, 'archives without an id send none');
});
