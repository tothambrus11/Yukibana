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
