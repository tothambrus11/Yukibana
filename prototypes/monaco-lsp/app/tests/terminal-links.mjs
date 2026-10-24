// Unit tests of the terminal's links (src/lib/terminal-links.ts): a project
// file's path and line in what a program or a compiler printed.
//
//   node --test tests/terminal-links.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linksIn } from '../src/lib/terminal-links.ts';

const files = new Set(['main.cpp', 'geometry.h', 'tests/geometry_test.cpp']);
const links = (text) => linksIn(text, files).filter((p) => p.place).map((p) => p.place);

test('a sanitizer frame links to the file, line and column it names', () => {
	assert.deepEqual(links('    #1 0x2fa in main main.cpp:21:40'), [{ path: 'main.cpp', line: 21, column: 40 }]);
});

test('a compiler diagnostic and a summary line link too, a line without a column as well', () => {
	assert.deepEqual(links("main.cpp:3:5: error: use of undeclared identifier"), [{ path: 'main.cpp', line: 3, column: 5 }]);
	assert.deepEqual(links('SUMMARY: AddressSanitizer: heap-buffer-overflow tests/geometry_test.cpp:9 in f()'), [{ path: 'tests/geometry_test.cpp', line: 9, column: null }]);
});

test('a path the project does not have stays plain text: system headers, absolute paths, other files', () => {
	assert.deepEqual(links('#2 0x1 in std::vector /usr/include/c++/v1/vector:1455:3'), []);
	assert.deepEqual(links('/workspace/main.cpp:3:5'), []);
	assert.deepEqual(links('other.cpp:3 and main.cpp:0'), []);
	assert.deepEqual(links('time 12:30'), []);
});

test('the pieces put back together are the text, links in their places', () => {
	const text = 'a main.cpp:1 b geometry.h:2:3 c';
	const pieces = linksIn(text, files);
	assert.equal(pieces.map((p) => p.text).join(''), text);
	assert.deepEqual(pieces.map((p) => (p.place ? `[${p.text}]` : p.text)), ['a ', '[main.cpp:1]', ' b ', '[geometry.h:2:3]', ' c']);
	assert.deepEqual(linksIn('', files), [{ text: '', place: null }]);
});
