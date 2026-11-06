/** `@yukibana/client`: the library the Theia extensions and the CLI's
 *  commands (`packages/cli`) share.
 *
 *  Three things, each usable without the others:
 *
 *  * **A submission bundle.** `createSubmissionBundle(folder)` reads the
 *    student's folder by its `yukibana.json`; the bundle lists its files
 *    (`files`, `skipped`, `problems`) and reads any of them (`read`) for a
 *    preview, and is only compressed when it is sent.
 *  * **A login.** `startLogin(registry, redirect)` gives the address to show
 *    and a `finish` for the address the browser comes back to;
 *    `loginWithLoopback` does both with a listener on 127.0.0.1. Either gives
 *    a `Session`, which a `SessionStore` keeps (`fileStore` is the
 *    terminal's; an IDE implements one over its secret storage).
 *  * **A client.** `new YukibanaClient({ url, accessToken })` is the whole
 *    API as that person. `tokenProvider(store)` is an `accessToken` that
 *    refreshes the session as it goes.
 *
 *  ```ts
 *  const store = theiaSecretStore();              // a SessionStore
 *  const session = await loginWithLoopback(url, { open, callbackPage }); // or startLogin + finish
 *  await store.save(session);
 *  const client = new YukibanaClient({ url, accessToken: tokenProvider(store) });
 *
 *  const made = await createSubmissionBundle(workspaceFolder);
 *  if (!made.ok) return show(made.problems);
 *  preview(made.bundle.files, (path) => made.bundle.read(path));
 *  if (await confirmed()) await client.submit(made.bundle);
 *  ```
 *
 *  The pure pieces under `lib/` (the config parser, the plans, tar, the
 *  assembly) are exported too, for an extension that wants to show what a
 *  read-only or hidden pattern matches, and so are the pieces only the CLI's
 *  commands use today (the release build's plans, the grading choices, the
 *  folder names): this package is the only way into them.
 *
 *  The library is headless: it owns the protocol, the data, the disk and the
 *  network, and nothing a person sees. Opening a browser, the page the
 *  browser lands on after a login, and every word on a screen belong to the
 *  host (the CLI's are in `packages/cli/src/commands/`, the IDE's in its
 *  extensions).
 *  Errors carry a status and the registry's own sentence for the host to
 *  show or translate.
 */

export { createSubmissionBundle, bundleOf, type BundleFile, type BundleResult, type SubmissionBundle } from './bundle.js';
export { YukibanaClient, RegistryError, type ClientOptions, type SubmissionQuery } from './client.js';
export {
  startLogin,
  refreshSession,
  tokenProvider,
  logout,
  memoryStore,
  codeOf,
  NotLoggedIn,
  type LoggedOut,
  type PendingLogin,
  type Session,
  type SessionStore,
} from './session.js';
export { loginWithLoopback, type CallbackOutcome, type LoopbackOptions } from './loopback.js';
export { loginCode } from './lib/pkce.js';
export { fileStore, defaultSessionPath } from './store.js';
export { readArchive, unpackStarter, writeEntries, isEmptyDir } from './extract.js';
export { readTree, type TreeOptions } from './tree.js';
export { publish, type PublishInput } from './publish.js';
export { assemble, submissionRoot, teacherRoot, tampered, type Assembled, type Assembly, type Tampering } from './lib/assemble.js';
export { planSubmission, type Packing } from './lib/pack.js';
export { planStarter, planTeacher, type Plan } from './lib/starter.js';
export { behind, chooseReleases, nameOf, wantedRelease, type Choice, type ReleaseRef, type Wanted } from './lib/grading.js';
export { folderNames, stampOf, type Person } from './lib/names.js';
export { sha256Hex } from './lib/bytes.js';
export { gzip } from './lib/gzip.js';
export {
  planUpdate,
  wantedPaths,
  onlyTheStamp,
  isText,
  type Change,
  type ChooseReason,
  type Folder,
  type FolderEntry,
  type Planned,
  type UpdatePlan,
  type Version,
} from './lib/update.js';
export {
  parseConfig,
  parseSettings,
  protectedPaths,
  configSchema,
  settingsSchema,
  CONFIG_FILE,
  DEFAULT_SETTINGS,
  KINDS,
  isProjectId,
  isUuid,
  type Config,
  type Features,
  type Kind,
  type Layout,
  type Settings,
  type SubmissionRules,
  type Widgets,
} from './lib/yukibana.js';
export { matcher } from './lib/glob.js';
export { readTar, writeTar, type Entry, type EntryType } from './lib/tar.js';
export type { Accepted, Author, Edition, EditionRole, Me, Member, Project, Published, Release, Submission } from './lib/wire.js';
