import { test } from 'vitest';
import assert from 'node:assert/strict';
import { behind, chooseReleases, nameOf, wantedRelease, type ReleaseRef } from '../src/lib/grading.js';

const V3: ReleaseRef = { releaseId: '00000000-0000-7000-8000-000000000003', label: 'v3' };
const V2: ReleaseRef = { releaseId: '00000000-0000-7000-8000-000000000002', label: '' };
const V1: ReleaseRef = { releaseId: '00000000-0000-7000-8000-000000000001', label: 'v1' };
const releases = [V3, V2, V1];
const ELSEWHERE = '00000000-0000-7000-8000-0000000000ee';

test('--release must name a release of this project; anything else is refused before downloading', () => {
  assert.deepEqual(wantedRelease(releases, undefined), { ok: true, wanted: 'own' });
  assert.deepEqual(wantedRelease(releases, 'newest'), { ok: true, wanted: 'newest' });
  assert.deepEqual(wantedRelease(releases, V1.releaseId.toUpperCase()), { ok: true, wanted: { releaseId: V1.releaseId } });
  const other = wantedRelease(releases, ELSEWHERE);
  assert.ok(!other.ok);
  assert.match(other.problem, /not a release of this project/);
  assert.ok(!wantedRelease([], undefined).ok, 'with no releases there is nothing to assemble with');
});

test('by default a submission is assembled with, and compared with, the release it started from', () => {
  const c = chooseReleases(releases, 'own', V1.releaseId, V1.releaseId);
  assert.equal(c.grade, V1);
  assert.equal(c.base, V1);
  assert.deepEqual(c.notes, []);
});

test('--release newest grades everyone with the newest, but still compares with where they started', () => {
  const c = chooseReleases(releases, 'newest', V1.releaseId, V1.releaseId);
  assert.equal(c.grade, V3);
  assert.equal(c.base, V1);
});

test('a named release is used for grading whatever the submission says', () => {
  const c = chooseReleases(releases, { releaseId: V2.releaseId }, V1.releaseId, null);
  assert.equal(c.grade, V2);
  assert.equal(c.base, V1);
});

test('a submission that says nothing is graded with and compared with the newest, as before releases had ids', () => {
  const c = chooseReleases(releases, 'own', null, null);
  assert.equal(c.grade, V3);
  assert.equal(c.base, null);
  assert.deepEqual(c.notes, []);
});

test('an archive sent without the id still counts when its own yukibana.json names a release of the project', () => {
  const c = chooseReleases(releases, 'own', null, V2.releaseId);
  assert.equal(c.base, V2);
  assert.equal(c.grade, V2);
});

test("a claim naming another project's release is ignored and said out loud", () => {
  const c = chooseReleases(releases, 'own', null, ELSEWHERE);
  assert.equal(c.base, null);
  assert.equal(c.grade, V3);
  assert.match(c.notes[0] ?? '', /not a release of this project/);
});

test("when the archive and the registry disagree, the registry's record wins and the teacher is told", () => {
  const c = chooseReleases(releases, 'own', V1.releaseId, V2.releaseId);
  assert.equal(c.base, V1);
  assert.match(c.notes[0] ?? '', /sent as started from v1 \(00000000-0000-7000-8000-000000000001\), but its yukibana.json names 00000000-0000-7000-8000-000000000002;/);
});

test('a release is called by its whole id, after its label when it has one', () => {
  assert.equal(nameOf(V2), '00000000-0000-7000-8000-000000000002');
  assert.equal(nameOf(V3), 'v3 (00000000-0000-7000-8000-000000000003)');
});

test('a submission based on an older release, or on none it says, is behind; one on the newest is not', () => {
  assert.equal(behind(releases, V3.releaseId), null);
  assert.match(behind(releases, V2.releaseId) ?? '', /started from 00000000-0000-7000-8000-000000000002, one release behind the newest, v3 \(/);
  assert.match(behind(releases, V1.releaseId) ?? '', /started from v1 \(.*\), 2 releases behind/);
  assert.match(behind(releases, null) ?? '', /does not say which release it started from/);
  assert.match(behind(releases, ELSEWHERE) ?? '', /not a release of this project/);
});

test('without releases to compare with, as for a student, nothing is behind', () => {
  assert.equal(behind([], null), null);
  assert.equal(behind([], V1.releaseId), null);
});
