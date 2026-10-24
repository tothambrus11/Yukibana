// Unit tests of the compiler output views' line mapping
// (src/lib/explorer-map.ts): which IR or assembly lines a source line
// produced, which source line an output line came from, which source a view
// shows as the editor moves between files, and the toolbar's flags.
//
//   node --test tests/explorer-map.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isViewSource, outputLinesFor, runsOf, shortFlags, sourceOf, viewSourceFor } from '../src/lib/explorer-map.ts';

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
