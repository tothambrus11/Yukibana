/** Uploading a release to the registry. One multipart request; the server
 *  hashes and stores both archives and records the release under the
 *  project the token names, or, when the bearer is a person's access token,
 *  under the project if that person owns it. */

import { decodePublished, type Published } from './lib/wire.js';

export interface PublishInput {
  /** The registry, like https://yukibana.example.org */
  readonly url: string;
  /** A project token (`yk_…`) from CI, or a person's access token. */
  readonly token: string;
  readonly projectId: string;
  /** The id written into the starter's yukibana.json, which the release
   *  row is given; null lets the registry choose, for archives that carry
   *  none. A taken id is refused (409) and nothing is stored. */
  readonly releaseId: string | null;
  readonly starter: Uint8Array;
  readonly teacher: Uint8Array;
  readonly label: string;
  readonly commit: string | null;
}

export type { Published };

export async function publish(input: PublishInput, fetchFn: typeof fetch = fetch): Promise<Published> {
  const form = new FormData();
  form.set('starter', new Blob([buffer(input.starter)], { type: 'application/gzip' }), 'starter.tar.gz');
  form.set('teacher', new Blob([buffer(input.teacher)], { type: 'application/gzip' }), 'teacher.tar.gz');
  form.set('label', input.label);
  if (input.commit !== null) form.set('commit', input.commit);
  if (input.releaseId !== null) form.set('release', input.releaseId);
  // The registry is a SvelteKit app, and SvelteKit refuses a cross-origin
  // POST whose content type is one a browser form can produce —
  // multipart/form-data among them — with "cross-site POST form submissions
  // are forbidden", before any handler runs. It compares this header against
  // its own origin, so a request without one is refused too. A command line
  // tool is not a browser and says where it is posting; the endpoint it posts
  // to takes a bearer token and no cookie, so there is no ambient credential
  // for a forged form to ride on anyway.
  const base = new URL(input.url);
  const res = await fetchFn(`${base.origin}/api/projects/${encodeURIComponent(input.projectId)}/releases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.token}`, origin: base.origin },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the registry answered ${res.status}: ${messageOf(text)}`);
  return decodePublished(JSON.parse(text));
}

function messageOf(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : text;
  } catch {
    return text;
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
