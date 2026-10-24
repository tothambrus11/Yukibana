// Unit tests of the optimisation levels (src/lib/optimization.ts): which
// level compile_flags.txt puts a C++ project on, how the Optimization picker
// rewrites that file, and how a saved level is read back.
//
//   node --test tests/optimization.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cppLevelOf, levelsOf, savedLevelOf, withCppLevel } from '../src/lib/optimization.ts';
import { targetOf, withTarget } from '../src/lib/cpp-targets.ts';

const said = (choice) => (choice.kind === 'other' ? { kind: 'other', flag: choice.flag } : { kind: choice.kind, flag: choice.level.flag });

test('a project without compile_flags.txt, or without a -O line, runs at -O2, as Run always did', () => {
	assert.deepEqual(said(cppLevelOf(undefined)), { kind: 'default', flag: '-O2' });
	assert.deepEqual(said(cppLevelOf(null)), { kind: 'default', flag: '-O2' });
	assert.deepEqual(said(cppLevelOf('-std=c++20\n-Wall\n')), { kind: 'default', flag: '-O2' });
});

test('the last -O line wins, as in clang, and a level the picker lacks is shown as it is spelt', () => {
	assert.deepEqual(said(cppLevelOf('-O0\n')), { kind: 'level', flag: '-O0' });
	assert.deepEqual(said(cppLevelOf('-O3\n-Wall\n  -Os  \r\n')), { kind: 'level', flag: '-Os' });
	assert.deepEqual(said(cppLevelOf('-O2\n')), { kind: 'level', flag: '-O2' });
	assert.deepEqual(said(cppLevelOf('-O1\n-Ofast\n')), { kind: 'other', flag: '-Ofast' });
	assert.deepEqual(said(cppLevelOf('-Og')), { kind: 'other', flag: '-Og' });
});

test('choosing a level replaces every -O line with one at the end and keeps the rest byte for byte', () => {
	assert.equal(withCppLevel('-std=c++20\n-O3\n-Wall\n-O1\n', '-O0'), '-std=c++20\n-Wall\n-O0\n');
	assert.equal(withCppLevel('-std=c++20\r\n-Wall', '-Oz'), '-std=c++20\r\n-Wall\r\n-Oz\r\n');
	assert.equal(withCppLevel('-std=c++20\n\n-Wall\n', '-O3'), '-std=c++20\n\n-Wall\n-O3\n');
	assert.equal(withCppLevel(undefined, '-O0'), '-O0\n');
});

test('choosing the default level removes the -O line, and a project without the file needs none', () => {
	assert.equal(withCppLevel('-std=c++20\n-O0\n', '-O2'), '-std=c++20\n');
	assert.equal(withCppLevel(undefined, '-O2'), '');
	assert.equal(withCppLevel('-Ofast\n', '-O2'), '');
});

test('the level and the target are independent lines of the same file', () => {
	let flags = withTarget('-std=c++20\n', 'aarch64-linux');
	flags = withCppLevel(flags, '-O0');
	assert.equal(flags, '--target=aarch64-linux-musl\n-std=c++20\n-O0\n');
	flags = withTarget(flags, 'x86_64-linux');
	assert.equal(said(cppLevelOf(flags)).flag, '-O0');
	assert.equal(targetOf(flags).target.id, 'x86_64-linux');
	assert.equal(withCppLevel(flags, '-O2'), '--target=x86_64-linux-musl\n-std=c++20\n');
});

test('only C, C++ and Swift have levels, and a saved level that is not one of the language\'s is the default', () => {
	assert.ok(levelsOf('cpp'));
	assert.deepEqual(levelsOf('swift').map((l) => l.flag), ['-Onone', '-O', '-Osize']);
	for (const language of ['python', 'javascript', 'typescript', 'rust', 'java', 'kotlin', 'php', 'haskell', 'scala']) assert.equal(levelsOf(language), null, language);
	for (const level of levelsOf('swift')) assert.equal(savedLevelOf('swift', level.flag), level.unavailable ? null : level.flag, level.flag);
	assert.equal(savedLevelOf('cpp', '-O0'), '-O0');
	assert.equal(savedLevelOf('swift', '-O3'), null);
	assert.equal(savedLevelOf('swift', 7), null);
	assert.equal(savedLevelOf('python', '-O'), null);
});
