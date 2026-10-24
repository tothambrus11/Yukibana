// Unit tests of the C++ sanitizer choice (src/lib/cpp-sanitizers.ts): which
// sanitizers compile_flags.txt turns on, how the Sanitizers menu rewrites
// that file, and that what the menu writes is what the pack's runner reads
// as that sanitizer (packs/cpp/src/toolchain.js, sanitizersOf).
//
//   node --test tests/cpp-sanitizers.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSanitizers, SANITIZERS, sanitizersOf, withSanitizers } from '../src/lib/cpp-sanitizers.ts';
import { flagsFor, sanitizersOf as packSanitizersOf } from '../../packs/cpp/src/toolchain.js';

const off = { address: false, undefined: false };

test('a project without compile_flags.txt, or without a -fsanitize= line, has no sanitizer on', () => {
	assert.deepEqual(sanitizersOf(undefined), off);
	assert.deepEqual(sanitizersOf('-std=c++20\n-O2\n'), off);
});

test('-fsanitize= lists and -fno-sanitize= are read in order, as clang reads them', () => {
	assert.deepEqual(sanitizersOf('-fsanitize=address,undefined\n'), { address: true, undefined: true });
	assert.deepEqual(sanitizersOf('-fsanitize=address\n-fsanitize=undefined\n-fno-sanitize=address\n'), { address: false, undefined: true });
	assert.deepEqual(sanitizersOf('  -fsanitize=undefined  \r\n-fno-sanitize=all\r\n'), off);
	// One check of UBSan's is not the menu's UndefinedBehaviorSanitizer.
	assert.deepEqual(sanitizersOf('-fsanitize=signed-integer-overflow\n'), off);
});

test('turning a sanitizer on adds one -fsanitize= line at the end and keeps every other line', () => {
	assert.equal(withSanitizers('-std=c++20\n-O1\n', { address: true, undefined: false }), '-std=c++20\n-O1\n-fsanitize=address\n');
	assert.equal(withSanitizers('-std=c++20\n-fsanitize=address\n-Wall\n', { address: true, undefined: true }), '-std=c++20\n-Wall\n-fsanitize=address,undefined\n');
	assert.equal(withSanitizers(undefined, { address: false, undefined: true }), '-fsanitize=undefined\n');
});

test('turning them off takes out only their names, so hand-written checks stay', () => {
	assert.equal(withSanitizers('-fsanitize=address,undefined\n-std=c++20\n', off), '-std=c++20\n');
	assert.equal(withSanitizers('-fsanitize=address,signed-integer-overflow\n-fno-sanitize-recover=undefined\n', off), '-fsanitize=signed-integer-overflow\n-fno-sanitize-recover=undefined\n');
	assert.equal(withSanitizers('-fsanitize=address\n', off), '');
	// A -fno-sanitize= that would turn a chosen one off again goes too.
	assert.equal(withSanitizers('-fno-sanitize=address,vptr\n', { address: true, undefined: false }), '-fno-sanitize=vptr\n-fsanitize=address\n');
});

test('what the menu writes is what it reads back, for every choice', () => {
	for (const address of [false, true])
		for (const undefined_ of [false, true]) {
			const choice = { address, undefined: undefined_ };
			for (const before of [undefined, '-std=c++20\n', '-fsanitize=address\n-fno-sanitize=undefined\n']) {
				assert.deepEqual(sanitizersOf(withSanitizers(before, choice)), choice, `${JSON.stringify(before)} -> ${JSON.stringify(choice)}`);
			}
		}
});

test("the pack's runner reads the menu's lines as the same sanitizers, and fetches the matching runtime", () => {
	const runtimes = { 'false,false': null, 'true,false': 'asan', 'false,true': 'ubsan', 'true,true': 'asan' };
	for (const address of [false, true])
		for (const undefined_ of [false, true]) {
			const text = withSanitizers('-std=c++20\n', { address, undefined: undefined_ });
			const pack = packSanitizersOf(flagsFor({ 'compile_flags.txt': text }, true));
			assert.equal(pack.address, address, text);
			assert.equal(pack.undefined, undefined_, text);
			assert.equal(pack.runtime, runtimes[`${address},${undefined_}`], text);
		}
});

test('the output panel names the sanitizers on and the line that says so', () => {
	assert.equal(describeSanitizers(off), 'Sanitizers: off (no -fsanitize= line in compile_flags.txt).');
	assert.match(describeSanitizers({ address: true, undefined: true }), /^Sanitizers: AddressSanitizer and UndefinedBehaviorSanitizer \(-fsanitize=address,undefined in compile_flags\.txt\)\./);
	assert.deepEqual(SANITIZERS.map((s) => s.id), ['address', 'undefined']);
});
