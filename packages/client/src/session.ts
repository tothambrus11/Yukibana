/** Logging in as a person, and staying logged in.
 *
 *  Identity is Supabase Auth's. A login that comes back to the loopback
 *  goes through the registry's website (`/auth/connect`): the person logs
 *  in there with GitHub or an emailed code, sees whom they are signed in
 *  as, and chooses to continue as them or to use another account. Only
 *  then does Auth's OAuth 2.1 server issue a code, for the registry's OAuth
 *  client, which this module trades for a session of the CLI's own. That
 *  session is not the website's: refreshing or logging out one leaves the
 *  other alone. Nothing about the login is kept on the loopback for next
 *  time; every login asks again.
 *
 *  A registry without an OAuth client, and a redirect that is not the
 *  loopback (a browser IDE's own route), log in the older way: straight to
 *  GitHub through the Auth server, as whichever GitHub account the browser
 *  holds.
 *
 *  What the registry receives either way is an access token like a browser
 *  session's, as a bearer. A login is three steps so that whoever drives
 *  it chooses how the browser is shown and where it comes back to:
 *
 *  1. `startLogin(registry, redirectUrl)` asks the registry for its Auth
 *     server and makes a PKCE pair; it returns the address to open.
 *  2. The caller opens it: the terminal in the system browser with a
 *     loopback listener (`loopback.ts`), the Theia extension however suits
 *     it, coming back to a route of its own.
 *  3. `finish(callback)` trades the code on the address the browser came
 *     back to for a session.
 *
 *  The redirect address must be on the Auth server's allow list
 *  (`cloud/db/supabase/config.toml`): the loopback on any port is, and an IDE that
 *  comes back somewhere else needs its address added there.
 *
 *  A session is kept by a `SessionStore`: a file for the terminal
 *  (`store.ts`), the IDE's secret storage for the extension. `tokenProvider`
 *  turns a store into what `YukibanaClient` takes, refreshing on the way.
 */

import { decodeAuthConfig } from './lib/wire.js';
import { authorizeUrl, connectReturnUrl, connectUrl, isLoopback, pkce, state as newState } from './lib/pkce.js';

export interface Session {
  /** The registry, like https://cloud.yukibana.dev */
  readonly url: string;
  /** Its Auth server, and the publishable key that server wants with every
   *  call. Neither is secret; both are remembered so a refresh does not ask
   *  the registry again. */
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  /** What the registry is sent as a bearer. Short-lived: an hour. */
  readonly accessToken: string;
  /** Trades for a new pair once. Rotated on every use, so a session must be
   *  saved after each refresh, and two refreshes must never race. */
  readonly refreshToken: string;
  /** When `accessToken` stops working, in seconds since the epoch. */
  readonly expiresAt: number;
  /** Who logged in, as the Auth server says; for display. */
  readonly email: string | null;
  /** The OAuth client the session was issued to, when the login went
   *  through the website. A refresh must name it: Auth refuses to refresh
   *  such a session without it. Absent for a session from the GitHub-direct
   *  login, which refreshes as it always did. */
  readonly clientId?: string;
}

/** Where a session is kept between runs. */
export interface SessionStore {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

/** A store that forgets when the process ends: for tests, and for an IDE
 *  that keeps the session elsewhere and only lends it. */
export function memoryStore(initial: Session | null = null): SessionStore {
  let held = initial;
  return {
    load: async () => held,
    save: async s => {
      held = s;
    },
    clear: async () => {
      held = null;
    },
  };
}

/** Nobody is logged in, or the session can no longer be refreshed. The
 *  answer is to log in again, which is why this is its own class. */
export class NotLoggedIn extends Error {}

export interface PendingLogin {
  /** Open this in a browser. */
  readonly authorizeUrl: URL;
  /** Where the browser will come back to, as given. */
  readonly redirectUrl: string;
  /** The `state` the browser must bring back, for a login through the
   *  website; null for the GitHub-direct login, which has none. A listener
   *  answers anything else that reaches it with a 400 and keeps waiting. */
  readonly state: string | null;
  /** Finishes the login with the address the browser came back to. Throws
   *  with the Auth server's sentence when the person declined or the code
   *  is spent. A login through the website needs the whole address, with
   *  its state, and refuses one whose state is not `state` before it reads
   *  the code or the error; the GitHub-direct login also takes just the
   *  `code`. */
  finish(callback: URL | string): Promise<Session>;
}

/** Step one of a login against the registry at `registry`. */
export async function startLogin(registry: string, redirectUrl: string, fetchFn: typeof fetch = fetch): Promise<PendingLogin> {
  const base = new URL(registry);
  const res = await fetchFn(new URL('/api/auth/config', base.origin));
  if (!res.ok) throw new Error(`the registry at ${base.origin} answered ${res.status} when asked how to log in; is the address right?`);
  const auth = decodeAuthConfig(await res.json());
  const pair = pkce();
  if (auth.oauthClientId !== null && isLoopback(redirectUrl)) {
    const clientId = auth.oauthClientId;
    // Auth's site_url, where the website's part of the login works; an
    // older registry does not say, and is its own site.
    const site = auth.siteUrl ?? base.origin;
    const st = newState();
    return {
      authorizeUrl: connectUrl(site, redirectUrl, pair.challenge, st),
      redirectUrl,
      state: st,
      async finish(callback) {
        if (stateOf(callback) !== st) throw new Error("the login came back without this request's state; start it again");
        const code = codeOf(callback);
        const body = await oauthTokenCall(fetchFn, auth.supabaseUrl, auth.publishableKey, {
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          redirect_uri: connectReturnUrl(site),
          code_verifier: pair.verifier,
        });
        return sessionOf(base.origin, auth.supabaseUrl, auth.publishableKey, body, clientId);
      },
    };
  }
  return {
    authorizeUrl: authorizeUrl(auth.supabaseUrl, redirectUrl, pair.challenge),
    redirectUrl,
    state: null,
    async finish(callback) {
      const code = codeOf(callback);
      const body = await tokenCall(fetchFn, auth.supabaseUrl, auth.publishableKey, 'pkce', { auth_code: code, code_verifier: pair.verifier });
      return sessionOf(base.origin, auth.supabaseUrl, auth.publishableKey, body);
    },
  };
}

/** The code on the address the browser came back to, or the Auth server's
 *  reason for not giving one. A bare string that is not an address is taken
 *  to be the code itself. */
export function codeOf(callback: URL | string): string {
  let url: URL;
  try {
    url = typeof callback === 'string' ? new URL(callback) : callback;
  } catch {
    if (typeof callback === 'string' && callback.trim() !== '') return callback.trim();
    throw new Error('the login came back with nothing');
  }
  // Errors arrive in the query or, from some providers, in the fragment.
  const params = new URLSearchParams(url.search);
  for (const [k, v] of new URLSearchParams(url.hash.replace(/^#/, ''))) if (!params.has(k)) params.set(k, v);
  const code = params.get('code');
  if (code !== null && code !== '') return code;
  const why = params.get('error_description') ?? params.get('error');
  throw new Error(why === null ? 'the login came back without a code' : `the login was refused: ${why}`);
}

/** The `state` on the address the browser came back to, or null when
 *  there is none (a bare code, or the GitHub-direct login). */
function stateOf(callback: URL | string): string | null {
  try {
    return (typeof callback === 'string' ? new URL(callback) : callback).searchParams.get('state');
  } catch {
    return null;
  }
}

/** A new session for an old one, by its refresh token. A session that
 *  came through the website refreshes at the OAuth server's token
 *  endpoint and names its client; any other at Auth's own. */
export async function refreshSession(session: Session, fetchFn: typeof fetch = fetch, timeoutMs = AUTH_TIMEOUT_MS): Promise<Session> {
  if (session.clientId !== undefined) {
    const fresh = await oauthTokenCall(
      fetchFn,
      session.supabaseUrl,
      session.publishableKey,
      { grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId },
      timeoutMs,
    );
    return sessionOf(session.url, session.supabaseUrl, session.publishableKey, fresh, session.clientId, session.email);
  }
  const body = await tokenCall(fetchFn, session.supabaseUrl, session.publishableKey, 'refresh_token', { refresh_token: session.refreshToken }, timeoutMs);
  return sessionOf(session.url, session.supabaseUrl, session.publishableKey, body);
}

/** An access token from `store`, refreshed (and saved) when it has less
 *  than `leewaySeconds` left. Refreshes are serialised: the refresh token
 *  rotates, and the second of two concurrent refreshes would find it spent
 *  and log the person out. Throws `NotLoggedIn` when there is nothing to
 *  refresh with. */
export function tokenProvider(store: SessionStore, fetchFn: typeof fetch = fetch, leewaySeconds = 60, now: () => number = () => Date.now() / 1000): () => Promise<string> {
  let refreshing: Promise<Session> | null = null;
  return async () => {
    const session = await store.load();
    if (session === null) throw new NotLoggedIn('not logged in; run `yukibana login`');
    if (session.expiresAt - leewaySeconds > now()) return session.accessToken;
    refreshing ??= (async () => {
      try {
        const fresh = await refreshSession(session, fetchFn);
        await store.save(fresh);
        return fresh;
      } catch (e) {
        throw new NotLoggedIn(`the session has expired and could not be renewed (${e instanceof Error ? e.message : String(e)}); log in again`);
      } finally {
        refreshing = null;
      }
    })();
    return (await refreshing).accessToken;
  };
}

/** How a logout went. `revoked` is whether the Auth server ended the
 *  session; when it did not, `why` says why in a sentence a host can show,
 *  because the refresh token then still works until it expires. */
export interface LoggedOut {
  readonly revoked: boolean;
  readonly why: string | null;
}

/** Ends this session at the Auth server (so the refresh token is dead even
 *  if the stored copy leaks later) and forgets it. Only this session, by
 *  `scope=local`: Auth's default, `global`, would also end every other
 *  session the person has, the website in each of their browsers and the
 *  IDE on their other machines.
 *
 *  Logging out takes a live access token, and a session idle for an hour
 *  (the usual case before a logout) has none: so an expired one is
 *  refreshed first, and the fresh one revoked. Each call gives up after
 *  `timeoutMs`. The session is forgotten here whatever happens. */
export async function logout(store: SessionStore, fetchFn: typeof fetch = fetch, now: () => number = () => Date.now() / 1000, timeoutMs = 5000): Promise<LoggedOut> {
  let session = await store.load();
  await store.clear();
  if (session === null) return { revoked: false, why: 'nobody was logged in' };
  try {
    if (session.expiresAt <= now()) session = await refreshSession(session, fetchFn, timeoutMs);
  } catch (e) {
    return { revoked: false, why: `the session had expired and could not be renewed to end it (${e instanceof Error ? e.message : String(e)})` };
  }
  try {
    const res = await fetchFn(new URL('/auth/v1/logout?scope=local', session.supabaseUrl), {
      method: 'POST',
      headers: { apikey: session.publishableKey, authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? { revoked: true, why: null } : { revoked: false, why: `the Auth server answered ${res.status}` };
  } catch (e) {
    return { revoked: false, why: `the Auth server could not be reached (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** How long a call to the Auth server may take before it is abandoned. */
const AUTH_TIMEOUT_MS = 30_000;

async function tokenCall(fetchFn: typeof fetch, supabaseUrl: string, key: string, grant: string, payload: Record<string, string>, timeoutMs = AUTH_TIMEOUT_MS): Promise<unknown> {
  const url = new URL('/auth/v1/token', supabaseUrl);
  url.searchParams.set('grant_type', grant);
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return answer(res);
}

/** The OAuth 2.1 server's token endpoint: a form, as RFC 6749 has it, from
 *  a public client (its id in the body, no secret). */
async function oauthTokenCall(fetchFn: typeof fetch, supabaseUrl: string, key: string, form: Record<string, string>, timeoutMs = AUTH_TIMEOUT_MS): Promise<unknown> {
  const res = await fetchFn(new URL('/auth/v1/oauth/token', supabaseUrl), {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return answer(res);
}

async function answer(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const why = [o['msg'], o['error_description'], o['message'], o['error']].find(v => typeof v === 'string');
    throw new Error(`the Auth server answered ${res.status}${typeof why === 'string' ? `: ${why}` : ''}`);
  }
  return body;
}

/** The `email` claim of an access token, read without verifying it: for
 *  display only, from a token this process has just received from the
 *  Auth server. Null when there is none, or the token is not a JWT. */
function emailOf(accessToken: string): string | null {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>)['email'] : undefined;
    return typeof email === 'string' && email !== '' ? email : null;
  } catch {
    return null;
  }
}

/** A session from the Auth server's token response. The OAuth server's
 *  response has no `user`, so the address comes from the token itself, or
 *  failing that from the session being refreshed. */
function sessionOf(url: string, supabaseUrl: string, publishableKey: string, body: unknown, clientId?: string, knownEmail: string | null = null): Session {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const access = o['access_token'];
  const refresh = o['refresh_token'];
  if (typeof access !== 'string' || typeof refresh !== 'string') throw new Error('the Auth server answered without a session');
  const expiresAt = typeof o['expires_at'] === 'number' ? o['expires_at'] : Math.floor(Date.now() / 1000) + (typeof o['expires_in'] === 'number' ? o['expires_in'] : 3600);
  const user = typeof o['user'] === 'object' && o['user'] !== null ? (o['user'] as Record<string, unknown>) : {};
  const email = typeof user['email'] === 'string' ? user['email'] : (emailOf(access) ?? knownEmail);
  return { url, supabaseUrl, publishableKey, accessToken: access, refreshToken: refresh, expiresAt, email, ...(clientId === undefined ? {} : { clientId }) };
}
