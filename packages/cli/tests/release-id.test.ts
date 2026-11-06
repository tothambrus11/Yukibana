import { test } from 'vitest';
import assert from 'node:assert/strict';
import { newReleaseId } from '../src/build.js';
import { isUuid } from '@yukibana/client';

test('a release id chosen by the CLI is a v7 uuid the database takes as its own', () => {
  const id = newReleaseId();
  assert.ok(isUuid(id));
  assert.equal(id[14], '7', 'version 7');
  assert.match(id[19] ?? '', /[89ab]/, 'the RFC variant');
});

test('its first 48 bits are the time it was chosen', () => {
  const before = Date.now();
  const id = newReleaseId();
  const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
  assert.ok(ms >= before && ms <= Date.now());
});

test('ids chosen one after another differ and sort in the order they were chosen', () => {
  const ids = Array.from({ length: 1000 }, () => newReleaseId());
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.toSorted(), ids);
});
