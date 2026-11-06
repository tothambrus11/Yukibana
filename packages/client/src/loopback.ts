/** A login through a browser, coming back to this machine.
 *
 *  For a host whose backend runs where the browser does: the terminal, a
 *  desktop IDE. It listens on 127.0.0.1 on a port the system picks, hands
 *  the host the address to open, and waits for the browser to come back to
 *  `/callback`. The address is the registry's `/auth/connect`, where the
 *  person logs in to the website and confirms which account (see
 *  `session.ts`); from a registry without an OAuth client, it is GitHub's
 *  sign-in through the Auth server. An IDE served from another machine cannot use this (the
 *  browser's 127.0.0.1 is not the server's) and drives `startLogin` with a
 *  redirect of its own instead.
 *
 *  The library owns nothing a person sees. How the address is opened (the
 *  system browser, a webview, a printed link) and what page the browser
 *  shows when it lands are both the host's: `open` and `callbackPage`.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startLogin, type Session } from './session.js';

/** How the browser's visit ended, for the host's page to say. */
export type CallbackOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface LoopbackOptions {
  /** Shows the person the sign-in address: opens a browser, prints it, or
   *  both. Called once, before waiting. */
  readonly open: (url: URL) => void | Promise<void>;
  /** The HTML the browser receives at the callback, which is the last thing
   *  the person sees there. Its result is sent as it is, so it is the
   *  host's to escape `reason` (the Auth server's words, from the URL). */
  readonly callbackPage: (outcome: CallbackOutcome) => string;
  /** How long to wait for the browser, in milliseconds. Ten minutes: long
   *  enough to log in to the website first, an emailed code included. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Logs in to the registry at `registry` and returns the session. Nothing is
 *  stored: the caller saves it where it keeps sessions. */
export async function loginWithLoopback(registry: string, options: LoopbackOptions): Promise<Session> {
  let deliver!: (url: URL) => void;
  const arrived = new Promise<URL>(resolve => {
    deliver = resolve;
  });
  // What the browser must bring back; until the login has started, nothing
  // is expected, and nothing is accepted.
  let expected: string | null | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    // Anything on this machine can knock on the port: a visit without this
    // login's state is answered and ignored, and the wait goes on.
    if (expected === undefined || (expected !== null && url.searchParams.get('state') !== expected)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('This is not the login this listener is waiting for.');
      return;
    }
    const failed = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(options.callbackPage(failed === null ? { ok: true } : { ok: false, reason: failed }));
    deliver(url);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  let timer: NodeJS.Timeout | undefined;
  try {
    const pending = await startLogin(registry, `http://127.0.0.1:${port}/callback`, options.fetch ?? fetch);
    expected = pending.state;
    await options.open(pending.authorizeUrl);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('no answer from the browser within the time allowed; try again')), options.timeoutMs ?? 10 * 60_000);
    });
    return await pending.finish(await Promise.race([arrived, timeout]));
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
