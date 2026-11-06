/** The browser half of a terminal login: OAuth's PKCE, against Supabase Auth.
 *
 *  Two ways in. Through the website (`connectUrl`): the registry's page
 *  logs the person in however the website does (GitHub or an emailed
 *  code), shows them whom they are signed in as, and on their say-so has
 *  Supabase's OAuth 2.1 server issue a code for the CLI's own client. Or,
 *  from a registry without that client, straight to GitHub through the
 *  Auth server (`authorizeUrl`), which signs in as whichever GitHub account
 *  the browser happens to hold.
 *
 *  The CLI makes a secret (the verifier), sends only its hash (the
 *  challenge) through the browser, and trades the code that comes back for
 *  a session by showing the secret. A code that leaks from the browser's
 *  history, or one a page forges into the loopback, is worth nothing
 *  without the verifier, which never leaves this process. That is why the
 *  loopback needs no `state` of its own.
 */

import { createHash, randomBytes } from 'node:crypto';

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** A fresh verifier and its S256 challenge. 32 random bytes: the 43
 *  characters RFC 7636 asks for at least. */
export function pkce(random: (n: number) => Uint8Array = randomBytes): Pkce {
  const verifier = base64url(random(32));
  return { verifier, challenge: challengeOf(verifier) };
}

export function challengeOf(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** A fresh `state` for a connect login: 16 random bytes, base64url. The
 *  code is already worthless without the verifier; the state lets the CLI
 *  also refuse a code that answers some other request. */
export function state(random: (n: number) => Uint8Array = randomBytes): string {
  return base64url(random(16));
}

/** Whether `redirect` is a loopback callback the registry's connect page
 *  will send a code to: `http://127.0.0.1:<port>/callback`, nothing else
 *  (the page checks the same, see cloud/web/src/lib/connect.ts). */
export function isLoopback(redirect: string): boolean {
  const m = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/.exec(redirect);
  return m !== null && Number(m[1]) <= 65535;
}

/** Where the browser goes for a login through the website: the registry's
 *  `/auth/connect`, with the challenge, the loopback to come back to and
 *  the state. The page decides the rest. */
export function connectUrl(registry: string, redirect: string, challenge: string, st: string): URL {
  const url = new URL('/auth/connect', new URL(registry).origin);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', st);
  return url;
}

/** Four characters the CLI prints and the website shows beside "Continue",
 *  so the person can see the page is asking about the login they started.
 *  A courtesy, not a check. The website makes the same from the same state
 *  (`loginCode` in cloud/web/src/lib/connect.ts). Null for an address that is not
 *  a connect page. */
export function loginCode(url: URL): string | null {
  const st = url.pathname === '/auth/connect' ? url.searchParams.get('state') : null;
  return st === null || st === '' ? null : st.slice(0, 4).toUpperCase();
}

/** The redirect URI of the registry's OAuth client, which the code was
 *  issued for and which the exchange must name again. */
export const connectReturnUrl = (registry: string): string => `${new URL(registry).origin}/auth/connect/return`;

/** Where the browser goes without the website: Supabase Auth's GitHub sign-in, coming back to
 *  `redirect` with `?code=`. Supabase only redirects to addresses on its
 *  allow list, which is why `cloud/db/supabase/config.toml` lists the loopback with
 *  any port. The scopes are the ones the web login asks for, so the profile
 *  is the same however someone first logs in. */
export function authorizeUrl(supabaseUrl: string, redirect: string, challenge: string): URL {
  const url = new URL('/auth/v1/authorize', supabaseUrl);
  url.searchParams.set('provider', 'github');
  url.searchParams.set('redirect_to', redirect);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 's256');
  url.searchParams.set('scopes', 'read:user user:email');
  return url;
}
