# Remaining work of the monorepo plan, as issues

Drafts for `ISC-HEI/Yukibana`, for steps 6 to 12 of §17 of `docs/monorepo-plan.md`. Steps 1 to 5 are the monorepo PR
(branch `claude/project-thread-0o3t0y`), which every issue builds on. Paths are the branch's, not the plan's.

Decisions taken after the plan, and reflected in the issues: Apache-2.0 instead of MIT, with Theia under EPL-2.0
(Ambrus, 2026-11-09); no per-client usage counter; SPDX headers not required; previews done (S6: email-code login
works on previews, GitHub login does not); the assignment updates in `ide/extensions/yukibana-cloud/src/node/update/`
follow the release file and check the newer release's `yukibana.json` version.

The plan's step 7 (versioned `yukibana.json`) is split in four (03 to 06), and its step 8 (`/api/v1`) in two (07, 08).
The plan's step 10 (release) is split into the Worker's update routes (09) and the pipeline (10).

## Index

| # | Title | Depends on | Size | Manual steps |
| --- | --- | --- | --- | --- |
| [01](01-merge-contributor-guides.md) | docs: merge the contributor guides | none | S | yes (confirm O1, observe Dependabot for S1) |
| [02](02-apache-license-and-notices.md) | chore: license the repository under Apache-2.0, with third-party notices | consent checklist | M | yes (consents from HES-SO and every author) |
| [03](03-project-schema-package.md) | feat(project-schema): versioned yukibana.json schemas with compiler-checked migrations | none | M | no |
| [04](04-release-file.md) | feat(client)!: move release identity out of yukibana.json into yukibana.release.json | 03 | M | no |
| [05](05-strict-v1-everywhere.md) | feat(client)!: read yukibana.json only through the strict versioned schema | 03, 04 | L | no |
| [06](06-corpus-schemas-config-commands.md) | feat(project-schema): test-project corpus, frozen released schemas, config init and upgrade | 05 | M | yes (`corpus-override` label) |
| [07](07-api-package-v1.md) | refactor(api)!: one zod definition per endpoint, served under /api/v1 | none | L | no |
| [08](08-client-versions-and-emergency-floor.md) | feat(cloud): client versions, GET /api/v1/meta and an emergency floor for old clients | 07 | L | no (emergency use only) |
| [09](09-update-feed-and-download-routes.md) | feat(cloud): an update feed and download links for the IDE, served from GitHub releases | none | M | yes (GitHub token as Worker secret) |
| [10](10-tag-driven-release-pipeline.md) | ci: release the IDE and the CLI together from a vX.Y.Z tag | 02, 06, 07, 08 | L | yes (npm org, environment, ruleset, first token publish, trusted publisher, tags) |
| [11](11-ide-updater.md) | feat(updater): download IDE updates in the background and install them on quit | 05, 08, 09, 10 | M | yes (first real update checked by hand) |
| [12](12-strip-and-rename-old-repository.md) | chore: strip tothambrus11/yukibana-cloud down to Light and rename it yukibana-light | cutover, 13 | M | yes (rename, secrets) |
| [13](13-production-and-course-repos-after-v0.1.0.md) | chore: move production data and the course repositories to v0.1.0 | 10, 06, (11) | S | yes (purge, course repository PRs) |

## Dependency order

```
01                                   (no dependencies; merge early)
02 (after consent) ───────────┐
03 ─▶ 04 ─▶ 05 ─▶ 06 ─────────┼─▶ 10 ─▶ 11 ─▶ tag v0.1.0 ─▶ 13 ─▶ 12
07 ─▶ 08 ─────────────────────┘          ▲
09 ──────────────────────────────────────┘   (11 also needs 05 and 08)
```

1. In parallel, from now: **01**, **02** (start the consent requests at once; merge when they are in), **03**,
   **07**, **09** (spike S4 first).
2. **04** after 03; **05** after 04; **06** after 05. **08** after 07.
3. **10** once 02, 06, 07 and 08 are merged; run its dry run.
4. **11** once 09 and 10 are merged.
5. A PR adds `1` to `packages/project-schema/released.json`; then tag **`v0.1.0`** (first npm publish, with the token).
6. **13** right after the release: purge or re-publish production releases, update the two course repositories.
7. **12** last, once the course repositories no longer use the old repository's Action.
8. Before the second release: configure npm trusted publishing and delete the token (issue 10).

Spikes and where they sit: S3 in 03, S4 in 09. S1's untested Dependabot side and O1 in 01. O3 in 10.
