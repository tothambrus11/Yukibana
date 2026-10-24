// Unit tests of the undo prompts' and notices' words (src/lib/undo-text.ts).
//
//   node --test tests/undo-text.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buttonLabel, projectNotice } from '../src/lib/undo-text.ts';

test('the undo prompt shows its buttons without access-key marks', () => {
	assert.equal(buttonLabel('&&Undo in 2 Files'), 'Undo in 2 Files');
	assert.equal(buttonLabel('Undo this &&File'), 'Undo this File');
	assert.equal(buttonLabel('Cancel'), 'Cancel');
});

test('a notice that changes were made to another file names it by its project path', () => {
	assert.equal(
		projectNotice("Could not undo 'Renaming distance to dist3' across all files because changes were made to /workspace/geometry.ts, /workspace/lib/util.ts", '/workspace/'),
		"Could not undo 'Renaming distance to dist3' across all files because changes were made to geometry.ts, lib/util.ts",
	);
});

test('a notice about a file deleted or renamed since says so, rather than that it was closed on disk', () => {
	assert.equal(
		projectNotice("Could not undo 'Renaming a to b' across all files. The following files have been closed and modified on disk: /workspace/geometry.py.", '/workspace/'),
		"Could not undo 'Renaming a to b' across all files. These files were deleted or renamed since: geometry.py.",
	);
});

test('a path that only contains the project folder further in is left alone', () => {
	assert.equal(projectNotice('see /tmp/workspace/x and /workspace/y', '/workspace/'), 'see /tmp/workspace/x and y');
});

test('any other notice is shown as it is', () => {
	assert.equal(projectNotice('Rename failed to compute edits', '/workspace/'), 'Rename failed to compute edits');
});
