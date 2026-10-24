/**
 * Stands in for monaco-editor's `internal/common/workers.js` (see
 * vite.config.ts), which the JSON language service imports for
 * `createWebWorker`. The original also imports every editor contribution, as
 * `editor.main` does, as a side effect: that would put the diff editor,
 * code lens, sticky scroll and the rest into the bundle, and their services
 * are registered after the editor's own have started, so creating an editor
 * then fails with "depends on UNKNOWN service ICodeLensCache".
 *
 * This is the same function without the side effects: the worker comes from
 * `MonacoEnvironment.getWorker` (set in monaco.ts), is sent the two messages
 * Monaco's worker bootstrap expects, and is handed to the editor's own
 * `createWebWorker`.
 */
import { editor } from 'monaco-editor/editor/editor.api';

interface Options {
	label?: string;
	moduleId?: string;
	createData?: unknown;
	host?: Record<string, (...args: unknown[]) => unknown>;
	keepIdleModels?: boolean;
}

export function createWebWorker<T extends object>(opts: Options): editor.MonacoWebWorker<T> {
	const environment = (globalThis as { MonacoEnvironment?: { getWorker?(id: string, label: string): Worker | Promise<Worker> } }).MonacoEnvironment;
	if (!environment?.getWorker) throw new Error('MonacoEnvironment.getWorker is not set');
	const worker = Promise.resolve(environment.getWorker('workerMain.js', opts.label ?? 'monaco-editor-worker')).then((w) => {
		w.postMessage('ignore');
		w.postMessage(opts.createData);
		return w;
	});
	return editor.createWebWorker<T>({ worker, ...(opts.host ? { host: opts.host } : {}), ...(opts.keepIdleModels !== undefined ? { keepIdleModels: opts.keepIdleModels } : {}) });
}
