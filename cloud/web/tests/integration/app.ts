/** The app itself, served over HTTP the way `npm run dev` serves it, for a
 *  suite that must go through everything a browser's request goes through:
 *  the hook, the routing, the cookies, and the routes' own code, against
 *  the local stack.
 *
 *  The configuration comes from `config` (tests/integration/env.ts), handed
 *  to the Worker's emulation as process environment. A `.dev.vars` in
 *  cloud/web wins over it, as it does for `npm run dev`: wrangler then
 *  reads that file and not the environment. `node cloud/dev/scripts/dev-vars.mjs` writes one
 *  for the same local stack, so either way the app talks to it.
 *
 *  `vite dev` turns SvelteKit's own origin check off, which is why a suite
 *  that shows a forged request is refused must run here: what refuses it is
 *  then this app's rule (#lib/server/forgery), not the framework's.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { config } from './env.js';

export interface App {
  /** Where the app answers, `http://127.0.0.1:<port>`, with no trailing slash. */
  readonly origin: string;
  /** Stops the server. Safe to call twice. */
  stop(): Promise<void>;
}

/** A TCP port nobody listens on at the moment of asking. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Starts the app and waits until it answers a page, at most `timeoutMs`.
 *  A server that exits or never answers fails with its own output, so the
 *  reason is in the test log rather than "fetch failed". */
export async function startApp(timeoutMs = 90_000): Promise<App> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const appDir = fileURLToPath(new URL('../..', import.meta.url));
  const vite = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: config.databaseUrl,
    PUBLIC_SUPABASE_URL: config.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,
    SITE_URL: origin,
    S3_ENDPOINT: config.s3.endpoint,
    S3_PUBLIC_ENDPOINT: config.s3.publicEndpoint,
    S3_BUCKET: config.s3.bucket,
    S3_REGION: config.s3.region,
    S3_ACCESS_KEY_ID: config.s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: config.s3.secretAccessKey,
  };
  if (config.oauthClientId !== null) env['SUPABASE_OAUTH_CLIENT_ID'] = config.oauthClientId;
  const child = spawn(process.execPath, [vite, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  let exited: number | null | undefined;
  const gone = new Promise<void>(resolve => child.once('exit', code => ((exited = code), resolve())));

  const stop = async (): Promise<void> => {
    if (exited === undefined) {
      child.kill('SIGTERM');
      await gone;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`the app exited (${String(exited)}) before it answered:\n${output}`);
    const answered = await fetch(`${origin}/auth/login`).then(
      r => r.status,
      () => null,
    );
    if (answered === 200) return { origin, stop };
    await new Promise(r => setTimeout(r, 250));
  }
  await stop();
  throw new Error(`the app did not answer ${origin}/auth/login within ${timeoutMs} ms:\n${output}`);
}
