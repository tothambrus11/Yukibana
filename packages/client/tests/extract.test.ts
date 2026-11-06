import { test } from 'vitest';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchive, unpackStarter, writeEntries } from '../src/extract.js';
import { gzip } from '../src/lib/gzip.js';
import { writeTar, type Entry } from '../src/lib/tar.js';

/** Returns a file entry at `path` containing `body`. */
const file = (path: string, body: string, mode = 0o644): Entry => ({ path, type: 'file', mode, mtime: 1, data: new TextEncoder().encode(body) });
/** Returns a folder entry at `path`. */
const dir = (path: string): Entry => ({ path, type: 'dir', mode: 0o755, mtime: 1, data: new Uint8Array(0) });
/** Returns a symlink entry at `path` pointing to `target`. */
const link = (path: string, target: string): Entry => ({ path, type: 'symlink', mode: 0o777, mtime: 1, data: new Uint8Array(0), linkTarget: target });

test('unpacking a hostile submission writes nothing outside the folder and no link out of it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'yukibana-extract-'));
  const root = join(parent, 'student');
  const refused = await writeEntries(root, [
    file('ok/a.txt', 'a'),
    file('run.sh', '#!/bin/sh', 0o4755),
    file('../escape.txt', 'x'),
    file('/etc/abs.txt', 'x'),
    link('docs/readme', '../ok/a.txt'),
    link('leak', '../../outside'),
    link('dir', '/'),
    file('dir/through.txt', 'x'),
  ]);
  assert.equal(await readFile(join(root, 'ok/a.txt'), 'utf8'), 'a');
  assert.equal((await stat(join(root, 'run.sh'))).mode & 0o7777, 0o755, 'executable, never setuid');
  assert.equal(await readlink(join(root, 'docs/readme')), '../ok/a.txt');
  await assert.rejects(lstat(join(parent, 'escape.txt')));
  await assert.rejects(lstat(join(root, 'leak')));
  assert.ok((await lstat(join(root, 'dir'))).isDirectory(), 'a file under a name is written before any link of that name, so no write passes through a link');
  assert.equal(refused.length, 4);
});

test('only a .tar.gz is read; a .tar.zst is refused', async () => {
  const tar = await writeTar([file('yukibana.json', '{}'), file('src/main.rs', 'fn main() {}')]);
  assert.deepEqual(
    (await readArchive(await gzip(tar))).map(e => e.path),
    ['yukibana.json', 'src/main.rs'],
  );
  await assert.rejects(readArchive(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0])), /not a \.tar\.gz/);
});

/** Returns `entries` as a gzipped tar, the way a starter is downloaded. */
const starterOf = async (entries: Entry[]): Promise<Uint8Array> => gzip(await writeTar(entries));
/** Creates and returns a new empty folder. */
const parentDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'yukibana-starter-'));
/** A `yukibana.json` that parses. */
const CONFIG = '{"version":1,"kind":"rust"}';

test('a hand-packed starter of loose files unpacks as it is, straight into the folder chosen for it', async () => {
  const folder = join(await parentDir(), 'warm-up');
  const refused = await unpackStarter(await starterOf([file('yukibana.json', CONFIG), dir('src'), file('src/main.rs', 'fn main() {}')]), folder);
  assert.deepEqual(refused, []);
  assert.deepEqual((await readdir(folder)).toSorted(), ['src', 'yukibana.json']);
  assert.equal(await readFile(join(folder, 'src/main.rs'), 'utf8'), 'fn main() {}');
});

test('a starter wrapped in one folder unpacks without it, whatever the folder is called', async () => {
  const folder = join(await parentDir(), 'warm-up');
  await unpackStarter(await starterOf([dir('calc'), file('calc/yukibana.json', CONFIG), file('calc/src/lib.rs', '')]), folder);
  assert.deepEqual((await readdir(folder)).toSorted(), ['src', 'yukibana.json']);
});

test('a project whose only top-level folder is its sources keeps that folder', async () => {
  const folder = join(await parentDir(), 'warm-up');
  await unpackStarter(await starterOf([dir('src'), file('src/main.rs', '')]), folder);
  assert.deepEqual(await readdir(folder), ['src']);
});

test('a starter is never unpacked over files that are already there', async () => {
  const folder = join(await parentDir(), 'warm-up');
  await mkdir(folder);
  await writeFile(join(folder, 'main.rs'), 'my work');
  await assert.rejects(unpackStarter(await starterOf([file('yukibana.json', CONFIG), file('main.rs', 'fn main() {}')]), folder), /already has files in it/);
  assert.deepEqual(await readdir(folder), ['main.rs']);
  assert.equal(await readFile(join(folder, 'main.rs'), 'utf8'), 'my work');
});

test('a starter is not unpacked where a file stands in place of the folder', async () => {
  const folder = join(await parentDir(), 'warm-up');
  await writeFile(folder, 'my notes');
  await assert.rejects(unpackStarter(await starterOf([file('yukibana.json', CONFIG)]), folder), /is not a folder/);
  assert.equal(await readFile(folder, 'utf8'), 'my notes');
});

test('an empty folder chosen for a starter is filled', async () => {
  const folder = await parentDir();
  await unpackStarter(await starterOf([file('yukibana.json', CONFIG)]), folder);
  assert.deepEqual(await readdir(folder), ['yukibana.json']);
});

test('a download that is not a whole starter leaves no folder behind', async () => {
  const parent = await parentDir();
  const whole = await starterOf([file('yukibana.json', CONFIG), file('src/main.rs', 'fn main() {}'.repeat(100))]);
  await assert.rejects(unpackStarter(new TextEncoder().encode('<html>Not found</html>'), join(parent, 'a')));
  await assert.rejects(unpackStarter(whole.subarray(0, whole.length - 20), join(parent, 'b')));
  assert.deepEqual(await readdir(parent), []);
});

test('a starter that cannot be written whole leaves nothing half-written', async () => {
  const parent = await parentDir();
  const empty = join(parent, 'chosen');
  await mkdir(empty);
  // A file and a folder by the same name: the second write fails.
  const clash = await starterOf([file('yukibana.json', CONFIG), file('src', ''), file('src/main.rs', '')]);
  await assert.rejects(unpackStarter(clash, join(parent, 'new', 'deeper', 'project')));
  await assert.rejects(unpackStarter(clash, empty));
  assert.deepEqual(await readdir(parent), ['chosen'], 'every folder it made is gone');
  assert.deepEqual(await readdir(empty), [], 'the folder it was given is as empty as it was');
});

test('a starter that fails halfway never removes anything outside the folder it was given', async () => {
  const parent = await parentDir();
  const chosen = join(parent, 'chosen');
  await mkdir(chosen);
  await writeFile(join(parent, 'other-work.txt'), 'mine');
  const hostile = await starterOf([file('../notes', 'x'), file('/abs/x', 'x'), file('.', 'x'), file('src', ''), file('src/main.rs', '')]);
  await assert.rejects(unpackStarter(hostile, chosen));
  assert.deepEqual((await readdir(parent)).toSorted(), ['chosen', 'other-work.txt'], 'the parent and its other files are untouched');
  assert.deepEqual(await readdir(chosen), [], 'and the folder it was given is empty again');
});
