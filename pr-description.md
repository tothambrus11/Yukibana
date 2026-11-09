<!-- claude-projects-attribution: {"github_login":"tothambrus11"} -->
_Requested by **Ambrus** · [project thread](https://claude.ai/code/project/chan_01USNwCaufKq4uEbM83rR17R?thread=cmsg_01USNwCaufKq4uEbM83rR17RHSgmBp5n4qjpJqY2Ze5kiG)_

# One repository for the Yukibana IDE, cloud and CLI

This PR moves `tothambrus11/yukibana-cloud` (minus Light and the demo) into this repository. It does that as one
workspace, one toolchain and one CI, implementing steps 1–5 of `docs/monorepo-plan.md` (#71) on top of `main` 6dff1e2.
Light stays in the old repository, which becomes `yukibana-light` later (step 12).

**Merge with "Create a merge commit". Do not squash or rebase.** c116fcf imports the cloud's history (106 commits),
and `.git-blame-ignore-revs` names the reformat commit (25b5cbd) by sha. A squash loses both.

## Architecture

```
ide/                      the desktop and browser IDE (Theia)
  browser/  electron/     the two apps
  extensions/*            Theia extensions (yukibana, yukibana-cloud, yukibana-submission, …, langs/scala)
  common/                 code shared by the extensions (depends on @theia/core)
  e2e/  scripts/  configs/
cloud/                    the registry at cloud.yukibana.dev
  web/                    the SvelteKit Worker: pages, /api, the yukibana.json schema route
  db/                     Supabase: migrations, policies, pgTAP tests, ops/bootstrap.sql, Edge Functions
  dev/                    the local stack: compose, devcontainer, Nix shell, dev scripts
  CLAUDE.md               the cloud's rules (database only via migrations, authorisation in Postgres, same-site defences)
packages/                 shared libraries and the CLI; nothing here depends on Theia
  client/                 what the IDE and the CLI share
  cli/                    the `yukibana` command: teacher and student commands
  fixtures/               the test course repository (a real pax tarball), used by three packages
action/                   the GitHub Action course repositories use to publish releases
.github/scripts/          CI's own typed, tested scripts (plan, licenses, release-age, production config)
docs/cloud/               the cloud's architecture, design, deploy and local-development guides
```

### Packages and what they depend on

| Package | Path | Depends on (workspace) | Heavy tools it owns |
| --- | --- | --- | --- |
| `@yukibana/client` | `packages/client` | `fixtures` (tests only) | zod, modern-tar, ignore |
| `@yukibana/cli` | `packages/cli` | `client` | uuid |
| `@yukibana/fixtures` | `packages/fixtures` | | |
| `@yukibana/cloud-web` | `cloud/web` | `client` (the schema, `KINDS`), `fixtures` (tests) | SvelteKit, wrangler, postgres, supabase-js |
| `@yukibana/cloud-db` | `cloud/db` | | Supabase CLI, squawk |
| `@yukibana/cloud-dev` | `cloud/dev` | `cloud-db`, `cloud-web` | |
| `@yukibana/ide` | `ide` | | @theia/cli |
| `@yukibana/ide-common` | `ide/common` | `ide` | @theia/core |
| `@yukibana/ide-ext`, `-cloud-ext`, `-submission-ext`, `-telemetry-ext`, `-launcher-ext`, `-product-ext`, `-scala-lang-ext` | `ide/extensions/*` | `ide`, `ide-common`, `client` (cloud, submission and core extensions) | @theia/* |
| `@yukibana/ide-browser`, `@yukibana/ide-electron` | `ide/browser`, `ide/electron` | the extensions | Electron (electron app only) |
| `@yukibana/ide-e2e` | `ide/e2e` | `ide` | Playwright |
| `@yukibana/ci-scripts` | `.github/scripts` | | |

```
ide/electron, ide/browser ─▶ ide/extensions/* ─▶ ide/common
                                     │
                                     ▼
packages/cli ───────────────▶ packages/client ◀──── cloud/web ◀── cloud/dev ──▶ cloud/db
                                     │                  │
                                     └──▶ packages/fixtures ◀┘ (tests)
```

- **`@yukibana/client`** is the registry client, login and sessions, packing, unpacking, assembly, the update planner and
  the `yukibana.json` parser and schema. It has two entry points. `.` is the Node library. `./config` is the
  browser-safe config parser that IDE frontend code imports. The JSON Schema it generates is exported as
  `./yukibana.schema.json`, and the Worker serves it from there.
- **`@yukibana/cli`** holds the commands, plus the teacher-only code the IDE never needs: building releases (`starter`,
  `store`), grading and names.
- **The IDE uses only `@yukibana/client`,** and it doesn't need Supabase, Docker or the cloud's code. The cloud
  doesn't need Electron or Theia.
- **Every dependency is declared** in the package that uses it, with its version in the strict catalog. Nothing
  resolves only by hoisting, and no package reads another's files by relative path.

### Toolchain

- **One pnpm 12 workspace and one lockfile,** with `catalogMode: strict`: every version is named once. The one
  exception is a named `ts6` catalog for `cloud/web`, because `svelte-check` doesn't support TypeScript 7 yet.
- **Node 24 everywhere,** downloaded by pnpm itself (`devEngines.runtime`, an exact pin).
- **TypeScript 7** (6 for `cloud/web`), oxlint and oxfmt, and Vitest.
- **One strict TypeScript base and one strict oxlint base** that `packages/*` and the cloud extend with their
  exceptions.
- **`minimumReleaseAge` 14 days,** which `pnpm install --frozen-lockfile` also enforces on the lockfile, and the same
  14-day Dependabot cooldown.
- **`pnpm setup:ide`, `setup:cloud` and `setup:cli`** install one area. An IDE developer never downloads Supabase,
  squawk or workerd, and a cloud developer never downloads Electron, Theia or its plugins.

### CI and deploys

- **`ci.yml`:** a `plan` job reads pnpm's package graph (`...[base]`), and the other jobs run only for what the change
  affects:
  - lint, typecheck, build and the unit tests of each affected package;
  - the cloud stack (migrations from empty, pgTAP, the integration suite);
  - IDE e2e on Linux, Windows and macOS, plus a Linux packaging check;
  - the devcontainer build;
  - the license allowlist.

  One required check, `ci-ok`, passes when every job passed or was skipped as unaffected. The workflow runs in the
  merge queue (`merge_group`), so the commit that lands is the one that was tested.
- **`deploy-cloud.yml`** deploys only after CI passed on `main` and actually ran the cloud stack. It runs migrations,
  then `ops/bootstrap.sql`, then the Supabase config, then the Worker. It never deploys over a newer deploy, and runs
  only in ISC-HEI/Yukibana.
- **`preview.yml`:** once a maintainer approves, it uploads a preview of the PR's Worker for any PR from a branch of
  this repository that affects `cloud/web`. The preview runs against production's database and bucket, without the
  PR's migrations, and the PR comment says so. Email-code login works there, GitHub login doesn't.
- **`package.yml`** builds the installers for a `v*` tag on `main`, with the version taken from the tag.
- **`drift.yml`** checks nightly that production matches the migrations.

## What's better than the two repositories

| | Before | Now |
| --- | --- | --- |
| A schema or API change | A PR in each repository, then a commit sha bumped in two places of `pnpm-workspace.yaml`. Each `main` saw a different contract in between. | One PR. The IDE uses `workspace:*`. |
| The CLI library in the IDE | `github:` dependency built through `prepack` on every install | A workspace package, built once |
| Toolchains | npm vs pnpm, Node 22 vs 24, two lint configs, `min-release-age` 3 vs 7 days, two Dependabot configs | One workspace, Node 24, one catalog, 14 days, one Dependabot |
| What the IDE and the CLI share | The whole CLI package, teacher code included | `@yukibana/client` only. Teacher-only code stays in the CLI. |
| Installing one area | Everything | `setup:ide` / `setup:cloud` / `setup:cli` |
| CI | Each repository ran everything, with path filters a required check couldn't use | Only the affected packages, one required `ci-ok`, a merge queue |
| Cloud deploys | Workers Builds deployed every push to `main`, even with CI red, unordered with the migration | Migrations first, then the Worker, only after CI passed, never over a newer deploy |
| The served `yukibana.json` schema | Imported by a relative path. A change didn't redeploy. | Exported by the client. A change redeploys. |
| Previews | None | Approved Worker previews on PRs |
| Installers | A tag's builds were Actions artifacts that expired after a day, and the version was always 0.1.0 | Built only from a tag on `main`, with the tag's version, and packaged on Linux in CI |
| Rules for coding agents | Cloud rules only in the cloud repository | `cloud/CLAUDE.md`, imported for `packages/` too |
| Contracts | Partial in the cloud, few in the CLI | Every exported function, type and field |

## The commits

1. **Import** (c116fcf, a merge commit): yukibana-cloud `main` 236a5de, filtered with git-filter-repo into the paths
   above. Bare `#N` in messages now read `tothambrus11/yukibana-cloud#N`. No `light/` or `demo/` history, and no
   tags. The recipe is in c116fcf's body, with corrections in a56b93d's body.
2. **Layout** (bc48ed5–ed11231): `ide/`, `packages/client`, and every path change of §2.1.
3. **pnpm** (4b71fe7, e7cd0a8): the workspace, catalogs and Node 24.
4. **Format** (25b5cbd, a36e7cf): the shared oxfmt config, and the blame ignore. The SPDX headers from 63ccf42 were
   reverted later, because they aren't required.
5. **CI and deploys** (6041407 onwards).

After those come three review rounds, each by independent reviewers with every finding checked, plus the
contract pass:
- packaging fixed;
- deploys gated on CI;
- previews for UI PRs;
- module boundaries tightened (teacher-only code back in the CLI, `./config`, declared dependencies);
- machinery removed (no special cases in the CI plan, one config base each);
- every export given its contract.

## Spikes (§17)

- **S2:** filtered installs keep areas apart, and `svelte-check` uses TypeScript 6.
- **S5:** pnpm downloads Node 24. `minimumReleaseAge` doesn't cover the runtime, so it's an exact pin, bumped by
  hand.
- **S1:** a too-young lockfile entry fails `pnpm install --frozen-lockfile` and `pnpm ci`. An exclusion must also list
  each too-young transitive dependency by exact version. Dependabot's side can't be tested outside GitHub.
- **S6:** email-code login works on a preview. GitHub login doesn't: it would need a wildcard redirect URL, which
  would let other Workers receive production logins, so none was added.

## Deviations from the plan

- Catalog versions follow the plan's rule (newest at least 14 days old) where its table had gone stale: wrangler
  4.152.0, supabase 2.122.0 and oxlint-tsgolint 7.0.2005.
- `@yukibana/cli` stays `private` until the release PR.
- `packages/fixtures` is new: three packages read the test course repository, so it has an owner the graph sees.
- `cloud/dev` and `.github/scripts` are workspace packages, so CI checks them like any other.
- squawk runs as `@yukibana/cloud-db`'s `lint`.
- Dependabot has no docker-compose entry: both compose images are `latest`.

## Checked

- **Here:** a clean clone runs `pnpm install --frozen-lockfile`, `format:check`, `lint`, `typecheck` and `test`. Also
  the IDE build, `pnpm package` on Linux (AppImage and deb), the cloud's build and wrangler dry-run bundle, squawk,
  and `plan.mts` on sample changes.
- **Only CI or a person can check:**
  - the cloud stack and the devcontainer build (they need Docker);
  - IDE e2e and packaging on Windows and macOS;
  - a real preview upload and deploy;
  - the merge queue settings.

## Before merging: the cutover

**Merging this PR is the first production deploy from this repository.** Do the steps at the top of
`docs/cloud/deploy.md`, in order:

1. Freeze yukibana-cloud's cloud parts (no merges outside `light/`). If anything merged there after 236a5de, re-run
   the import first.
2. Disconnect the Worker from Workers Builds, and disable yukibana-cloud's `database.yml`, `drift.yml`, `ci.yml` and
   `ci-devcontainer.yml`. Keep its `CLOUDFLARE_*` secrets, because they deploy Light.
3. Create this repository's `production` and `preview` environments and their secrets.
4. In `main`'s branch protection:
   - remove `build.yml`'s required checks;
   - require `ci-ok`;
   - turn on the merge queue with the **merge commit** method. "Require branches to be up to date" adds nothing with
     a merge queue.
5. Merge.

Left for later PRs (6–12 of the plan): merging the contributor guides, the versioned `yukibana.json`, `/api/v1`, the
license, the release pipeline and the updater.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_011CH6tLbdpe6LmTTpuoFycR
