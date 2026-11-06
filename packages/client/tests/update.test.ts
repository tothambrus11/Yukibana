import { test } from 'vitest';
import assert from 'node:assert/strict';
import { onlyTheStamp, planUpdate, wantedPaths, type Change, type Folder, type FolderEntry } from '../src/lib/update.js';
import type { Entry } from '../src/lib/tar.js';

const enc = (s: string) => new TextEncoder().encode(s);
const V1 = '00000000-0000-7000-8000-000000000001';
const V2 = '00000000-0000-7000-8000-000000000002';
const config = (release: string, readOnly: readonly string[]) =>
  JSON.stringify({ version: 1, kind: 'rust-cargo', readOnly, projectId: '00000000-0000-7000-8000-0000000000aa', releaseId: release });
const file = (path: string, body: string | Uint8Array, mode = 0o644): Entry => ({
  path,
  type: 'file',
  mode,
  mtime: 1,
  data: typeof body === 'string' ? enc(body) : body,
});
const starter = (release: string, readOnly: readonly string[], files: Record<string, string>): Entry[] => [
  file('yukibana.json', config(release, readOnly)),
  ...Object.entries(files).map(([p, b]) => file(p, b)),
];
const folderOf = (files: Record<string, string | FolderEntry>): Folder =>
  new Map(Object.entries(files).map(([p, b]) => [p, typeof b === 'string' ? { kind: 'file', data: enc(b), mode: 0o644 } : b]));

/** Plans, and returns each change as "kind path" plus its flags, for tables. */
const plan = (base: Entry[], newest: Entry[], folder: Folder): string[] => {
  const planned = planUpdate(base, newest, folder);
  if (!planned.ok) throw new Error(planned.problem);
  return planned.plan.changes.map(describe);
};
const describe = (c: Change): string => {
  const flags = c.kind === 'write' || c.kind === 'delete' ? [c.editedByStudent && 'edited', c.newlyProtected && 'newly'].filter(Boolean) : [];
  const reason = c.kind === 'choose' ? ` (${c.reason})` : '';
  return `${c.kind} ${c.path}${reason}${flags.length > 0 ? ` [${flags.join(',')}]` : ''}`;
};

const RO = ['tests/**'];
const base = starter(V1, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
const mine = (over: Record<string, string | FolderEntry | null> = {}): Folder => {
  const files: Record<string, string | FolderEntry> = {
    'yukibana.json': config(V1, RO),
    'src/lib.rs': 'fn a() {}\n',
    'src/helpers.rs': 'helpers v1\n',
    'tests/t.rs': 'test v1\n',
    'README.md': 'read me\n',
  };
  for (const [p, b] of Object.entries(over)) {
    if (b === null) delete files[p];
    else files[p] = b;
  }
  return folderOf(files);
};

test("a folder nobody touched takes the teacher's whole release, the stamp last", () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v2\n', 'tests/t.rs': 'test v2\n', 'src/new.rs': 'new\n' });
  assert.deepEqual(plan(base, newest, mine()), ['delete README.md', 'write src/helpers.rs', 'write src/new.rs', 'write tests/t.rs', 'write yukibana.json']);
});

test("the student's own edits are never touched where the teacher changed nothing", () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  const folder = mine({ 'src/lib.rs': 'fn a() { mine }\n', 'notes.txt': 'my notes\n' });
  assert.deepEqual(plan(base, newest, folder), ['write yukibana.json']);
});

test('an editable file both changed is a merge, and nothing is written to it', () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\nfn b() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, newest, mine({ 'src/lib.rs': 'fn a() { mine }\n' })), ['write yukibana.json', 'merge src/lib.rs']);
});

test('when both made the same change there is nothing to do', () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() { fixed }\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, newest, mine({ 'src/lib.rs': 'fn a() { fixed }\n' })), ['write yukibana.json']);
});

test("a read-only file is the teacher's, and a student's edit to it is replaced, flagged", () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v2\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, newest, mine({ 'tests/t.rs': 'test v1, weakened\n' })), ['write tests/t.rs [edited]', 'write yukibana.json']);
  assert.deepEqual(plan(base, newest, mine({ 'tests/t.rs': null })), ['write tests/t.rs', 'write yukibana.json'], 'a deleted read-only file comes back');
});

test('a file that becomes read-only is replaced too, and flagged as newly protected when the student had edited it', () => {
  const newest = starter(V2, ['tests/**', 'src/helpers.rs'], {
    'src/lib.rs': 'fn a() {}\n',
    'src/helpers.rs': 'helpers v2\n',
    'tests/t.rs': 'test v1\n',
    'README.md': 'read me\n',
  });
  assert.deepEqual(plan(base, newest, mine({ 'src/helpers.rs': 'my helpers\n' })), ['write src/helpers.rs [edited,newly]', 'write yukibana.json']);
  assert.deepEqual(plan(base, newest, mine()), ['write src/helpers.rs [newly]', 'write yukibana.json'], 'untouched, it is simply updated');
});

test("a file read-only only in the old release is still the teacher's: the student's edit there was tampering under the old stamp", () => {
  const newest = starter(V2, [], { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v2\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, newest, mine({ 'tests/t.rs': 'my test\n' })), ['write tests/t.rs [edited]', 'write yukibana.json']);
});

test('a protected file the student created that no release has is deleted, flagged, so grading does not see it as added', () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, newest, mine({ 'tests/extra.rs': 'mine\n' })), ['delete tests/extra.rs [edited]', 'write yukibana.json']);
});

test("deletions: an untouched file goes, a changed one is the student's to choose about", () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, newest, mine()), ['delete src/helpers.rs', 'write yukibana.json']);
  assert.deepEqual(plan(base, newest, mine({ 'src/helpers.rs': 'mine\n' })), ['write yukibana.json', 'choose src/helpers.rs (deletedByTeacher)']);
  assert.deepEqual(plan(base, newest, mine({ 'src/helpers.rs': null })), ['write yukibana.json'], 'deleted by both is nothing');
});

test('a file the student deleted and the teacher changed is a choice; one only the student deleted stays deleted', () => {
  const changed = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v2\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, changed, mine({ 'src/helpers.rs': null })), ['write yukibana.json', 'choose src/helpers.rs (deletedByStudent)']);
  const same = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  assert.deepEqual(plan(base, same, mine({ 'src/helpers.rs': null })), ['write yukibana.json']);
});

test('two different files created at one path are a choice, never a merge against nothing', () => {
  const newest = starter(V2, RO, {
    'src/lib.rs': 'fn a() {}\n',
    'src/helpers.rs': 'helpers v1\n',
    'tests/t.rs': 'test v1\n',
    'README.md': 'read me\n',
    'src/extra.rs': 'teacher\n',
  });
  assert.deepEqual(plan(base, newest, mine({ 'src/extra.rs': 'student\n' })), ['write yukibana.json', 'choose src/extra.rs (bothAdded)']);
});

test('binary files and non-files cannot be merged line by line', () => {
  const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, n]);
  const b = [...base, file('img.png', png(1))];
  const n = [
    ...starter(V2, RO, { 'src/lib.rs': 'fn a() {}\nfn b() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' }),
    file('img.png', png(2)),
  ];
  const folder = mine({ 'img.png': { kind: 'file', data: png(3), mode: 0o644 }, 'src/lib.rs': { kind: 'other' } });
  assert.deepEqual(plan(b, n, folder), ['write yukibana.json', 'choose img.png (binary)', 'choose src/lib.rs (binary)']);
});

test('a script the teacher made executable is updated, even with the same bytes', () => {
  const b = [...base, file('run.sh', 'echo\n', 0o644)];
  const n = [
    ...starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' }),
    file('run.sh', 'echo\n', 0o755),
  ];
  assert.deepEqual(plan(b, n, mine({ 'run.sh': 'echo\n' })), ['write run.sh', 'write yukibana.json']);
});

test('only a new stamp is something a host may apply without asking', () => {
  const same = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  const planned = planUpdate(base, same, mine({ 'src/lib.rs': 'mine\n' }));
  assert.ok(planned.ok);
  assert.equal(onlyTheStamp(planned.plan), true);
  assert.equal(planned.plan.from, V1);
  assert.equal(planned.plan.to, V2);
  const fixed = planUpdate(base, starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v1\n', 'tests/t.rs': 'test v2\n', 'README.md': 'read me\n' }), mine());
  assert.ok(fixed.ok);
  assert.equal(onlyTheStamp(fixed.plan), false);
});

test('a starter wrapped in a folder, as git archive makes them, plans the same', () => {
  const newest = starter(V2, RO, { 'src/lib.rs': 'fn a() {}\n', 'src/helpers.rs': 'helpers v2\n', 'tests/t.rs': 'test v1\n', 'README.md': 'read me\n' });
  const wrapped = newest.map(e => ({ ...e, path: `parser/${e.path}` }));
  assert.deepEqual(plan(base, wrapped, mine()), plan(base, newest, mine()));
});

test("the folder paths a plan needs are the starters' and the protected ones", () => {
  const newest = starter(V2, ['tests/**', 'data'], { 'src/lib.rs': 'x' });
  assert.deepEqual(wantedPaths(base, newest, ['target/debug/x', 'tests/mine.rs', 'data/in.txt', 'notes.txt']), [
    'README.md',
    'data/in.txt',
    'src/helpers.rs',
    'src/lib.rs',
    'tests/mine.rs',
    'tests/t.rs',
    'yukibana.json',
  ]);
});

test('a starter without a config cannot be planned, and says which', () => {
  const planned = planUpdate([file('a', 'x')], base, new Map());
  assert.ok(!planned.ok);
  assert.match(planned.problem, /started from has no yukibana.json/);
});
