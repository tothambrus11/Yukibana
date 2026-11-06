import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { execSync } from 'node:child_process';
import type { UserConfig } from 'vite';

/** The commit this build is, for `version` in `$app/env`, which every
 *  incident report names (#lib/incident): Cloudflare's build says it in
 *  WORKERS_CI_COMMIT_SHA, a checkout in git. Without either, SvelteKit's
 *  default, the build's time, still tells one deploy from another. */
function commit(): string | undefined {
  const fromCi = process.env['WORKERS_CI_COMMIT_SHA'];
  if (fromCi !== undefined && fromCi !== '') return fromCi.slice(0, 12);
  try {
    return (
      execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}
const name = commit();

/** One Worker serves the pages and the API. In development the adapter
 *  emulates the Worker's bindings (Hyperdrive, vars, secrets from .dev.vars)
 *  from wrangler.jsonc behind `cloudflare:workers`, so the env is the same
 *  shape on a laptop as in production. SvelteKit 3 takes its configuration
 *  here, in the plugin; there is no svelte.config.js. */
export default {
  plugins: [
    sveltekit({
      ...(name === undefined ? {} : { version: { name } }),
      adapter: adapter({
        // The Worker's configuration, beside this file, which `wrangler
        // deploy` reads too. Development reads the same file.
        platformProxy: { configPath: './wrangler.jsonc', persist: true },
      }),
    }),
  ],
} satisfies UserConfig;
