# ci: release the IDE and the CLI together from a vX.Y.Z tag

**Labels:** `area:ci`, `area:ide`, `area:cli`, `release`, `manual-steps`, `size:L`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Plan step 10 (§10.1,
§10.2, §10.3, §12).

## Goal

Pushing a tag `vX.Y.Z` on `main` is the only way to release, and nothing becomes public until everything was built,
installed and tested from the release's own files. The CLI goes to npm and course repositories run the published CLI.
This fixes problems 8, 10, 11 and 12 of §1, and prepares 14 (the signing hook's place).

Today, on the branch:

- `.github/workflows/package.yml` builds installers for a `v*` tag on `main` into Actions artifacts kept 1 day, with
  the version set by `pnpm pkg set` in `ide/electron` only. No GitHub Release, no npm package.
- `ide/electron/electron-builder.yml` names artifacts **without** the version (`${productName}Setup.${ext}`,
  `${productName}.${ext}`), publishes to three `yukibana.isc-vs.ch` URLs, and `package.yml` edits the macOS URL with
  `sed`. Linux builds `deb` and `AppImage`.
- `packages/cli` is `private`, built with `tsc` into `lib/`, with no `--version` until issue 08.
- `action/action.yml` installs the workspace with pnpm and runs `packages/cli/lib/index.js` from the action's own
  checkout, and interpolates `${{ inputs.* }}` straight into its bash scripts. Its header tells course repositories
  to use `ISC-HEI/Yukibana/action@main`.

## Scope

- **`.github/workflows/release.yml`**, replacing `package.yml` (deleted). Triggers: `push: tags: ['v[0-9]+.[0-9]+.[0-9]+']`
  and `workflow_dispatch` as a **dry run** (every job but `publish`).
  - `verify`: the tag's commit is on `main` (as `package.yml` checks today); valid semver; higher than the last
    published release. The pure checks live in `.github/scripts/release-checks.mts` with tests. It creates the draft
    release once, with notes from git-cliff (`cliff.toml` at the root).
  - `test`: lint, typecheck and unit tests of the whole workspace, the corpus included.
  - `cli`: `ide/scripts/release-version.mts "$V"` (new) writes the version into `ide/electron`, `ide/browser` and
    `packages/cli` in the checkout only. tsdown (`packages/cli/tsdown.config.ts`, newest version at least 14 days
    old in the catalog) bundles `@yukibana/client`, `@yukibana/project-schema` and `@yukibana/api` into `dist/`;
    `zod`, `modern-tar`, `ignore` and `uuid` stay real dependencies. `pnpm pack`, then a script
    (`.github/scripts/pack-cli.mts`, tested) drops `devDependencies` and workspace packages from the packed manifest.
    Smoke: `npm i -g` the tarball in an empty folder; `yukibana --version` equals the tag; `check`, `build` and
    `assemble` on the oldest and newest corpus projects; the tarball holds only `dist`, `schemas`, `LICENSE`,
    `NOTICE` and `ThirdPartyNotices.txt`, and its manifest has no `workspace:` or `catalog:`.
  - `ide` on `windows-2022`, `ubuntu-22.04`, `macos-15` (arm64) and `macos-15-intel`: set the version,
    `electron-builder --publish never`, upload to the draft. Smoke: install (NSIS `/S`, the AppImage, the macOS zip),
    start it with Playwright, wait for the workbench, open the oldest and newest corpus projects, check their settings
    are applied, quit (a new `ide/e2e/smoke/` with its own Playwright config pointing at the installed app).
  - `publish` (environment `release`, needs every job): `actions/attest-build-provenance` on every file; `npm publish`
    of the tested tarball with provenance, skipped if that version is already on npm; publish the draft, skipped if
    already published; move the `action-v<major>` tag to this commit.
- **`packages/cli/package.json`**: no `private`, `publishConfig.access: public`, `bin` from `dist/`, `files`,
  `engines.node: ">=24"` (already). A daily "a newer version is available" line on stderr, cached in the CLI's config
  folder, off when `CI` is set or stderr is not a terminal (§12), with unit tests.
- **`ide/electron/electron-builder.yml`**: artifact names with the version (`Yukibana-Setup-${version}.exe`,
  `Yukibana-${version}-${arch}.zip`/`.dmg`, `Yukibana-${version}.AppImage`), accepted by issue 09's
  `release-files.ts` (a test runs it over `dist/`); one top-level `publish: { provider: generic, url:
  https://cloud.yukibana.dev/updates/ }`; the three `yukibana.isc-vs.ch` URLs go, and so does the `sed` step; Linux
  builds only the AppImage; NSIS stays per-user. No `win.publisherName`. A comment marks
  `win.signtoolOptions.sign` as where signing goes (§14).
- **`action/action.yml`**: `actions/setup-node` with Node 24, then `npx -y @yukibana/cli@<major> publish ...`, the major
  taken from `github.action_ref` (`action-v0` gives `0`). Inputs reach the script through `env:`, never through
  `${{ }}` inside `run:`. The header says `uses: ISC-HEI/Yukibana/action@action-v0`.
- **Docs**: a Releasing section in `CONTRIBUTING.md` (how to tag, the dry run, what to do with a failed draft);
  `docs/cloud/cli.md` installs the CLI from npm.

## Out of scope

- The updater and the release's update test (issue 11, which adds that job here).
- Signing (§14), merging the two `latest-mac.yml` files, a prerelease channel, a changelog file.

## Design decisions already made

- Versions exist only in tags; every `package.json` in git says `0.0.0-dev`; the release triggers on
  `v[0-9]+.[0-9]+.[0-9]+` only; a tag ruleset limits `v[0-9]*` to maintainers; the first release is `v0.1.0`; the IDE
  and the CLI release together under one version; git-cliff notes; no prerelease channel (§10.1).
- The pipeline, drafts until everything passed, npm before the GitHub release, re-running `publish` finishes what is
  missing, a bad release is fixed by a new patch (§10.2).
- Versioned artifact names, the generic provider through the Worker, AppImage only on Linux, two macOS runners,
  per-user NSIS (§10.3).
- The CLI bundled with tsdown, only real runtime dependencies in the manifest, `engines.node >=24`, ships `schemas/*`,
  `LICENSE` and notices; the first publish with a short-lived token, trusted publishing (OIDC) from the second; the
  Action runs `npx -y @yukibana/cli@<major>` and course repositories use `action-v<major>` (§12).
- No signing for now, no `win.publisherName` while unsigned (§14).

## Open questions

- **O3: is `ide/browser` deployed anywhere?** If yes, this pipeline (or `deploy-cloud.yml`) gets a deploy job for it.
  If no, the release builds only the Electron app and `release-version.mts` still stamps `ide/browser` for its About
  dialog.
- **Should `v0.1.0` wait for issue 11?** An app installed from a release without the updater never updates itself.
  Proposal: merge this, run the dry run, merge 11, then tag `v0.1.0`.
- Does the `release` environment's protection allow moving the `action-v*` tag under the tag ruleset? The ruleset must
  cover `v[0-9]*` only, so `action-v*` stays movable by the workflow.

## Acceptance criteria

- [ ] A dry run (`workflow_dispatch`) on `main` passes every job and leaves a draft, which is then deleted.
- [ ] `release-checks.mts` tests: a tag not on `main`, a non-semver tag, and a version not higher than the last release
      are each refused with a sentence.
- [ ] The CLI smoke passes from the tarball alone; the manifest and file-list checks fail on a planted `workspace:`
      dependency and on a stray file.
- [ ] The IDE smoke passes on all four targets, opening the oldest and newest corpus projects.
- [ ] The built artifact names pass issue 09's `release-files.ts`.
- [ ] `gh attestation verify` succeeds on one installer and on the tarball of the first real release.
- [ ] `action/action.yml` passes actionlint, and no `${{ inputs.` appears inside a `run:`.
- [ ] Every new exported function, type and field (scripts included) has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: 02 (the files to ship; `v0.1.0` waits for the consent), 06 (corpus and schemas), 07 (the published CLI
  speaks `/api/v1`), 08 (`--version`, the version source).
- Blocks: 11, 13.

## Manual and irreversible steps for a maintainer

- Register the npm organisation `yukibana`.
- Create the `release` environment (required reviewers, deployments from `v*` tags only) and the tag ruleset for
  `v[0-9]*` (maintainers only). An organisation admin does both.
- Before `v0.1.0`: a PR that adds `1` to `packages/project-schema/released.json`, which freezes v1's schema and corpus.
- For `v0.1.0` only: a short-lived granular npm token with publish rights on `@yukibana`, stored as `NPM_TOKEN` in the
  `release` environment. **The first publish is permanent**: a published version can never be reused.
- Immediately before the second release (npm drops an unused trusted-publisher setup after 48 hours): configure the
  trusted publisher (`ISC-HEI/Yukibana`, workflow `release.yml`, environment `release`), delete `NPM_TOKEN`, and turn
  off token publishing for the package. When the repository moves organisation, update the trusted publisher.
- Each release: push the tag; approve the `publish` job; delete the draft of a failed run.

## Risks

- npm's OIDC publishing needs a recent npm (11.5 or newer) in the job; pin it.
- macOS Intel runners (`macos-15-intel`) are being retired by GitHub; when they go, `macos-x64` needs another plan.
- Four installers smoke-tested on real runners can be flaky; a flaky smoke blocks a release, which is the intended
  failure mode, but needs a quick re-run path (re-run failed jobs keeps the draft).
- Anyone who installed a `.deb` from a `package.yml` run gets no updates once Linux is AppImage only; there are no
  users yet.
