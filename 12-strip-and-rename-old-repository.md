# chore: strip tothambrus11/yukibana-cloud down to Light and rename it yukibana-light

**Labels:** `area:light`, `manual-steps`, `size:M`. The PR is in `tothambrus11/yukibana-cloud`; this issue tracks it
from `ISC-HEI/Yukibana`.

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`) and its cutover. Plan
step 12 (§4.1 step 6).

## Goal

Each product lives in one repository: the cloud, the CLI and the IDE in `ISC-HEI/Yukibana`, Light in
`yukibana-light`. This finishes problem 1 of §1 (two repositories for one contract). Problem 16 (Light is same-site
with the cloud) is not fixed by a rename; the cloud's same-site defences stay.

## Scope (in the old repository, at `origin/main` 236a5de or later)

- **Keep:** `light/`; the `light-*` workflows (`light-caches`, `light-ci`, `light-haskell-ghc`, `light-haskell-ghc-tools`,
  `light-haskell-inputs-release`, `light-kotlin-graalvm`, `light-modules`, `light-packs`, `light-release`,
  `light-swift-lsp-lite`, `light-swift-toolchain`, `light-toolchain-unit`); `.github/actions/once` **and**
  `.github/actions/light-swift-toolchain` (the plan names only `once`, but the Light workflows use both); and whatever
  root file Light's CI turns out to read (check `.gitattributes`, `.gitignore`).
- **Delete:** `app/`, `cli/`, `supabase/`, `ops/`, `dev/`, `scripts/`, `action/`, `docs/`, `demo/`, `.devcontainer/`,
  `wrangler.jsonc`, `.squawk.toml`, `.dev.vars.example`, `.env.example`, `.envrc`, `flake.nix`, `flake.lock`, `.npmrc`,
  the root `package.json`, `package-lock.json` and `oxfmt.config.mts` (if Light does not use them), `CLAUDE.md`,
  `.wrangler/`, and the cloud workflows `ci.yml`, `ci-devcontainer.yml`, `database.yml`, `drift.yml` (already
  disabled at the cutover).
- A new root `README.md` for Light, pointing at `ISC-HEI/Yukibana` for the rest.
- **Hard-coded URLs** to `tothambrus11/yukibana-cloud`, updated although the rename redirects:
  - `light/modules/runtime/package.json` and `light/modules/protocol/package.json` (`repository.url`);
  - `light/scripts/pack-store.sh` (the default repository, lines 132 and 184);
  - `light/packs/kotlin/kotlinc/build.sh` (lines 51, 284, 292), `light/packs/kotlin/graalvm/build.sh` (line 87),
    `light/packs/swift/build.sh` (line 91), `light/packs/haskell/build.sh` (lines 59, 107, 132);
  - prose mentions in `light/prototypes/runner-isolation/README.md` and
    `light/toolchains/swift/docs/upstream-todo-resolvedcursorinfo.md`, where they name the repository rather than a
    historical PR.
- **Tags:** keep `light-packs-*`, `light-toolchains-*`, `haskell-inputs-*` and `kotlin-graalvm-*`; Light's build
  scripts download their releases. No cloud tags exist to remove (`git ls-remote --tags origin` shows only these four
  families).
- **Secrets:** keep `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (they deploy Light; `light-release.yml` reads
  them from its `light` environment). Delete `SUPABASE_*`, `APP_DB_PASSWORD` and `FIRST_ADMIN_EMAIL` once the cloud has
  deployed from `ISC-HEI/Yukibana` at least once.
- **Rename** the repository to `yukibana-light`. GitHub keeps its releases and redirects the old URLs.
- **In `ISC-HEI/Yukibana`:** `docs/cloud/deploy.md` line 10 (`gh workflow disable <file> -R
  tothambrus11/yukibana-cloud`) becomes past tense or goes; the imported commit messages' `tothambrus11/yukibana-cloud#N`
  links keep working through the redirect and are left as they are.
- Any open cloud issue still in the old repository moves to `ISC-HEI/Yukibana` (§4.1 step 1).

## Out of scope

- Moving Light to a registrable domain of its own (§15), which is what would let the cloud drop its same-site defences.
- Light's license.

## Design decisions already made

- Light keeps the old repository, renamed `yukibana-light`; renaming keeps its GitHub Releases and redirects the old
  URLs; the hard-coded URLs are updated anyway; its Cloudflare secrets stay (§0, §4.1 step 6, summary).

## Open questions

- Which root files Light's CI needs: confirm by running `light-ci.yml` on the stripped branch before merging.
- Light's license, now that the rest is Apache-2.0: the old repository's owners decide.

## Acceptance criteria

- [ ] `git ls-files` on the stripped branch lists only `light/`, the kept workflows and actions, and the root files
      Light needs.
- [ ] `light-ci`, `light-modules` and a `light-release` dry run pass on the stripped branch.
- [ ] A pack build (for example `light/packs/haskell/build.sh`) downloads its inputs from the new URLs.
- [ ] After the rename, `curl -sI https://github.com/tothambrus11/yukibana-cloud/releases/download/<a light tag>/<file>`
      still redirects to the file.
- [ ] The database secrets are gone from the old repository; the Cloudflare ones remain.
- [ ] `git grep tothambrus11/yukibana-cloud` in `ISC-HEI/Yukibana` finds only history references.

## Depends on / Blocks

- Depends on: the cutover (the cloud deploys from `ISC-HEI/Yukibana`), and 13: the two course repositories use the
  old repository's `action/` (`tothambrus11/yukibana-cloud/action@main`, §1 problem 8), so it is deleted only after
  they moved to `ISC-HEI/Yukibana/action@action-v0`.
- Blocks: nothing.

## Manual and irreversible steps for a maintainer

- The owner of `tothambrus11/yukibana-cloud` renames it and prunes its secrets and branch protection.
- Never create a new repository called `yukibana-cloud` under that account: it would break every redirect.

## Risks

- Workflows elsewhere that `uses:` an action from the old repository by its old name rely on GitHub's redirect for
  actions, which is not guaranteed; update them.
- A Light build script that downloads from a URL not listed above breaks only when the redirect does; `git grep
  yukibana-cloud light/` before merging finds them.
