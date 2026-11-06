import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTar, writeTar, type Entry } from '../src/lib/tar.js';
import { gunzip, gzip } from '../src/lib/gzip.js';

const text = (s: string) => new TextEncoder().encode(s);
const fixture = new URL('./fixtures/repo.tar.gz', import.meta.url);

test('a GitHub-style tarball is read: wrapper directory, pax global header, long paths', async () => {
  const entries = await readTar(await gunzip(new Uint8Array(readFileSync(fixture))));
  const paths = new Set(entries.map(e => e.path));
  assert.ok(!paths.has('pax_global_header'), 'the global header is not an entry');
  assert.ok(paths.has('acme-calc-0123abc/Cargo.toml'));
  const long = entries.find(e => e.path.endsWith('/deeper/mod.rs'));
  assert.ok(long, 'a path over 100 bytes arrives whole');
  assert.equal(long.path, 'acme-calc-0123abc/src/a_very_long_directory_name_to_push_the_path_past_one_hundred_characters/and_then_some_more_of_it/deeper/mod.rs');
  const run = entries.find(e => e.path === 'acme-calc-0123abc/run.sh');
  assert.ok(run);
  assert.equal(run.mode & 0o111, 0o111, 'the executable bit survives');
  assert.equal(new TextDecoder().decode(run.data), '#!/bin/sh\necho hi\n');
  assert.equal(entries.find(e => e.path === 'acme-calc-0123abc/src')?.type, 'dir');
});

test('what is written is read back the same, long names included', async () => {
  const deep = 'd/' + 'x'.repeat(120) + '/' + 'y'.repeat(90) + '/file.txt';
  const entries: Entry[] = [
    { path: 'proj', type: 'dir', mode: 0o755, mtime: 1_700_000_000, data: new Uint8Array(0) },
    { path: 'proj/a.txt', type: 'file', mode: 0o644, mtime: 1_700_000_000, data: text('hello') },
    { path: 'proj/run', type: 'file', mode: 0o755, mtime: 1_700_000_001, data: new Uint8Array(1000).fill(7) },
    { path: `proj/${deep}`, type: 'file', mode: 0o644, mtime: 1_700_000_002, data: text('deep') },
    { path: 'proj/link', type: 'symlink', mode: 0o777, mtime: 1_700_000_003, data: new Uint8Array(0), linkTarget: 'a.txt' },
  ];
  const back = await readTar(await writeTar(entries));
  assert.deepEqual(
    back.map(e => [e.path, e.type, e.mode, e.mtime, e.data.length, e.linkTarget ?? '']),
    entries.map(e => [e.path, e.type, e.mode, e.mtime, e.data.length, e.linkTarget ?? '']),
  );
  assert.deepEqual(back[1]?.data, text('hello'));
  assert.deepEqual(back[3]?.data, text('deep'));
});

test('a symlink whose target is too long for ustar points where it did', async () => {
  const target = '../'.repeat(10) + 'shared/' + 'n'.repeat(90);
  const [back] = await readTar(await writeTar([{ path: 'link', type: 'symlink', mode: 0o777, mtime: 1, data: new Uint8Array(0), linkTarget: target }]));
  assert.equal(back?.linkTarget, target);
});

test('what is written is an archive the system tar accepts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yukibana-tar-'));
  const long = 'proj/' + 'long_'.repeat(30) + '/f.txt';
  const bytes = await gzip(
    await writeTar([
      { path: 'proj', type: 'dir', mode: 0o755, mtime: 1_700_000_000, data: new Uint8Array(0) },
      { path: 'proj/a.txt', type: 'file', mode: 0o644, mtime: 1_700_000_000, data: text('hello\n') },
      { path: long, type: 'file', mode: 0o600, mtime: 1_700_000_000, data: text('deep\n') },
    ]),
  );
  writeFileSync(join(dir, 'out.tar.gz'), bytes);
  const listing = execFileSync('tar', ['-tzf', join(dir, 'out.tar.gz')], { encoding: 'utf8' });
  assert.deepEqual(listing.trim().split('\n'), ['proj/', 'proj/a.txt', long]);
});

test('an empty archive, or one cut short before its first entry, reads as no entries', async () => {
  assert.deepEqual(await readTar(new Uint8Array(0)), []);
  assert.deepEqual(await readTar(new Uint8Array(1024)), []);
  assert.deepEqual(await readTar((await writeTar([])).subarray(0, 100)), []);
});

test('an archive cut short inside a file is refused rather than read as a shorter file', async () => {
  const whole = await writeTar([{ path: 'Main.scala', type: 'file', mode: 0o644, mtime: 1, data: new Uint8Array(2000).fill(65) }]);
  await assert.rejects(readTar(whole.subarray(0, 512 + 700)), /ends inside Main\.scala \(700 of 2000 bytes\)/);
});

test('a file dated before 1970 keeps its date', async () => {
  const [back] = await readTar(await writeTar([{ path: 'old.txt', type: 'file', mode: 0o644, mtime: -86_400, data: text('x') }]));
  assert.equal(back?.mtime, -86_400);
});
