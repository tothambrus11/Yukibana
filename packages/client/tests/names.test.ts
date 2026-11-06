import { test } from 'vitest';
import assert from 'node:assert/strict';
import { folderNames, safeSegment, stampOf, type Person } from '../src/lib/names.js';

test('a name becomes a folder every filesystem accepts', () => {
  const cases: [string, string][] = [
    ['Zoë Ångström', 'Zoë Ångström'],
    ['田中 太郎', '田中 太郎'],
    ['a/b\\c', 'a_b_c'],
    ['what: "now"?', 'what_ _now__'],
    ['  lots   of\tspace ', 'lots of space'],
    ['.hidden', '_hidden'],
    ['..', '__'],
    ['trailing. ', 'trailing'],
    ['CON', '_CON'],
    ['com1.txt', '_com1.txt'],
    ['', '_'],
    ['line\nbreak', 'line break'],
    ['bell\u0007', 'bell_'],
  ];
  for (const [input, want] of cases) assert.equal(safeSegment(input), want, JSON.stringify(input));
  assert.ok(new TextEncoder().encode(safeSegment('é'.repeat(200))).length <= 80, 'long names are cut on a character');
});

const person = (userId: string, fullName: string | null, githubLogin: string | null = null, email: string | null = null): Person => ({ userId, fullName, githubLogin, email });

test("each student's folder is their name, or their login, address or id when GitHub had no name", () => {
  const names = folderNames([
    person('11111111-0000', 'Ada Lovelace', 'ada'),
    person('22222222-0000', null, 'grace'),
    person('33333333-0000', null, null, 'alan@uni.example'),
    person('44444444-0000', '   '),
  ]);
  assert.deepEqual([...names.values()], ['Ada Lovelace', 'grace', 'alan', '44444444-0000']);
});

test('two students with one name, in any case, both get their login so neither is the plain one by accident', () => {
  const names = folderNames([person('11111111-0000', 'Kim Lee', 'kimlee'), person('22222222-0000', 'kim lee', 'klee2'), person('33333333-0000', 'Kim Lee', null)]);
  assert.deepEqual([...names.values()], ['Kim Lee (kimlee)', 'kim lee (klee2)', 'Kim Lee (33333333)']);
});

test('a submission time is a sortable folder name without colons', () => {
  assert.equal(stampOf('2026-10-07T14:03:05.123Z'), '2026-10-07T14-03-05Z');
});
