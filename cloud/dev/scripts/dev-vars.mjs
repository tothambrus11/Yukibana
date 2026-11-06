// Writes cloud/web/.dev.vars: the local overrides for the production values
// in wrangler.jsonc, beside it, which is where wrangler looks for it. Reads the running stack for the things that vary by
// machine, and leaves an existing file alone.
//
//   node cloud/dev/scripts/dev-vars.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = new URL('../../web/.dev.vars', import.meta.url);
if (existsSync(target)) {
  console.log('.dev.vars exists; leaving it alone');
  process.exit(0);
}
const status = JSON.parse(execFileSync('npx', ['--yes', 'supabase', 'status', '-o', 'json', '--workdir', fileURLToPath(new URL('../../db', import.meta.url))], { encoding: 'utf8' }));
// The devcontainer and the stack's containers are siblings, so "localhost"
// differs: the CLI already honours SUPABASE_SERVICES_HOSTNAME in its URLs,
// and the bucket gets the same treatment.
const host = process.env.SUPABASE_SERVICES_HOSTNAME ?? '127.0.0.1';
// The OAuth client the CLI and the IDE log in through (cloud/dev/scripts/oauth-client.mjs).
// A `db reset` empties Auth's tables, so after one, delete this file and run
// this again.
const oauthClient = execFileSync(process.execPath, [fileURLToPath(new URL('./oauth-client.mjs', import.meta.url))], { encoding: 'utf8' }).trim();
const vars = [
  '# Written by `node cloud/dev/scripts/dev-vars.mjs`. Local overrides for wrangler.jsonc,',
  '# which holds production values. Delete this file to regenerate it.',
  '',
  `SUPABASE_PUBLISHABLE_KEY=${status.PUBLISHABLE_KEY ?? status.ANON_KEY}`,
  `PUBLIC_SUPABASE_URL=${status.API_URL}`,
  `SUPABASE_OAUTH_CLIENT_ID=${oauthClient}`,
  'SITE_URL=http://127.0.0.1:5173',
  '',
  '# RustFS, from cloud/dev/compose.yml.',
  `S3_ENDPOINT=http://${host}:9000`,
  'S3_PUBLIC_ENDPOINT=http://localhost:9000',
  'S3_REGION=us-east-1',
  'S3_ACCESS_KEY_ID=rustfsadmin',
  'S3_SECRET_ACCESS_KEY=rustfsadmin',
  '',
].join('\n');
writeFileSync(target, vars);
console.log(`wrote .dev.vars for ${status.API_URL}`);
