# feat(cloud): client versions, GET /api/v1/meta and an emergency floor for old clients

**Labels:** `area:cloud`, `area:packages`, `area:ide`, `area:cli`, `database`, `size:L`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Second part of plan
step 8 (§8.3), without the usage counter.

## Goal

The registry knows which client is calling, an old client is told to update, and in an emergency (a security hole, a
client that corrupts submissions) an admin can refuse clients below a version without a deploy. This fixes the second
half of problem 5 of §1 (nothing detects an old client).

## Scope

- **Migration** `cloud/db/supabase/migrations/<timestamp>_client_policy.sql`, written by hand, starting with
  `lock_timeout` and `statement_timeout`, linted by squawk:
  - `public.client_policy`: one row (`id boolean primary key default true check (id)`), `min_client text`,
    `block_below text` (both null by default, each checked against `^[0-9]+\.[0-9]+\.[0-9]+$`), `updated_at`,
    `updated_by`. Row level security on; **no** grant to `anon`, `authenticated` or `yukibana_publisher`.
  - `app.client_policy()`: `security definer`, `stable`, `set search_path = ''`, returns both values; executable by
    `anon`, `authenticated` and `yukibana_publisher` (a function grant, not a table grant, so the publisher rule holds).
  - `app.set_client_policy(min_client text, block_below text)`: `security definer`, `set search_path = ''`, refuses
    anyone but an admin (`app.is_admin()`, `42501`), validates both, writes, and calls
    `app.audit('set_client_policy', ...)` with the old and new values, in the same transaction.
- **pgTAP** `cloud/db/supabase/tests/client_policy.test.sql`, written as negatives: a student, an assistant, a teacher
  and `anon` cannot call `app.set_client_policy`; nobody can select, insert, update or delete `client_policy`
  directly; `yukibana_publisher` cannot read the table; an invalid version is refused; an admin's change leaves exactly
  one `audit_log` row naming them; `anon` can call `app.client_policy()`.
- **`packages/api`**: the `Yukibana-Client` header name and format (`ide/1.4.0`, `cli/1.4.0`), and `GET /api/v1/meta`
  returning `{ minClient: string | null, blockBelow: string | null }`.
- **Worker**:
  - `cloud/web/src/lib/server/db.ts`: an `asAnon(sql, run)` beside `asUser` and `asPublisher`, which becomes `anon` for
    one transaction, because the floor must be read before anyone is authenticated. The guide's rule ("every query
    runs inside `asUser` or `asPublisher`") gains it (issue 01's text, or this PR if 01 has merged).
  - A pure module (`cloud/web/src/lib/client-version.ts`) parses the header and compares versions; `0.0.0-dev` is
    never blocked or advised; a request without the header (a browser, curl) is not a client and is never blocked.
  - `hooks.server.ts`: an `/api/` request whose header is below `blockBelow` is answered `426` with a sentence for the
    person ("This version of the Yukibana IDE can no longer be used. Install the newest from ..."), before anything else
    runs. The policy is read through `app.client_policy()` and cached in the isolate for a short time (see open
    questions).
  - `cloud/web/src/routes/api/v1/meta/+server.ts`: public, no credentials, short cache.
  - Admin page (`cloud/web/src/routes/admin/+page.server.ts`, `+page.svelte`): shows both values and a
    `setClientPolicy` form action that calls `app.set_client_policy` through `asUser`. It is a cookie-authenticated
    form, so the forgery rules apply as to `setRole`.
- **Client** (`packages/client/src/client.ts`, `session.ts`): `ClientOptions` gains a required
  `client: { name: 'ide' | 'cli'; version: string }`, sent as `Yukibana-Client` on every request to the registry's
  origin (login, refresh, `auth/config`, API calls, downloads), never to the bucket a download redirects to. A `426`
  becomes a `RegistryError` with that status and the server's sentence. `meta()` reads `/api/v1/meta`. A pure
  `adviceFor(meta, version)` returns `ok`, `update-advised` or `blocked`, tested as a table.
- **CLI**: its version comes from its own `package.json` (a JSON import, which tsdown inlines in issue 10; `0.0.0-dev`
  in the workspace). New `yukibana --version`. When `minClient` is above the version, a warning on stderr with
  `npm i -g @yukibana/cli@latest`.
- **IDE**: the backend's `YukibanaClient` (`ide/extensions/yukibana-cloud/src/node/cloud-client.ts`) gets the app's
  version (Electron's `app.getVersion()` passed from the main process, or Theia's application info in the browser
  app). Below `minClient`, a status-bar item "A newer Yukibana IDE is available" opens the download page; on macOS
  always the download page. Issue 11 turns it into "Restart to update" when an update is downloaded.
- Docs: `docs/cloud/deploy.md` says how to set `blockBelow` in an emergency and how to clear it.

## Out of scope

- A per-client usage counter (dropped from §8.3 after the plan).
- The updater (issue 11) and the CLI's daily "newer version available" line from npm (issue 10, §12).

## Design decisions already made

- Every request sends `Yukibana-Client`; the host injects its version, because `@yukibana/client` stays `0.0.0-dev`
  (§8.3).
- `minClient` and `blockBelow` live in a database row edited on the admin page, because an emergency cannot wait for a
  PR and a deploy; `GET /api/v1/meta` returns them (§8.3).
- `minClient` is advice; `blockBelow` answers `426` with a sentence, is normally unset, and setting it is audited
  (§8.3). Dev builds ignore both.
- The cloud's rules: the database changes only through a migration; writes are `security definer` functions that check
  the caller and audit; every rule has a pgTAP negative; the Worker never re-decides (`cloud/CLAUDE.md`).
- No per-client counter (decision after the plan).

## Open questions

- How long the Worker caches the policy. A DB round trip on every request costs latency; a cache means an emergency
  floor takes effect after the TTL. Proposal: 60 seconds per isolate.
- Store versions as checked text and compare in TypeScript, or as an integer triple compared in SQL? Proposal: text,
  since only the Worker compares.

## Acceptance criteria

- [ ] `pnpm --filter @yukibana/cloud-db lint` (squawk) passes; the migration bounds both timeouts.
- [ ] The pgTAP negatives above pass after `reset` from empty.
- [ ] Integration: with `blockBelow = 1.0.0`, a request with `cli/0.9.0` to `GET /api/v1/me`, to a submission and to a
      token publish is a `426` with the sentence and `tests.fingerprint()` is unchanged; `cli/1.0.0`, `0.0.0-dev` and a
      request without the header pass; `GET /api/v1/meta` returns the row.
- [ ] Integration: the admin form changes the row and writes one audit row; `sibling.test.ts` shows a page on a sibling
      subdomain cannot change it.
- [ ] Unit tests: header parsing (valid, missing, malformed, dev), `adviceFor` as a table, the client sends the header
      on every registry request and not to the bucket.
- [ ] `yukibana --version` prints the package's version.
- [ ] Every new exported function, type and field has a contract comment in the project's style; the migration
      explains why in `--` comments.

## Depends on / Blocks

- Depends on: 07.
- Blocks: 10 (`--version` and the version source), 11 (the status-bar path).

## Manual steps for a maintainer

- None for the deploy: `deploy-cloud.yml` runs the migration, then the Worker.
- In an emergency only: set `blockBelow` on the admin page, and clear it afterwards. The admin page is a browser page
  without the header, so a wrong floor never locks the admin out.

## Risks

- A wrong `blockBelow` refuses every client at once; the admin page stays usable to undo it.
- Reading the policy on every API request adds load; the cache bounds it.
