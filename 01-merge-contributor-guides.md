# docs: merge the contributor guides

**Labels:** `docs`, `area:all`, `size:S`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Plan step 6 (§17).

## Goal

One guide that says how code is written in every area, so that a rule exists once and an IDE, cloud or CLI
contributor finds it in the same place. This finishes problem 3 of §1 (two sets of conventions) for the written rules;
the toolchain half is done in the monorepo PR.

Today the rules are spread over four files:

- `CONTRIBUTING.md` (175 lines): setup, commands, architecture, dependencies and supply chain, CI. Mostly the IDE.
- `cloud/CLAUDE.md` (208 lines): the cloud's rules (database only through migrations, authorisation in Postgres,
  same-site rules, types, contract documentation, testing, "before you push"). Paths are already corrected.
- `packages/CLAUDE.md` (12 lines): imports `cloud/CLAUDE.md` for `packages/client` and `packages/cli`.
- `docs/cloud/README.md` (177 lines): running the cloud locally, publishing, collecting, deploying.

Nothing says that commits and PR titles are conventional commits, that the merge queue uses merge commits, or which
cloud rules apply to `ide/`. There is no root `CLAUDE.md`, so an agent working in `ide/` reads none of the shared
rules.

## Scope

- `CONTRIBUTING.md` becomes the one guide, by area:
  - **Everywhere:** setup (`pnpm setup:ide`, `setup:cloud`, `setup:cli`), formatting (`oxfmt.config.mts`: 4 spaces,
    single quotes, 180 columns; Svelte keeps 2 spaces; Markdown excluded), conventional commits for every commit and
    PR title with the scopes in use (`ide`, `cloud`, `client`, `cli`, `ci`, `deps`, ...), merge queue with merge
    commits, contract documentation, tests named as sentences about the product, untyped input read only at named
    boundaries, no `any`, "nothing fails silently", no license headers, dependencies and supply chain (already there).
  - **IDE:** what is there today.
  - **Cloud:** the database rule, authorisation in Postgres, the Worker's roles (`asUser`, `asPublisher`), the
    sibling-subdomain rules, moved from `cloud/CLAUDE.md` without changing their meaning.
  - **Packages:** `@yukibana/client` (two entries, `.` for Node and `./config` browser-safe), `@yukibana/cli`
    (teacher-only code stays there), `@yukibana/fixtures`.
  - **CI, deploys and releases:** what is there today, plus a placeholder for the release section that issue 10 fills.
- `cloud/CLAUDE.md` and `packages/CLAUDE.md` keep only what is agent-specific and import the guide's sections
  (`@../CONTRIBUTING.md`), so nothing is said twice.
- A root `CLAUDE.md` that imports `CONTRIBUTING.md`, so agents in `ide/` get the shared rules.
- `docs/cloud/README.md` keeps how to run the cloud locally, publish and collect; rules it repeats become links.
- `README.md` links the guide.
- The Dependencies section states the decided release-age window (O1) and what S1 found (below).

## Out of scope

- Changing any rule. This issue moves text; a rule that should change gets its own issue.
- The license section's content (issue 02) and the release section's content (issue 10).
- Rewriting `docs/architecture.md`, `docs/cloud/architecture.md` or `docs/cloud/design.md`.

## Design decisions already made

- One contributor guide, the cloud's rules merged into `CONTRIBUTING.md` by area (§4.3).
- Conventional commits for every commit and PR title (§4.3).
- SPDX headers are not required (decision after the plan; `CONTRIBUTING.md` already says so).
- 14 days for `minimumReleaseAge` and the Dependabot cooldown (§3.2). The monorepo PR implements it:
  `minimumReleaseAge: 20160` in `pnpm-workspace.yaml` and `cooldown: default-days: 14` in `.github/dependabot.yml`.

## Open questions

- **O1:** the maintainer confirms 14 days (implemented) rather than 7. If 7, this issue changes both values and the
  guide in one commit.
- Which of the cloud's code rules bind `ide/` too. Contract comments do already (the monorepo PR gave every export
  one). Branded ids, "no `any`" and "untyped input in one named place" are not enforced there today. Proposal: the
  guide lists them under "Everywhere" only where `ide/`'s oxlint config already enforces them, and names the rest as
  cloud and packages only.
- **S1, Dependabot's side** (untestable outside GitHub): S1 showed that `pnpm install --frozen-lockfile` and `pnpm ci`
  refuse a lockfile entry younger than the window, so a too-young version cannot reach `main` through CI. What is
  left to observe is how Dependabot behaves: whether it proposes versions younger than `minimumReleaseAge` (they would
  fail CI and add noise), and what a security update does (expected: its PR fails CI until the version is 14 days
  old, which is the documented default "the update waits"). No lockfile age check is added unless that observation
  shows a way around CI.

## Acceptance criteria

- [ ] Every rule in today's `cloud/CLAUDE.md` appears exactly once, in `CONTRIBUTING.md`, under its area. The PR
      description lists each moved section and where it went.
- [ ] `cloud/CLAUDE.md`, `packages/CLAUDE.md` and the new root `CLAUDE.md` import the guide; Claude Code's `/memory`
      in `ide/`, `cloud/web/` and `packages/cli/` shows the shared rules loaded.
- [ ] Conventional commits, the scopes and the merge commit rule are written down.
- [ ] Every command the guides name is a script that exists (checked by hand from a clean clone, or by a small test in
      `.github/scripts` that greps `pnpm <script>` against the `package.json` files).
- [ ] `markdownlint` (`.markdownlint.yaml`, pre-commit) passes.
- [ ] O1 is answered in this issue, and the guide says the window that is configured.
- [ ] After the first Dependabot run on `ISC-HEI/Yukibana`, the S1 observation is recorded in the guide's
      Dependencies section.

## Depends on / Blocks

- Depends on: nothing beyond the monorepo PR.
- Blocks: nothing. Merge it early: issues 02, 08 and 10 add sections to the guide.

## Manual steps for a maintainer

- Answer O1.
- After the first weekly Dependabot run in this repository, look at its PRs and record what S1 left open.

## Risks

- A wrong import path in a `CLAUDE.md` silently drops the rules for agents. The `/memory` check above catches it.
- Text conflicts with the other issues' doc changes, if this merges late.
