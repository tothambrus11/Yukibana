# feat(project-schema): test-project corpus, frozen released schemas, config init and upgrade

**Labels:** `area:packages`, `area:cli`, `area:ide`, `area:ci`, `feature`, `size:M`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Last part of plan
step 7 (§7.4, §7.5, §6.1).

## Goal

Every released version of `yukibana.json` stays readable forever, and we know it because real-looking projects written
at each version are migrated and checked in CI. A released JSON Schema never changes under the files that name it.
Teachers get a complete file without reading the docs, and an upgrade path. Editors check the file offline. This
finishes problems 6 and 7 of §1.

## Scope

- **`test-projects/`** (`@yukibana/test-projects`, private), added to `pnpm-workspace.yaml`'s `packages` and the
  catalog:
  - `src/harness.ts`: `projectTest(name, fn)` reads `<name>/project/yukibana.json` at its own version, migrates it, and
    gives the test `project` (the latest `ProjectFile`), `starter()` (what the starter holds) and `assemble(submission)`
    (the result of assembling `submissions/<submission>` against the project). Parsing or migration failure fails the
    test.
  - At least `scala-basic-v1` and `rust-basic-v1` (both `KINDS`), each with `project/`, `submissions/` (synthetic:
    untouched, edited-readonly, edited-hidden) and `project.test.ts`, typed against the latest `ProjectFile`.
  - A test that every version up to `LATEST` has at least one project written at it.
  - `test-projects/README.md`: how to add a project, that projects are synthetic only, and what freezes when.
- **`packages/project-schema/released.json`**: the list of released versions, `[]` until the release PR of issue 10
  adds `1`. The schema generator never rewrites a released version's file.
- **Frozen files check**: `.github/scripts/frozen.mts` (with tests) fails when a PR changes a released version's
  `packages/project-schema/schemas/yukibana.v{N}.json` or anything under `test-projects/*-v{N}/project/` or
  `submissions/`, unless the PR has the `corpus-override` label. Wired into `ci.yml` through `plan.mts` when
  `@yukibana/test-projects` or `@yukibana/project-schema` is affected (§6.1's table).
- **CLI commands** in `packages/cli/src/commands/config.ts`, listed in `USAGE` and `docs/cloud/cli.md`:
  - `yukibana config init [<dir>] [--kind <kind>]` writes a complete latest-version file, every field and `$schema`;
    it refuses to overwrite an existing file.
  - `yukibana config upgrade [<dir>]` rewrites a file at an older version as the latest, through the migrations, and
    says which version it came from. On the latest version it changes nothing and says so.
- **The npm package ships the schemas**: `@yukibana/project-schema` exports `./schemas/*`; issue 10 puts them in the
  CLI tarball.
- **IDE schema registration**: a `JsonSchemaContribution` (`@theia/core/lib/browser/json-schema-store`) in
  `ide/extensions/yukibana/src/browser/` registers each bundled schema under its `$schema` URL, so a file is checked
  against the version it names, offline; files named `yukibana.json` without `$schema` get the latest; and
  `yukibana.release.json` gets its own.
- **IDE e2e**: a test in `ide/e2e/e2e/` opens the oldest and the newest corpus projects and checks that their
  settings are applied (a widget hidden, a file read-only).

## Out of scope

- Registering the schema with SchemaStore (§15).
- Dropping a version (§7.1: only deliberately, with a support window).

## Design decisions already made

- The corpus: synthetic projects and submissions only, typed tests against the latest type, no snapshots, frozen
  `project/` and `submissions/` once their version is released, the test file never frozen, `corpus-override` by a
  maintainer with the reason in the PR, at least one project per version, IDE e2e and release smoke open the oldest and
  newest (§7.5).
- Released schemas are static files CI keeps unchanged; only the unreleased version is generated (§7.4).
- Offline: the npm package ships `schemas/*` and the IDE registers them, picking the file by `$schema` (§7.4).
- `config init` writes every field; `config upgrade` rewrites to the latest (§7.1).

## Open questions

- **The harness needs the CLI's starter code** (`planStarter` in `packages/cli/src/lib/starter.ts`), which the
  monorepo PR kept out of `@yukibana/client` on purpose, and `@yukibana/cli` exports no library. Options: (a) run the
  built `yukibana build` as a subprocess and read its archives (tests the binary too, slower); (b) an internal export
  `@yukibana/cli/internal/starter` that the pack step of issue 10 removes. Proposal: (a).
- **The merge queue does not carry labels.** A `merge_group` event has no PR labels, so `frozen.mts` cannot see
  `corpus-override` there. Proposal: in the merge queue, look up the PR from the merge group's head ref with the
  GitHub API (`GITHUB_TOKEN`, read-only), or skip the check in `merge_group` because the PR run already enforced it on
  the same diff.
- Cache lifetime of the not-yet-released schema served by the Worker (issue 05): short until `released.json` lists it.

## Acceptance criteria

- [ ] `pnpm --filter @yukibana/test-projects test` migrates and checks every corpus project.
- [ ] A test fails when a version has no corpus project.
- [ ] `frozen.mts` tests: a change to a released schema fails; a change to a released corpus project fails; the same
      change with `corpus-override` passes; a change to an unreleased version or to a `project.test.ts` passes.
- [ ] CLI tests: `config init` output parses with `parseProjectFile` and has every field; it refuses to overwrite;
      `config upgrade` of each corpus project parses back unchanged by a second upgrade.
- [ ] The IDE marks a misspelt field in `yukibana.json` as an error with no network access (unit test of the
      contribution's registrations, plus a manual check).
- [ ] IDE e2e opens the oldest and newest corpus projects and sees their settings applied.
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: 05.
- Blocks: 10 (the release smoke opens corpus projects and the CLI ships the schemas).

## Manual steps for a maintainer

- Create the `corpus-override` label, and decide who may apply it (maintainers only).

## Risks

- A corpus that is slow to run is a corpus people skip; keep each project small.
- Someone copies a real course repository into the corpus; `test-projects/README.md` and the guide (issue 01) say synthetic only,
  because real repositories hold hidden tests and real submissions are personal data, and this repository is public.
