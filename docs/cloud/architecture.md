# Yukibana Cloud: architecture

2026-10-21. An architecture is three answers: what the structural elements
of the system are, how they relate to each other, and the principles that
decided the first two. This page gives them in that order. `design.md` is
the longer record of individual decisions and what was left out;
`deploy.md` is how the elements below are set up and shipped; `CLAUDE.md`
is how the code inside them is written.

## 1. The elements

### What runs

| Element | What it is | Where it lives |
| --- | --- | --- |
| **The Worker** | The SvelteKit app in `cloud/web/`, built by `adapter-cloudflare` into one Cloudflare Worker. It serves the pages and the JSON API under `/api/`, and holds no state between requests. | `cloud/web/`, configured by `cloud/web/wrangler.jsonc` |
| **Postgres** | Supabase's database. The schema, every policy, every function that writes, the roles the Worker connects as, and the audit log. | `cloud/db/supabase/migrations/`, plus `cloud/db/ops/bootstrap.sql` for passwords |
| **Supabase Auth** | Who someone is: an account per verified address, proved by GitHub (an OAuth App) or by a one-time code mailed through Resend. It issues the JWTs everything else trusts. | `cloud/db/supabase/config.toml`, pushed by the deploy |
| **Supabase Realtime** | Private broadcast topics that tell open pages "this edition changed". It carries news, never data. | the `live_signals` migration, checked by `cloud/db/ops/realtime-policies.sql` |
| **Hyperdrive** | Cloudflare's pool in front of Postgres. The Worker opens a client per request; Hyperdrive keeps the real connections. | the `hyperdrive` binding in `wrangler.jsonc` |
| **The bucket** | The bytes: release archives and submissions. R2 in production, RustFS locally and in CI, both spoken to over S3. | `cloud/web/src/lib/server/storage.ts`, `cloud/dev/compose.yml` |

### What people use

| Element | Who | What it does |
| --- | --- | --- |
| **The pages** | everyone | Browse editions and projects, enrol, set dates, publish a release by hand, download, submit by upload. Served by the Worker. |
| **The CLI**, `yukibana` | teachers, students, CI | `check` and `build` turn a course repository into the two archives of a release; `publish`, `download` and `assemble` for staff; `login`, `projects`, `starter`, `submit` for students. |
| **The library** | the IDE | `packages/client/src/library.ts`: the same login, API client and submission packing as the CLI, headless, for the Theia extensions. |
| **The GitHub Action** | a course repository's CI | `action/action.yml`: builds the archives with the CLI and publishes them with a project token. |

### What is stored

The domain is four nouns deep: a **course** holds **editions**, an edition
holds **projects**, a project has **releases** and **submissions**.

* `app_user` is the profile of an `auth.users` account, with its platform
  role (`user`, `teacher`, `admin`).
* `enrollment` is (edition, address, role), role being `student`,
  `assistant` or `owner`. `user_id` is null until that address logs in.
* `project` carries its window: `available_after`, `deadline`, `closes_at`,
  and a `position` for ordering.
* `project_release` is a pair of object keys (starter, teacher archive) with
  sizes and SHA-256s; `project_token` is a hash of a publishing secret.
* `submission` is one append-only row per version handed in, pointing at one
  object.
* `audit_log` is a row for every write a `security definer` function made.

Object keys are `starters/<project>/<uuid>.tar.gz`,
`teacher/<project>/<uuid>.tar.gz` and `submissions/<submission>.tar.gz`
(`cloud/web/src/lib/ids.ts`).

### Inside the Worker

| Module | Responsibility |
| --- | --- |
| `hooks.server.ts` | Every request: refuse a write this site's pages did not send, read and check the configuration, verify the session, make `/api/` errors JSON. |
| `lib/server/forgery.ts` | Which requests may write on the strength of the cookies: a form from this site's own origin, or anything with a bearer. |
| `lib/server/session.ts`, `lib/session-cookie.ts`, `lib/claims.ts` | The verified JWT claims of the caller, from a bearer header or the `__Host-` session cookies, and which of them reach the database. |
| `lib/server/context.ts` | `withContext`: a database client, the bucket and the configuration for one request, closed after the response. `requireClaims`, `requireBearer`, `answering`. |
| `lib/server/db.ts` | `asUser` and `asPublisher`: the only two ways to run a query. |
| `lib/server/storage.ts` | `Bucket`, the one S3 implementation, and presigned URLs. |
| `lib/server/releases.ts`, `submissions.ts` | The two writes that touch both the bucket and the database, in a fixed order. |
| `lib/server/catalogue.ts`, `student.ts` | The reads behind the API and the pages. |
| `lib/server/env.ts`, `worker.ts` | `configOf`, the one place the Worker's environment is trusted. |
| `routes/` | Pages and endpoints: they call the modules above and show what came back. They hold no rules. |

### What delivers it

| Element | When | Does |
| --- | --- | --- |
| **CI** (`ci.yml`, `ci-devcontainer.yml`) | every push and pull request | lint, typecheck, unit tests, a build; the whole stack from empty migrations, pgTAP, integration tests; the devcontainer. |
| **Database** (`database.yml`) | after CI succeeds on `main`, or by hand | migrations, `cloud/db/ops/bootstrap.sql`, Supabase settings. |
| **Cloudflare Workers Builds** | every push | builds the Worker; deploys it on `main`, uploads a preview version elsewhere. |
| **Drift** (`drift.yml`) | nightly | fails if production differs from the migrations. |

## 2. How they relate

### The picture

```
  browser pages ─────────┐            ┌──────── presigned GET (1 min) ───────┐
  CLI / IDE library ─────┼─ HTTPS ─▶  │                                       │
  GitHub Action ─────────┘   (JWT or  ▼                                       │
                           token)  ┌────────────┐   S3, signed   ┌──────────┐ │
                                   │   Worker   │ ─────────────▶ │  bucket  │◀┘
                                   │ (SvelteKit)│                │ R2/RustFS│
                                   └─────┬──────┘                └──────────┘
                     verify JWT (JWKS)   │   SQL as yukibana_app,
                  ┌──────────────────────┤   becoming the caller
                  ▼                      ▼
          ┌──────────────┐        ┌────────────┐        ┌────────────┐
          │ Supabase Auth│ ─────▶ │  Postgres  │ ─────▶ │  Realtime  │ ──▶ open pages
          │ GitHub, codes│ trigger│ RLS, audit │ trigger│  "changed" │     reload via
          └──────────────┘        └────────────┘        └────────────┘     the Worker
                  ▲                      ▲ Hyperdrive pools this hop
     OAuth / codes│
     (browser, CLI PKCE)
```

### Who talks to whom, and as whom

* **Clients reach Auth directly to log in, and the Worker for everything
  else.** A browser goes through GitHub or a mailed code and lands on
  `/auth/callback`, which stores the session in cookies. The CLI and the IDE
  library open `/auth/connect` in the system browser: the person logs in to
  the website and confirms which account, the Worker asks Supabase Auth's
  OAuth 2.1 server for an authorization for the registry's OAuth client,
  the consent route approves that one (and only the one this browser's
  connect cookie names) for a PKCE-bound code, and sends the browser with
  it straight to a listener on `127.0.0.1`. The CLI trades it for a session
  of its own and sends the access token as `Authorization: Bearer`. CI
  sends a project token instead.
* **The Worker trusts a request only after Auth's keys say so.** The hook
  verifies the JWT (`getClaims`) on every request; a bearer header wins over
  cookies. Enrolling and publishing through the API demand a bearer, so a
  cross-site form cannot make a browser's cookie do either; any other write
  without a bearer must be a form from the site's own origin, which the hook
  checks before anything else. That holds against a page on a sibling
  subdomain too (Light, at light.yukibana.dev, is the same site), and the
  session cookies' `__Host-` names keep such a page from setting a session
  of its choosing (CLAUDE.md, "A sibling subdomain is another person's
  page").
* **The Worker reaches Postgres through Hyperdrive, as `yukibana_app`, and
  immediately becomes someone else.** Each query runs in a transaction that
  sets the role to `authenticated` with the caller's claims (`asUser`), or
  to `yukibana_publisher` for a project token (`asPublisher`). From there
  the database's policies and `security definer` functions decide what the
  query may see and do. `yukibana_app` itself can read nothing.
* **The Worker reaches the bucket with its own credentials, and clients
  reach it only through presigned URLs.** Uploads pass through the Worker,
  which hashes and sizes them itself. Downloads are a one-minute presigned
  URL, minted only after the caller's policies returned the row it belongs
  to, followed by a redirect.
* **Auth feeds Postgres.** A trigger on `auth.users` creates the `app_user`
  row and links any `enrollment` rows waiting for that confirmed address.
* **Postgres feeds Realtime, and Realtime feeds the pages back through the
  Worker.** Triggers on `project`, `project_release`, `enrollment` and
  `submission` broadcast a table name on `edition:<id>`,
  `edition:<id>:staff` or `user:<id>`; `app.may_listen` decides who may
  join. A page that hears one reruns its loads through the Worker, under the
  same policies as the first load.
* **The CLI and the registry share nothing but the HTTP API.** The archives
  are made by the CLI before they arrive, by pure functions in `packages/client/src/lib`;
  the registry checks they are gzip and under a cap, and stores them
  without opening them. Every archive is a `.tar.gz`.

### The flows that cross every element

**Publishing a release.** `yukibana build` (on a laptop, or in the Action)
makes `starter.tar.gz` (hidden tests removed) and `teacher.tar.gz`. A `POST
/api/projects/<id>/releases` carries both. The Worker checks shape and size,
asks the database whether this caller may publish (a staff member's
`app.may_edit_projects`, or `app.project_for_token` for a token), writes
both objects, then records the release through `app.publish_release` or
`app.publish_release_with_token`. If the row is refused, both objects are
deleted, and a failure to delete is reported as an orphan.

**Submitting.** The CLI or the IDE packs the student's folder with the same
library function into a `.tar.gz` and posts it to
`/api/projects/<id>/submissions`; the upload form on the project page ends
in the same function, `acceptSubmission`. The Worker asks `app.can_submit`, so a closed window is refused before the
upload is stored, writes the object, then inserts the row as the student
and takes the row's id back with `returning`. A window that closes in
between makes that insert see no project (the policy hides it) and insert
nothing without an error, so no row back is a refusal and the object is
deleted again; the insert policy's own error is reached only when the
student's role changed in between. A refusal is a 403 whose sentence comes
from `app.submit_refusal`, asked in the same transaction as `can_submit`:
to someone in the edition it says whether they are staff, the project is
not open yet, or it has closed; to anyone else, or when the reason cannot
be had, it says only that the project is not accepting submissions from
them.
`submitted_at` and `author_id` are forced by a trigger; late is
`submitted_at > deadline`, computed when read.

**Downloading.** `GET /api/projects/<id>/starter`,
`/api/releases/<id>/<archive>` or `/api/submissions/<id>` looks the row up
as the caller, and redirects to a presigned URL for its key. No row, no URL.

**Grading.** `yukibana download --assemble` fetches submissions and the
newest teacher archive and, on the teacher's machine, puts back every
read-only and hidden path from the teacher archive, reporting what a student
had changed under them.

**Enrolling.** An owner calls `app.enrol` with an address. If an account
has that confirmed address the row links now; otherwise at that person's
first login, by the `auth.users` trigger.

### Environments

The same elements exist three times, wired the same way.

| | Local | CI | Production |
| --- | --- | --- | --- |
| Postgres, Auth, Realtime | `supabase start` | `supabase start` on the runner | a Supabase project |
| Bucket | RustFS, `cloud/dev/compose.yml` | RustFS | R2 bucket `yukibana-cloud` |
| Worker | `npm --prefix cloud/web run dev`, configured by `cloud/web/.dev.vars` | a production build, and the integration suite against the server modules | Workers Builds, `wrangler.jsonc` |
| Database connection | `localConnectionString` in `wrangler.jsonc` | the same | Hyperdrive, as `yukibana_app` |
| Mail | the stack's catcher at :54324 | none | Resend |

`wrangler.jsonc` and `[remotes.production]` in `cloud/db/supabase/config.toml` hold
production's values, because that is what is deployed and what a diff
should show; `.dev.vars` and the rest of `config.toml` override them
locally.

## 3. The principles behind it

Each principle says what it decided above, and what it costs.

**The cloud is a registry; it transforms nothing.** It holds identities,
enrolment, released archives and submissions. Building a starter, hiding
tests and assembling a submission for grading happen in the CLI, where the
repository already is. *Why:* an earlier draft built starters in the Worker
from a GitHub App's webhooks, which needed a paid plan for the CPU, a
webhook surface, and a copy of every teacher's repository. Moving the
transformation out removed all three and lets a teacher without CI upload
two files by hand. *Cost:* a teacher needs the CLI, and the registry cannot
check that a starter builds; that check belongs in the course repository's
CI.

**Authorisation lives in Postgres, and only there.** Every rule about who
may see or do something is a row level security policy or a `security
definer` function, and the Worker runs every query as the person asking.
*Why:* one copy of the rules cannot disagree with itself, pgTAP can test
each one as a negative, and a bug in a route cannot widen access, because
the route never had the access to give. *How it is enforced:* the Worker's
role owns nothing and bypasses nothing, so a query outside `asUser` or
`asPublisher` fails rather than answering as the owner; tables written by
functions have no insert grant. *Cost:* every read pays a role switch, and a
misconfigured connection (as `postgres`) would switch the model off
silently, which is why `db.ts` names that case when it happens.

**Least power per credential.** A browser session, a CLI session and a
project token each reach exactly what their holder may. A project token is
stored only as a hash, and `yukibana_publisher` can call two functions and
read no table, so a leaked token can publish to one project and do nothing
else. Presigned URLs live a minute because a URL is a bearer token that
outlives the check that made it.

**The schema changes only through migrations, and migrations only add.**
*Why:* the database is the rule book, so it is reviewed like code; and
because nothing is ever removed in the same step, an old Worker against a
new schema keeps working. That is what lets the Worker and the database
deploy independently (see `deploy.md`). *How it is enforced:* squawk lints
every migration, CI rebuilds the database from empty on every push, and the
nightly drift job fails if production differs. *Cost:* a removal takes two
deploys, and a mistake is fixed by a new migration, never by editing one.

**The database holds keys, the bucket holds bytes.** One `Bucket` interface,
one S3 implementation. *Why:* a URL in a row would outlive the permission to
read it and tie the data to one provider. Changing provider is three
variables and a copy. *Cost:* the bucket and the database can disagree, so
every write orders itself (object first, row second, delete the object if
the row is refused) and reports the orphan it could not clean up.

**History is appended, not rewritten.** Submissions have no update or delete
path, and lateness is computed, not stored, so an extended deadline applies
to work already handed in. A wrong release is followed by a right one.

**Enrolment is by address and independent of the account.** Staff enrol an
address before or after that person ever logs in, and one table holds both.
*Why:* that is exactly the shape a school's roster feed produces, so a later
sync can drive the table directly. Identity is "a verified address", whoever
proves it, so a new login provider changes the login screen and nothing
else.

**Live pages carry news, not data.** *Why:* a second channel carrying rows
would need a second copy of the read rules. Broadcasting only "this edition
changed" keeps the Worker as the one way data leaves the database.

**Fit the free tiers, by design rather than by luck.** One Worker, one
Supabase project, one R2 bucket, no paid plan. This is part of why the
Worker transforms nothing (CPU time) and why uploads have caps sized to one
request's body limit.

**Nothing fails silently.** A misconfiguration names itself (the wrong
database role, an R2 token pasted in place of its access key, a placeholder
left in the production configuration); a refused row deletes its objects;
the deploy names every missing secret at once. The comments record which of
these were learned the hard way, because those are the ones somebody will
meet again.

**Types carry meaning; input is trusted in one named place.** Ids are
branded per table so a wrong id is a compile error. The Worker's
environment, form fields and `yukibana.json` are each checked once, at the
boundary, by a function whose name can be grepped.
