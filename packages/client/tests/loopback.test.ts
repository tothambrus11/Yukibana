import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loginWithLoopback, type CallbackOutcome } from '../src/loopback.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** The Auth server and the registry, faked; the browser is the test itself,
 *  visiting the loopback the way the Auth server's redirect would. */
const authServer: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.endsWith('/api/auth/config')) return json({ supabaseUrl: 'https://auth.example', publishableKey: 'pk' });
  return json({ access_token: 'at', refresh_token: 'rt', expires_at: 2000, user: { email: 'ada@uni.example' } });
};

test('the host opens the address and writes the page the browser lands on; the library only listens and trades the code', async () => {
  const pages: CallbackOutcome[] = [];
  let landed = '';
  const session = await loginWithLoopback('https://cloud.example', {
    fetch: authServer,
    callbackPage: outcome => {
      pages.push(outcome);
      return "<p>the host's own page</p>";
    },
    open: async url => {
      const back = new URL(url.searchParams.get('redirect_to') ?? '');
      assert.equal(back.hostname, '127.0.0.1');
      back.searchParams.set('code', 'abc');
      landed = await (await fetch(back)).text();
    },
  });
  assert.equal(session.accessToken, 'at');
  assert.deepEqual(pages, [{ ok: true }]);
  assert.equal(landed, "<p>the host's own page</p>", 'what the browser shows is exactly what the host wrote');
});

test("a refused login reaches the host's page with the reason, and the login fails with it", async () => {
  const pages: CallbackOutcome[] = [];
  await assert.rejects(
    loginWithLoopback('https://cloud.example', {
      fetch: authServer,
      callbackPage: outcome => {
        pages.push(outcome);
        return '';
      },
      open: async url => {
        const back = new URL(url.searchParams.get('redirect_to') ?? '');
        back.searchParams.set('error_description', 'The user denied');
        await (await fetch(back)).text();
      },
    }),
    /refused: The user denied/,
  );
  assert.deepEqual(pages, [{ ok: false, reason: 'The user denied' }]);
});

/** A registry with an OAuth client: the browser goes to its connect page,
 *  and comes back from it with a code and the CLI's state. */
const registryWithClient: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.endsWith('/api/auth/config')) return json({ supabaseUrl: 'https://auth.example', publishableKey: 'pk', oauthClientId: 'client-1' });
  return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
};

test("through the website, the browser is sent to the registry's connect page, and the code it brings back is traded for the IDE's own session", async () => {
  const session = await loginWithLoopback('https://cloud.example', {
    fetch: registryWithClient,
    callbackPage: () => '',
    open: async url => {
      assert.equal(url.origin + url.pathname, 'https://cloud.example/auth/connect');
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      assert.equal(back.hostname, '127.0.0.1');
      back.searchParams.set('code', 'abc');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      await (await fetch(back)).text();
    },
  });
  assert.deepEqual({ accessToken: session.accessToken, clientId: session.clientId }, { accessToken: 'at', clientId: 'client-1' });
});

test("a visit to the port without this login's state is answered 400 and ignored, and the login still finishes", async () => {
  const strays: number[] = [];
  const session = await loginWithLoopback('https://cloud.example', {
    fetch: registryWithClient,
    callbackPage: () => '',
    open: async url => {
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      for (const query of ['code=forged', 'code=forged&state=wrong', 'error=access_denied&state=wrong']) {
        strays.push((await fetch(`${back.toString()}?${query}`)).status);
      }
      strays.push((await fetch(new URL('/elsewhere', back))).status);
      back.searchParams.set('code', 'abc');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      await (await fetch(back)).text();
    },
  });
  assert.deepEqual(strays, [400, 400, 400, 404]);
  assert.equal(session.accessToken, 'at');
});

test("cancelling on the website ends the wait with the website's reason", async () => {
  await assert.rejects(
    loginWithLoopback('https://cloud.example', {
      fetch: registryWithClient,
      callbackPage: () => '',
      open: async url => {
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'You cancelled the login on the website.');
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        await (await fetch(back)).text();
      },
    }),
    /refused: You cancelled the login on the website\./,
  );
});
