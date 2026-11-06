/** Connecting a terminal or a desktop IDE to the registry, through the
 *  website: what `/auth/connect` accepts and where it sends the browser,
 *  decided without asking anyone.
 *
 *  The CLI (or the IDE through `@yukibana/cli`) listens on 127.0.0.1 and
 *  opens `/auth/connect` with a PKCE challenge, its loopback address and a
 *  state of its own. The person logs in to the website as usual (GitHub or
 *  an emailed code), sees whom they are signed in as, and confirms. Only
 *  then does the website ask Supabase Auth's OAuth 2.1 server, server to
 *  server, for an authorization, and send the browser with its id to the
 *  website's consent route; that approves for the person signed in, takes
 *  the code from Auth's answer, and sends the browser with it straight to
 *  the loopback. The CLI trades the code for a session of its own with its
 *  PKCE verifier.
 *
 *  The website makes the authorization itself, rather than sending the
 *  browser to Auth to make it, so that it knows the id before the browser
 *  comes back with one. The consent route is a GET (Auth's
 *  `authorization_url_path` is one), and the first look at an
 *  authorization binds it to whoever is signed in: a page on a sibling
 *  subdomain, which the browser sends this site's cookies for, could
 *  otherwise name an authorization of its own and have Auth bind and
 *  approve it as the person viewing it. Now the route asks Auth about one
 *  id only, the one this browser's "Continue" was given.
 *
 *  Auth matches a client's redirect URIs exactly, and a loopback listener's
 *  port is whatever the system gave it, so no loopback address can be
 *  registered. The client's one redirect URI is the website's own
 *  `/auth/connect/return`: the code is issued for it, but the consent route
 *  reads the code from Auth's answer instead of sending the browser there
 *  with it. The loopback travels inside `state`, which Auth carries
 *  untouched and the consent route checks again before relaying. What
 *  reaches the loopback is a code, never a token: worth nothing without the
 *  verifier, used once, and dead three minutes after the authorization
 *  began.
 *
 *  All of this works only on the origin that is Auth's `site_url`: the
 *  consent route is found there, the redirect URI is registered there, and
 *  the cookie that proves the person clicked is set there. The CLI learns
 *  that origin from `/api/auth/config`, and `/auth/connect` moves to it.
 */

/** A request to connect, as the CLI sent it to `/auth/connect`. */
export interface ConnectRequest {
  /** The loopback listener's port: the only part of its address that varies. */
  readonly port: number;
  /** The CLI's S256 PKCE challenge, passed to Auth as it is. */
  readonly challenge: string;
  /** The CLI's own state, given back to it with the code. */
  readonly state: string;
}

/** The only loopback address the browser is ever sent to: `127.0.0.1`, the
 *  port given, `/callback`. The same rule as the Auth allow list's
 *  `http://127.0.0.1:*\/callback`, and the address `loginWithLoopback`
 *  listens on. `localhost` is not accepted: it can resolve elsewhere. */
export const loopback = (port: number): URL => new URL(`http://127.0.0.1:${port}/callback`);

const PORT = /^[1-9]\d{0,4}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** The port of `redirect` if it is exactly a loopback callback address, or
 *  null for anything else: another host, `https`, user info, a query, a
 *  fragment, a path that is not `/callback`. */
export function loopbackPort(redirect: string): number | null {
  const m = /^http:\/\/127\.0\.0\.1:([0-9]+)\/callback$/.exec(redirect);
  if (m === null || m[1] === undefined || !PORT.test(m[1])) return null;
  const port = Number(m[1]);
  return port <= 65535 ? port : null;
}

/** A connect request from `/auth/connect`'s query, or null with nothing
 *  half-accepted. The challenge must be S256's 43 base64url characters
 *  (RFC 7636); a `plain` challenge would be the verifier itself, sent
 *  through the browser. */
export function connectRequestOf(query: URLSearchParams): ConnectRequest | null {
  const port = loopbackPort(query.get('redirect_uri') ?? '');
  const challenge = query.get('code_challenge') ?? '';
  const state = query.get('state') ?? '';
  const method = query.get('code_challenge_method') ?? 'S256';
  if (port === null || !CHALLENGE.test(challenge) || !STATE.test(state) || method.toUpperCase() !== 'S256') return null;
  return { port, challenge, state };
}

/** The query `/auth/connect` was opened with, for a link back to it (after
 *  a login, or a switch of account). */
export function connectQuery(req: ConnectRequest): string {
  const q = new URLSearchParams({ redirect_uri: loopback(req.port).toString(), code_challenge: req.challenge, code_challenge_method: 'S256', state: req.state });
  return q.toString();
}

/** What travels through Auth as `state`: the loopback's port, the CLI's
 *  state, and a nonce this browser holds in a cookie since the person
 *  confirmed. The nonce is what makes "nothing reaches the loopback until
 *  the person clicked" true: `/return` relays only a state whose nonce is
 *  the one in the cookie, so a page elsewhere that starts an authorization
 *  on its own gets nothing delivered. */
export interface Relay {
  readonly port: number;
  readonly state: string;
  readonly nonce: string;
}

export const relayState = (r: Relay): string => `${r.port}.${r.state}.${r.nonce}`;

/** The cookie that remembers, for five minutes, that the person in this
 *  browser clicked "Continue" for the login with this nonce. One per login,
 *  so two at once (the IDE and a terminal, two windows, a double click) do
 *  not overwrite each other. `__Host-`: this origin's alone, only over TLS
 *  (or to 127.0.0.1 in development), for every path. Its name is the proof
 *  that the state's nonce is this browser's; its value is the id of the
 *  authorization "Continue" made, the only one the consent route will ask
 *  Auth about. HttpOnly, so no page can read either. */
export const CONNECT_COOKIE_PREFIX = '__Host-yukibana-connect-';
export const connectCookie = (nonce: string): string => `${CONNECT_COOKIE_PREFIX}${nonce}`;

/** Four characters the CLI prints and the website shows, so the person can
 *  see that the page asking them is the login they started. A courtesy,
 *  not a check: the state and the verifier are the checks. The CLI makes
 *  the same from the same state (`loginCode` in packages/client/src/lib/pkce.ts). */
export const loginCode = (state: string): string => state.slice(0, 4).toUpperCase();

/** The relay a `state` names, or null if it is not one this module made. */
export function relayOf(state: string | null): Relay | null {
  const parts = (state ?? '').split('.');
  if (parts.length !== 3) return null;
  const [p, s, n] = parts as [string, string, string];
  const port = loopbackPort(`http://127.0.0.1:${p}/callback`);
  if (port === null || !STATE.test(s) || !NONCE.test(n)) return null;
  return { port, state: s, nonce: n };
}

/** What the website asks for once the person has confirmed: Auth's OAuth
 *  2.1 authorization endpoint, for the registry's client, coming back to
 *  `returnUrl`. The Worker requests it, not the browser (`start` in
 *  #lib/server/connect). `scope` is Auth's default, `email`: the registry needs
 *  nothing an ordinary session does not carry. */
export function authorizeUrl(supabaseUrl: string, clientId: string, returnUrl: string, req: ConnectRequest, nonce: string): URL {
  const url = new URL('/auth/v1/oauth/authorize', supabaseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', returnUrl);
  url.searchParams.set('code_challenge', req.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', 'email');
  url.searchParams.set('state', relayState({ port: req.port, state: req.state, nonce }));
  return url;
}

/** The loopback address with what Auth answered: a `code`, or an `error`
 *  and its description, and the CLI's own state. Nothing else is carried
 *  over: whatever else was on the address stays here. */
export function deliveryUrl(relay: Relay, answer: URLSearchParams): URL {
  const url = loopback(relay.port);
  const code = answer.get('code');
  if (code !== null && code !== '') {
    url.searchParams.set('code', code);
  } else {
    url.searchParams.set('error', answer.get('error') ?? 'server_error');
    url.searchParams.set('error_description', answer.get('error_description') ?? 'The login did not complete.');
  }
  url.searchParams.set('state', relay.state);
  return url;
}

/** The loopback address for a person who said no on the website. */
export function declinedUrl(req: ConnectRequest): URL {
  const url = loopback(req.port);
  url.searchParams.set('error', 'access_denied');
  url.searchParams.set('error_description', 'You cancelled the login on the website.');
  url.searchParams.set('state', req.state);
  return url;
}
