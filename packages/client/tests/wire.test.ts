import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Unexpected, decodeList, decodeProject, decodeSubmission } from '../src/lib/wire.js';

const project = {
  projectId: 'p',
  editionId: 'e',
  courseCode: 'CS-101',
  editionLabel: '2026',
  slug: 'warmup',
  title: 'Warm up',
  kind: 'rust-cargo',
  availableAfter: '2026-10-01T00:00:00Z',
  deadline: null,
  closesAt: null,
  late: false,
  role: 'student',
  starterReady: true,
  currentReleaseId: '00000000-0000-7000-8000-000000000002',
  canSubmit: true,
  mySubmissions: 0,
  myLastSubmittedAt: null,
};

test('a project the registry answers is read as it is, and a missing optional time reads as none', () => {
  assert.deepEqual(decodeProject(project), project);
  const { deadline: _, ...older } = project;
  assert.equal(decodeProject(older).deadline, null, 'a registry older than a nullable field answers without it');
  const { currentReleaseId: __, ...beforeUpdates } = project;
  assert.equal(decodeProject(beforeUpdates).currentReleaseId, null, 'and a registry from before updates reads as no release to update to');
});

test('a field of the wrong type is refused with a sentence that names it', () => {
  assert.throws(() => decodeProject({ ...project, deadline: 5 }), new Unexpected('the registry answered project.deadline as number, not text'));
  assert.throws(() => decodeProject({ ...project, role: 'janitor' }), /project\.role as "janitor", not a role/);
  assert.throws(() => decodeProject('nothing'), /the registry answered project as something other than an object/);
});

test('an answer with several wrong fields names every one of them', () => {
  assert.throws(
    () => decodeProject({ ...project, deadline: 5, role: 'janitor' }),
    new Unexpected('the registry answered project.deadline as number, not text; the registry answered project.role as "janitor", not a role'),
  );
});

test('an answer with every field wrong names every one of them, none left for a second run', () => {
  const allWrong = Object.fromEntries(Object.keys(project).map(k => [k, Symbol(k)]));
  assert.throws(
    () => decodeProject(allWrong),
    (e: unknown) => {
      const message = e instanceof Error ? e.message : '';
      for (const field of Object.keys(project)) assert.ok(message.includes(`project.${field} as`), field);
      return true;
    },
  );
});

test('an error inside a list names the item and the field', () => {
  const submission = { submissionId: 's', projectId: 'p', submittedAt: 't', byteSize: 1, sha256: 'ab', latest: true, late: false, baseReleaseId: null, author: { userId: 'u' } };
  const list = decodeList(decodeSubmission, 'submissions');
  assert.equal(list([submission])[0]?.author.fullName, null);
  assert.throws(() => list([submission, { ...submission, author: { userId: 7 } }]), /submissions\[1\]\.author\.userId as number, not text/);
  assert.throws(() => list({}), /submissions as something other than a list/);
});
