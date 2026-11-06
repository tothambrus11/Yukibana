# Integrating Yukibana into Theia, or any frontend

What a student's IDE needs from Yukibana is four things: who the student is,
which exercises are open to them, what a submission from their folder would
hold, and a way to send it. All four are in `@yukibana/client`
(`packages/client/src/library.ts`), whose dependencies are `modern-tar`, `ignore` and `zod` (none
with dependencies of its own), and which runs wherever Node 22.15
or later does: a Theia backend, an Electron main process, a VS Code
extension host. `ide/extensions/yukibana-cloud` is the IDE's client built on
it; read it next to this page.

## What the library is, and is not

The library is headless. It owns the protocol (login, refresh, the API), the
data (the registry's answers, decoded and checked), the disk (reading a
folder into a bundle, unpacking a starter safely) and the network, and
nothing a person sees. Opening a browser, the page the browser shows after a
login, every list, button and sentence on a screen: those belong to the host.
Where a person must see something, the library takes a callback (`open`,
`callbackPage`) or returns data for the host to render (`bundle.files`,
`bundle.problems`, `RegistryError.status`). The CLI's choices are in
`packages/cli/src/commands/`, the IDE's in its extensions; neither is exported.

## The split

```
 frontend (browser / renderer)          backend (Node)                       registry
 ────────────────────────────          ─────────────────────────────         ──────────────────
 exercise list, preview, buttons  ⇄    YukibanaClient, SessionStore,    ⇄    /api/... as the student
 never sees a token or the disk         SubmissionBundle, login              (policies decide)
```

The frontend is a web page and is treated as one. The session, the client
and every bundle live in the backend; the frontend asks for lists and
verdicts over whatever RPC the host has (Theia's JSON-RPC service, Electron's
IPC). In Theia that is a backend contribution exposing a service, and a
frontend widget calling it: the IDE's is `CloudService` in
`ide/extensions/yukibana-cloud/src/common/cloud-protocol.ts`.

## Logging in

A login is three steps so the host decides how the browser is shown and where
it comes back:

```ts
import { startLogin, loginWithLoopback } from '@yukibana/client';

// Desktop (Electron Theia): back to a listener on 127.0.0.1 on a free port.
// The host opens the address and writes the page the browser lands on.
const session = await loginWithLoopback(registry, {
  open: (url) => openExternal(url),
  callbackPage: (outcome) => outcome.ok ? signedInPage() : failedPage(escapeHtml(outcome.reason)),
});

// Browser Theia, served from elsewhere: back to a route the Theia server owns.
const pending = await startLogin(registry, 'https://ide.example.org/yukibana/callback');
openInNewTab(pending.authorizeUrl);
// …the route receives the browser and hands its URL to the backend:
const session2 = await pending.finish(callbackUrl);
```

With the loopback, the browser goes to the registry's own page,
`/auth/connect`. The person logs in to the website there if they are not
already (GitHub, or a code mailed to them), sees whom they are signed in as,
and chooses: **Continue as** that account, **Use a different account** (which
logs the website out in that browser and back to the login), or **Cancel**.
Nothing reaches the loopback before they choose. Then Supabase Auth's OAuth
2.1 server issues a code for the registry's OAuth client, the page hands it
to the loopback, and the library trades it with the PKCE verifier, which
never leaves the backend, for a session of the IDE's own: not the website's
cookie session, so logging out of one leaves the other signed in. The
listener ignores (with a 400) any visit that does not carry this login's
state, and waits up to ten minutes, enough for an emailed code. The page
shows four characters of the state; `loginCode(pending.authorizeUrl)` gives
the same, for the IDE to show beside its "waiting for the browser".
`Session.clientId` names the client; keep it with the rest of the session,
because a refresh needs it. Nothing about the login is remembered on the
loopback, and every login asks again.

A registry without an OAuth client (`/api/auth/config` says
`oauthClientId: null`) and a redirect that is not the loopback (browser
Theia's own route) log in the older way: OAuth with PKCE straight to GitHub
through the Auth server. That redirect must be on the Auth server's allow
list (`cloud/db/supabase/config.toml`, `additional_redirect_urls`, local and
production); a browser Theia's callback address has to be added there, and
reaches production with the next deploy (`supabase config push`).

`logout(store)` ends only this session (`scope=local`): the website and the
person's other machines stay signed in. It renews an expired session first,
so it has a live token to end it with; when the server did not end it,
`revoked` is false and `why` says why, for the IDE to tell the person.

If the IDE already has a Supabase session for the same project (one login for
the IDE and Yukibana), skip all of this: hand its access token to the client.

## Keeping the session

```ts
import { tokenProvider, YukibanaClient, type SessionStore } from '@yukibana/client';

const store: SessionStore = {
  load: async () => JSON.parse((await secrets.get('yukibana.session')) ?? 'null'),
  save: async (s) => secrets.set('yukibana.session', JSON.stringify(s)),
  clear: async () => secrets.delete('yukibana.session'),
};
await store.save(session);
const client = new YukibanaClient({ url: registry, accessToken: tokenProvider(store) });
```

The session holds a refresh token: store it where the host keeps secrets
(Theia's or VS Code's secret storage, as the IDE's
`ide/extensions/yukibana-cloud/src/node/cloud-session-manager.ts` does, or
Electron's `safeStorage`), never in plain settings.
`tokenProvider` refreshes an hour-long access token before it expires and
saves the rotated pair; it never runs two refreshes at once, because the
second would find the refresh token spent. When it cannot refresh it throws
`NotLoggedIn`: show the login again.

`accessToken` is just a function returning a token, so any source works.

## The exercise list

```ts
const projects = await client.projects();
```

For a student the registry returns only the projects of editions they are
enrolled in as a student whose window is open now: `availableAfter` has
passed and `closesAt` has not. The database's policies decide that; the IDE
filters nothing and cannot widen it. Each project says:

* `deadline`: when it is due. After it, `late` is true, and a submission
  is still accepted and recorded as late;
* `closesAt`: when it disappears and stops accepting work (null: never);
* `canSubmit`, `starterReady`, `mySubmissions`, `myLastSubmittedAt`.

`client.submissions(projectId)` lists the student's own submissions, newest
first; `latest` marks the one that counts and `late` the ones after the
deadline. Lateness is computed from the server-stamped `submittedAt` against
the deadline as it is now, so an extension granted later applies to work
already handed in. A student still reads their own submissions after a
project closes.

How to word any of this is the host's; the IDE's choices are in its
extensions, not part of the library.

## The workspace

`@yukibana/client/config` is the part that runs in a browser: `parseSettings`
reads a folder's `yukibana.json` with the defaults the IDE needs (a file
without `version` or `kind` is fine, so any folder opens), and
`DEFAULT_SETTINGS` is what a folder without one gets. It is the same
schema `parseConfig` checks a release with, so the IDE and the CLI read
every field the same way.

`client.downloadStarter(projectId)` returns the starter archive, and
`unpackStarter(archive, folder)` unpacks it into `folder`, which must be
missing or empty. The host names that folder: the project's slug, or what
the student typed. A starter is one folder; its contents go into `folder`
and its name is ignored. Nothing is written outside `folder`, no link
points out of it, and an unpack that fails leaves nothing behind.

The starter carries a `yukibana.json`
with the IDE's settings (`features`, `layout`, `openFiles`, `readOnly`) and
the `projectId`, so the workspace knows where it submits to. `readOnly` is a
list of globs: `matcher(config.readOnly)` from the library answers "is this
path read-only?" with the same rules the assembly uses. Read-only is a
courtesy in the editor; the teacher's assembly is what enforces it, and it
reports every change.

## Submitting: prepare, preview, send

```ts
import { createSubmissionBundle } from '@yukibana/client';

const made = await createSubmissionBundle(workspaceRoot);
if (!made.ok) return showProblems(made.problems);    // no or broken yukibana.json
const b = made.bundle;
b.files;        // [{ path, type, size, mode }]: exactly what the archive will hold
b.skipped;      // left out: .git, .theia, build output, submission.exclude
b.problems;     // reasons not to send (too large, a symlink out of the folder)
b.read(path);   // the exact bytes that will be sent, for a preview pane
b.projectId;    // from the folder's yukibana.json

if (b.problems.length === 0 && await confirm(`Send ${b.files.length} files?`)) {
  const accepted = await client.submit(b);           // { submissionId, byteSize, sha256 }
}
```

Nothing is compressed until `submit` (or `archive()`), so a preview of a big
folder costs one read of it. The bundle is a snapshot: files saved after it
was made are not in it, so make a new one when the student comes back to
the preview. Packing is the same function `yukibana submit` uses, which is
the point: the IDE and the terminal cannot disagree about what a submission
holds, and the assembly on the teacher's side sees the same files.

Whether to offer the send button is the host's decision from that data, for
example when there are no problems, the folder names a project, and that
project is open to the student now.

## Errors

A refusal is a `RegistryError` with the HTTP `status` and the registry's own
sentence, written to be shown: 401 log in again, 403 not allowed now (the
window has closed, not enrolled), 404 not found or not visible, 413 too
large. `NotLoggedIn` means the session is gone.

## Checklist for the Theia extension

1. A backend contribution that owns a `YukibanaClient`, a `SessionStore` over
   Theia's secret storage, and the bundles; a frontend service interface
   like the IDE's `CloudService`.
2. Login: `loginWithLoopback` in Electron Theia; `startLogin` with a backend
   route as the redirect in browser Theia, and that route's address added to
   `cloud/db/supabase/config.toml`.
3. An exercise view over `client.projects()`, a starter download into a new
   workspace, and a submissions view over `client.submissions()`.
4. A submit command: make the bundle, show the file list with a preview of
   any file, show the problems and the late warning, send on confirmation.
5. Apply `yukibana.json`'s `features`, `layout`, `openFiles` and `readOnly`
   when the workspace opens; they are read by the fork, not by the library.
