import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { consent, returnUrlOf, siteOrigin } from '#lib/server/connect.ts';
import { workerConfig } from '#lib/server/worker.ts';

/** "Continue" sends the browser here (Auth's `authorization_url_path` in
 *  cloud/db/supabase/config.toml) with the authorization it made. What happens is
 *  `consent`'s decision (#lib/server/connect): approve for whoever is
 *  signed in, and only the authorization this browser's connect cookie
 *  names, then straight to the loopback with the code. A GET because that
 *  is the shape Auth gives the route; a request with any other id, which
 *  is all a page elsewhere can send, is refused before Auth is asked and
 *  changes nothing. */
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  const config = workerConfig();
  if (config.oauthClientId === null) error(503, 'This registry does not offer logging in from an IDE through the website yet.');
  const decided = await consent({
    authorizationId: url.searchParams.get('authorization_id'),
    signedIn: locals.claims !== null,
    cookies: cookies.getAll().map(c => ({ name: c.name, value: c.value })),
    auth: locals.supabase.auth.oauth,
    expected: { clientId: config.oauthClientId, returnUrl: returnUrlOf(siteOrigin(config.siteUrl, url)) },
  });
  for (const name of decided.spend) cookies.delete(name, { path: '/' });
  if ('status' in decided.to) error(decided.to.status, decided.to.message);
  redirect(303, decided.to.redirect.toString(), { external: [decided.to.redirect.origin] });
};
