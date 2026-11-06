/** Logging in and out from a terminal, and asking who you are. */

import { loginWithLoopback, logout } from '@yukibana/client';
import { callbackPage, openInBrowser } from './browser.js';
import { clientFor, registryUrl, type Invocation } from './common.js';

export async function login(inv: Invocation): Promise<void> {
  const url = await registryUrl(inv);
  const session = await loginWithLoopback(url, { open: openInBrowser, callbackPage });
  await inv.store.save(session);
  const me = await clientFor(inv).then(c => c.me());
  console.log(`logged in to ${session.url} as ${me.fullName ?? me.githubLogin ?? me.email ?? me.userId}${me.platformRole === 'user' ? '' : ` (${me.platformRole})`}`);
}

export async function logoutCommand(inv: Invocation): Promise<void> {
  const { revoked, why } = await logout(inv.store);
  console.log(revoked ? 'logged out' : `logged out here; the session was not ended at the server (${why ?? 'no reason given'}), so it lasts until it expires`);
}

export async function whoami(inv: Invocation): Promise<void> {
  const me = await (await clientFor(inv)).me();
  if (inv.options.json === true) {
    console.log(JSON.stringify(me, null, 2));
    return;
  }
  console.log(`${me.fullName ?? '(no name)'}${me.githubLogin === null ? '' : ` @${me.githubLogin}`}${me.email === null ? '' : ` <${me.email}>`}`);
  console.log(`platform role: ${me.platformRole}; user id ${me.userId}`);
}
