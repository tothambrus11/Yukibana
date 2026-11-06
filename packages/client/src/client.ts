/** The registry's API, as whoever the credentials say.
 *
 *  Everything a person may do from a terminal or an IDE goes through here,
 *  and the registry decides what that is: the same call lists every
 *  student's submissions for a teacher and only their own for a student,
 *  because the database's policies answer, not this class. Credentials are
 *  a function returning an access token, so the caller decides where they
 *  come from: `tokenProvider` over a stored session for the terminal, the
 *  IDE's own login for the extension.
 */

import type { SubmissionBundle } from './bundle.js';
import { publish } from './publish.js';
import {
  Unexpected,
  decodeAccepted,
  decodeEdition,
  decodeList,
  decodeMe,
  decodeMember,
  decodeProject,
  decodeRelease,
  decodeSubmission,
  type Accepted,
  type Edition,
  type EditionRole,
  type Me,
  type Member,
  type Project,
  type Published,
  type Release,
  type Submission,
} from './lib/wire.js';

export interface ClientOptions {
  /** The registry, like https://cloud.yukibana.dev */
  readonly url: string;
  /** An access token for the person, asked for before every request so a
   *  provider can refresh it. */
  readonly accessToken: () => Promise<string> | string;
  readonly fetch?: typeof fetch;
}

/** The registry refused, with the sentence it gave. `status` is the HTTP
 *  status: 401 means log in again, 403 not allowed, 404 no such thing or
 *  not visible to you (the registry does not tell those apart), 409 a
 *  conflict, 413 too large. */
export class RegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SubmissionQuery {
  /** Only each author's newest submission: the ones that count. */
  readonly latest?: boolean;
  /** Only this author's, by user id. */
  readonly author?: string;
}

export class YukibanaClient {
  readonly origin: string;
  readonly #token: () => Promise<string> | string;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.origin = new URL(options.url).origin;
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Who the credentials are. */
  me(): Promise<Me> {
    return this.#json('GET', '/api/me', decodeMe);
  }

  /** The editions the person is enrolled in, with their role in each. */
  editions(): Promise<Edition[]> {
    return this.#json('GET', '/api/editions', decodeList(decodeEdition, 'editions'));
  }

  /** An edition's enrolments. Staff see everyone; a student sees their own. */
  members(edition: string): Promise<Member[]> {
    return this.#json('GET', `/api/editions/${seg(edition)}/members`, decodeList(decodeMember, 'members'));
  }

  /** Enrols an address (owners only). Enrolling an address twice changes
   *  nothing, its role included. */
  async enrol(edition: string, email: string, role: EditionRole = 'student'): Promise<void> {
    await this.#json('POST', `/api/editions/${seg(edition)}/members`, () => undefined, { json: { email, role } });
  }

  /** Removes an enrolment (owners only). Submissions stay. */
  async unenrol(edition: string, email: string): Promise<void> {
    await this.#json('DELETE', `/api/editions/${seg(edition)}/members?email=${encodeURIComponent(email)}`, () => undefined);
  }

  /** The projects the person can see: for a student, the published ones of
   *  their editions; for staff, all of their editions'. `edition` narrows
   *  the list to one. */
  projects(edition?: string): Promise<Project[]> {
    const q = edition === undefined ? '' : `?edition=${encodeURIComponent(edition)}`;
    return this.#json('GET', `/api/projects${q}`, decodeList(decodeProject, 'projects'));
  }

  project(project: string): Promise<Project> {
    return this.#json('GET', `/api/projects/${seg(project)}`, decodeProject);
  }

  /** Submissions to a project, newest first. Staff see everyone's; a
   *  student sees their own. */
  submissions(project: string, query: SubmissionQuery = {}): Promise<Submission[]> {
    const q = new URLSearchParams();
    if (query.latest === true) q.set('latest', 'true');
    if (query.author !== undefined) q.set('author', query.author);
    const qs = q.size === 0 ? '' : `?${q.toString()}`;
    return this.#json('GET', `/api/projects/${seg(project)}/submissions${qs}`, decodeList(decodeSubmission, 'submissions'));
  }

  /** A project's releases, newest first (staff only). */
  releases(project: string): Promise<Release[]> {
    return this.#json('GET', `/api/projects/${seg(project)}/releases`, decodeList(decodeRelease, 'releases'));
  }

  /** Sends a bundle as a new submission. Refuses, without sending, a bundle
   *  that has problems or names no project (unless `project` is given). */
  async submit(bundle: SubmissionBundle, project: string | null = bundle.projectId): Promise<Accepted> {
    if (bundle.problems.length > 0) throw new Error(`not submitted: ${bundle.problems.join('; ')}`);
    if (project === null) throw new Error('not submitted: the folder names no project; give one');
    return this.submitArchive(project, await bundle.archive(), bundle.releaseId);
  }

  /** Sends an archive made elsewhere (a `.tar.gz`) as a new submission.
   *  `release` is the release the work started from, as the folder's
   *  yukibana.json says; null when it says none. */
  submitArchive(project: string, archive: Uint8Array, release: string | null = null): Promise<Accepted> {
    const q = release === null ? '' : `?release=${encodeURIComponent(release)}`;
    return this.#json('POST', `/api/projects/${seg(project)}/submissions${q}`, decodeAccepted, { bytes: archive, contentType: 'application/gzip' });
  }

  /** Publishes a release as the person (owners and assistants). CI uses a project
   *  token instead; see `publish`. `release` is the id the starter carries
   *  (see `build`), or null for archives that carry none. */
  async publishRelease(project: string, starter: Uint8Array, teacher: Uint8Array, label = '', commit: string | null = null, release: string | null = null): Promise<Published> {
    return publish({ url: this.origin, token: await this.#token(), projectId: project, releaseId: release, starter, teacher, label, commit }, this.#fetch);
  }

  /** A submission's archive, as sent (a `.tar.gz`). */
  downloadSubmission(submission: string): Promise<Uint8Array> {
    return this.#download(`/api/submissions/${seg(submission)}`);
  }

  /** The starter students get now (a `.tar.gz`). */
  downloadStarter(project: string): Promise<Uint8Array> {
    return this.#download(`/api/projects/${seg(project)}/starter`);
  }

  /** One archive of a release (a `.tar.gz`). Staff may download either;
   *  a student only the starter, of a release of a project they may download
   *  from now, which is how an IDE fetches the base of an update. */
  downloadRelease(release: string, archive: 'starter' | 'teacher'): Promise<Uint8Array> {
    return this.#download(`/api/releases/${seg(release)}/${archive}`);
  }

  async #request(method: string, path: string, body?: { json?: unknown; bytes?: Uint8Array; contentType?: string }): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.#token()}`, accept: 'application/json' };
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body?.bytes !== undefined) {
      headers['content-type'] = body.contentType ?? 'application/octet-stream';
      payload = new Blob([body.bytes.slice().buffer]);
    }
    // SvelteKit compares a write's Origin with its own; a tool says where it
    // is posting, as publish.ts explains.
    if (method !== 'GET') headers['origin'] = this.origin;
    return this.#fetch(`${this.origin}${path}`, { method, headers, redirect: 'manual', ...(payload === undefined ? {} : { body: payload }) });
  }

  async #json<T>(method: string, path: string, decode: (v: unknown) => T, body?: { json?: unknown; bytes?: Uint8Array; contentType?: string }): Promise<T> {
    const res = await this.#request(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new RegistryError(res.status, `the registry answered ${res.status}: ${messageOf(text)}`);
    if (res.status === 204 || text === '') return decode(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Unexpected(`the registry answered ${method} ${path} with something other than JSON`);
    }
    return decode(parsed);
  }

  /** Follows the registry's redirect to a presigned URL itself, without the
   *  bearer: the URL is its own credential, and the bucket must not see the
   *  person's token. */
  async #download(path: string): Promise<Uint8Array> {
    const res = await this.#request('GET', path);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location !== null) {
      await res.body?.cancel();
      const file = await this.#fetch(new URL(location, this.origin));
      if (!file.ok) throw new RegistryError(file.status, `the bucket answered ${file.status} for ${path}`);
      return new Uint8Array(await file.arrayBuffer());
    }
    const text = await res.text();
    if (!res.ok) throw new RegistryError(res.status, `the registry answered ${res.status}: ${messageOf(text)}`);
    throw new Unexpected(`the registry answered ${path} without sending anywhere to download it from`);
  }
}

const seg = (id: string): string => encodeURIComponent(id);

export function messageOf(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : text;
  } catch {
    return text;
  }
}
