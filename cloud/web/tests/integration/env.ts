/** The local stack the integration suite runs against. Every value has the
 *  local default from wrangler.jsonc and cloud/dev/compose.yml; set them to point
 *  elsewhere. `tests.uid` mirrors the seed's helper of the same name, so a
 *  test can be the seeded people. */
import { createHash } from 'node:crypto';
import type { Claims } from '../../src/lib/claims.js';
import type { UserId } from '../../src/lib/ids.js';
import type { Config } from '../../src/lib/server/env.js';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
// In the devcontainer the stack is on the host, not on this machine's localhost.
const host = process.env['SUPABASE_SERVICES_HOSTNAME'] ?? '127.0.0.1';

export const config: Config = {
  databaseUrl: env('DATABASE_URL', `postgres://yukibana_app:yukibana@${host}:54322/postgres`),
  supabaseUrl: env('PUBLIC_SUPABASE_URL', `http://${host}:54321`),
  // The key every local stack has unless told otherwise; CI passes what
  // `supabase status` reports, in case a CLI release changes it.
  supabasePublishableKey: env('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'),
  // Registered on the stack by `node cloud/dev/scripts/oauth-client.mjs`, which CI
  // runs before this suite; the connect tests say so when it is missing.
  oauthClientId: process.env['SUPABASE_OAUTH_CLIENT_ID'] ?? null,
  siteUrl: null,
  s3: {
    endpoint: env('S3_ENDPOINT', `http://${host}:9000`),
    publicEndpoint: env('S3_PUBLIC_ENDPOINT', `http://${host}:9000`),
    bucket: env('S3_BUCKET', 'yukibana-cloud'),
    region: env('S3_REGION', 'us-east-1'),
    accessKeyId: env('S3_ACCESS_KEY_ID', 'rustfsadmin'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY', 'rustfsadmin'),
  },
  submissionMaxBytes: 1024 * 1024,
  releaseMaxBytes: 1024 * 1024,
};

/** The local stack's mail catcher (`[local_smtp]` in cloud/db/supabase/config.toml),
 *  where the login codes land. Mailpit, read over its HTTP API. */
export const mailUrl = env('MAIL_URL', `http://${host}:54324`);

/** The id `tests.create_user(addr)` gave this address in the seed. */
export function uid(addr: string): UserId {
  const h = createHash('md5').update(`tests.user:${addr.toLowerCase()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as UserId;
}

export const claimsOf = (addr: string): Claims => ({ sub: uid(addr), role: 'authenticated', email: addr });

export const TEACHER = 'teacher@yukibana.local';
export const ALICE = 'alice@yukibana.local';
export const BOB = 'bob@yukibana.local';
export const ASSISTANT = 'ta@yukibana.local';
