import { test } from 'vitest';
import assert from 'node:assert/strict';
import { globToRegExp, matcher } from '../src/lib/glob.js';

test('a star stays inside one segment and a double star crosses them', () => {
  assert.ok(globToRegExp('src/*.rs').test('src/lib.rs'));
  assert.ok(!globToRegExp('src/*.rs').test('src/deep/lib.rs'));
  assert.ok(globToRegExp('src/**/*.rs').test('src/deep/er/lib.rs'));
  assert.ok(globToRegExp('src/**/*.rs').test('src/lib.rs'), '`**/` matches zero segments too');
  assert.ok(globToRegExp('tests/hidden/**').test('tests/hidden/a/b.rs'));
  assert.ok(globToRegExp('file?.txt').test('file1.txt'));
  assert.ok(!globToRegExp('file?.txt').test('file10.txt'));
});

test('a pattern naming a directory hides everything under it', () => {
  const hidden = matcher(['tests/hidden', 'secrets/**']);
  assert.equal(hidden('tests/hidden'), true);
  assert.equal(hidden('tests/hidden/secret.rs'), true);
  assert.equal(hidden('tests/hidden/deep/er.rs'), true);
  assert.equal(hidden('tests/public.rs'), false);
  assert.equal(hidden('secrets/key.pem'), true);
  assert.equal(hidden('secrets'), false, 'a `/**` pattern does not match the bare directory');
});

test('regex metacharacters in a path are literal', () => {
  assert.ok(globToRegExp('a.b(c)').test('a.b(c)'));
  assert.ok(!globToRegExp('a.b').test('aXb'));
});

test('a leading ./ and a trailing slash mean nothing', () => {
  const hidden = matcher(['./tests/hidden/']);
  assert.equal(hidden('tests/hidden/secret.rs'), true);
  assert.equal(hidden('./tests/hidden/secret.rs'), true);
});
