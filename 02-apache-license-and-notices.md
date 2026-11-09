# chore: license the repository under Apache-2.0, with third-party notices

**Labels:** `legal`, `area:all`, `blocked`, `needs-consent`, `size:M`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Plan step 9 (§13, §17),
with the license changed by the decision below.

## Goal

The repository says under which license its code is, every package agrees with it, and what we ship (the installers
and the npm package) carries the notices its dependencies require. This fixes problem 15 of §1 (no root `LICENSE`;
packages that declared none).

Today, on the branch:

- No root `LICENSE` or `NOTICE`. The only license file is `ide/electron/resources/LICENSE` (MIT, "Copyright (c) 2026
  ISC @ HES-SO Valais/Wallis and others"), which `electron-builder.yml`'s `nsis.license: LICENSE` shows in the
  Windows installer.
- Every workspace `package.json` says `"license": "MIT"` (19 of them); the root `package.json` has no `license`.
- 135 files carry `SPDX-License-Identifier: MIT` (113 in `ide/extensions`, 9 in `.github/scripts`, 9 in `ide/e2e`,
  the rest in root configs), and both `.vscode/*.code-snippets` insert an MIT header into new files.
- `.github/scripts/licenses.mts` already enforces an allowlist for npm packages and reviewed plugins. Two of its
  entries promise things the build does not do yet:
  - `jschardet` (LGPL-2.1+) is accepted because it is "shipped unminified as its own file, so it can be replaced".
    No build configuration does that (`ide/electron/esbuild.mjs`, `ide/browser/esbuild.mjs` and the generated
    `gen-esbuild.*.mjs` bundle it like any other module).
  - `redhat.java` (EPL-2.0, from `vscjava.vscode-java-pack`) bundles the Eclipse JustJ JRE under
    GPL-2.0-only WITH Classpath-exception-2.0. That answers the plan's "check whether it bundles a JRE", but nothing
    ships the notice or a source offer for it.
- No third-party notices are shipped anywhere.

## Scope

1. **Consent first** (checklist below). The PR may be prepared and reviewed before, but it merges only once every box
   is ticked.
2. Root `LICENSE` with the Apache-2.0 text, and a root `NOTICE` with the copyright line HES-SO confirms.
3. `"license": "Apache-2.0"` in every `package.json`, the root included. A unit test in `.github/scripts` reads every
   workspace package (`pnpm-workspace.yaml`'s `packages`) and fails on another value or a missing field, so a new
   package cannot forget it.
4. The `SPDX-License-Identifier: MIT` lines are removed rather than rewritten (headers are not required, and an MIT
   header would contradict the license). The two `.vscode/*.code-snippets` stop inserting a header.
5. **The installer's license comes from the root.** `ide/electron/resources/LICENSE` is deleted; a step before
   electron-builder (a script in `ide/electron/scripts/`, run by `pnpm -C ide package`) copies the root `LICENSE`
   into the build resources, gitignored, and `nsis.license` points at it. `electron-builder.yml`'s
   `copyright: Copyright © 2026-2026 ...` becomes the confirmed holder line.
6. **Generated `ThirdPartyNotices.txt`**, for the Electron app and for the npm package:
   - A generator in `.github/scripts/notices.mts`: a pure function from a list of (package, version, license,
     license text) to the file's text, tested as a table, and a command that collects the list (pnpm's license
     listing for the production closure of `@yukibana/ide-electron` or `@yukibana/cli`, plus `ide/plugins/*` for the
     app).
   - It contains, beyond each license text: that Theia is used under its **EPL-2.0** option, with a source offer that
     names the exact Theia version (`eclipse-theia/theia` tag `v1.76.0`, read from the catalog, not hard-coded); the
     LGPL notice for `jschardet` and where its replaceable file is; the JustJ JRE's license and a source offer; the
     CC-BY-4.0 attribution for `@vscode/codicons`; the OFL for `font-awesome`.
   - The app ships it at the root of its resources (`extraResources` in `electron-builder.yml`). The CLI's copy is
     generated here and packed by issue 10.
7. **jschardet as a replaceable file:** marked external in the IDE's esbuild configs that bundle it (find which ones:
   Theia's backend encoding service at least), its unminified `index.js` and `LICENSE` copied next to the bundle, and
   included in the app despite `files: '!**node_modules/**'`. A check after `pnpm -C ide build` fails if a bundle
   contains jschardet's code or the separate file is missing.
8. **redhat.java's JRE:** check the plugin variant that `ide/package.json`'s `theiaPlugins` actually downloads on each
   OS, and record in `licenses.mts`'s review which JRE version it bundles, so the notice names it.
9. `licenses.mts`: the Theia exceptions' reason says "used under the EPL-2.0 option; the GPL-2.0-only option is not
   compatible with Apache-2.0". Review that nothing in `ALLOWED` is incompatible with distributing under Apache-2.0.
10. Docs: a License section in `README.md`; `CONTRIBUTING.md` says contributions are made under Apache-2.0 (its
    section 5 covers inbound contributions).

## Consent checklist (blocks the merge, and so the first public release)

The existing code was published under MIT. Relicensing it needs the copyright holders' agreement. Record each answer
as a comment on this issue (or a link to the written answer) and tick the box.

- [ ] **HES-SO** confirms in writing who the copyright holder is (the exact wording for `NOTICE` and
      `electron-builder.yml`) and that the code written by its employees is released under Apache-2.0.
- [ ] **The other main committer, LordBaryhobal** (Louis Heredero; 167 commits as `louis.heredero@hevs.ch` and 40 as
      the GitHub noreply address on the branch) agrees in writing to relicense their contributions from MIT to
      Apache-2.0, or HES-SO confirms that they were made as its employee.
- [ ] **Ambrus Tóth** (three identities in `git shortlog -sne`) agrees likewise.
- [ ] Every other human author in `git shortlog -sne` of both imported histories is listed here, and agrees or is
      confirmed as HES-SO's work. Dependabot's commits need nothing.
- [ ] The 71 commits authored as `Claude <noreply@anthropic.com>` in the history, and the 38 authored as `t <t@t>`
      (all on the monorepo PR branch, 2026-11-07), are attributed to the person who ran those sessions, who is
      covered by one of the boxes above.
- [ ] Theia under EPL-2.0 is confirmed as the option we use (EPL-2.0's secondary-license clause is not used).

## Out of scope

- Signing (§14), SchemaStore, per-file headers.
- Light's license: it stays in the old repository (issue 12) and is decided there.

## Design decisions already made

- **Apache-2.0**, not MIT (Ambrus, 2026-11-09). This overrides §0 and §13. Theia is used under its EPL-2.0 option.
- SPDX headers are not required.
- `jschardet` is external and shipped unminified as its own file (§13).
- Notices are generated, with the EPL source offer at the exact Theia version and the LGPL notice (§13).
- The installer's license is generated from the root (§2.1, §13).
- The CI license allowlist exists and stays (§13, done in the monorepo PR).

## Open questions

- The exact holder line ("HES-SO Valais-Wallis", "ISC, HES-SO Valais/Wallis", "and contributors"?). HES-SO decides.
- DCO sign-off for future contributions, or Apache-2.0 section 5 alone. Proposal: section 5 alone.
- If a contributor does not agree: MIT allows sublicensing, so their code can stay in an Apache-2.0 distribution
  with its MIT notice kept in `NOTICE`. That is a fallback, not the plan.

## Acceptance criteria

- [ ] Every consent box above is ticked before merging.
- [ ] Root `LICENSE` (Apache-2.0) and `NOTICE` exist; GitHub detects the license.
- [ ] Every `package.json` says `Apache-2.0`; the unit test fails on a package without it.
- [ ] `git grep SPDX-License-Identifier` finds nothing; the snippets insert no header.
- [ ] The Windows installer shows the Apache-2.0 text (checked on the CI-packaged Windows build).
- [ ] The packaged app contains `ThirdPartyNotices.txt` with the Theia source offer at the catalog's Theia version,
      the jschardet LGPL notice, the JustJ JRE notice, and the codicons and font-awesome notices.
- [ ] The notice generator has table tests (an EPL entry gets a source offer, an LGPL entry names its file, a missing
      license text fails).
- [ ] The jschardet check passes after `pnpm -C ide build`, and fails when the external setting is removed.
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: nothing in code. Blocked by the consent checklist.
- Blocks: 10 (the release ships `LICENSE`, `NOTICE` and the notices; `v0.1.0` is not tagged before this merges).

## Manual steps for a maintainer

- Collect the consents above (HES-SO, LordBaryhobal, every listed author).

## Risks

- A Theia upgrade that changes how jschardet is imported puts it back into the bundle; the build check catches that.
- A GPL-licensed JRE needs a working source offer for as long as we distribute it; the notice must point at a source
  that stays available (Eclipse's JustJ downloads for that exact version).
- Waiting for consent can delay `v0.1.0`; start the requests now.
