# Deploying Yukibana Cloud

One Supabase project (Postgres and Auth), one Cloudflare Worker, one R2
bucket. Everything below fits the free tier of both, with one caveat: R2 asks
for a payment method before it will turn on, even though the 10 GB allowance
is genuinely free.

This page has two halves. The first is how a change reaches production once
an environment exists; the second, from step 1, is setting one up.
`architecture.md` says what the pieces are and how they connect.

## The pipeline

After the first setup, deploying is `git push` to `main`. Four things
listen to the repository:

```
 push / pull request ──▶ CI (ci.yml, ci-devcontainer.yml)
                           │ success on main
                           ▼
                         Database (database.yml)
                           placeholders → secrets → migration list → db push
                           → ops/bootstrap.sql → config diff → config push

 push to main ─────────▶ Cloudflare Workers Builds
                           npm run build → npx wrangler deploy
 push to another branch ▶ Cloudflare Workers Builds
                           npm run build → a preview version, not deployed

 03:17 UTC daily ──────▶ Drift (drift.yml)
                           production vs migrations, Realtime policies
```

| | Triggered by | Does | Needs |
| --- | --- | --- | --- |
| **CI** | every push and pull request, any branch | `npm run check`, the app and CLI builds, `yukibana check` over the fixture; then the real stack on the runner: squawk, every migration from empty, pgTAP, the Realtime policy check, the integration suite; and, separately, the devcontainer build | nothing secret |
| **Database** | CI finishing successfully on `main` (`workflow_run`), or by hand | checks no placeholder is left, checks every secret is set, lists then applies pending migrations, runs `ops/bootstrap.sql`, prints the settings diff, pushes `supabase/config.toml`'s production block. One run at a time (`concurrency: deploy`). | the repository secrets in step 5 |
| **Workers Builds** | every push to any branch, from Cloudflare's own connection to the repository | `npm run build` (installs and builds `app/`); on `main`, `npx wrangler deploy` with `wrangler.jsonc`; on any other branch, a preview version with its own URL, which the bot links on the pull request | the Worker secrets in step 4, set once |
| **Drift** | nightly, or by hand | `supabase db diff` of production against the migrations for `public` and `app`, and `ops/realtime-policies.sql` | `SUPABASE_DB_URL` only |

Two consequences are worth knowing before the first change:

* **The database waits for CI; the Worker does not.** Workers Builds is
  Cloudflare's, not a GitHub workflow, so it deploys every push to `main`
  whether CI passes or not. Keep `main` green by merging pull requests whose
  CI passed, not by relying on the deploy to stop.
* **A preview is production with other code.** A branch's preview URL runs
  the branch's Worker with production's bindings and secrets: the same
  database, the same bucket, the same accounts. Log in there only to look,
  and remember that the production schema is what it sees, so a preview of
  code that needs an unapplied migration will fail where it reads it.
* **Neither half knows about the other**, so nothing orders them. What keeps
  the site up is the rule that migrations only ever add: an old Worker
  against a new schema is fine. The other direction is not.

## Shipping a change

**Code only** (pages, API, anything under `app/`). Merge to `main`. Workers
Builds deploys it; the Database workflow runs and finds
nothing to apply.

**A migration only** (a policy, a function, a new column nobody reads yet).
`npx supabase migration new <name>`, write it by hand, add its pgTAP
negatives, `npm run db:lint`, `npm run db:reset`, `npm run db:test`. Merge;
the Database workflow applies it after CI passes, and the "Migrations
pending" step in its log is the record of which files ran.

**Both: code that needs a new migration.** Two pushes. The migration first;
wait for the Database run to go green; then the code that uses it. In one
push, Workers Builds would usually win the race and serve code that reads a
column that does not exist yet.

**A Supabase setting** (`supabase/config.toml`'s production block). Merge;
the Database workflow pushes it after CI passes, and prints the before and
after. When code needs the setting, the setting goes first and the code reads
it only once it is live, the same as a migration. Turning on the IDE's login
(step 7) is this case.

**Removing something.** The other way round, and also two pushes: first
stop reading it and deploy, then drop it in a later migration. An old
Worker still running against a dropped column is the failure this avoids.

**Supabase settings** (auth providers, redirect URLs, mail, rate limits).
Edit `[remotes.production]` in `supabase/config.toml` and merge. The
"Supabase settings, before" step prints what the push will change; the
dashboard stays read-only.

**Worker configuration.** A non-secret value is `vars` in `wrangler.jsonc`
and ships with the next build. A secret is `npx wrangler secret put <NAME>`
from a checkout, which takes effect at once and needs no deploy.

**By hand.** The Database workflow has a "Run workflow" button
(`workflow_dispatch`); it applies `main`'s migrations and settings without
waiting for a push. A Worker build can be retried from the Cloudflare
dashboard, or deployed from a checkout with `npm run build && npm run
deploy` after `npx wrangler login`.

## Rolling back

**The Worker.** Cloudflare keeps previous versions: the Worker's
Deployments tab in the dashboard, or `npx wrangler rollback`, puts one back
in seconds. Because migrations only add, the older Worker works against the
newer schema. Then revert the commit on `main`, or the next push redeploys
what was rolled back.

**The database.** There are no down migrations. A migration that went out
wrong is corrected by a new migration that undoes or repairs it, reviewed
and pushed like any other. Never edit a migration that has run, and never
fix production by hand: the next drift run would fail, and the ledger would
no longer describe the database.

**Settings.** Revert the change to `supabase/config.toml` and let the
workflow push it again.

## Setting up an environment

Once per environment, in this order. Production already exists; this is
for a new one, or for finding out how the existing one was made.

## 1. Supabase

From the project dashboard, collect four things.

| What | Where |
| --- | --- |
| Project ref | The first label of the API URL, `https://<ref>.supabase.co` |
| Publishable (anon) key | Settings → API |
| **Session pooler** connection string | Connect → Session pooler, port 5432 |
| **Direct** connection string | Connect → Direct connection, port 5432 |

Both connection strings, and which goes where, matter:

* the **session pooler** string is what GitHub Actions uses. A direct
  connection resolves to IPv6 only, and GitHub's runners have no IPv6, so
  every database step would fail to connect. The pooler is IPv4 on every plan;
* the **direct** string is the shape Hyperdrive uses, but **not as it is
  given to you**. Both strings the dashboard hands out connect as `postgres`,
  and the Worker must connect as `yukibana_app`: see step 2. Hyperdrive is
  the pool, so pooling it twice is what you are avoiding.

Percent-encode the password inside the pooler string if it contains anything
outside `A-Za-z0-9._~-`. The Supabase CLI rejects a string that is not encoded.

Then create a **GitHub OAuth App** for login, at GitHub → Settings →
Developer settings → OAuth Apps → New. The callback URL is
`https://<ref>.supabase.co/auth/v1/callback`. Keep the client id and secret.
This is an OAuth App, not a GitHub App: the registry reads no repositories.

Login codes are mailed through **Resend**. Supabase's built-in mailer sends
only to your organisation's own members, a couple of mails an hour, and on
the free plan it refuses the code template, failing the whole auth push. At
resend.com, add the domain `yukibana.dev` and put the DNS records it shows
into Cloudflare, then create an API key with sending access. The rest is in
`supabase/config.toml` under `[remotes.production.auth.email.smtp]`; the
key is the `SUPABASE_AUTH_SMTP_PASS` secret below. Another provider, or
another sender address, is a change to that block.

Nothing else is configured by hand. The deploy workflow pushes the auth
settings from `supabase/config.toml`, and the schema comes from the
migrations. The dashboard is read-only from here on; `drift.yml` fails
nightly if something is changed there.

## 2. Cloudflare

**Enable R2** (dashboard → R2). It asks for a payment method; the free tier
is 10 GB of storage, 10 million reads a month and no egress charges.

**Create the bucket**, named `yukibana-cloud`, the same name local development and CI use.

**Create an R2 API token** (R2 → Manage API tokens → Create), with Object
Read & Write on that bucket. The page that follows shows three values, once:

| Shown as | Length | Use |
| --- | --- | --- |
| Token value | about 40–53 characters | **not used**: it is for Cloudflare's own API |
| Access Key ID | 32 hexadecimal characters | `S3_ACCESS_KEY_ID` |
| Secret Access Key | 64 hexadecimal characters | `S3_SECRET_ACCESS_KEY` |

The token value comes first and looks like a key, and pasting it as
`S3_ACCESS_KEY_ID` makes every upload fail; the Worker checks the shapes and
names the mistake. The same page shows the S3 API endpoint,
`https://<account id>.r2.cloudflarestorage.com`.

**Create the Hyperdrive config**, from a checkout. Note the user and the
password: `yukibana_app`, with the value you will put in `APP_DB_PASSWORD`
(step 5). The host and port are the direct connection's; the rest of that
string is not.

```bash
npx wrangler hyperdrive create yukibana-cloud \
  --connection-string="postgresql://yukibana_app:<APP_DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres"
```

It prints an id. Hyperdrive is on the free plan, with 100,000 queries a day.

**Not `postgres`.** The string the dashboard offers connects as `postgres`,
and pasting it here is the one mistake that does not announce itself. That
role owns the tables, and a table's owner is not subject to its own policies
unless they are forced, which these migrations deliberately do not do — so
the whole authorisation model would be off, silently. It is also not a member
of `yukibana_publisher`, so publishing a release would fail while every page
kept working. This happened; `app/src/lib/server/db.ts` now answers such a
connection with a sentence naming it, which is how you would find out.

The password reaches the database from `APP_DB_PASSWORD` through
`ops/bootstrap.sql` on every deploy, so the two must be the same value. To
change it later, change the secret, deploy, then
`npx wrangler hyperdrive update <id> --connection-string=...`.

**Point Workers Builds at this repository**, if it is not already: the
Worker → Settings → Builds.
Cloudflare's defaults are what this repository is arranged for, so leave the
root directory empty: `wrangler.jsonc` sits at the root, `npm run build`
there builds the app, and `npx wrangler deploy` deploys it. An earlier
layout kept the Worker's configuration under `app/`, and Cloudflare's build
failed with "could not detect a directory containing static files", which is
what wrangler says when it is run somewhere with no configuration to find.

Note the account id from the dashboard sidebar: it is the first label of the
R2 S3 endpoint, which `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` in
`wrangler.jsonc` hold.

## 3. Fill in the three placeholders

`node scripts/check-production-config.mjs` names them and where each lives;
the deploy workflow runs it first and refuses to deploy while any remain.

| Placeholder | Value |
| --- | --- |
| `REPLACE_ME_PROJECT_REF` | the Supabase project ref |
| `REPLACE_ME_HYPERDRIVE_ID` | the id `hyperdrive create` printed |
| `REPLACE_ME_WORKERS_SUBDOMAIN` | your workers.dev subdomain, so the app is at `https://yukibana-cloud.<subdomain>.workers.dev`, or the custom domain instead |

They are in `wrangler.jsonc` at the repository root (production values,
because that is what is deployed and what a diff should show) and `supabase/config.toml` (under
`[remotes.production]`, which is what `config push` applies to the project;
everything above that block stays local). Commit the result.

One more value is the environment's own without being a placeholder:
`SITE_URL` in `wrangler.jsonc`, the address people use. It must be the
origin of `site_url` under `[remotes.production.auth]`; step 7 says why.

## 4. Worker secrets

Three, set once. The Worker already exists, so this works before the first
deploy. From the repository root, after `npx wrangler login`:

```bash
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
```

They are not in the deploy workflow: a secret that is re-pushed on every
deploy is a secret that is in CI's environment on every deploy.

## 5. Repository secrets

GitHub → Settings → Secrets and variables → Actions.

| Secret | Value |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | a personal access token, from the Supabase dashboard |
| `SUPABASE_PROJECT_REF` | the project ref |
| `SUPABASE_DB_URL` | the **session pooler** connection string, percent-encoded |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` | the OAuth App's client id |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` | the OAuth App's secret |
| `SUPABASE_AUTH_SMTP_PASS` | the Resend API key, for the login codes |
| `APP_DB_PASSWORD` | a password you generate for the `yukibana_app` role |
| `FIRST_ADMIN_EMAIL` | the address your GitHub account reports as primary |

No Cloudflare credentials: Workers Builds deploys the Worker with its own
connection to this repository, and the Database workflow never touches it.

These go on the **Secrets** tab, as **repository** secrets. GitHub has four
stores that look alike in the interface and are not the same thing, and the
Database workflow can read exactly one of them:

| Where | Readable here |
| --- | --- |
| Actions, Secrets tab, repository secrets | yes |
| Actions, Secrets tab, on the environment named `default` | yes, the workflow declares it |
| Actions, Variables tab | no, a different store, and not masked in logs |
| Dependabot secrets | no, a different store |

The workflow names an environment called `default`, so either place works.
Put them on the Secrets tab in whichever you use: a variable is printed in
plain text in run logs, and `SUPABASE_DB_URL` carries the database password.

A secret that is set shows up as `***` in a run's environment listing; one
that is blank there does not exist as far as the job is concerned. Until the
production configuration in step 3 is filled in, the workflow stops with a
notice rather than failing, because nobody has pointed the repository at an
environment yet. Once it is filled in, a missing secret fails the run and
names itself.

`APP_DB_PASSWORD` is yours to invent: `ops/bootstrap.sql` sets it on the
connection role every deploy, so it never appears in a migration.

## 6. Deploy, log in, deploy again

Push to `main` (the Database workflow then runs once CI has passed), or run
the Database workflow by hand. It will check the
placeholders are gone, list and apply pending migrations, run
`ops/bootstrap.sql`, and push the Supabase settings; Cloudflare builds and
deploys the Worker alongside it.

`ops/bootstrap.sql` sets the connection role's password and then tries to
promote the first admin. On a brand-new project it finds nobody to promote
and says so, because an account only exists once someone has logged in. So
**open the app, log in (with GitHub, or a code mailed to `FIRST_ADMIN_EMAIL`),
and run the workflow again**. The second
run promotes you, and every run after that is a no-op.

You are then an admin: `/admin` grants `teacher` to anyone who has logged in
once, and a teacher creates courses, editions and projects.

## 7. The IDE's OAuth client

The CLI and the IDE log in through the website: `/auth/connect` shows the
person whom they are signed in as, and on their say-so Supabase Auth's OAuth
2.1 server issues a code for the registry's own OAuth client, which the CLI
trades for a session of its own (`app/src/lib/connect.ts` says how and why).
The server is switched on by `[auth.oauth_server]` in `supabase/config.toml`,
which the Database workflow pushes like any setting. The client is data,
not a setting, so it is registered once per environment, with the project's
secret key (Settings → API keys). Turning it on, in a new environment or in
one that runs without it, is four steps, in this order:

1. **The setting.** Merge with `[auth.oauth_server]` enabled, and wait for
   that Database run to go green. Until it has pushed the setting, Auth has
   no OAuth server and the script below fails with a 404 from
   `/auth/v1/admin/oauth/clients`.
2. **The client.** From a checkout of `main`, with the key in a git-ignored
   file rather than on the command line, where it would stay in the shell's
   history (`.env` is ignored here):

   ```bash
   node --env-file=.env scripts/oauth-client.mjs https://<ref>.supabase.co https://cloud.yukibana.dev
   ```

   where `.env` holds `SUPABASE_SECRET_KEY=<secret key>`. It prints the
   client's id, which is not a secret.
3. **The id.** Put it in `wrangler.jsonc` as `SUPABASE_OAUTH_CLIENT_ID` and
   merge. Workers Builds deploys it; nothing waits on the database.
4. **Check.** `curl https://cloud.yukibana.dev/api/auth/config` answers with
   the id as `oauthClientId` and the address as `siteUrl`. Then `yukibana
   login` prints a four-letter code and opens the website, which shows the
   same code beside "Continue as …".

The site address given to the script must be the
origin of Auth's `site_url` (`[remotes.production.auth]` in
`supabase/config.toml`) and of `SITE_URL` in `wrangler.jsonc`: Auth sends
the consent step to `site_url`, the client's one redirect URI is on that
origin, and the cookie that says the person clicked "Continue" is set
there, so a login started on any other address (the workers.dev one, say)
is moved there first. Until step 3 is deployed, the CLI and the IDE log in
with GitHub directly, as before, so nothing breaks between the steps.
Running the script again finds the client rather than making a second one,
and refuses to reuse a client of that name that is not public, has other
grants, or has more than one redirect URI. The secret key is
used for this and nowhere else: it is not a Worker secret and not a
repository secret.

## Afterwards

The migrations in this repository have been applied to the production
project as of 2026-09-18, so the ledger there records them. From that point
a migration that has run is frozen: every change is a new file, including a
change to something only ever deployed once. CLAUDE.md says the same thing;
this is the date it started being true.


Everything else is in the app. A teacher creates a course, an edition,
enrols by address, and creates a project. Publishing a release is
`docs/cloud/yukibana-json.md`: `yukibana build` and an upload, or a token and the
GitHub Action in the course repository.

## When something goes wrong

**"failed to connect" in a database step.** `SUPABASE_DB_URL` is the direct
connection string rather than the session pooler one. See step 1.

**The deploy refuses with a list of placeholders.** Step 3, and commit.

**Login redirects to localhost.** `[remotes.production]` in
`supabase/config.toml` still has the placeholder subdomain, or the deploy has
not pushed the settings yet. The pushed values are printed by the "Supabase
settings, before" step of the last deploy.

**A merge to `main` changed nothing on the site.** Workers Builds reports
a "Workers Builds: yukibana-cloud" check on every commit it builds; a
commit on `main` without one was never built, and the site still runs the
one before. Workers Builds starts from a GitHub webhook, so first look at
githubstatus.com: when Webhooks is degraded, the delivery is late rather
than lost, and the build appears once GitHub works through its backlog (on
2026-10-21 the merge of #49 waited this way). If GitHub is fine, or the
check never comes, retry the build from the Worker's Deployments page in
the Cloudflare dashboard, or push again. `/api/auth/config` answering without
`siteUrl` is the sign that code from before the website login is live.

**`yukibana login` or the IDE still goes straight to GitHub.** The deployed
`wrangler.jsonc` has no `SUPABASE_OAUTH_CLIENT_ID`: `/api/auth/config`
answers without `oauthClientId`. Step 7, 3. A CLI older than the website
login also goes to GitHub whatever the registry says; the IDE needs an
`@yukibana/cli` from after it.

**The website says the login expired or was already used.** Five minutes
passed between "Continue" and the browser coming back, or the browser
refuses the site's cookies.

**"Continue" answers 502 with what Auth's OAuth server said.** The Worker
asks Auth for the authorization itself (so that the consent route asks Auth
about no other), and Auth refused or sent it somewhere other than this
site's consent route: the client was registered for another address than
`site_url`'s, or `SUPABASE_OAUTH_CLIENT_ID` names no client. Run the script
again with the right address: it registers a client for it, and
`SUPABASE_OAUTH_CLIENT_ID` must be that client's id.

**The client script answers 404.** The OAuth server is not on yet: step 7,
1. The "Supabase settings, before" step of the last Database run shows
whether `[auth.oauth_server]` has been pushed.

**A submission is rejected but a small one works.** The Worker hashes each
upload, and the Workers free plan allows about 10 ms of CPU per request.
Source archives are kilobytes and fine; a student who tars up `target/` can
exceed it. The fix is to have the client send its own SHA-256 and let R2
verify it, not a paid plan.

**The Cloudflare build fails on the Hyperdrive id.** The placeholders in
step 3 are not filled in, or `hyperdrive create` has not been run. The build
failing is the intended outcome: a Worker deployed with a placeholder id
starts and then fails every request that touches the database.

**Publishing a release answers 500, but every page works.** The Worker is
connected as a role that is not a member of `yukibana_publisher` — almost
always `postgres`, from pasting the dashboard's connection string into
Hyperdrive. The response says so since the day it was found; the fix is
`npx wrangler hyperdrive update <id> --connection-string=...` with
`yukibana_app` and `APP_DB_PASSWORD`, and no redeploy, since Hyperdrive is
read per request.

**Nightly Drift failed.** Something changed the database outside a migration.
The job prints the difference; either revert it in the dashboard or write it
down as a migration.
