# feat(cloud): an update feed and download links for the IDE, served from GitHub releases

**Labels:** `area:cloud`, `spike`, `size:M`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Part of plan step 10
(§10.3), with spike S4 (§17).

## Goal

Installed IDEs look for updates at `https://cloud.yukibana.dev/updates/`, so they do not depend on where the
repository lives, and the website links to `https://cloud.yukibana.dev/download/<os>`. The Worker answers both from
the repository's published GitHub releases. This prepares problems 12 and 13 of §1 (a dead update URL, no updater).

Today `ide/electron/electron-builder.yml` publishes to `https://yukibana.isc-vs.ch/download/...`, which does not
respond, and the Worker has no such routes.

## Scope

1. **Spike S4** first, on a throwaway branch: build two versions of the app by hand (for example `0.0.1` and `0.0.2`,
   with artifact names that carry the version, as issue 10 will make them) and publish them as releases of a test
   repository or fork; deploy the routes below as a Worker preview; point electron-updater's generic provider at the
   preview's `/updates/`. Check on Windows (NSIS) and Linux (AppImage):
   - it follows the `302`s for `latest.yml` / `latest-linux.yml` and for the installer;
   - a **differential** update works: the previous version's `.blockmap` is found by file name, and range requests
     survive the redirect to GitHub's asset host (`useMultipleRangeRequest: false` is set for Windows today);
   - the result is posted here. If it fails, the fallback is GitHub as the update provider (which ties installed apps
     to the repository's location), and that needs the maintainer's decision.
2. **Routes** (GET only, no cookies, no database):
   - `cloud/web/src/routes/updates/[file]/+server.ts`: `latest.yml`, `latest-linux.yml` and `latest-mac.yml` redirect
     to that file of the newest published release. Any other name must carry a version (the installer, the zip, the
     AppImage, a `.blockmap`), and redirects to that exact file in release `v<that version>`, so a release published
     in between cannot mix two versions. Anything else is a 404.
   - `cloud/web/src/routes/download/[target]/+server.ts`: `windows`, `linux`, `macos-arm64`, `macos-x64` redirect to
     the newest release's installer for that target; anything else is a 404.
3. **`cloud/web/src/lib/release-files.ts`**, pure: the artifact name patterns (with the version), the version in a
   name, and which asset is the installer for each target. Issue 10's electron-builder config must produce names it
   accepts, and a test there checks that against the built files.
4. **`cloud/web/src/lib/server/github.ts`**: the newest published release (not a draft, not a prerelease) from the
   GitHub API with a read-only token, cached with the Cache API for a few minutes. If GitHub fails or rate-limits,
   it serves the last good answer, kept under a second cache key with a long lifetime. Failures are `report()`ed.
5. **Config**: `RELEASES_REPOSITORY` (`ISC-HEI/Yukibana`) in `cloud/web/wrangler.jsonc`'s `vars`, so the
   organisation move changes one value and no installed app; the token as a Worker secret `GITHUB_RELEASES_TOKEN`;
   both read in `configOf` (`lib/server/env.ts`). Without the token the routes answer `503` with a sentence.
   `.dev.vars.example` names it.
6. Docs: `docs/cloud/deploy.md` (the token, its permissions, its rotation).

## Out of scope

- The electron-builder changes (versioned names, the generic provider URL, removing the old URLs and the macOS `sed`):
  issue 10.
- The updater in the IDE: issue 11.
- Merging the two `latest-mac.yml` files: waits for macOS signing (§10.3, §14).

## Design decisions already made

- electron-builder's `generic` provider at `https://cloud.yukibana.dev/updates/`; `latest*.yml` to the newest
  published release; a versioned file to its exact release; `/download/<target>` for the website; GitHub's API with a
  read-only token, cached a few minutes with the Cache API; the last cached answer when GitHub fails (§10.3).
- Artifact names keep the version, because electron-updater finds the previous blockmap by replacing the version in
  the name (§10.3).
- Only published releases are visible to the feed; drafts never are (§10.2).

## Open questions

- The Cache API is per data centre and may evict; "last good" there is best effort. A KV namespace would make it
  durable at the cost of a new binding. Proposal: Cache API now, KV only if S4 or production shows evictions matter.
- What the feed answers before the first release: 404 (electron-updater logs it and retries later). Confirm.

## Acceptance criteria

- [ ] S4's result is posted here, for a full and a differential update on Windows and Linux.
- [ ] Unit tests (tables) for `release-files.ts`: every artifact name of a release maps to its version and target;
      names without a version, with another product name or with `..` are refused.
- [ ] Unit tests for `github.ts` with a fake `fetch` and a fake cache: a fresh answer is cached; a GitHub error serves
      the last good answer; no last good answer gives a `503`; drafts and prereleases are never chosen.
- [ ] Route tests: each `latest*.yml` redirects to the newest release; a versioned file redirects to its own release
      even when a newer one exists; an unknown name and an unknown target are 404.
- [ ] `sibling.test.ts` passes with the new routes (read from `src/routes`); they change nothing.
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: nothing in code. S4 needs versioned artifact names, which the spike sets by hand.
- Blocks: 11.

## Manual steps for a maintainer

- Create a fine-grained GitHub token owned by the organisation, read-only on `ISC-HEI/Yukibana` (Contents and
  Metadata), and set it with `pnpm --filter @yukibana/cloud-web exec wrangler secret put GITHUB_RELEASES_TOKEN`.
- Put its expiry date in the team calendar.

## Risks

- An expired token degrades to the last good answer and then to `503`, so updates stop quietly; the `report()` and the
  calendar entry are the guard.
- GitHub may change how release asset downloads redirect; S4 checks the current behaviour, and the route tests pin
  the URLs we produce.
