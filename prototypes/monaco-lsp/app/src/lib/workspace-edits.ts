/**
 * Edits that span files, undone as VS Code undoes them. Two of Monaco's
 * services are replaced (monaco.ts installs them when the services start):
 *
 * - The bulk edit service, through which Monaco applies every workspace
 *   edit: a rename, a quick fix or other code action, and (lsp/client.ts)
 *   an edit the language server asks for with `workspace/applyEdit`.
 *   Standalone Monaco's applies each file's edits as that file's own undo
 *   step, so Ctrl+Z after a rename undid it in one file and left the
 *   others renamed: the project no longer compiled. This one does what VS
 *   Code's does: it pushes one undo element covering every file the edit
 *   touched (Monaco's `MultiModelEditStackElement`, which Monaco's undo
 *   service holds as a workspace element in each file's undo stack), then
 *   applies the edits into it.
 * - The dialog service, which Monaco's undo service asks before undoing
 *   such an element: standalone Monaco's is `window.confirm`, which cannot
 *   offer the two choices the question has. This one is a dialog in the
 *   app's style.
 *
 * What Ctrl+Z (or Ctrl+Y) then does is Monaco's undo service's, unchanged,
 * which is VS Code's (platform/undoRedo/common/undoRedoService):
 *
 * - When every file the edit touched still has it as its latest change,
 *   undo in any of them asks "Would you like to undo 'Renaming a to b'
 *   across all files?": Undo in N Files, Undo this File, or Cancel. Redo
 *   does not ask, and redoes it in every file.
 * - When another of those files was edited since, undoing across files
 *   would undo the edit under that file's later changes, or the later
 *   changes with it: neither is what was asked. So the edit is undone in
 *   this file only, at once, and a notice names the files that changed.
 *   The other files keep the edit, and each can still undo its own part.
 *   Asking first would offer one choice, and the notice says what was done.
 * - When one of those files was deleted or renamed since (`forgetUndo`),
 *   the same: this file only, and the notice says which files went away.
 *
 * Every project file is a Monaco model for as long as the project is open,
 * whether or not a tab shows it (workspace.svelte.ts), so an edit can be
 * undone in a file without a tab, and its language server sees the undo as
 * it sees any change: a `didChange` per file.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices';
import { IUndoRedoService } from 'monaco-editor/platform/undoRedo/common/undoRedo';
import { MultiModelEditStackElement, SingleModelEditStackElement } from 'monaco-editor/editor/common/model/editStack';
import { IBulkEditService, ResourceEdit, ResourceTextEdit, type BulkEditOptions, type BulkEditResult } from 'monaco-editor/editor/browser/services/bulkEditService';
import { buttonLabel } from './undo-text';

type UndoRedoService = {
	pushElement(element: unknown, group?: unknown, source?: unknown): void;
	removeElements(resource: monaco.Uri): void;
};

/** The undo element's code when the caller gives none, as VS Code's. */
const DEFAULT_CODE = 'undoredo.workspaceEdit';

/**
 * Monaco's bulk edit service, as VS Code's applies text edits: every file's
 * edits in one undo element. Only text edits: a file operation (create,
 * rename, delete) is refused with an error, as standalone Monaco's does;
 * the language client says which it could not apply before it gets here.
 */
export class WorkspaceBulkEditService {
	/** The refactoring preview (VS Code's Refactor Preview panel) does not exist here. */
	hasPreviewHandler(): boolean {
		return false;
	}

	/**
	 * Applies `editsIn`, a Monaco `WorkspaceEdit` or its edits. Rejects,
	 * changing nothing, when an edit names a file with no model or a
	 * version the model has left behind. The undo element is labelled with
	 * the caller's words (the rename's "Renaming a to b"), which the undo
	 * prompt quotes.
	 */
	async apply(editsIn: unknown, options?: BulkEditOptions): Promise<BulkEditResult> {
		const edits = Array.isArray(editsIn) ? (editsIn as unknown[]) : ResourceEdit.convert(editsIn);
		const byModel = new Map<monaco.editor.ITextModel, monaco.editor.IIdentifiedSingleEditOperation[]>();
		for (const edit of edits) {
			if (!(edit instanceof ResourceTextEdit)) throw new Error('only text edits are supported');
			const model = monaco.editor.getModel(edit.resource);
			if (!model) throw new Error(`no such file: ${edit.resource.toString()}`);
			if (typeof edit.versionId === 'number' && model.getVersionId() !== edit.versionId) throw new Error(`${edit.resource.toString()} changed in the meantime`);
			const list = byModel.get(model) ?? [];
			list.push({ range: monaco.Range.lift(edit.textEdit.range), text: edit.textEdit.text, forceMoveMarkers: true });
			byModel.set(model, list);
		}
		if (byModel.size === 0) return { ariaSummary: 'Made no edits', isApplied: false };

		// VS Code's BulkEditService prefers the quotable label, the one
		// without quotes around the names, since the prompt quotes it.
		const label = options?.quotableLabel ?? options?.label ?? 'Workspace edit';
		const code = options?.code ?? DEFAULT_CODE;
		const editor = options?.editor;
		const steps = [...byModel.keys()].map((model) => new SingleModelEditStackElement(label, code, model, editor?.getModel() === model ? editor.getSelections() : null));
		// One file: an ordinary undo step in it. More: one element in every
		// file's stack, which the undo service undoes as one.
		const element = steps.length === 1 ? steps[0]! : new MultiModelEditStackElement(label, code, steps);
		undoRedo().pushElement(element, options?.undoRedoGroup, options?.undoRedoSource);
		let count = 0;
		try {
			// Each model's edit stack appends to the open element pushed
			// above, the last one in its stack, rather than starting its own.
			for (const [model, ops] of byModel) {
				model.pushEditOperations(null, ops, () => null);
				count += ops.length;
			}
		} finally {
			element.close();
		}
		return { ariaSummary: `Made ${count} text edits in ${byModel.size} files`, isApplied: true };
	}
}

/**
 * Applies a workspace edit as Monaco's own features do, through the bulk
 * edit service: one undo step across its files, labelled `label`. Rejects
 * when a file has no model.
 */
export async function applyWorkspaceEdit(edit: monaco.languages.WorkspaceEdit, label: string): Promise<boolean> {
	const service = StandaloneServices.get(IBulkEditService) as { apply(edit: unknown, options: BulkEditOptions): Promise<BulkEditResult> };
	return (await service.apply(edit, { label, quotableLabel: label, code: DEFAULT_CODE })).isApplied;
}

/**
 * Forgets a file's undo history, when the file was deleted or renamed. An
 * edit across files that included it can then no longer be undone across
 * files: undo in another of them undoes that file's part only, and says
 * this file went away. Without this, Monaco keeps a disposed model's
 * history for when a model of the same URI and contents comes back (VS
 * Code's closed editors), and the undo prompt would offer to undo in the
 * deleted file too, only to refuse once chosen.
 */
export function forgetUndo(uri: monaco.Uri): void {
	undoRedo().removeElements(uri);
}

function undoRedo(): UndoRedoService {
	return StandaloneServices.get(IUndoRedoService) as UndoRedoService;
}

/** A button of a Monaco prompt: its label, and what choosing it answers. */
type PromptButton = { label: string; run(context: { checkboxChecked: boolean }): unknown };

/** The questions Monaco's services ask (VS Code's `IPrompt`, `IConfirmation`). */
type Prompt = {
	message: string;
	detail?: unknown;
	buttons?: PromptButton[];
	cancelButton?: boolean | string | PromptButton;
};
type Confirmation = { message: string; detail?: unknown; primaryButton?: string; cancelButton?: string };

/**
 * Monaco's dialog service, as an in-app modal dialog. Monaco's undo service
 * asks through it whether to undo an edit across files; nothing else in the
 * features this app loads asks anything. Escape, or a click outside,
 * cancels.
 */
export class AppDialogService {
	async prompt(prompt: Prompt): Promise<{ result?: unknown }> {
		const buttons = [...(prompt.buttons ?? [])];
		const cancel = prompt.cancelButton;
		const cancelButton: PromptButton | null = typeof cancel === 'object' ? cancel : cancel ? { label: typeof cancel === 'string' ? cancel : 'Cancel', run: () => undefined } : null;
		const labels = buttons.map((b) => b.label);
		if (cancelButton) labels.push(cancelButton.label || 'Cancel');
		const chosen = await ask(prompt.message, prompt.detail, labels);
		const button = chosen === null ? cancelButton : (buttons[chosen] ?? cancelButton);
		return { result: await button?.run({ checkboxChecked: false }) };
	}

	async confirm(confirmation: Confirmation): Promise<{ confirmed: boolean; checkboxChecked: boolean }> {
		const chosen = await ask(confirmation.message, confirmation.detail, [confirmation.primaryButton ?? 'Yes', confirmation.cancelButton ?? 'Cancel']);
		return { confirmed: chosen === 0, checkboxChecked: false };
	}

	async info(message: string, detail?: unknown): Promise<void> {
		await ask(message, detail, ['OK']);
	}

	async warn(message: string, detail?: unknown): Promise<void> {
		await ask(message, detail, ['OK']);
	}

	async error(message: string, detail?: unknown): Promise<void> {
		await ask(message, detail, ['OK']);
	}
}

/**
 * Shows a modal dialog with `message`, `detail` when it is text, and a
 * button per label, the first focused (so Enter chooses it). Resolves with
 * the chosen button's index, or null when the dialog was dismissed. Focus
 * returns to what had it, the editor, when the dialog closes.
 */
function ask(message: string, detail: unknown, labels: string[]): Promise<number | null> {
	const dialog = document.createElement('dialog');
	dialog.className = 'app-dialog';
	const id = `app-dialog-${Math.random().toString(36).slice(2)}`;
	dialog.setAttribute('aria-labelledby', id);
	// The content in a box of its own, so a click on the dialog itself is one outside it.
	const body = document.createElement('div');
	body.className = 'app-dialog-body';
	dialog.append(body);
	const text = document.createElement('p');
	text.className = 'app-dialog-message';
	text.id = id;
	text.textContent = message;
	body.append(text);
	if (typeof detail === 'string' && detail) {
		const more = document.createElement('p');
		more.className = 'app-dialog-detail';
		more.textContent = detail;
		body.append(more);
	}
	const footer = document.createElement('footer');
	body.append(footer);
	return new Promise((resolve) => {
		let chosen: number | null = null;
		labels.forEach((label, i) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = i === 0 ? 'app-dialog-button primary' : 'app-dialog-button';
			button.textContent = buttonLabel(label);
			button.addEventListener('click', () => {
				chosen = i;
				dialog.close();
			});
			footer.append(button);
		});
		dialog.addEventListener('click', (e) => {
			if (e.target === dialog) dialog.close();
		});
		dialog.addEventListener('close', () => {
			dialog.remove();
			resolve(chosen);
		});
		document.body.append(dialog);
		dialog.showModal();
		footer.querySelector('button')?.focus();
	});
}
