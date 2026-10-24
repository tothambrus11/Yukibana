/**
 * The one place Monaco is imported. It loads the bare editor API plus only
 * the editor features and syntax grammars this app uses, so Monaco's own
 * TypeScript service never reaches the bundle: language features come from a
 * language server pack. The exceptions are the languages no pack serves:
 * JSON (configuration files such as `jsconfig.json` and `tsconfig.json`, with
 * their schemas), HTML, and CSS with SCSS and Less, which get Monaco's own
 * language services. Each of those is a small `register` module here; its
 * code (`*Mode.js`) and its worker are separate chunks, fetched the first
 * time a model of that language exists, so a Python session never downloads
 * them.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
// `?worker` imports are constructors holding the worker file's URL: the
// worker itself is only fetched by `new`, in getWorker below.
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import 'monaco-editor/languages/features/html/register';
import 'monaco-editor/languages/features/css/register';
import { StandaloneNotificationService, StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices';
import { MessageController } from 'monaco-editor/editor/contrib/message/browser/messageController';
import { OneReference } from 'monaco-editor/editor/contrib/gotoSymbol/browser/referencesModel';
import { ICommandService } from 'monaco-editor/platform/commands/common/commands';
import { IListService } from 'monaco-editor/platform/list/browser/listService';
import { pathOf, ROOT_URI } from './project';
import { AppDialogService, WorkspaceBulkEditService } from './workspace-edits';
import { projectNotice } from './undo-text';

/** The part of Monaco's internal list and tree widgets the references peek's keys use. */
type List = {
	getFocus(): unknown[];
	setSelection(elements: unknown[], browserEvent: KeyboardEvent): void;
	getInput?(): unknown;
	expand?(element: unknown): Promise<boolean>;
	onDidChangeModel?(listener: () => void): { dispose(): void };
};

// How Monaco names a file to people: the references peek's title and file
// rows, for example. Standalone Monaco's label service shows a file URI as
// a platform path (`\workspace` on Windows) and has no idea of a workspace.
// This one is the standalone service with the project folder as the
// workspace: a project file is shown by its project path, so a file at the
// root has no folder to show. Monaco reads overrides only when its services
// start, which is before any editor or other service exists: here.
//
// Monaco's notifications are shown too. Standalone Monaco writes them to the
// console only, so a rename the language server refused after the new name
// was typed (Phpactor's class rename, clangd's "the chosen name is a
// keyword") looked like a rename that did nothing. This service also shows
// each one as the inline message of the editor with focus, the place a
// rename refused before the name was typed already says why. A notice that
// an undo across files was done in one file only (workspace-edits.ts) comes
// just before that undo, which moves the caret and would close a message
// shown at once: so the message is shown once the current task is done,
// where the caret then is, and names files by their project paths.
const ROOT_PATH = monaco.Uri.parse(ROOT_URI).path;
class EditorNotificationService extends StandaloneNotificationService {
	override notify(notification: { severity: number; message: unknown }): unknown {
		const shown = super.notify(notification);
		const m = notification.message;
		const text = projectNotice(typeof m === 'string' ? m : m instanceof Error ? m.message : '', ROOT_PATH);
		// Severity 0 is Ignore.
		const editor = monaco.editor.getEditors().find((e) => e.hasWidgetFocus());
		if (!text || notification.severity <= 0 || !editor) return shown;
		setTimeout(() => {
			const position = editor.getPosition();
			if (position) MessageController.get(editor)?.showMessage(text, position);
		});
		return shown;
	}
}
// Workspace edits (rename, code actions) as one undo step across their
// files, and the dialog that asks whether to undo one: workspace-edits.ts.
// The keys are Monaco's service ids.
StandaloneServices.initialize({
	labelService: {
		getUriLabel: (uri: monaco.Uri) => pathOf(uri) ?? (uri.scheme === 'file' ? uri.fsPath : uri.path),
		getUriBasenameLabel: (uri: monaco.Uri) => uri.path.slice(uri.path.lastIndexOf('/') + 1),
	},
	notificationService: new EditorNotificationService(),
	IWorkspaceEditService: new WorkspaceBulkEditService(),
	dialogService: new AppDialogService(),
});

/** The editors' font stack; the first entry is the bundled web font. */
export const EDITOR_FONT = "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// The editor features used, as editor.main.js imports them, minus the ones
// this app has no use for (diff editor, colour picker, sticky scroll, ...).
// The `features/*/register` modules are not used: some import only part of a
// feature (suggest/register leaves out the suggest widget).
import 'monaco-editor/features/codicon/register'; // codicon.css
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations';
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions';
// Colour swatches and the colour picker, for the CSS service's colours.
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo';
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
// Also format on type (FormatOnType), which needs `formatOnType` in the editor's options.
import 'monaco-editor/editor/contrib/format/browser/formatActions';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/indentation/browser/indentation';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution';
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/links/browser/links';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints';
import 'monaco-editor/editor/contrib/rename/browser/rename';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens';
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch';

import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
// Web projects: HTML and CSS (SCSS, Less) grammars; their language services
// are registered at the top of this file.
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/swift/register';
import 'monaco-editor/languages/definitions/scala/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/kotlin/register';
// Monaco has no Haskell grammar: ours.
import './haskell-language';

// Monaco runs diffing and word-based helpers in a worker of its own, and each
// of the JSON, HTML and CSS services in another, started the first time the
// service is asked about a model. The label is the model's language; HTML's
// service also serves Handlebars and Razor, CSS's SCSS and Less.
const WORKERS: Record<string, new () => Worker> = { json: JsonWorker, html: HtmlWorker, handlebars: HtmlWorker, razor: HtmlWorker, css: CssWorker, scss: CssWorker, less: CssWorker };
self.MonacoEnvironment = { getWorker: (_id, label) => new (WORKERS[label] ?? EditorWorker)() };

// The schemas ship with the app (static/schemas/, from SchemaStore) and are
// fetched from it on demand: never from a third-party host. The files are
// JSON with comments and trailing commas, as TypeScript reads them.
jsonDefaults.setDiagnosticsOptions({
	validate: true,
	allowComments: true,
	comments: 'ignore',
	trailingCommas: 'ignore',
	enableSchemaRequest: true,
	schemas: ['jsconfig', 'tsconfig'].map((name) => ({
		uri: new URL(`schemas/${name}.json`, document.baseURI).href,
		fileMatch: [`${name}.json`, `*/${name}.json`, `${name}.*.json`],
	})),
});

// The references peek (Shift+F12, or F12 with several definitions) behaves
// as in VS Code: Up and Down show each reference in the preview, Enter goes
// to it and closes the peek. Standalone Monaco lacks VS Code's list
// commands: its tree handles the keys itself, so they only move the focus
// (arrows) or preview the focused reference (Enter), and keybindings never
// see them. After an arrow moves the focus, the focused reference is
// selected with the key's event, which is what VS Code's `list.focusDown`
// does; the tree then opens it as a preview. Enter is taken before the tree
// gets it and runs `openReference`, Monaco's own command for going to the
// focused reference and closing the peek.
//
// The peek also opens with every file's references shown, not only the
// current file's, so the arrows walk through all of them. Monaco's tree
// collapses every node it has not been told to expand; the peek focuses its
// tree when it opens, and that is when the files are
// expanded, once per peek (as soon as the tree has them).
const expanded = new WeakSet<object>();
/** Expands every file of the peek's references, once; false while the tree has none yet. */
function expandFiles(list: List): boolean {
	const input = list.getInput?.();
	if (typeof input !== 'object' || input === null) return false;
	if (expanded.has(input)) return true;
	expanded.add(input);
	// A peek over one file has that file as its input; over several, a model with `groups`.
	const groups = 'groups' in input && Array.isArray(input.groups) ? (input.groups as unknown[]) : [];
	for (const group of groups) void list.expand?.(group);
	return true;
}
window.addEventListener('focusin', (e) => {
	if (!(e.target instanceof Element) || !e.target.closest('.reference-zone-widget .ref-tree')) return;
	const list = (StandaloneServices.get(IListService) as { lastFocusedList?: List }).lastFocusedList;
	if (!list || expandFiles(list) || !list.onDidChangeModel) return;
	// Focused before its references arrived: expand them when they do.
	const listener = list.onDidChangeModel(() => {
		if (expandFiles(list)) listener.dispose();
	});
});
window.addEventListener(
	'keydown',
	(e) => {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (!(e.target instanceof Element) || !e.target.closest('.reference-zone-widget .ref-tree')) return;
		const list = (StandaloneServices.get(IListService) as { lastFocusedList?: List }).lastFocusedList;
		if (!list) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			// The tree moves its focus as usual; the focused reference is selected once it has.
			setTimeout(() => list.setSelection(list.getFocus(), e));
		} else if (e.key === 'Enter' && list.getFocus()[0] instanceof OneReference) {
			e.preventDefault();
			e.stopPropagation();
			void (StandaloneServices.get(ICommandService) as { executeCommand(id: string): Promise<unknown> }).executeCommand('openReference');
		}
	},
	true,
);

// Monaco measures character widths once, with whatever font is available at
// that moment. The editor font is a web font that arrives later, so without
// a remeasure the caret is drawn at the fallback font's offsets while the
// text uses JetBrains Mono: the cursor drifts away from what was typed.
document.fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());
void document.fonts.load(`13.5px ${EDITOR_FONT.split(',')[0]}`).then(() => monaco.editor.remeasureFonts());

export { monaco };

// `?trace` also exposes Monaco to the console and to tests.
if (new URLSearchParams(location.search).has('trace')) Object.assign(globalThis, { monaco });
