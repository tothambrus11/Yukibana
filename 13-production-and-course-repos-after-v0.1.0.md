# chore: move production data and the course repositories to v0.1.0

**Labels:** `area:cloud`, `release`, `manual-steps`, `size:S`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Plan §4.1 step 5,
right after `v0.1.0` is published.

## Goal

After `v0.1.0`, what is in production and the two course repositories work with the released IDE and CLI. This
finishes problem 8 of §1 (course repositories build the CLI from `main` on every run).

## Scope

- **Production releases.** Every release published before `v0.1.0` has a starter whose `yukibana.json` is the old
  loose shape with the ids inside and no `yukibana.release.json`. The strict reader (issue 05) refuses those files,
  the IDE finds no stamp in those folders (issue 04), and `yukibana collect` cannot read those teacher archives. Choose
  one (decision below):
  - **Purge:** delete those releases, their submissions and their bucket objects. Releases are never deleted by the
    app, `submission.base_release_id` references `project_release` with `on delete restrict`, and production may not
    be changed by `psql` or the SQL editor (`cloud/CLAUDE.md`), so the purge is a migration (`<timestamp>_purge_pre_v1_releases.sql`,
    deleting by creation time, writing one `audit_log` row) plus a script that deletes the objects it names from R2.
  - **Re-publish:** each project's teacher re-runs the Action with the new CLI. The newest release then has a valid
    starter; the old rows stay, and grading a submission that started from an old release fails at `collect`.
- **The two course repositories** (`LordBaryhobal/yukibana-template-scala`, `LordBaryhobal/demo-project`), a PR each:
  `yukibana.json` rewritten as v1 (`yukibana config upgrade`, or `config init` and copy the values), any `projectId` or
  `releaseId` removed from it, the workflow switched to `uses: ISC-HEI/Yukibana/action@action-v0`, then a publish run.
- **End to end:** in the `v0.1.0` IDE, a student downloads the starter, submits; a teacher runs `yukibana collect` and
  `assemble` with `@yukibana/cli@0.1.0`.

## Out of scope

- Anything that changes code in `ISC-HEI/Yukibana` beyond the purge migration.

## Design decisions already made

- Breakage until `v0.1.0` is accepted, then the existing releases are purged or re-published and the course
  repositories move to the strict `yukibana.json` and `ISC-HEI/Yukibana/action@action-v0` (§4.1 step 5, summary).

## Open questions

- **Purge or re-publish?** Proposal: purge. There are no users, a half-readable history is worse than none, and the
  migration makes the deletion reviewed and audited like any other change.
- Who tells the course repositories' owner (LordBaryhobal) before their CI breaks. It breaks as soon as issue 07 is
  deployed, so tell them then, not after `v0.1.0`.

## Acceptance criteria

- [ ] Decision recorded here.
- [ ] If purged: the migration is squawk-clean, bounds its timeouts, has a pgTAP test that it removes only releases
      created before the cut-off and their submissions, and leaves an audit row; the R2 script lists what it would
      delete before deleting (dry run first).
- [ ] Both course repositories publish a release through `action-v0`; their starters download and submit in the
      `v0.1.0` IDE.
- [ ] `yukibana collect` and `assemble` work on those submissions.

## Depends on / Blocks

- Depends on: 10 (`v0.1.0` published, `action-v0` moved), 06 (`config upgrade`), and 11 if `v0.1.0` waits for it.
- Blocks: 12 (the old repository's `action/` is deleted only after the course repositories stopped using it).

## Manual and irreversible steps for a maintainer

- The purge deletes production rows and objects for good; take a database backup (Supabase's point in time, or a
  dump) and an R2 listing first.
- Course repository PRs need their owner's review and merge.
- Check the course repositories' `YUKIBANA_PROJECT` variable and `YUKIBANA_TOKEN` secret still name a live project
  and token after the purge (a purge that removes a project would invalidate both).

## Risks

- Deleting by creation time can catch a release published just before the cut-off by someone testing; list the rows
  first and name the cut-off in the migration.
- The access to the course repositories was not checked from here; the workflow names (`action@main` of the old
  repository) come from the plan's §1 and need confirming in those repositories.
