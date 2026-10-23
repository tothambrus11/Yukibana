/**
 * The one place Monaco is imported. It loads the bare editor API plus only
 * the editor features and syntax grammars this app uses, so none of Monaco's
 * own TypeScript, CSS or HTML language services reach the bundle: every
 * language feature comes from a language server pack. The exception is JSON:
 * configuration files (`jsconfig.json`, `tsconfig.json`) get Monaco's JSON
 * service, with their schemas, since no pack's server knows them.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices';
import { OneReference } from 'monaco-editor/editor/contrib/gotoSymbol/browser/referencesModel';
import { ICommandService } from 'monaco-editor/platform/commands/common/commands';
import { IListService } from 'monaco-editor/platform/list/browser/listService';

/** The part of Monaco's internal list and tree widgets the references peek's keys use. */
type List = {
	getFocus(): unknown[];
	setSelection(elements: unknown[], browserEvent: KeyboardEvent): void;
};

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
import 'monaco-editor/editor/contrib/comment/browser/comment';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo';
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
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
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/swift/register';
import 'monaco-editor/languages/definitions/scala/register';

// Monaco runs diffing and word-based helpers in a worker of its own, and the
// JSON service in another (loaded only when a JSON file is opened).
self.MonacoEnvironment = { getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()) };

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
