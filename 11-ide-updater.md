# feat(updater): download IDE updates in the background and install them on quit

**Labels:** `area:ide`, `feature`, `size:M`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). Plan step 11 (§11).

## Goal

An installed IDE updates itself without interrupting anyone: it downloads in the background and installs when the
student quits. The places that tell a student "you need a newer IDE" can then offer "Restart to update". This fixes
problem 13 of §1 (an installed IDE never updates).

## Scope

- **`ide/extensions/updater`** (`@yukibana/ide-updater-ext`), a dependency of `ide/electron` only (not
  `ide/browser`), with `electron-updater` in the catalog (6.8.11 or the newest at least 14 days old):
  - An electron-main contribution: `autoDownload` on, `autoInstallOnAppQuit` on, a check at startup and every 6 hours.
    It never calls `quitAndInstall` unless the person asked.
  - Off for `0.0.0-dev`, when the app is not packaged, and on Linux unless `APPIMAGE` is set.
  - macOS: unsigned apps cannot install updates (Squirrel.Mac needs a signature), so it only checks `latest-mac.yml`
    and, when a newer version exists, offers the download page (`/download/macos-arm64` or `-x64`).
  - The feed is the app's `app-update.yml` (from issue 10's `publish` setting), unless `YUKIBANA_UPDATE_FEED` is set,
    in which case `setFeedURL({ provider: 'generic', url })`.
  - Its state (idle, checking, downloading with progress, downloaded with the version, failed with a sentence) reaches
    the frontend over Theia's electron IPC.
- **Frontend**: a status-bar item "Restart to update to X.Y.Z" once an update is downloaded; its command quits through
  the normal close flow, so unsaved-changes prompts run, and the update installs on that quit.
- **One service for "needs a newer IDE"** (`IdeUpdateService.offer()`), used by issue 05's newer-version message (a
  project, an assignment update, a starter download) and issue 08's `minClient` warning: restart if an update is
  downloaded, show the progress if one is downloading, otherwise open `/download/<os>`.
- **Release update test** in `release.yml` (issue 10), Windows and Linux: start the installed app with
  `YUKIBANA_UPDATE_FEED` pointing at a local server that serves a fake `vX.Y.(Z+1)` (a `latest*.yml` with a higher
  version, the right `sha512` and a renamed copy of the installer), and check that the app finds and downloads it
  (`APPIMAGE` set for the AppImage).
- Docs: `docs/features.md`, and the Releasing section of `CONTRIBUTING.md`.

## Out of scope

- Signing and macOS auto-install (§14), staged rollouts, a beta channel, holding updates back near deadlines (§15).

## Design decisions already made

- electron-updater in Electron's main process, checking at startup and every 6 hours, downloading in the background,
  installing on quit, never restarting by itself; a "Restart to update" item; the "needs a newer IDE" error offers the
  same; the release smoke checks that each build can update to a newer one (§11).
- The generic provider through the Worker (§10.3); one channel (§0).
- `YUKIBANA_UPDATE_FEED` is an environment variable: whoever can set it already controls the machine (§10.2).
- Unsigned macOS cannot auto-update; Mac users update from the download page (§15).
- No `win.publisherName` while unsigned, or electron-updater rejects every update (§14).

## Open questions

- Theia's `theia-ide` has an updater extension to learn from. It is EPL-2.0: copying code from it brings an EPL notice
  into our files. Proposal: read it, write our own.

## Acceptance criteria

- [ ] Unit tests for the pure parts: the schedule, the off conditions (dev, unpackaged, Linux without `APPIMAGE`,
      macOS), reading `YUKIBANA_UPDATE_FEED`, and the state transitions.
- [ ] The release update test passes on Windows and Linux in a dry run of `release.yml`.
- [ ] A frontend test: the status-bar item appears only in the downloaded state, and `offer()` chooses restart,
      progress or the download page by state.
- [ ] After `v0.1.0` and a first patch release, an app installed from `v0.1.0` updates to the patch on Windows and
      Linux (a manual check, recorded here).
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: 05 (the newer-version paths), 08 (the `minClient` warning), 09 (the feed), 10 (`app-update.yml` and the
  release workflow).
- Blocks: the `v0.1.0` tag (recommended, see issue 10), 13.

## Manual steps for a maintainer

- After the first patch release, check the real update path from `v0.1.0` by hand.

## Risks

- A release that breaks the updater cannot repair itself; students reinstall from the download page. The release
  update test is the guard.
- Machines that never update (labs with updates off, per-machine installs, students offline for weeks) stay old;
  `minClient` and `blockBelow` (issue 08) are the answer to that.
