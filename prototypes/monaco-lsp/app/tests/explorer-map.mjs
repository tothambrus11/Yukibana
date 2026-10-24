// Unit tests of the compiler output views' line mapping
// (src/lib/explorer-map.ts): which IR or assembly lines a source line
// produced, which source line an output line came from, which source a view
// shows as the editor moves between files, the toolbar's flags, and what
// the linked views draw with: the lines' hues, the parts of a line, and
// which place of a line to scroll to.
//
//   node --test tests/explorer-map.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hueGroups, isViewSource, lineKey, outputLinesFor, partAt, partFromChain, runsOf, runToReveal, shortFlags, sourceOf, viewSourceFor } from '../src/lib/explorer-map.ts';

// main:                      1  null
//   push rbp                 2  main.cpp:6
//   call distance            3  main.cpp:8
//   movsd ...                4  main.cpp:8
// .LBB0_1:                   5  null
//   call norm                6  main.cpp:9
//   ret (inlined from a header) 7  geometry.h:9
//   xor eax, eax             8  main.cpp:8
const lines = [null, { file: 'main.cpp', line: 6 }, { file: 'main.cpp', line: 8 }, { file: 'main.cpp', line: 8 }, null, { file: 'main.cpp', line: 9 }, { file: 'geometry.h', line: 9 }, { file: 'main.cpp', line: 8 }];

test('a source line lights up every output line it produced, in order', () => {
	assert.deepEqual(outputLinesFor(lines, 'main.cpp', 8), [3, 4, 8]);
	assert.deepEqual(outputLinesFor(lines, 'main.cpp', 6), [2]);
});

test("a line of another file with the same number is not the source line's output", () => {
	assert.deepEqual(outputLinesFor(lines, 'geometry.h', 9), [7]);
	assert.deepEqual(outputLinesFor(lines, 'main.cpp', 9), [6]);
	assert.deepEqual(outputLinesFor(lines, 'geometry.cpp', 8), []);
});

test('a source line that produced no code, or no line at all, lights up nothing', () => {
	assert.deepEqual(outputLinesFor(lines, 'main.cpp', 1), []);
	assert.deepEqual(outputLinesFor(lines, 'main.cpp', 0), []);
	assert.deepEqual(outputLinesFor(lines, 'main.cpp', 2.5), []);
	assert.deepEqual(outputLinesFor([], 'main.cpp', 8), []);
});

test('an output line leads back to its source line; labels and lines outside the output lead nowhere', () => {
	assert.deepEqual(sourceOf(lines, 3), { file: 'main.cpp', line: 8 });
	assert.deepEqual(sourceOf(lines, 7), { file: 'geometry.h', line: 9 });
	assert.equal(sourceOf(lines, 1), null);
	assert.equal(sourceOf(lines, 5), null);
	assert.equal(sourceOf(lines, 0), null);
	assert.equal(sourceOf(lines, 9), null);
	assert.equal(sourceOf(lines, Number.NaN), null);
});

test('the mapping round-trips: every mapped output line is among its source line’s output lines', () => {
	for (let n = 1; n <= lines.length; n++) {
		const at = sourceOf(lines, n);
		if (at) assert.ok(outputLinesFor(lines, at.file, at.line).includes(n), `line ${n}`);
	}
});

test('consecutive output lines of one source line are decorated as one block', () => {
	assert.deepEqual(runsOf([3, 4, 8]), [
		{ start: 3, end: 4 },
		{ start: 8, end: 8 },
	]);
	assert.deepEqual(runsOf([]), []);
	assert.deepEqual(runsOf([1, 2, 3]), [{ start: 1, end: 3 }]);
});

test('the views show C and C++ sources; a header or another file keeps the source shown before', () => {
	for (const p of ['main.c', 'a.cc', 'main.cpp', 'x.cxx', 'y.c++', 'z.C', 'src/deep/k.cpp']) assert.ok(isViewSource(p), p);
	for (const p of ['geometry.h', 'g.hpp', 'compile_flags.txt', 'main.cpp.bak', 'README.md']) assert.ok(!isViewSource(p), p);
	assert.equal(viewSourceFor('geometry.cpp', 'main.cpp'), 'geometry.cpp');
	assert.equal(viewSourceFor('geometry.h', 'main.cpp'), 'main.cpp');
	assert.equal(viewSourceFor('compile_flags.txt', 'main.cpp'), 'main.cpp');
	assert.equal(viewSourceFor(null, 'main.cpp'), 'main.cpp');
	assert.equal(viewSourceFor('geometry.h', null), null);
});

test("the toolbar's flags say how the code is compiled, not where its files are", () => {
	const flags = ['--target=x86_64-linux-musl', '-resource-dir=/usr/lib/clang/21', '-O2', '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST', '-std=c++20', '-Wall', '-I.', '-I', 'include', '-isystem', '/usr/include/x', '-gline-tables-only', '-fno-discard-value-names', '-S', '-masm=intel'];
	assert.deepEqual(shortFlags(flags), ['-O2', '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST', '-std=c++20', '-Wall', '-masm=intel']);
	const wasm = ['--target=wasm32-wasip1', '--sysroot=/wasi', '-resource-dir=/usr/lib/clang/21', '-O2', '-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false', '-S', '-emit-llvm'];
	assert.deepEqual(shortFlags(wasm), ['-O2', '-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false']);
});

const at = (line, column = 0) => ({ file: 'main.cpp', line, column });

test('lines whose code sits side by side in a view get different hues', () => {
	// IR: 18 19 18 21; assembly: 19 21 21 18
	const ir = [null, at(18), at(19), at(18), null, at(21)];
	const asm = [at(19), at(21), at(21), null, at(18)];
	const hue = hueGroups([ir, asm], 8);
	assert.equal(hue.size, 3);
	assert.notEqual(hue.get(lineKey('main.cpp', 18)), hue.get(lineKey('main.cpp', 19)));
	assert.notEqual(hue.get(lineKey('main.cpp', 19)), hue.get(lineKey('main.cpp', 21)));
});

test('neighbouring source lines get different hues even when their code is apart', () => {
	const hue = hueGroups([[at(5), null, null, at(6)]], 8);
	assert.notEqual(hue.get(lineKey('main.cpp', 5)), hue.get(lineKey('main.cpp', 6)));
});

test('hues are spread: a line takes the least used one its neighbours leave, and the same output gets the same colours', () => {
	const map = [at(1), at(3), at(5), at(7), at(9), at(11), at(13), at(15), at(17)];
	const hue = hueGroups([map], 8);
	assert.deepEqual([1, 3, 5, 7, 9, 11, 13, 15].map((l) => hue.get(lineKey('main.cpp', l))), [0, 1, 2, 3, 4, 5, 6, 7]);
	assert.deepEqual(hueGroups([map], 8), hue);
	// More neighbours than hues: one is shared rather than none given.
	const crowded = hueGroups([[at(1), at(2), at(1), at(3), at(1), at(4)]], 2);
	assert.equal(crowded.size, 4);
	for (const h of crowded.values()) assert.ok(h === 0 || h === 1);
});

test('lines of different files are different groups', () => {
	const hue = hueGroups([[{ file: 'a.cpp', line: 3 }, { file: 'b.h', line: 3 }]], 8);
	assert.notEqual(hue.get(lineKey('a.cpp', 3)), hue.get(lineKey('b.h', 3)));
});

// `    for (int i = 0; i < n; ++i) {` is line 18; clangd's selection ranges, innermost first.
const range = (from, to, line = 17) => ({ start: { line, character: from - 1 }, end: { line, character: to - 1 } });
const FOR = range(5, 35); // the whole for statement, on its line
const forBody = { start: { line: 17, character: 4 }, end: { line: 21, character: 5 } }; // ... down to its closing brace

test("an instruction recorded at an expression's start comes from the largest expression starting there", () => {
	// `++i` at column 28: the unary operator, then the for statement.
	assert.deepEqual(partFromChain([range(30, 31), range(28, 31), forBody], 18, 28), { start: 28, end: 31 });
	// A call `dot(points[i], light)` at column 17, inside `int d = ...`: the call, not the declaration.
	assert.deepEqual(partFromChain([range(17, 20, 18), range(17, 37, 18), range(9, 37, 18), range(9, 38, 18)], 19, 17), { start: 17, end: 37 });
});

test("an instruction recorded at a binary operator comes from the operator's expression", () => {
	// `i < n`: clang records the `<` at column 23; no range starts there.
	assert.deepEqual(partFromChain([range(21, 26), FOR], 18, 23), { start: 21, end: 26 });
});

test('a part never spans lines, and no column means no part', () => {
	assert.equal(partFromChain([forBody], 18, 5), null);
	assert.equal(partFromChain([range(28, 31)], 18, 0), null);
	assert.equal(partFromChain([], 18, 28), null);
});

test('the caret is in the smallest part around it, or the part it just ends', () => {
	const parts = [{ start: 21, end: 26 }, { start: 28, end: 31 }, { start: 5, end: 35 }];
	assert.deepEqual(partAt(parts, 24), { start: 21, end: 26 });
	assert.deepEqual(partAt(parts, 31), { start: 5, end: 35 });
	assert.deepEqual(partAt(parts, 3), null);
	assert.deepEqual(partAt([{ start: 28, end: 31 }], 31), { start: 28, end: 31 });
});

test('a view scrolls only when none of the line\'s places is in view, and then to the nearest one', () => {
	const runs = [{ start: 3, end: 5 }, { start: 40, end: 41 }, { start: 90, end: 90 }];
	assert.equal(runToReveal(runs, 1, 30), null);
	assert.deepEqual(runToReveal(runs, 50, 80), { start: 40, end: 41 });
	assert.deepEqual(runToReveal(runs, 70, 85), { start: 90, end: 90 });
	assert.equal(runToReveal([], 1, 30), null);
});
