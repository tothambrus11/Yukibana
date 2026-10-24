// Unit tests of the LSP answers the client converts without Monaco
// (src/lib/lsp/plain.ts): a refused rename's reason, folding ranges and
// smart-select chains.
//
//   node --test tests/lsp.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reasonOf, toFolds, toSelectionChain } from '../src/lib/lsp/plain.ts';

const range = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
const monacoRange = (sl, sc, el, ec) => ({ range: { startLineNumber: sl + 1, startColumn: sc + 1, endLineNumber: el + 1, endColumn: ec + 1 } });

test("a refused PHP class rename says Phpactor's sentence, not its stack trace", () => {
	const message = "There are no file path candidates#0 /opt/phpactor/lib/Rename/Adapter/ReferenceFinder/ClassMover/ClassRenamer.php(80): Phpactor\\Rename\\x->convert('Geometry\\\\Pt')\n#1 /opt/phpactor/lib/Rename/Model/Renamer/ChainRenamer.php(34)";
	assert.equal(reasonOf(message), 'There are no file path candidates');
});

test("clangd's refusal is shown as it was sent", () => {
	assert.equal(reasonOf('invalid name: "int" is a keyword'), 'invalid name: "int" is a keyword');
});

test('a server that refuses without a message still gets a reason, and a long one is cut', () => {
	assert.equal(reasonOf('  \n'), 'The language server could not do this.');
	const long = reasonOf('x'.repeat(1000));
	assert.equal(long.length, 300);
	assert.ok(long.endsWith('…'));
});

test('folding ranges move to lines counted from 1, keep their kind, and one-line ranges are dropped', () => {
	assert.deepEqual(
		toFolds([
			{ startLine: 0, endLine: 3, kind: 'imports' },
			{ startLine: 5, endLine: 9 },
			{ startLine: 7, endLine: 7 },
			{ startLine: 9, endLine: 8 },
		]),
		[{ start: 1, end: 4, kind: 'imports' }, { start: 6, end: 10 }],
	);
});

test('smart select grows from the word to the enclosing statement and block', () => {
	const chain = { range: range(2, 4, 2, 8), parent: { range: range(2, 0, 2, 20), parent: { range: range(1, 0, 4, 1) } } };
	assert.deepEqual(toSelectionChain(chain), [monacoRange(2, 4, 2, 8), monacoRange(2, 0, 2, 20), monacoRange(1, 0, 4, 1)]);
});

test('smart select stops at a parent that does not contain its child', () => {
	const chain = { range: range(2, 4, 2, 8), parent: { range: range(3, 0, 3, 5), parent: { range: range(0, 0, 9, 0) } } };
	assert.deepEqual(toSelectionChain(chain), [monacoRange(2, 4, 2, 8)]);
});
