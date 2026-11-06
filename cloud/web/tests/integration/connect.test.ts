import { test, expect, beforeAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { authorizeUrl, connectCookie, type ConnectRequest } from '../../src/lib/connect.js';
import { approve, consent, nonce, returnUrlOf, start } from '../../src/lib/server/connect.js';
import { claimsOf } from '../../src/lib/claims.js';
import { sendCode, verifyCode } from '../../src/lib/server/login.js';
import { config } from './env.js';
import { codeMailedTo } from './mail.js';

// The whole of an IDE login through the website, against the real Auth
// server: everything the browser and the CLI would do, with the website's
// part done by the same functions its routes call. The routes themselves
// (the cookie, the forms) are thin over these and are not run here;
// tests/integration/sibling.test.ts sends the consent route what a page
// elsewhere could.

/** The local site_url (cloud/db/supabase/config.toml), where Auth sends the consent
 *  step and where the OAuth client's one redirect URI lives. */
const SITE = 'http://127.0.0.1:5173';
const RETURN = returnUrlOf(SITE);

const clientId = (): string => {
  if (config.oauthClientId === null) throw new Error('SUPABASE_OAUTH_CLIENT_ID is not set: run `node cloud/dev/scripts/oauth-client.mjs` against the stack and export what it prints');
  return config.oauthClientId;
};

/** A browser of its own, with the website's session in memory. */
const browser = () =>
  createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

const b64url = (b: Buffer): string => b.toString('base64url');

/** What the CLI makes before it opens the browser. */
function cliRequest(): { verifier: string; req: ConnectRequest } {
  const verifier = b64url(randomBytes(32));
  return { verifier, req: { port: 4242, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(randomBytes(16)) } };
}

/** As the CLI calls the OAuth server's token endpoint. */
async function token(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL('/auth/v1/oauth/token', config.supabaseUrl), {
    method: 'POST',
    headers: { apikey: config.supabasePublishableKey, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

type Browser = ReturnType<typeof browser>;
let site: Browser;
let userId: string;

beforeAll(async () => {
  const addr = `connect-${randomUUID()}@yukibana.local`;
  site = browser();
  const since = Date.now();
  expect(await sendCode(site.auth, addr)).toEqual({ ok: true });
  const signedIn = await verifyCode(site.auth, addr, await codeMailedTo(addr, since));
  if (!signedIn.ok) throw new Error(signedIn.message);
  userId = signedIn.userId;
});

const expected = () => ({ clientId: clientId(), returnUrl: RETURN });

/** From "Continue" to the code on the loopback address: what "Continue"
 *  asks Auth from the server, and the consent route's decision on the
 *  authorization it was given, holding the cookie "Continue" set. Returns
 *  the loopback address the browser is sent to. */
async function confirm(req: ConnectRequest, as: Browser = site): Promise<URL> {
  const n = nonce();
  const started = await start({ authorize: authorizeUrl(config.supabaseUrl, clientId(), RETURN, req, n), site: SITE, nonce: n, fetchFn: fetch });
  if ('status' in started.to) throw new Error(started.to.message);
  const at = started.to.redirect;
  expect(at.origin + at.pathname).toBe(`${SITE}/auth/connect/consent`);
  expect(started.cookie).toEqual({ name: connectCookie(n), value: at.searchParams.get('authorization_id') });
  const decided = await consent({
    authorizationId: at.searchParams.get('authorization_id'),
    signedIn: true,
    cookies: started.cookie === null ? [] : [started.cookie],
    auth: as.auth.oauth,
    expected: expected(),
  });
  expect(decided.spend).toEqual([connectCookie(n)]);
  if ('status' in decided.to) throw new Error(decided.to.message);
  return decided.to.redirect;
}

test('the person signed in on the website, once they confirm, gives the IDE a code that only its verifier can trade, for a session of its own', async () => {
  const { verifier, req } = cliRequest();
  const back = await confirm(req);
  expect(back.origin + back.pathname).toBe('http://127.0.0.1:4242/callback');
  expect(back.searchParams.get('state')).toBe(req.state);
  const code = back.searchParams.get('code') ?? '';
  expect(code).not.toBe('');

  const wrong = await token({ grant_type: 'authorization_code', code, client_id: clientId(), redirect_uri: RETURN, code_verifier: b64url(randomBytes(32)) });
  expect(wrong.status).toBe(400);

  const traded = await token({ grant_type: 'authorization_code', code, client_id: clientId(), redirect_uri: RETURN, code_verifier: verifier });
  expect(traded.status).toBe(200);
  const access = String(traded.body['access_token']);

  // A token the registry accepts as this person, like a website session's.
  const { data, error } = await browser().auth.getClaims(access);
  expect(error).toBeNull();
  expect(claimsOf(data?.claims ?? {})).toMatchObject({ sub: userId, role: 'authenticated' });

  // And the code is spent.
  const again = await token({ grant_type: 'authorization_code', code, client_id: clientId(), redirect_uri: RETURN, code_verifier: verifier });
  expect(again.status).toBe(400);
});

test("the IDE's session refreshes only by naming its client, and logging it out leaves the website signed in", async () => {
  const { verifier, req } = cliRequest();
  const code = (await confirm(req)).searchParams.get('code') ?? '';
  const traded = await token({ grant_type: 'authorization_code', code, client_id: clientId(), redirect_uri: RETURN, code_verifier: verifier });
  expect(traded.status).toBe(200);

  const plain = await fetch(new URL('/auth/v1/token?grant_type=refresh_token', config.supabaseUrl), {
    method: 'POST',
    headers: { apikey: config.supabasePublishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: traded.body['refresh_token'] }),
  });
  expect(plain.ok).toBe(false);

  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: String(traded.body['refresh_token']), client_id: clientId() });
  expect(refreshed.status).toBe(200);

  const out = await fetch(new URL('/auth/v1/logout?scope=local', config.supabaseUrl), {
    method: 'POST',
    headers: { apikey: config.supabasePublishableKey, authorization: `Bearer ${String(refreshed.body['access_token'])}` },
  });
  expect(out.ok).toBe(true);
  const dead = await token({ grant_type: 'refresh_token', refresh_token: String(refreshed.body['refresh_token']), client_id: clientId() });
  expect(dead.status).toBe(400);

  const { data, error } = await site.auth.refreshSession();
  expect(error).toBeNull();
  expect(data.session?.user.id).toBe(userId);
});

test("someone else, signed in elsewhere, cannot approve an authorization the first person's browser began", async () => {
  const { req } = cliRequest();
  const res = await fetch(authorizeUrl(config.supabaseUrl, clientId(), RETURN, req, nonce()), { redirect: 'manual' });
  const id = new URL(res.headers.get('location') ?? '').searchParams.get('authorization_id') ?? '';
  // The first to look at it binds it to themselves.
  const mine = await approve(site.auth.oauth, id, expected());
  expect(mine.ok).toBe(true);
  const other = browser();
  const addr = `connect-${randomUUID()}@yukibana.local`;
  const since = Date.now();
  await sendCode(other.auth, addr);
  const signedIn = await verifyCode(other.auth, addr, await codeMailedTo(addr, since));
  if (!signedIn.ok) throw new Error(signedIn.message);
  expect(await approve(other.auth.oauth, id, expected())).toMatchObject({ ok: false, status: 400 });
});
