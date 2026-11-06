# Yukibana Cloud: design

2026-09-18. The decisions behind the schema and the service, and what was
deliberately left out of the first version.

## Scope

Courses, their editions, the projects in an edition, and the submissions to
a project. Staff enrol students by address, publish releases of a project
(two archives built beforehand by the CLI), and read what students submit.
The cloud is a registry: it transforms nothing. Students see the editions they are
in, download a project's starter after its date, and submit versions of
their solution.

Out of the first version, each because it adds a surface the roster and
grading integrations would later have to fight:

* invitation emails, tokens, accept/decline: enrolment is silent, the
  edition is simply there at first login;
* self-service joining;
* grading, feedback, plagiarism checks, team submissions, per-student
  extensions;
* running anything a student submitted;
* reading repositories. An earlier draft had a GitHub App and built starters
  in the Worker on every push. It cost a paid Cloudflare plan for the CPU
  time, a webhook surface, and a copy of every teacher's repository in the
  bucket. Moving the transformation into a CLI that runs where the
  repository already is (a laptop, the repository's own CI) removed all
  three. A teacher without CI runs the same CLI on their own machine.

## Constraints

1. **Enrolment is independent of the account.** Staff enrol by email address,
   before or after that person has ever logged in. Both orders work: an
   address that already belongs to an account links on the spot; an unknown
   address links at that person's first confirmed login.
2. **Authorisation lives in Postgres.** Policies and `security definer`
   functions decide everything. The Worker runs every query as the caller,
   so the policies are the application's rules, not a second copy of them.
3. **No bulk address exposure.** A student never reads another person's
   address; staff read the roster of their own editions only.
4. **A roster feed is the forcing function.** Every table is judged by how
   cleanly a school's SIS could later drive it. `enrollment.source` says
   which rows a sync owns.
5. **Submissions are append-only.** No update or delete path exists.
6. **The schema changes only through migrations.** See CLAUDE.md.

## The model

**Course → edition → project → submission.** A course is a code that groups
editions; nearly everything hangs off an edition, including the course's
name: each edition carries the name it ran under, its owners may change it,
and where the page means the course rather than one edition it shows the
latest edition's name (2026-10; until then a course's title was fixed at
creation). A new edition is a copy of
the previous one (`app.duplicate_edition`): projects and staff come along,
students and dates do not. A project belongs to one edition; reusing an
assignment next year is duplicating the edition, not sharing the project,
because a shared project would need its own access control and would show
every teacher every other teacher's hidden-test configuration.

**Two role dimensions.** `app_user.role` is the platform role (`user`,
`teacher`, `admin`): a teacher creates courses and editions, an admin makes
teachers. `enrollment.role` is the role in one edition (`student`,
`assistant`, `owner`). Owners and assistants are both staff and both
look after the projects: create, edit, reorder, publish releases. Owners
alone run the edition (roster, roles, duplicate, archive), delete a
project (and its releases with it), and make publishing tokens. The
editing rule has one name, `app.may_edit_projects`: the policies ask it, and
so do the pages before drawing a control, so nobody sees a reorder handle or
a form that would only be refused. An admin
is not implicitly staff of anything: to see an edition they enrol in it,
and it shows in the roster. The first admin is
`app.bootstrap_admin`, run by an operator.

**One `enrollment` table, not invitation plus membership.** A row with
`user_id` null is an address staff enrolled that has not logged in yet. The
trigger on `auth.users` fills it in when the address is confirmed. Roster
feeds produce exactly (edition, address, role), so one table upserts against
them. Removing someone is a delete whether or not they ever logged in.

**Identity is a verified address, via Supabase Auth.** Two ways prove one:
GitHub, whose primary verified address is what it reports, and a one-time
code mailed to the address (2026-10). Enrolment matches on the address either
way, and both reach the same `auth.users` row for it. There is no password
and no link in the mail, only the code. Until 2026-10 GitHub was the only way
in; that made every test account a GitHub account, and left a student whose
GitHub primary was not the enrolled address with nothing to do but change it.
A code account is confirmed by its code and not before
(`enable_confirmations`), because a confirmed address is what links
enrolments. Anyone may ask for a code: an account with no enrolment sees
nothing. An institutional OIDC provider later changes the login screen and
nothing else, because `auth.users.id` is the identity either way. The roster
shows who has and has not linked.

**No `user_contact` table.** Earlier drafts split addresses out of the
profile to keep bulk reads from harvesting them. Supabase already holds the
verified address in `auth.users`, which no API role can read, and staff see
the addresses they enrolled in `enrollment`. The split protected nothing.

**Draft until dated, gone when closed.** A project has a window:
`available_after` opens it (null: a draft nobody but staff sees),
`closes_at` ends it (null: never), and a student sees the project, its
starter and its submit button only inside it. `deadline` is the due date
within the window, not a wall: work after it is accepted and is late
(2026-10; until then the deadline refused it, and a minute-late student had
nowhere to put their work). Lateness is not stored. `submitted_at` is
stamped by the server, and late is `submitted_at > deadline`, asked when it
is read, so an extension applies to work already handed in, and a
submission row is still never rewritten. A student keeps reading their own
submissions after the window closes; `app.deadline_of` tells them the
deadline of a project they submitted to and no longer see.

**Order is a number between two numbers.** Staff arrange an edition's
projects by dragging them, and each drop is saved at once through
`app.move_project(project, after, before)`. `project.position` is a
`numeric`: a moved project takes the midpoint of its new neighbours', so a
move writes one row and the rest of the edition is never renumbered. The
midpoint is `(a + b) * 0.5`, which is exact; `/ 2` would round to a scale
and two positions would eventually tie. New projects go to the end, and a
duplicated edition keeps the order. Positions are only compared, never
shown.

**What a student sees.** The home page's To do tab lists, across every
edition they are a student in, what is still to hand in (soonest deadline
first, overdue at the top) and what is handed in, late or not. Each
edition's project list shows the same, in the order staff set. Every row
links to the project, opens it in the IDE (`yukibana://project/open?id=<project
id>`), downloads the starter, and goes to the upload form; the IDE's submit
button and the form end in the same submission. "Overdue" is past the
deadline and still open, "missed" is closed with nothing handed in; neither
is stored, both are worked out from the dates when the page is drawn.

**Live pages carry news, not data.** Open pages update without a reload:
a trigger on `project`, `project_release`, `enrollment` and `submission`
broadcasts "this edition changed" on a private Supabase Realtime topic, and
a page that hears it reruns its loads through the Worker. The payload is a
table name and nothing else, so Realtime never holds a second copy of the
read rules; `app.may_listen`, behind the policy on `realtime.messages`,
only decides whom a change wakes. An edition's topic reaches everyone
enrolled, its `:staff` topic reaches staff, and `user:<id>` reaches one
person (their own submissions, say from the IDE, and their enrolments). A
change to a project students cannot see (a draft, one not yet open, one
closed) goes to staff only, by the same `app.window_open` the read
policies use. The policy lives in Supabase's `realtime` schema, which the
nightly drift diff leaves out, so `ops/realtime-policies.sql` checks it
exactly, in CI and against production. A page holds the news back while it would
lose something to a reload: during a drag, while its own moves are being
saved, while a settings form has unsaved edits (which then says the
project changed underneath it). What changes by the clock alone, a
project opening at its date, sends nothing; it shows at the next load.

**Submissions.** The body goes through the Worker as one request, not a
presigned upload: the server computes the size and SHA-256 itself, stores
the object, then inserts the row inside the student's policies. A refused
row deletes the object. Every version is a row; `submitted_at` is
trigger-forced, as is `author_id`.

**Ids are UUIDv7**, from `app.uuidv7()` in the first migration. Sequential
integers leak volume and order even through RLS; random uuids scatter an
index. Postgres 18 has this built in and Supabase runs 17, so it is written
down rather than waited for.

**Addresses and logins are lowercased text, not citext.** Every function
here runs with `set search_path = ''`, and there citext's `=` is invisible:
Postgres falls back to text equality without a word, and a role change for
`Early@Example.com` found no row. Lowercase on write, compare lowercase.

## Releases and the CLI

A release is two archives: the **starter** students download and the
**teacher archive**, the whole project with the hidden tests, for staff.
Both are made by `yukibana build` from a checkout, by the same pure
functions (`packages/client/src/lib`): a tar reader and writer, a glob matcher, and a
plan per archive, tested against a fixture that is a real pax tarball. The
registry stores what it is given, checks that each is gzip and under a cap,
records sizes and SHA-256s, and serves the newest starter to students whose
project is open. Staff see the whole history and can fetch either archive of
any release; a wrong release is followed by a right one.

Two ways to publish, both the same request:

* `yukibana publish` from a teacher's machine;
* the GitHub Action in the course repository's CI, on every push.

The project page used to take the two files from `yukibana build` by hand.
It stopped (2026-10) when releases began carrying their id inside the
starter: an upload could only match its starter if the teacher pasted the
id `build` printed, and a blank or wrong field failed in silence, leaving
every submission from that starter unable to say which release it started
from. Nobody wanted to assemble a starter by hand anyway.

CI cannot log in with GitHub SSO, so it uses a **project token**: made by an
owner on the project page, shown once, stored only as a SHA-256. The Worker
hashes what it receives and runs the request as `yukibana_publisher`, a role
whose entire power is two functions: turn a hash into a project id, and
record a release for it. A leaked token can publish releases to one project,
which its staff can see and follow with a new one, and can be revoked from
the page.

## The student's side and the teacher's

A course repository's `yukibana.json` is also what our Theia fork reads:
which widgets show, which files open, which are read-only. `readOnly` and
`hidden` are the two lists that matter to grading. A student receives the
starter (no hidden files); what they send back is the folder minus `.git`,
`.theia`, build output and what the file excludes. Packing is one library
function in `packages/client`, called by `yukibana submit` and by the IDE extension
alike, so the two cannot disagree about which files a submission holds.

A teacher grades an **assembly**: the submission with `yukibana.json`, every
read-only path and every hidden path deleted and taken from the newest
release's teacher archive. The newest, not the one live at submission time,
so a test fixed after the fact applies to everyone. What a student changed
under a protected path is undone and reported, never silently: a changed
read-only test is exactly what a teacher wants to see. The assembly is the
CLI's job, on the teacher's machine, because the registry transforms
nothing.

Submissions still go through the Worker rather than to the bucket by a
presigned upload: at 32 MiB a request is well under the platform's limit,
and the server computing the size and SHA-256 itself is worth more than the
bytes saved. A direct upload needs a reservation, an upload and a
confirmation that cannot check the hash without reading the object back,
and something to sweep up what was reserved and never confirmed.

## Where the bytes live

The one storage adapter speaks S3: R2 in production (zero egress, a free
allowance that a course does not exceed), RustFS locally and in CI. The
database holds object keys, never URLs, so changing provider is three
variables and an `rclone` copy. Downloads are presigned URLs good for a
minute, minted only after the caller's policies returned the row: a URL is
a bearer token and outlives the permission that made it, which is why it is
short.

## The local stack and CI

Adopted from `tothambrus11/supabase-experiment`: the Supabase CLI as a
pinned dev dependency, a devcontainer that drives the host's Docker daemon
with the workspace mounted at its host path (so the CLI's bind mounts
resolve), `host.docker.internal` for the services, a preflight script that
probes whether a machine can run this, a smoke test, and two workflows: the
stack on a VM runner, and the devcontainer built so a broken one fails a PR.
Added: the bucket as a compose file beside it, the pgTAP suite, the
integration suite, squawk over migrations, the deploy and drift workflows.

## Open questions

* **Which address will students' GitHub accounts report?** Less pressing
  since email codes (2026-10): a student whose GitHub primary is personal can
  log in by code to the enrolled address instead. If that is still not
  enough, enrolment by GitHub login is the next matching key
  (`app_user.github_login` already exists); it would be a second nullable
  column on `enrollment`, not a redesign.
* **Code login from the CLI and the IDE.** Settled (2026-10): they log in
  through the website (`/auth/connect`), so by GitHub or by code, as the
  account the person confirms there, by way of Supabase Auth's OAuth 2.1
  server. A registry without the OAuth client still sends them straight to
  GitHub (`authorizeUrl` in `packages/client/src/lib/pkce.ts`).
* **Retention.** Addresses and submission bodies are personal data. Cascading
  deletes from `auth.users` would erase graded work; the schema restricts
  instead, and bucket lifecycle rules must agree with whatever the database
  does. Decide with the institution.
* **Per-student extensions.** A deadline is per project. An extension for
  one student is likely a row (project, student, deadline) that
  `app.deadline_of` and the lateness query consult first.
* **Validating starters.** The obvious next check is that a starter builds:
  `cargo check` after the hidden tests are gone. Now that the build happens
  in the course repository's own CI, that is a step in the same job, with
  the toolchain the repository already has. The registry does not need to
  know.
* **A headless login.** `yukibana login` is OAuth with PKCE through the
  system browser, back to a loopback listener (2026-10). A machine no
  browser can reach (SSH, a container) has only `YUKIBANA_ACCESS_TOKEN`;
  Supabase Auth has no device-code grant, and its OAuth server could be the
  way to one.
