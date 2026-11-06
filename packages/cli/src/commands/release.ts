/** A teacher's commands for a course repository: check it, build the two
 *  archives, publish them as a release. */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { build, commitOf, newReleaseId } from '../build.js';
import { isProjectId, publish, sha256Hex } from '@yukibana/client';
import { accessTokenFor, fail, projectOf, registryUrl, type Invocation } from './common.js';

/** `check`, `build` and `publish`: the same build, then nothing, a write,
 *  or an upload. */
export async function release(command: 'check' | 'build' | 'publish', inv: Invocation): Promise<void> {
  const dir = resolve(inv.args[0] ?? '.');
  const folder = inv.options.folder ?? basename(dir);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(folder)) fail(`--folder must be lowercase letters, digits and dashes; "${folder}" is not (it names the directory students unpack)`);

  const projectId =
    command === 'publish'
      ? await projectOf(inv, inv.options.project, dir).catch(() => fail('--project (or YUKIBANA_PROJECT) is required to publish'))
      : (inv.options.project ?? inv.env['YUKIBANA_PROJECT'] ?? '');
  // Not for `check`, whose starter nobody receives: a YUKIBANA_PROJECT set for something else must not fail it.
  if (command !== 'check' && projectId !== '' && !isProjectId(projectId))
    fail(`"${projectId}" is not a project id, a uuidv7; the starter would carry it, and its yukibana.json would be refused`);

  // The id is chosen before the build so the starter can carry it, and the
  // publish below gives the row the same one. A check publishes nothing, so
  // its starter names no release; a `build` is for a look inside, and its id
  // names a release that will not exist.
  const releaseId = command === 'check' ? null : newReleaseId();
  const result = await build(dir, folder, projectId, releaseId);
  if (!result.ok) fail(...result.problems);
  if (!result.ok) return;
  const { built } = result;
  for (const w of built.warnings) console.error(`warning: ${w}`);
  if (command === 'build' && projectId === '') {
    console.error('warning: no --project, so the starter does not say where submissions go; students will have to name the project when they submit');
  }
  console.log(`${built.config.kind}: ${built.starterEntries} entries in the starter; ${built.hidden.length === 0 ? 'nothing hidden' : `hidden: ${built.hidden.join(', ')}`}`);
  console.log(`starter ${built.starter.byteLength} bytes sha256 ${sha256Hex(built.starter).slice(0, 12)}; teacher ${built.teacher.byteLength} bytes`);
  if (command === 'check') return;

  if (command === 'build') {
    const out = resolve(inv.options.out ?? join(dir, '.yukibana'));
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'starter.tar.gz'), built.starter);
    await writeFile(join(out, 'teacher.tar.gz'), built.teacher);
    console.log(`wrote ${join(out, 'starter.tar.gz')} and ${join(out, 'teacher.tar.gz')}`);
    return;
  }

  // A project token from CI, or the person logged in, who must own the project.
  const url = await registryUrl(inv);
  const token = inv.options.token ?? inv.env['YUKIBANA_TOKEN'] ?? (await accessTokenFor(inv)().catch(() => ''));
  if (token === '') fail('--token (or YUKIBANA_TOKEN) is required to publish, unless you are logged in as staff of the project');
  const commit = await commitOf(dir);
  const published = await publish({ url, token, projectId, releaseId, starter: built.starter, teacher: built.teacher, label: inv.options.label ?? '', commit });
  console.log(`published release ${published.releaseId}${commit === null ? '' : ` at ${commit.slice(0, 12)}`}`);
}
