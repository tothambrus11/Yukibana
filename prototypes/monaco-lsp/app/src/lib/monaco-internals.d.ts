/**
 * Types for the few Monaco internals the app reaches into, which the
 * package ships without declarations. Each is the smallest shape the app
 * relies on; see the use for why it is needed.
 */
type ServiceId = { readonly _serviceBrand: undefined };

declare module 'monaco-editor/editor/standalone/browser/standaloneServices' {
	/** The services of every standalone editor on the page; `get` creates one on first use. */
	export const StandaloneServices: {
		get(id: ServiceId): unknown;
		/** Starts the services, with the given ones (by service id) instead of Monaco's own; a no-op once started. */
		initialize(overrides: Record<string, unknown>): unknown;
	};
	/**
	 * Standalone Monaco's notification service: every notification (a
	 * rename's reject reason, "Rename failed to compute edits", ...) goes to
	 * the browser console and nowhere else. `info`, `warn` and `error` all
	 * call `notify`.
	 */
	export class StandaloneNotificationService {
		notify(notification: { severity: number; message: unknown }): unknown;
	}
}
declare module 'monaco-editor/editor/contrib/message/browser/messageController' {
	/** The inline message an editor shows at a position (the one a refused rename uses). */
	export class MessageController {
		/** The editor's controller; every editor has one, since rename imports it. */
		static get(editor: unknown): MessageController | null;
		/** Shows the message under `position` until the cursor moves or the editor loses focus. */
		showMessage(message: string, position: { lineNumber: number; column: number }): void;
	}
}
declare module 'monaco-editor/platform/list/browser/listService' {
	/** Tracks the list or tree that last had focus (`lastFocusedList`). */
	export const IListService: ServiceId;
}
declare module 'monaco-editor/platform/commands/common/commands' {
	/** Runs a registered command by id (`executeCommand`). */
	export const ICommandService: ServiceId;
}
declare module 'monaco-editor/editor/contrib/gotoSymbol/browser/referencesModel' {
	/** One reference in the references peek's tree (as opposed to a file's row). */
	export class OneReference {}
}
declare module 'monaco-editor/platform/undoRedo/common/undoRedo' {
	/** Every file's undo and redo stack, and the cross-file elements in them (workspace-edits.ts). */
	export const IUndoRedoService: ServiceId;
}
declare module 'monaco-editor/editor/common/model/editStack' {
	type Model = import('monaco-editor/editor/editor.api').editor.ITextModel;
	type Selection = import('monaco-editor/editor/editor.api').Selection;
	/**
	 * One file's undo step. While open (until `close`), the model's edits
	 * are appended to it when it is the last element in the file's stack.
	 */
	export class SingleModelEditStackElement {
		constructor(label: string, code: string, model: Model, beforeCursorState: Selection[] | null);
		close(): void;
	}
	/**
	 * One undo step across files, made of each file's step: the undo
	 * service keeps it in every one of those files' stacks and undoes it in
	 * all of them, or (split) in one.
	 */
	export class MultiModelEditStackElement {
		constructor(label: string, code: string, editStackElements: SingleModelEditStackElement[]);
		close(): void;
	}
}
declare module 'monaco-editor/editor/browser/services/bulkEditService' {
	type Uri = import('monaco-editor/editor/editor.api').Uri;
	type IRange = import('monaco-editor/editor/editor.api').IRange;
	type Editor = import('monaco-editor/editor/editor.api').editor.ICodeEditor;
	/** The service Monaco's features apply a workspace edit through (rename, code actions). */
	export const IBulkEditService: ServiceId;
	export class ResourceEdit {
		/** A Monaco `WorkspaceEdit`'s edits as these classes; throws on an edit of no known kind. */
		static convert(edit: unknown): ResourceEdit[];
	}
	/** One text edit of one file; `versionId` is the model version it was computed for, if known. */
	export class ResourceTextEdit extends ResourceEdit {
		readonly resource: Uri;
		readonly textEdit: { range: IRange; text: string };
		readonly versionId: number | undefined;
	}
	/** What a feature says about the edit it applies; the labels name the undo step. */
	export interface BulkEditOptions {
		editor?: Editor | undefined;
		label?: string | undefined;
		quotableLabel?: string | undefined;
		code?: string | undefined;
		undoRedoGroup?: unknown;
		undoRedoSource?: unknown;
	}
	export interface BulkEditResult {
		ariaSummary: string;
		isApplied: boolean;
	}
}
declare module 'monaco-editor/editor/standalone/common/themes' {
	/** A rule of Monaco's built-in themes: a token and its colour (`rrggbb`). */
	interface BuiltinRule {
		token: string;
		foreground?: string;
		background?: string;
		fontStyle?: string;
	}
	/** Monaco's `vs` and `vs-dark` themes, whose rules colour every token the Yukibana themes do not name. */
	export const vs: { rules: BuiltinRule[] };
	export const vs_dark: { rules: BuiltinRule[] };
}
