import { test, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asUser, connect } from '../../src/lib/server/db.js';
import { SESSION_COOKIE } from '../../src/lib/session-cookie.js';
import { CONNECT_COOKIE_PREFIX, authorizeUrl, connectCookie } from '../../src/lib/connect.js';
import { nonce, returnUrlOf } from '../../src/lib/server/connect.js';
import { ALICE, TEACHER, claimsOf, config } from './env.js';
import { codeMailedTo } from './mail.js';
import { startApp, type App } from './app.js';

// Light, at light.yukibana.dev, runs programs people paste into it, and it
// is the same site as the cloud: the browser sends the cloud's Lax cookies
// with every request a page there makes here. These are the requests such a
// page can make, sent to the real app over HTTP with a signed-in teacher's
// cookies, and what must come of them: nothing. The app runs under `vite
// dev`, where SvelteKit's own origin check is off, so what refuses them is
// the app's rule (#lib/server/forgery) and the routes, not the framework.

const LIGHT = 'https://light.yukibana.dev';
const sql = connect(config.databaseUrl);
let app: App;
/** The teacher's session as their browser holds it: a Cookie header. */
let teacher = '';

/** One `Set-Cookie` header, read. */
interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: ReadonlyMap<string, string>;
}

function setCookies(response: Response): SetCookie[] {
  return response.headers.getSetCookie().map(line => {
    const [pair = '', ...rest] = line.split(';');
    const at = pair.indexOf('=');
    const attributes = new Map(
      rest.map(a => {
        const eq = a.indexOf('=');
        return eq === -1 ? [a.trim().toLowerCase(), ''] : [a.slice(0, eq).trim().toLowerCase(), a.slice(eq + 1).trim()];
      }),
    );
    return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), attributes };
  });
}

/** A form this site's own page submits, as a browser does without
 *  JavaScript: it accepts HTML, so SvelteKit answers an action's redirect
 *  with a 303 rather than the JSON `{type: 'redirect'}` it gives a fetch
 *  that accepts anything. */
const ownForm = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  redirect: 'manual',
  headers: { origin: app.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
  body: new URLSearchParams(fields),
});

/** Logs `addr` in through the app's own login page, by the code mailed to
 *  it, and returns the cookies the app set, checking on the way that every
 *  one of them is a cookie a sibling subdomain could not have set. */
async function signIn(addr: string): Promise<SetCookie[]> {
  const since = Date.now();
  const sent = await fetch(`${app.origin}/auth/login?/send`, ownForm({ email: addr, next: '/' }));
  expect(sent.status, await sent.clone().text()).toBe(200);
  const verified = await fetch(`${app.origin}/auth/login?/verify`, ownForm({ email: addr, code: await codeMailedTo(addr, since), next: '/' }));
  expect(verified.status, await verified.clone().text()).toBe(303);
  const cookies = setCookies(verified).filter(c => c.value !== '');
  expect(cookies.length, 'logging in set no cookie').toBeGreaterThan(0);
  for (const c of cookies) {
    expect(c.name.startsWith(SESSION_COOKIE), c.name).toBe(true);
    expect(c.attributes.has('secure'), `${c.name} is not Secure`).toBe(true);
    expect(c.attributes.get('path'), c.name).toBe('/');
    expect(c.attributes.has('domain'), `${c.name} has a Domain`).toBe(false);
  }
  return cookies;
}

const cookieHeader = (cookies: readonly { name: string; value: string }[]): string => cookies.map(c => `${c.name}=${c.value}`).join('; ');

/** Whom the app takes the bearer of `cookie` for: their address, or null. */
async function whoIs(cookie: string): Promise<string | null> {
  const r = await fetch(`${app.origin}/api/me`, { headers: { cookie, accept: 'application/json' } });
  if (r.status === 401) return null;
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { email: string | null }).email;
}

const fingerprint = async (): Promise<unknown> => asUser(sql, claimsOf(TEACHER), async tx => (await tx<{ f: unknown }[]>`select tests.fingerprint() as f`)[0]?.f);

beforeAll(async () => {
  app = await startApp();
  teacher = cookieHeader(await signIn(TEACHER));
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await sql.end({ timeout: 5 });
});

// Every route, read from src/routes, so a route added later is covered
// without anyone remembering to add it here.

interface Route {
  /** The path with its parameters filled in. */
  readonly path: string;
  /** What the route answers: `GET` for a page, the methods a `+server.ts`
   *  exports, and `POST ?/<name>` for each form action. */
  readonly requests: readonly { readonly method: string; readonly query: string }[];
}

function routes(values: Record<string, string>): Route[] {
  const root = fileURLToPath(new URL('../../src/routes', import.meta.url));
  const found: Route[] = [];
  const walk = (dir: string): void => {
    const files = readdirSync(dir);
    const id = relative(root, dir)
      .split(sep)
      .filter(s => s !== '')
      .map(s => {
        const name = s.match(/^\[(\w+)\]$/)?.[1];
        if (name === undefined) return s;
        const value = values[name];
        if (value === undefined) throw new Error(`no value for the route parameter [${name}] in ${dir}: add one to this test`);
        return value;
      });
    const path = `/${id.join('/')}`;
    const requests: { method: string; query: string }[] = [];
    if (files.includes('+page.svelte')) requests.push({ method: 'GET', query: '' });
    for (const file of ['+server.ts', '+page.server.ts']) {
      if (!files.includes(file)) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      for (const m of source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)) requests.push({ method: m[1] ?? '', query: '' });
      const actions = source.split(/export const actions\b/)[1];
      if (actions !== undefined) for (const m of actions.matchAll(/^ {2}(\w+): async/gm)) requests.push({ method: 'POST', query: `?/${m[1] ?? ''}` });
    }
    if (requests.length > 0) found.push({ path, requests });
    for (const f of files) if (statSync(join(dir, f)).isDirectory()) walk(join(dir, f));
  };
  walk(root);
  return found;
}

/** Real ids where the seed has them, so a request reaches the route's code
 *  rather than its 404. */
async function seeded(): Promise<Record<string, string>> {
  return asUser(sql, claimsOf(TEACHER), async tx => {
    const [p] = await tx<{ project_id: string; edition_id: string }[]>`select project_id, edition_id from project where slug = 'warmup'`;
    if (p === undefined) throw new Error('no seeded project "warmup"');
    const [r] = await tx<{ id: string }[]>`select release_id as id from project_release where project_id = ${p.project_id} limit 1`;
    const [s] = await tx<{ id: string }[]>`select submission_id as id from submission where project_id = ${p.project_id} limit 1`;
    const none = '00000000-0000-4000-8000-000000000000';
    return { edition: p.edition_id, project: p.project_id, release: r?.id ?? none, submission: s?.id ?? none, archive: 'starter' };
  });
}

/** Fields that would make any of the routes' forms do something, were the
 *  request let through: enrol someone as an owner, create a course, rename
 *  the project, log out. */
const BAIT: Record<string, string> = {
  email: 'mallory@evil.example',
  role: 'owner',
  code: 'EVIL-1',
  title: 'Owned',
  label: 'owned',
  slug: 'owned',
  course_id: '',
  kind: 'exercise',
};

const bodies = (): { type: string; body: () => BodyInit }[] => [
  {
    type: 'text/plain',
    body: () =>
      Object.entries(BAIT)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
  },
  { type: 'application/x-www-form-urlencoded', body: () => new URLSearchParams(BAIT) },
  {
    type: 'multipart/form-data',
    body: () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(BAIT)) form.set(k, v);
      form.set('starter', new File(['x'], 'starter.tar.gz'));
      form.set('teacher', new File(['x'], 'teacher.tar.gz'));
      return form;
    },
  },
];

test('a page on a sibling subdomain cannot act as the person viewing it, through any route', { timeout: 180_000 }, async () => {
  const all = routes(await seeded());
  expect(
    all.some(r => r.requests.some(q => q.method !== 'GET')),
    'found no route that writes',
  ).toBe(true);
  const before = await fingerprint();
  const letThrough: string[] = [];
  for (const { path, requests } of all) {
    for (const { method, query } of requests) {
      if (method === 'GET') continue;
      for (const { type, body } of bodies()) {
        const headers: Record<string, string> = { origin: LIGHT, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', cookie: teacher };
        // A FormData body sets its own type, with the boundary.
        if (type !== 'multipart/form-data') headers['content-type'] = type;
        const r = await fetch(`${app.origin}${path}${query}`, { method, headers, body: body(), redirect: 'manual' });
        const said = await r.text();
        if (r.status !== 403) letThrough.push(`${method} ${path}${query} as ${type}: ${r.status} ${said.slice(0, 200)}`);
      }
    }
  }
  expect(letThrough).toEqual([]);
  expect(await fingerprint()).toEqual(before);
  expect(await whoIs(teacher)).toBe(TEACHER);
});

test('a page on a sibling subdomain that loads every route of this site changes nothing and signs nobody in or out', { timeout: 180_000 }, async () => {
  const all = routes(await seeded());
  const before = await fingerprint();
  const touched: string[] = [];
  for (const { path, requests } of all) {
    if (!requests.some(q => q.method === 'GET')) continue;
    // A no-cors fetch, an <img>, a <script src>: the browser sends the
    // cookies and no Origin.
    const r = await fetch(`${app.origin}${path}`, { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', cookie: teacher }, redirect: 'manual' });
    await r.arrayBuffer();
    const session = setCookies(r).filter(c => c.name.startsWith(SESSION_COOKIE));
    if (session.length > 0) touched.push(`GET ${path} set ${session.map(c => c.name).join(', ')}`);
  }
  expect(touched).toEqual([]);
  expect(await fingerprint()).toEqual(before);
  expect(await whoIs(teacher)).toBe(TEACHER);
});

test('a page on a sibling subdomain cannot have Auth bind or approve a login of its own as the person viewing it, nor cancel theirs', { timeout: 60_000 }, async () => {
  if (config.oauthClientId === null) throw new Error('SUPABASE_OAUTH_CLIENT_ID is not set: run `node cloud/dev/scripts/oauth-client.mjs` against the stack and export what it prints');
  // Two real authorizations for the registry's client, made the way
  // "Continue" makes them: the teacher's, whose id their connect cookie
  // holds, and one the sibling page made for itself. Both for the client's
  // registered return URI, on Auth's site_url, so Auth takes them.
  const registered = returnUrlOf('http://127.0.0.1:5173');
  const authorization = async (n: string): Promise<string> => {
    const req = { port: 4242, challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', state: 'c3RhdGUtb2YtdGhlLWNsaQ' };
    const res = await fetch(authorizeUrl(config.supabaseUrl, config.oauthClientId ?? '', registered, req, n), { redirect: 'manual' });
    expect(res.status, await res.text()).toBe(302);
    const id = new URL(res.headers.get('location') ?? '').searchParams.get('authorization_id');
    if (id === null) throw new Error(`Auth made no authorization: ${res.headers.get('location') ?? ''}`);
    return id;
  };
  const n = nonce();
  const theirs = await authorization(n);
  const forged = await authorization(nonce());
  const browser = `${teacher}; ${connectCookie(n)}=${theirs}`;
  const sibling = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', cookie: browser };

  const before = await fingerprint();
  const answers: string[] = [];
  for (const path of [
    `/auth/connect/consent?authorization_id=${forged}`,
    '/auth/connect/consent',
    `/auth/connect/return?error=access_denied&state=4242.c3RhdGUtb2YtdGhlLWNsaQ.${nonce()}`,
  ]) {
    const r = await fetch(`${app.origin}${path}`, { headers: sibling, redirect: 'manual' });
    await r.arrayBuffer();
    const spent = setCookies(r)
      .filter(c => c.name.startsWith(CONNECT_COOKIE_PREFIX))
      .map(c => c.name);
    answers.push(`${path}: ${r.status}${spent.length > 0 ? `, spent ${spent.join(', ')}` : ''}`);
  }
  expect(answers).toEqual([`/auth/connect/consent?authorization_id=${forged}: 400`, '/auth/connect/consent: 400', expect.stringMatching(/^\/auth\/connect\/return\?.*: 400$/)]);
  expect(await fingerprint()).toEqual(before);

  // The control: the browser's own authorization does reach Auth, and the
  // fingerprint sees Auth bind it, so the equality above is not a
  // fingerprint that cannot see Auth's OAuth tables. (This app's SITE_URL
  // is not Auth's site_url, so the approval is then refused; the binding
  // is what counts here.)
  const own = await fetch(`${app.origin}/auth/connect/consent?authorization_id=${theirs}`, {
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', cookie: browser },
    redirect: 'manual',
  });
  await own.arrayBuffer();
  expect(own.status).not.toBe(503);
  expect(await fingerprint()).not.toEqual(before);
});

test('a Domain=yukibana.dev cookie set by a light.yukibana.dev page does not change who the cloud thinks is signed in', { timeout: 60_000 }, async () => {
  // Alice's real session, under the name @supabase/ssr reads by default:
  // the cookie a page on a sibling subdomain could set for the whole of
  // yukibana.dev to sign the teacher in as Alice. (It cannot set one under
  // the __Host- name: a browser refuses that name with a Domain.)
  const legacy = `sb-${new URL(config.supabaseUrl).hostname.split('.')[0] ?? ''}-auth-token`;
  const tossed = (await signIn(ALICE)).map(c => ({ name: c.name.replace(SESSION_COOKIE, legacy), value: c.value }));

  expect(await whoIs(cookieHeader(tossed))).toBeNull();
  expect(await whoIs(`${cookieHeader(tossed)}; ${teacher}`)).toBe(TEACHER);
  expect(await whoIs(`${teacher}; ${cookieHeader(tossed)}`)).toBe(TEACHER);

  // And a request that carries one is told to forget it; that it cannot
  // reach the copy set for the whole domain is why the name is what counts.
  const r = await fetch(`${app.origin}/auth/login`, { headers: { cookie: cookieHeader(tossed) } });
  const cleared = setCookies(r)
    .filter(c => c.value === '' && c.name.startsWith(legacy))
    .map(c => c.name);
  expect(cleared.toSorted()).toEqual(tossed.map(c => c.name).toSorted());
});
