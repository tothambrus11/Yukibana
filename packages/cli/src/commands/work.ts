/** A student's commands: get the starter, look at what would be submitted,
 *  submit it. The same bundle the IDE extension previews. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createSubmissionBundle, sha256Hex, type SubmissionBundle, unpackStarter } from '@yukibana/client';
import { bytes, clientFor, fail, projectOf, type Invocation } from './common.js';

/** Runs `starter <project> [--out dir]`: unpacks the project's starter into
 *  `dir` itself, or, without `--out`, into `<project slug>` in the working
 *  directory. It once always added the slug under `dir`, so nobody could
 *  name the folder their project went into; the default is this command's
 *  to choose, and `unpackStarter` only ever takes the folder it is given.
 *
 *  Exits non-zero, having written nothing, when `--out` is empty, or when
 *  the folder exists and is not empty. Warns about each entry left out. */
export async function starter(inv: Invocation): Promise<void> {
  if (inv.options.out?.trim() === '') fail('--out names the folder to unpack the starter into');
  const id = await projectOf(inv, inv.args[0]);
  const client = await clientFor(inv);
  const [project, archive] = await Promise.all([client.project(id), client.downloadStarter(id)]);
  const folder = resolve(inv.options.out ?? project.slug);
  const refused = await unpackStarter(archive, folder).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
  for (const r of refused) console.error(`warning: not unpacked: ${r}`);
  console.log(`unpacked the starter into ${folder}`);
}

async function bundleIn(dir: string): Promise<SubmissionBundle> {
  const made = await createSubmissionBundle(dir);
  if (!made.ok) return fail(...made.problems);
  return made.bundle;
}

function preview(bundle: SubmissionBundle): void {
  for (const f of bundle.files) console.log(`  ${f.path}${f.type === 'symlink' ? ` -> ${f.linkTarget ?? ''}` : `  (${bytes(f.size)})`}`);
  console.log(`${bundle.files.length} files, ${bytes(bundle.totalBytes)} before compression`);
  if (bundle.skipped.length > 0)
    console.log(`left out by yukibana.json: ${bundle.skipped.length} (${bundle.skipped.slice(0, 5).join(', ')}${bundle.skipped.length > 5 ? ', …' : ''})`);
  for (const p of bundle.problems) console.error(`problem: ${p}`);
}

/** `pack [dir] [--out file]`: the archive `submit` would send, written to
 *  disk, for the project page's upload form or for a look inside. Without
 *  `--out` it goes into a new folder of its own under the system's
 *  temporary directory, named `submission.filename`. It used to be written
 *  into the project, where nothing excluded it, so the next submission
 *  carried the last one inside it. `submit` writes nothing at all. */
export async function pack(inv: Invocation): Promise<void> {
  const bundle = await bundleIn(resolve(inv.args[0] ?? '.'));
  preview(bundle);
  if (bundle.problems.length > 0) fail('not packed: fix the problems above');
  const archive = await bundle.archive();
  const out = inv.options.out === undefined ? join(await mkdtemp(join(tmpdir(), 'yukibana-pack-')), bundle.config.submission.filename) : resolve(inv.options.out);
  await save(out, archive);
  console.log(`wrote ${out}: ${bytes(archive.byteLength)}, sha256 ${sha256Hex(archive)}`);
}

/** `submit [dir]`: lists what would be sent and asks, then sends. `--yes`
 *  skips the question, for scripts; without a terminal to ask on, it is
 *  required, so nothing is sent that nobody looked at by accident. */
export async function submit(inv: Invocation): Promise<void> {
  const dir = resolve(inv.args[0] ?? '.');
  const bundle = await bundleIn(dir);
  const id = await projectOf(inv, inv.options.project, dir);
  const client = await clientFor(inv);
  const p = await client.project(id);
  preview(bundle);
  if (bundle.problems.length > 0) fail('not submitted: fix the problems above');
  if (!p.canSubmit) fail(`not submitted: ${p.title} is not accepting submissions from you now`);
  if (p.late) console.log(`note: the deadline was ${new Date(p.deadline ?? '').toLocaleString()}; a submission now is recorded as late.`);
  if (inv.options.yes !== true) {
    if (!process.stdin.isTTY) fail('not submitted: pass --yes to submit without being asked');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Submit these files to "${p.title}"? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) fail('not submitted');
  }
  const accepted = await client.submit(bundle, id);
  console.log(`submitted ${accepted.submissionId}: ${bytes(accepted.byteSize)}, sha256 ${accepted.sha256.slice(0, 12)}. Your newest submission is the one that counts.`);
  if (p.late) console.log('The deadline had passed, so this submission is recorded as late.');
}

/** Writes bytes, making the folder. */
export async function save(path: string, data: Uint8Array): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, data);
}
