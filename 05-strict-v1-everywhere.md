# feat(client)!: read yukibana.json only through the strict versioned schema

**Labels:** `area:packages`, `area:ide`, `area:cli`, `area:cloud`, `breaking`, `size:L`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Part of plan step 7
(§7.1, §7.3, §7.4).

## Goal

Every program that reads `yukibana.json` reads it with `@yukibana/project-schema`: at its own version, migrated to the
latest, strict. An IDE or CLI that meets a newer version says so and offers the update, instead of dropping fields it
does not know. The schema an editor checks the file with is the one for its version, at its own URL. This fixes
problems 6 and 7 of §1.

## Scope

- `packages/client/src/lib/yukibana.ts`: `configSchema`, `settingsShape`, the defaults, `Settings`, `Config`, `raw`,
  `parseSettings`, `DEFAULT_SETTINGS`, the unknown-field warnings, `SCHEMA_URL` and `configJSONSchema` go. What stays
  are the rules about the file's meaning (`CONFIG_FILE`, `RELEASE_FILE`, `IDE_STATE`, `ALWAYS_EXCLUDED`,
  `NEVER_SUBMITTED`, `buildOutput`, `excludes`, `protectedPaths`), typed with `ProjectFile`. `KINDS` comes from
  `@yukibana/project-schema`.
- `starterConfig(parsed)` writes the teacher's file **at the teacher's version** with `hidden: []` (not the migrated
  latest), from the version and value `parseProjectFile` returns. `sameStudentConfig` compares at that version.
- `packages/client/src/config.ts` (`@yukibana/client/config`): its exports follow; it re-exports `parseProjectFile`,
  `ProjectFile` and `NO_PROJECT_FILE` so existing importers keep one entry.
- `packages/client/yukibana.schema.json`, `tests/schema.test.ts`, the `./yukibana.schema.json` export and the `schema`
  script go. `packages/project-schema` generates `schemas/yukibana.v1.json` and `schemas/yukibana-release.v1.json`
  (`z.toJSONSchema`, draft 2020-12, descriptions from `.describe()`); a test fails when a committed file differs from
  what the generator writes, and a script updates them. Released versions are frozen by issue 06.
- Every `parseConfig` caller uses `parseProjectFile`: in the client `bundle.ts`, `lib/assemble.ts`, `lib/update.ts`;
  in the CLI `packages/cli/src/commands/common.ts`, `collect.ts` and `packages/cli/src/lib/starter.ts`; in the IDE
  `update-service.ts` (below). In the CLI a newer version fails with "This project needs yukibana.json vN; this CLI
  reads up to vM. Update it: npm i -g @yukibana/cli@latest".
- IDE: `ide/extensions/yukibana/src/common/yukibana-config.ts` (today a thin wrapper over `parseSettings`) and its spec
  are deleted. `config-provider.ts`, `yukibana-layout-contribution.ts`, `languages/code-lens-providers.ts`,
  `suggestions-provider.ts`, `provider-toggle.ts` and `yukibana-cleanup-contribution.ts` use `ProjectFile` and
  `NO_PROJECT_FILE`. A folder without the file opens with `NO_PROJECT_FILE`; an invalid file shows a notification
  naming every bad field (today it is only logged); a newer version shows "This project needs yukibana.json vN; this
  IDE reads up to vM" with an action that opens the download page (issue 11 makes it "Restart to update" when an update
  is ready).
- **Assignment updates** (`ide/extensions/yukibana-cloud/src/node/update/update-service.ts`, `configIn`, `plan`, and
  `packages/client/src/lib/update.ts`): before planning, parse the newer release's `yukibana.json` from its starter. If
  its version is newer than this IDE reads, the check returns a new state, "needs a newer IDE" with the version, and
  nothing in the folder is written or planned. The frontend (`browser/update/update-contribution.ts`,
  `update-widget.tsx`, `update-texts.ts`) shows it with the same action as above.
- **Downloading a starter** (`cloud-service.ts` `downloadProject`, `@yukibana/client`'s `unpackStarter`) checks the
  starter's version the same way before unpacking anything.
- Worker: `cloud/web/src/routes/schema/yukibana.json/+server.ts` is deleted (the old URL is dropped). A new route
  `cloud/web/src/routes/schema/yukibana/[file]/+server.ts` serves `v{N}.json` from `@yukibana/project-schema`'s
  `schemas/` for every version it knows, and 404 for any other name. A released version is
  `cache-control: public, max-age=31536000, immutable`; the unreleased latest gets a short max-age until issue 06
  freezes it. `access-control-allow-origin: *` as today. `cloud/web/src/lib/kinds.ts` takes `KINDS` from the package.
  `cloud/web/tests/schema.test.ts` follows.
- `packages/fixtures/repo.tar.gz` is rebuilt with a strict v1 `yukibana.json`, and keeps what makes it a real fixture:
  a pax tarball with a wrapper directory, a global header, a long path and a hidden test, as `git archive` makes it.
  The script that makes it is committed next to it.
- `docs/cloud/yukibana-json.md` describes v1 (every field required, `$schema`, versions and what a newer one means).

## Out of scope

- The corpus, freezing released files, `config init`/`upgrade`, the IDE's JSON Schema registration (issue 06).
- The updater itself (issue 11).

## Design decisions already made

- Code only sees the latest type; a newer version fails naming both versions and the IDE offers its update (§7.1).
- The starter keeps the teacher's version, with `hidden: []` (§7.3).
- The IDE's own parser is deleted; the IDE and the CLI read the same parsed `ProjectFile` (§7.3).
- Whatever brings a newer release into a student's folder checks first that this IDE reads it, and otherwise offers
  the IDE update (§7.3; for the assignment updates, decision after the plan).
- Schemas served at `https://cloud.yukibana.dev/schema/yukibana/v{N}.json`, generated for the unreleased version
  (§7.4); the old `/schema/yukibana.json` is dropped (§2.1).

## Open questions

- Where the "newer IDE" action points before issue 11 exists: proposal `https://cloud.yukibana.dev/download/<os>`
  (issue 09), falling back to the GitHub releases page if 09 is not merged.
- Whether an invalid `yukibana.json` should also make the IDE's protected files writable or keep the last good
  settings. Proposal: keep `NO_PROJECT_FILE`'s settings and the notification; nothing silent.

## Acceptance criteria

- [ ] `git grep -n "parseConfig\|parseSettings\|configSchema\|settingsSchema"` finds nothing outside the package's
      history.
- [ ] Client tests: a starter's `yukibana.json` is the teacher's file at the teacher's version with `hidden: []`; a
      student's copy with only formatting changes is not reported as modified.
- [ ] CLI tests: each command refuses a newer version with the sentence above, and an invalid file with every field
      named.
- [ ] IDE unit tests (`config-provider.spec.ts`): no file gives `NO_PROJECT_FILE`; an invalid file notifies naming
      the fields; a newer version shows the newer-IDE message.
- [ ] `update-service.spec.ts`: a newer release whose `yukibana.json` is a version above `LATEST` yields "needs a newer
      IDE", and the folder's bytes and the journal are unchanged afterwards.
- [ ] Download test: a starter with a newer version is not unpacked, and the destination stays empty.
- [ ] Worker tests: `/schema/yukibana/v1.json` equals the package's file with the immutable header once released;
      `/schema/yukibana/v0.json`, `v99.json` and `/schema/yukibana.json` are 404. `sibling.test.ts` passes with the new
      route (read from `src/routes`).
- [ ] CI's "Check the fixture with the built CLI" step passes on the rebuilt fixture.
- [ ] IDE e2e: a strict v1 project opens with its settings applied.
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: 03, 04.
- Blocks: 06, 10.

## Manual steps for a maintainer

- None. Every `yukibana.json` in production starters and in the two course repositories stops parsing (accepted;
  issue 13).

## Risks

- Writing the starter at the teacher's version, while the program reads the latest, is easy to get backwards: the
  starter test above pins it.
- A hand-made fixture loses the properties that make it real; it is rebuilt with a committed script from `git archive`.
