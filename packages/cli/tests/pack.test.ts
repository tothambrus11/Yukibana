import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pack } from '../src/commands/work.js';
import { memoryStore, readArchive } from '@yukibana/client';

afterEach(() => vi.restoreAllMocks());

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yukibana-project-'));
  await writeFile(join(dir, 'yukibana.json'), JSON.stringify({ version: 1, kind: 'scala-sbt', projectId: '01a0b563-aeff-7c42-ae73-5aab2f2b5a01' }));
  await writeFile(join(dir, 'Main.scala'), 'object Main');
  return dir;
}

/** Runs `pack`, and returns where it says it wrote the archive. */
async function packed(dir: string, out?: string): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  await pack({ options: out === undefined ? {} : { out }, args: [dir], env: {}, store: memoryStore() });
  const wrote = /^wrote (.+): /.exec(lines.at(-1) ?? '')?.[1];
  assert.ok(wrote !== undefined, `pack said where it wrote: ${lines.join('\n')}`);
  return wrote;
}

test('packing leaves the project folder as it was, so the next submission does not carry the last one', async () => {
  const dir = await project();
  const out = await packed(dir);
  assert.deepEqual((await readdir(dir)).toSorted(), ['Main.scala', 'yukibana.json']);
  assert.ok(out.startsWith(tmpdir()), `${out} is under the temporary directory`);
  assert.equal(out, join(dirname(out), 'submission.tar.gz'));
  const entries = await readArchive(new Uint8Array(await readFile(out)));
  assert.deepEqual(
    entries.map(e => e.path),
    ['Main.scala', 'yukibana.json'],
  );
});

test('two packs never write over each other', async () => {
  const dir = await project();
  const first = await packed(dir);
  const second = await packed(dir);
  assert.notEqual(dirname(first), dirname(second));
});

test('a pack told where to write writes there', async () => {
  const dir = await project();
  const out = join(await mkdtemp(join(tmpdir(), 'yukibana-out-')), 'nested', 'mine.tar.gz');
  assert.equal(await packed(dir, out), out);
});
