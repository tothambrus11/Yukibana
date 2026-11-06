/** A submission, made and looked at before it is sent.
 *
 *  This is the library half of `yukibana submit`, and what the IDE
 *  extension calls: make a bundle from the student's folder, show what is
 *  in it (every file, and any file's contents), and only when the student
 *  says so, hand it to `YukibanaClient.submit`. Nothing here talks to the
 *  network, and nothing is compressed until `archive()` is asked for, so a
 *  preview of a large folder costs a read of it and no more.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planSubmission, submissionExcluder } from './lib/pack.js';
import { writeTar, type Entry, type EntryType } from './lib/tar.js';
import { CONFIG_FILE, parseConfig, type Config } from './lib/yukibana.js';
import { gzip } from './lib/gzip.js';
import { readTree } from './tree.js';

/** One file of a bundle, as a preview lists it. */
export interface BundleFile {
  /** Relative to the project root, forward slashes. */
  readonly path: string;
  readonly type: Exclude<EntryType, 'dir'>;
  /** Bytes, uncompressed; 0 for a symlink. */
  readonly size: number;
  /** Unix permission bits. */
  readonly mode: number;
  /** For a symlink, where it points. */
  readonly linkTarget?: string;
}

export interface SubmissionBundle {
  /** The project the folder's `yukibana.json` names, or null when it names
   *  none (a course repository rather than a starter). `submit` refuses a
   *  bundle without one unless it is told the project. */
  readonly projectId: string | null;
  /** The release the folder's starter was, or null when its yukibana.json
   *  names none. `submit` sends it so the teacher can tell which release a
   *  submission started from. */
  readonly releaseId: string | null;
  /** The folder's `yukibana.json`, parsed. */
  readonly config: Config;
  /** Every file the archive will hold, in archive order. */
  readonly files: readonly BundleFile[];
  /** Files the folder has and the archive will not, because of the rules. */
  readonly skipped: readonly string[];
  /** Reasons this bundle must not be sent, in sentences. `submit` refuses a
   *  bundle with any; a preview should show them. */
  readonly problems: readonly string[];
  /** The sum of the files' sizes, uncompressed. */
  readonly totalBytes: number;
  /** A file's contents, or undefined when the bundle has no such file. The
   *  bytes are what will be sent; decoding them for display is the
   *  caller's business. */
  read(path: string): Uint8Array | undefined;
  /** The archive the registry receives: a tar of the files, gzipped. Made
   *  once and remembered. */
  archive(): Promise<Uint8Array>;
}

const NO_CONFIG = `there is no ${CONFIG_FILE} here; submit from the folder the starter unpacked into`;

export type BundleResult = { ok: true; bundle: SubmissionBundle } | { ok: false; problems: readonly string[] };

/** Returns a bundle of the folder `dir`, which must hold the starter's
 *  `yukibana.json`. Fails, with reasons, only when the config is missing or
 *  broken; a bundle with problems is still returned so a preview can show
 *  them alongside the files.
 *
 *  Reads into memory only what may be sent: a folder the rules leave out,
 *  such as `target/` or `node_modules`, is never entered. */
export async function createSubmissionBundle(dir: string): Promise<BundleResult> {
  const text = await readFile(join(dir, CONFIG_FILE), 'utf8').catch(() => null);
  if (text === null) return { ok: false, problems: [NO_CONFIG] };
  const parsed = parseConfig(text);
  if (!parsed.ok) return { ok: false, problems: [parsed.error] };
  const gitignores = new Map<string, string>();
  const excluded = submissionExcluder(parsed.config, gitignores);
  return bundleOf(await readTree(dir, { skip: excluded, gitignore: (folder, patterns) => gitignores.set(folder, patterns) }));
}

/** Returns a bundle of `tree`, a folder already in memory, as
 *  `createSubmissionBundle` would: what a test, or an editor that holds
 *  unsaved buffers, would use. */
export function bundleOf(tree: readonly Entry[]): BundleResult {
  const cfg = tree.find(e => e.path === CONFIG_FILE && e.type === 'file');
  if (cfg === undefined) return { ok: false, problems: [NO_CONFIG] };
  const parsed = parseConfig(new TextDecoder().decode(cfg.data));
  if (!parsed.ok) return { ok: false, problems: [parsed.error] };
  const config = parsed.config;

  const packing = planSubmission(tree, config);
  const byPath = new Map(packing.entries.filter(e => e.type === 'file').map(e => [e.path, e.data] as const));
  const files: BundleFile[] = [];
  for (const e of packing.entries) {
    if (e.type === 'dir') continue;
    const file: { -readonly [K in keyof BundleFile]: BundleFile[K] } = { path: e.path, type: e.type, size: e.type === 'file' ? e.data.length : 0, mode: e.mode };
    if (e.linkTarget !== undefined) file.linkTarget = e.linkTarget;
    files.push(file);
  }
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const problems = [...packing.problems];
  if (totalBytes > config.submission.maxBytes) {
    problems.push(`the submission holds ${totalBytes} bytes and this project takes at most ${config.submission.maxBytes}; is build output in it?`);
  }

  let archived: Promise<Uint8Array> | null = null;
  return {
    ok: true,
    bundle: {
      projectId: config.projectId,
      releaseId: config.releaseId,
      config,
      files,
      skipped: packing.skipped,
      problems,
      totalBytes,
      read: path => byPath.get(path),
      archive: () => (archived ??= writeTar(packing.entries).then(gzip)),
    },
  };
}
