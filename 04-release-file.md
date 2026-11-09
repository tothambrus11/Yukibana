# feat(client)!: move release identity out of yukibana.json into yukibana.release.json

**Labels:** `area:packages`, `area:ide`, `area:cli`, `breaking`, `size:M`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Part of plan step 7
(§7.3).

## Goal

`yukibana.json` has one shape in a course repository and in a starter. The starter's identity (which project, which
release) moves to `yukibana.release.json`, which only `yukibana build` and `publish` write. This is the half of problem
6 of §1 that the strict schema needs: v1 (issue 03) has no `projectId` or `releaseId`.

Today the ids are fields of `yukibana.json` (`Settings.projectId`, `Config.releaseId` in
`packages/client/src/lib/yukibana.ts`), `starterConfig` writes them into the starter's copy, and the IDE's assignment
updates use them as the folder's **stamp**: `ide/extensions/yukibana-cloud/src/node/update/update-service.ts` reads it
(`stampOf`), checks a downloaded starter by it (`fetchStarter`), and moves it (`onlyTheStamp`); the planner writes
`yukibana.json` last (`rank` in `packages/client/src/lib/update.ts`) and the journal's rollback restores it last
(`journal.ts`), so a host that stops halfway still knows where it was. The plan's call-site list (§7.3) predates the
updates and misses them.

## Scope

Call sites, at their paths on the branch:

- `packages/client/src/lib/yukibana.ts`: `RELEASE_FILE = 'yukibana.release.json'`. `projectId` and `releaseId` leave
  `Settings`, `Config`, `settingsShape` and `configSchema`. `ALWAYS_EXCLUDED` gains `RELEASE_FILE` (a course
  repository's tree never contributes one). `starterConfig(config)` no longer takes ids; a new
  `releaseFileText(projectId, releaseId)` writes the release file (through `@yukibana/project-schema`'s schema).
  `sameStudentConfig` drops its id special case. `NEVER_SUBMITTED` does **not** gain it: a submission carries the claim.
- `packages/client/src/lib/pack.ts`: a submission always holds `RELEASE_FILE` when the folder has one, as it always
  holds `CONFIG_FILE` today (`included`, line 106), whatever `submission.include` says.
- `packages/client/src/bundle.ts`: `SubmissionBundle.projectId` and `releaseId` come from the folder's release file
  (parsed with `parseReleaseFile`); no file gives nulls; an invalid one is a bundle problem naming the file.
- `packages/client/src/lib/update.ts`: the stamp is the starters' release files (`plan.from`, `plan.to`); `RELEASE_FILE`
  is protected like `CONFIG_FILE`; `rank` writes `yukibana.json` second to last and `yukibana.release.json` last;
  `onlyTheStamp` is true when only the release file is written (and `yukibana.json` is unchanged).
- `packages/client/src/lib/assemble.ts`: the student's release file is neither protected nor reported as modified.
- `packages/cli/src/lib/starter.ts` (`planStarter`) and `packages/cli/src/build.ts`: the starter gets
  `yukibana.release.json` only when the build has a project and a release id; `check`, and `build` without
  `--project`, write none, so a student cannot submit from a preview build.
- `packages/cli/src/commands/release.ts`: the `isProjectId` error says the release file would be refused.
- `packages/cli/src/commands/common.ts` (`projectOf`): the default project comes from the release file.
- `packages/cli/src/commands/collect.ts` (`claimedRelease`): the claim comes from the submission's release file.
- `ide/extensions/yukibana-cloud/src/browser/welcome/welcome-model.ts` (`projectIdOf`, `CONFIG_FILENAME`) and
  `project-locations.ts` (`projectIdAt`, `stateOf`): a folder is recognised by its release file, parsed with
  `@yukibana/project-schema` (browser-safe).
- `ide/extensions/yukibana-cloud/src/node/update/update-service.ts`: `stampOf` reads the release file; `fetchStarter`
  checks the downloaded starter's release file names the release; the "nothing else changed" path places the
  release file; the error "yukibana.json does not say which release this folder started from" names the release file;
  the rows shown to the student leave out both files.
- `ide/extensions/yukibana-cloud/src/node/update/journal.ts` (`rollBack`): the release file is restored last and
  `yukibana.json` just before it.
- `ide/extensions/yukibana-cloud/src/node/cloud-service.ts`, `ide/extensions/yukibana-submission/src/node/submission-service.ts`
  and `submission-frontend-contribution.ts` keep their signatures; their `projectId` now comes from the bundle's
  release file. Check that nothing else reads the ids from `yukibana.json`.
- `cloud/web/src/lib/server/releases.ts`: the contract comment of `publishRelease` names the release file. The Worker
  never reads archives, so nothing else changes there.
- Docs: `docs/cloud/yukibana-json.md`, `docs/cloud/cli.md`, `docs/cloud/theia.md`, `docs/cloud/architecture.md`.

No fallback reads ids from an old `yukibana.json`: there are no users, and production's old releases are dealt with in
issue 13.

## Out of scope

- The strict v1 switch (issue 05). Here the client's loose schema simply loses the two fields, so an old starter's ids
  become an "unknown field" warning.

## Design decisions already made

- `yukibana.release.json` at the starter's root, strict, all required, versioned, written only by `build`/`publish`; a
  course repository has none; a preview build writes none (§7.3).
- It is the student's claim: submitted, not protected from the student, and kept by the registry only when it names
  a release of the same project (§7.3, and migration `20261021130000_release_ids_in_starters.sql`).
- `collect` and assembly read the claim from the submission's release file; assembly takes `yukibana.json` and the
  protected files from the teacher's release (§7.3).
- The update flow's stamp moves to the release file, and "the stamp is written last" follows it (decision after the
  plan).

## Open questions

- Should an invalid release file block `submit` (the registry cannot tell which project) or only drop the release id?
  Proposal: block, unless `--project` (CLI) names the project, because a wrong project is worse than no submission.

## Acceptance criteria

- [ ] No code reads `projectId` or `releaseId` from `yukibana.json` (a test parses a file that has them and gets the
      unknown-field warning, not an id).
- [ ] CLI tests (`packages/cli/tests/starter.test.ts`, `release-id.test.ts`, `pack.test.ts`): `build --project` writes
      the release file with the chosen ids; `check` and `build` without `--project` write none; a course repository's
      own `yukibana.release.json` is not in the starter.
- [ ] Client tests (`yukibana.test.ts`, `bundle.test.ts`, `assemble.test.ts`, `publish.test.ts`): a submission holds
      the release file even when `submission.include` leaves it out; the bundle's ids come from it; assembly neither
      protects nor reports it.
- [ ] Planner tests (`update.test.ts`): the release file is the last write and `yukibana.json` the one before;
      `onlyTheStamp` holds when only the release file differs; both files are protected.
- [ ] IDE tests (`update-service.spec.ts`, `welcome-model.spec.ts`, `project-locations.spec.ts`,
      `cloud-service.spec.ts`): the stamp is read from the release file; a rollback that stops halfway leaves the old
      release file; a starter whose release file names another release is refused; a folder with ids only in
      `yukibana.json` is not recognised as the project's copy.
- [ ] Integration (`cloud/web/tests/integration`): a release published by token and by owner, then a submission from
      its starter, records `base_release_id` from the release file; a release file naming another project's release
      leaves `base_release_id` null.
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: 03 (`parseReleaseFile`, the release file's schema).
- Blocks: 05.

## Manual steps for a maintainer

- None. Existing starters in production lose their stamp for the IDE (accepted; issue 13).

## Risks

- The stamp ordering is what makes an interrupted update recoverable; a mistake there leaves a folder that claims a
  release it does not hold. The planner and journal tests above cover both orders.
- A student can edit the release file; that was already true of `yukibana.json` and the registry already checks it.
