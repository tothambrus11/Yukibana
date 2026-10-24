/**
 * The words of Monaco's undo prompts and notices, as this app shows them
 * (workspace-edits.ts). Monaco's undo service writes them for VS Code: a
 * button's label marks its access key with `&&`, and a file is named by
 * its full path (`/workspace/geometry.ts`). Here a file is named by its
 * project path, as everywhere else in the app, and a file the service
 * calls "closed and modified on disk" is one deleted or renamed in the
 * project, the only way a project file's model goes away while the
 * project stays open.
 *
 * Imports nothing, so `node` can load this file directly
 * (tests/undo-text.mjs).
 */

/**
 * A dialog button's label without VS Code's access-key marks: `&&Undo in 2
 * Files` is `Undo in 2 Files`. The browser has no access keys in a dialog,
 * so the mark is dropped rather than drawn.
 */
export function buttonLabel(label: string): string {
	return label.replace(/&&/g, '');
}

/**
 * An undo or redo notice with project paths. `root` is the path the
 * project's model URIs start with (`/workspace/`): every path that starts
 * with it, after a space, a comma or the start of the text, loses it.
 * Monaco's sentence for files whose models were disposed is reworded,
 * since a project file's model is disposed only when the file is deleted
 * or renamed (or the whole project is replaced, which leaves nothing to
 * undo). A text that is not one of these notices comes back with only its
 * paths shortened.
 */
export function projectNotice(text: string, root: string): string {
	const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return text
		.replace(new RegExp(`(^|[\\s,])${escaped}`, 'g'), '$1')
		.replace('The following files have been closed and modified on disk:', 'These files were deleted or renamed since:');
}
