import { test } from 'vitest';
import assert from 'node:assert/strict';
import { assemble, submissionRoot, tampered } from '../src/lib/assemble.js';
import type { Entry } from '../src/lib/tar.js';
import { starterConfig, parseConfig } from '../src/lib/yukibana.js';

const text = (s: string) => new TextEncoder().encode(s);
const file = (path: string, body: string): Entry => ({ path, type: 'file', mode: 0o644, mtime: 1, data: text(body) });
const body = (entries: readonly Entry[], path: string) => {
  const e = entries.find(x => x.path === path);
  return e === undefined ? undefined : new TextDecoder().decode(e.data);
};

const CONFIG = '{"version":1,"kind":"scala-sbt","readOnly":["tests/*","README.md","yukibana.json"],"hidden":["tests/hidden"]}';
const parsed = parseConfig(CONFIG);
if (!parsed.ok) throw new Error(parsed.error);
const studentCopy = starterConfig(parsed.config, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01', null);

/** The teacher archive: the whole project in its folder. */
const teacher: Entry[] = [
  { path: 'hello', type: 'dir', mode: 0o755, mtime: 1, data: new Uint8Array(0) },
  file('hello/yukibana.json', CONFIG),
  file('hello/build.sbt', 'teacher build'),
  file('hello/README.md', 'the task'),
  file('hello/Main.scala', 'teacher solution'),
  file('hello/tests/public.scala', 'public test'),
  file('hello/tests/hidden/secret.scala', 'secret test'),
];

/** What an honest student sends: the starter, with their own work. */
const honest = (): Entry[] => [
  file('yukibana.json', studentCopy),
  file('build.sbt', 'student build'),
  file('README.md', 'the task'),
  file('Main.scala', 'student solution'),
  file('tests/public.scala', 'public test'),
];

test("an assembly is the student's work with the teacher's read-only and hidden files", () => {
  const made = assemble(honest(), teacher);
  assert.ok(made.ok);
  const { entries, tampering } = made.assembly;
  assert.equal(body(entries, 'Main.scala'), 'student solution', "the work is the student's");
  assert.equal(body(entries, 'build.sbt'), 'student build', "what is not protected is the student's, even if the teacher has it too");
  assert.equal(body(entries, 'tests/hidden/secret.scala'), 'secret test', 'the hidden test is back');
  assert.equal(body(entries, 'yukibana.json'), CONFIG, "the config is always the teacher's");
  assert.ok(!tampered(tampering), "an honest submission flags nothing, though its config copy differs from the teacher's");
});

test('a changed read-only file is replaced and flagged', () => {
  const sub = honest().map(e => (e.path === 'tests/public.scala' ? file(e.path, 'assert(true)') : e));
  const made = assemble(sub, teacher);
  assert.ok(made.ok);
  assert.equal(body(made.assembly.entries, 'tests/public.scala'), 'public test');
  assert.deepEqual(made.assembly.tampering.modified, ['tests/public.scala']);
});

test('a deleted read-only file is restored and flagged; a hidden one the student never had is not', () => {
  const sub = honest().filter(e => e.path !== 'README.md');
  const made = assemble(sub, teacher);
  assert.ok(made.ok);
  assert.equal(body(made.assembly.entries, 'README.md'), 'the task');
  assert.deepEqual(made.assembly.tampering.deleted, ['README.md']);
});

test("an edited or missing yukibana.json is flagged, and the teacher's is used either way", () => {
  const edited = honest().map(e => (e.path === 'yukibana.json' ? file(e.path, studentCopy.replace('"tests/*",', '')) : e));
  const a = assemble(edited, teacher);
  assert.ok(a.ok);
  assert.deepEqual(a.assembly.tampering.modified, ['yukibana.json']);
  assert.equal(body(a.assembly.entries, 'yukibana.json'), CONFIG);
  const missing = honest().filter(e => e.path !== 'yukibana.json');
  const b = assemble(missing, teacher);
  assert.ok(b.ok);
  assert.deepEqual(b.assembly.tampering.deleted, ['yukibana.json']);
});

test('a file a student slips into a protected folder is dropped and flagged', () => {
  const sub = [...honest(), file('tests/hidden/secret.scala', 'fake'), file('tests/mine.scala', 'extra')];
  const made = assemble(sub, teacher);
  assert.ok(made.ok);
  assert.equal(body(made.assembly.entries, 'tests/hidden/secret.scala'), 'secret test');
  assert.equal(body(made.assembly.entries, 'tests/mine.scala'), undefined);
  assert.deepEqual(made.assembly.tampering.added, ['tests/hidden/secret.scala', 'tests/mine.scala']);
});

test('a symlink out of the project in a submission is dropped', () => {
  const sub = [...honest(), { path: 'evil', type: 'symlink', mode: 0o777, mtime: 1, data: new Uint8Array(0), linkTarget: '../../.ssh/id_rsa' } as Entry];
  const made = assemble(sub, teacher);
  assert.ok(made.ok);
  assert.deepEqual(made.assembly.refused, ['evil']);
  assert.ok(!made.assembly.entries.some(e => e.path === 'evil'));
});

test('a submission packed with its folder is read from inside it; one without a config is taken as it is', () => {
  const wrapped: Entry[] = [{ path: 'hello', type: 'dir', mode: 0o755, mtime: 1, data: new Uint8Array(0) }];
  for (const e of honest()) wrapped.push(file(`hello/${e.path}`, new TextDecoder().decode(e.data)));
  assert.ok(submissionRoot(wrapped).some(e => e.path === 'Main.scala'));
  const bare = [file('src/Main.scala', 'x')];
  assert.deepEqual(
    submissionRoot(bare).map(e => e.path),
    ['src/Main.scala'],
    'a lone top folder without a config is not a wrapper',
  );
});

test('a teacher archive without a config cannot assemble anything, and says so', () => {
  const made = assemble(honest(), [file('x/Main.scala', '')]);
  assert.ok(!made.ok);
  assert.match(made.problem, /no yukibana.json/);
});

/** A later release that fixed the public test and made one more file
 *  read-only. */
const CONFIG_V2 = '{"version":1,"kind":"scala-sbt","readOnly":["tests/*","README.md","yukibana.json","Util.scala"],"hidden":["tests/hidden"]}';
const teacherV2: Entry[] = teacher
  .map(e => (e.path === 'hello/tests/public.scala' ? file(e.path, 'fixed public test') : e.path === 'hello/yukibana.json' ? file(e.path, CONFIG_V2) : e))
  .concat([file('hello/Util.scala', 'helper')]);

test("a read-only file fixed in a later release is not reported as the student's change, and the fix is what gets graded", () => {
  const made = assemble(honest(), teacherV2, teacher);
  assert.ok(made.ok);
  assert.ok(!tampered(made.assembly.tampering), 'the student who started from the first release changed nothing');
  assert.equal(body(made.assembly.entries, 'tests/public.scala'), 'fixed public test');
  assert.equal(body(made.assembly.entries, 'Util.scala'), 'helper', 'and the newer release decides what is protected');
  assert.equal(body(made.assembly.entries, 'yukibana.json'), CONFIG_V2);
});

test('compared with the newest release alone, the same honest student would have been flagged', () => {
  const made = assemble(honest(), teacherV2);
  assert.ok(made.ok);
  assert.deepEqual(made.assembly.tampering.modified, ['tests/public.scala', 'yukibana.json']);
});

test('a student who started from an old release and changed its read-only file is still caught', () => {
  const sub = honest().map(e => (e.path === 'tests/public.scala' ? file(e.path, 'assert(true)') : e));
  const made = assemble(sub, teacherV2, teacher);
  assert.ok(made.ok);
  assert.deepEqual(made.assembly.tampering.modified, ['tests/public.scala']);
  assert.equal(body(made.assembly.entries, 'tests/public.scala'), 'fixed public test');
});

test('a starter copy naming its release is not a change to yukibana.json', () => {
  const stamped = starterConfig(parsed.config, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01', '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
  const sub = honest().map(e => (e.path === 'yukibana.json' ? file(e.path, stamped) : e));
  const made = assemble(sub, teacher);
  assert.ok(made.ok);
  assert.ok(!tampered(made.assembly.tampering));
});

test('a broken archive for the release the student started from is a problem, not a silent comparison with another', () => {
  const made = assemble(honest(), teacher, [file('x/Main.scala', '')]);
  assert.ok(!made.ok);
  assert.match(made.problem, /the release the student started from/);
});

test("a file the grading release protects but the student's did not is replaced, and said so rather than lost in silence", () => {
  const base: Entry[] = [
    file('hello/yukibana.json', '{"version":1,"kind":"scala-sbt","readOnly":["tests/*"]}'),
    file('hello/tests/a.scala', 'A'),
    file('hello/Main.scala', 'skeleton'),
  ];
  const grade: Entry[] = [
    file('hello/yukibana.json', '{"version":1,"kind":"scala-sbt","readOnly":["tests/*","Main.scala"],"hidden":["hidden"]}'),
    file('hello/tests/a.scala', 'A'),
    file('hello/Main.scala', 'skeleton 2'),
    file('hello/hidden/h.scala', 'H'),
  ];
  const sub = [
    file('yukibana.json', '{"version":1,"kind":"scala-sbt","readOnly":["tests/*"]}'),
    file('tests/a.scala', 'A'),
    file('Main.scala', 'student work'),
    file('hidden/mine.scala', 'mine'),
  ];
  const made = assemble(sub, grade, base);
  assert.ok(made.ok);
  assert.ok(!tampered(made.assembly.tampering), 'the student broke no rule of the release they had');
  assert.deepEqual(made.assembly.overridden, ['Main.scala', 'hidden/mine.scala']);
  assert.equal(body(made.assembly.entries, 'Main.scala'), 'skeleton 2');
});

test("a change the grading release no longer protects stays the student's, and is not reported as undone", () => {
  const base: Entry[] = [
    file('hello/yukibana.json', '{"version":1,"kind":"scala-sbt","readOnly":["tests/*","Main.scala"]}'),
    file('hello/tests/a.scala', 'A'),
    file('hello/Main.scala', 'skeleton'),
  ];
  const grade: Entry[] = [
    file('hello/yukibana.json', '{"version":1,"kind":"scala-sbt","readOnly":["tests/*"]}'),
    file('hello/tests/a.scala', 'A'),
    file('hello/Main.scala', 'skeleton'),
  ];
  const sub = [file('yukibana.json', '{"version":1,"kind":"scala-sbt","readOnly":["tests/*","Main.scala"]}'), file('tests/a.scala', 'A'), file('Main.scala', 'student')];
  const made = assemble(sub, grade, base);
  assert.ok(made.ok);
  assert.deepEqual(made.assembly.tampering.modified, ['Main.scala']);
  assert.deepEqual(made.assembly.unrestored, ['Main.scala']);
  assert.equal(body(made.assembly.entries, 'Main.scala'), 'student');
});

test('with one release, nothing is overridden or left unrestored', () => {
  const sub = honest().map(e => (e.path === 'tests/public.scala' ? file(e.path, 'assert(true)') : e));
  const made = assemble(sub, teacher);
  assert.ok(made.ok);
  assert.deepEqual(made.assembly.overridden, []);
  assert.deepEqual(made.assembly.unrestored, []);
});
