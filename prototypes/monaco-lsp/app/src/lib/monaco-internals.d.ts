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
