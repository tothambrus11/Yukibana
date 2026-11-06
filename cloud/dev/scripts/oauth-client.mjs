// Registers the registry's OAuth client on Supabase Auth, once per
// environment, and prints its id: the value of SUPABASE_OAUTH_CLIENT_ID.
// Through it the CLI and the IDE log in by way of the website
// (/auth/connect, cloud/web/src/lib/connect.ts). Idempotent: a client with this
// name and this redirect URI already there is reused, not duplicated.
//
//   node cloud/dev/scripts/oauth-client.mjs                      the local stack
//   node cloud/dev/scripts/oauth-client.mjs <auth url> <site>    another one; the
//       secret key is read from SUPABASE_SECRET_KEY, never an argument
//
// The client is public (no secret: a CLI cannot keep one), may use the
// authorization code and refresh token grants, and has exactly one
// redirect URI, the site's /auth/connect/return. Auth matches it exactly.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NAME = 'Yukibana IDE and CLI';

let [authUrl, site] = process.argv.slice(2);
let key = process.env.SUPABASE_SECRET_KEY;
if (authUrl === undefined) {
  const status = JSON.parse(execFileSync('npx', ['--yes', 'supabase', 'status', '-o', 'json', '--workdir', fileURLToPath(new URL('../../db', import.meta.url))], { encoding: 'utf8', shell: process.platform === 'win32' }));
  authUrl = status.API_URL;
  key ??= status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  // The local site_url in cloud/db/supabase/config.toml, where `npm run dev` serves.
  site ??= 'http://127.0.0.1:5173';
}
if (site === undefined || key === undefined || key === '') {
  console.error('usage: SUPABASE_SECRET_KEY=... node cloud/dev/scripts/oauth-client.mjs <auth url> <site url>');
  process.exit(2);
}

const redirect = `${new URL(site).origin}/auth/connect/return`;
const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const endpoint = new URL('/auth/v1/admin/oauth/clients', authUrl);

async function call(method, body) {
  const res = await fetch(endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${method} ${endpoint} answered ${res.status}: ${text}`);
    console.error('Is [auth.oauth_server] enabled in cloud/db/supabase/config.toml, and the stack restarted since?');
    process.exit(1);
  }
  return JSON.parse(text);
}

// Auth (v2.197) answers the whole list in one response; were it ever to
// page, a missing client would be registered twice, so follow any `page`
// it offers rather than assume.
const clients = [];
for (let page = 1; page < 100; page++) {
  const url = new URL(endpoint);
  if (page > 1) url.searchParams.set('page', String(page));
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`GET ${url} answered ${res.status}: ${await res.text()}`);
    console.error('Is [auth.oauth_server] enabled in cloud/db/supabase/config.toml, and the stack restarted since?');
    process.exit(1);
  }
  const body = await res.json();
  clients.push(...(body.clients ?? []));
  const more = res.headers.get('link')?.includes('rel="next"') ?? false;
  if (!more) break;
}
const existing = clients.find(c => c.client_name === NAME && (c.redirect_uris ?? []).includes(redirect));
if (existing !== undefined) {
  // Reused only as it was meant: public, no secret, the two grants, the one URI.
  const grants = [...(existing.grant_types ?? [])].sort().join(',');
  const problems = [
    existing.client_type !== 'public' && `it is ${existing.client_type}, not public`,
    grants !== 'authorization_code,refresh_token' && `its grants are ${grants}`,
    (existing.redirect_uris ?? []).length !== 1 && `it has ${existing.redirect_uris.length} redirect URIs`,
  ].filter(Boolean);
  if (problems.length > 0) {
    console.error(`"${NAME}" (${existing.client_id}) exists but ${problems.join('; ')}. Fix or delete it in the dashboard, then run this again.`);
    process.exit(1);
  }
}
const client =
  existing ??
  (await call('POST', {
    client_name: NAME,
    client_type: 'public',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: [redirect],
  }));
console.error(`${existing === undefined ? 'registered' : 'found'} "${NAME}" for ${redirect}`);
console.log(client.client_id);
