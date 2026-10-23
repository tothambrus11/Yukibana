/**
 * A language client: one language server in a Web Worker, the project's
 * Monaco models kept in sync with it, and Monaco's language features
 * answered by it. The app runs one client at a time, for the project of the
 * selected language.
 */
import type * as lsp from 'vscode-languageserver-protocol';
import { monaco } from '../monaco';
import { Connection, REQUEST_CANCELLED, ResponseError } from './connection';
import * as c from './convert';

/** What a pack reports while it downloads, from the `yukibana/loading` notification. */
export interface LoadingProgress {
	label: string;
	/** Bytes so far. */
	loaded: number;
	/** Bytes expected, or 0 when the pack does not know. */
	total: number;
}

/** Lifecycle of a client as the status bar shows it. */
export type ClientState =
	| { kind: 'starting' }
	| { kind: 'running'; server: string }
	| { kind: 'stopped' }
	| { kind: 'failed'; reason: string };

/** Severity of a line in the output panel, after LSP's `MessageType`. */
export type LogLevel = 'error' | 'warning' | 'info' | 'log';

/** What the client tells the page. */
export interface ClientEvents {
	state(state: ClientState): void;
	loading(progress: LoadingProgress | null): void;
	log(level: LogLevel, text: string): void;
	/** A server asked to show a document, or Monaco to open one: switch the editor to it. */
	open(uri: monaco.Uri, selection: monaco.IRange | undefined): void;
}

/** How a client is set up; all of it fixed for the client's life. */
export interface ClientOptions {
	/** The pack's `server.js`, started as a module worker. */
	serverUrl: URL;
	/** Monaco language ids whose editor features this server answers. */
	languages: readonly string[];
	/** The workspace folder every model lives under, `file:///workspace/`. */
	rootUri: string;
	/** Answers to `workspace/configuration`, by dotted section name. */
	settings: Record<string, unknown>;
	events: ClientEvents;
}

const MARKER_OWNER = 'lsp';
const LOG_LEVELS: Record<number, LogLevel> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'log', 5: 'log' };

/** One running language server and everything registered on its behalf. */
export class LanguageClient {
	private readonly connection: Connection;
	private readonly disposables: monaco.IDisposable[] = [];
	/** Models synchronised with the server, by `uri.toString()`. */
	private readonly models = new Map<string, { model: monaco.editor.ITextModel; listener: monaco.IDisposable }>();
	/** The server's diagnostics as it sent them, for code action requests. */
	private readonly diagnostics = new Map<string, lsp.Diagnostic[]>();
	private capabilities: lsp.ServerCapabilities = {};
	private syncKind: lsp.TextDocumentSyncKind = 0;
	private ready = false;
	private stopping = false;
	private readonly semanticTokensChanged = new monaco.Emitter<void>();

	/** The pack's `server.js`. */
	readonly serverUrl: URL;

	constructor(private readonly options: ClientOptions) {
		this.serverUrl = options.serverUrl;
		const worker = new Worker(options.serverUrl, { type: 'module', name: options.serverUrl.pathname });
		this.connection = new Connection(worker, (error) => this.closed(error));
		this.listen();
	}

	/**
	 * Initialises the server and opens every given model. Resolves once the
	 * server is running; rejects when it fails to start.
	 */
	async start(models: Iterable<monaco.editor.ITextModel>): Promise<void> {
		this.options.events.state({ kind: 'starting' });
		const result = await this.connection.request<lsp.InitializeResult>('initialize', this.initializeParams());
		this.options.events.loading(null);
		this.capabilities = result.capabilities;
		const sync = result.capabilities.textDocumentSync;
		this.syncKind = typeof sync === 'number' ? sync : (sync?.change ?? 0);
		this.connection.notify('initialized', {});
		this.ready = true;
		for (const model of models) this.addModel(model);
		this.registerFeatures();
		const info = result.serverInfo;
		this.options.events.state({ kind: 'running', server: info ? `${info.name}${info.version ? ' ' + info.version : ''}` : 'language server' });
	}

	/**
	 * Starts synchronising a model: a file that was created (`created`) or
	 * already existed. Every project file is handed to the server, whatever
	 * its language, because a `compile_flags.txt` or `jsconfig.json` is part
	 * of the project as the server sees it.
	 */
	addModel(model: monaco.editor.ITextModel, created = false): void {
		if (!this.ready) return;
		const key = model.uri.toString();
		if (this.models.has(key)) return;
		const listener = model.onDidChangeContent((e) => this.changed(model, e));
		this.models.set(key, { model, listener });
		this.connection.notify('textDocument/didOpen', {
			textDocument: { uri: key, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() },
		} satisfies lsp.DidOpenTextDocumentParams);
		if (created) this.watched(key, 1);
	}

	/** Stops synchronising a model whose file is being deleted. */
	removeModel(model: monaco.editor.ITextModel): void {
		const key = model.uri.toString();
		const entry = this.models.get(key);
		if (!entry) return;
		entry.listener.dispose();
		this.models.delete(key);
		this.diagnostics.delete(key);
		monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
		this.connection.notify('textDocument/didClose', { textDocument: { uri: key } });
		this.watched(key, 3);
	}

	/** Shuts the server down politely, then terminates its worker regardless. */
	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		if (this.ready) {
			const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
			await Promise.race([this.connection.request('shutdown', null).catch(() => {}), timeout]);
			this.connection.notify('exit', null);
		}
		this.connection.dispose();
	}

	private initializeParams(): lsp.InitializeParams {
		const markup = ['markdown', 'plaintext'] as lsp.MarkupKind[];
		return {
			processId: null,
			clientInfo: { name: 'Yukibana Code' },
			locale: navigator.language,
			rootUri: this.options.rootUri,
			workspaceFolders: [{ uri: this.options.rootUri, name: 'workspace' }],
			capabilities: {
				general: { positionEncodings: ['utf-16'] },
				window: { workDoneProgress: true, showDocument: { support: true } },
				workspace: {
					configuration: true,
					workspaceFolders: true,
					applyEdit: true,
					workspaceEdit: { documentChanges: true },
					didChangeWatchedFiles: { dynamicRegistration: false },
					semanticTokens: { refreshSupport: true },
				},
				textDocument: {
					synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
					publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: false },
					completion: {
						contextSupport: true,
						completionItem: {
							snippetSupport: true,
							documentationFormat: markup,
							deprecatedSupport: true,
							preselectSupport: true,
							tagSupport: { valueSet: [1] },
							insertReplaceSupport: true,
							labelDetailsSupport: true,
							resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
						},
						completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'data'] },
					},
					hover: { contentFormat: markup },
					signatureHelp: {
						contextSupport: true,
						signatureInformation: { documentationFormat: markup, parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
					},
					definition: { linkSupport: true },
					declaration: { linkSupport: true },
					typeDefinition: { linkSupport: true },
					implementation: { linkSupport: true },
					references: {},
					documentHighlight: {},
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					rename: { prepareSupport: true },
					formatting: {},
					rangeFormatting: {},
					codeAction: {
						codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } },
						isPreferredSupport: true,
						disabledSupport: true,
						dataSupport: true,
						resolveSupport: { properties: ['edit'] },
					},
					semanticTokens: {
						requests: { full: true },
						tokenTypes: [],
						tokenModifiers: [],
						formats: ['relative'],
						multilineTokenSupport: false,
						overlappingTokenSupport: false,
					},
					inlayHint: {},
				},
			},
		};
	}

	private listen(): void {
		const conn = this.connection;
		const events = this.options.events;
		conn.onNotification('yukibana/loading', (p) => events.loading(p as LoadingProgress));
		conn.onNotification('window/logMessage', (p) => {
			const m = p as lsp.LogMessageParams;
			events.log(LOG_LEVELS[m.type] ?? 'log', m.message);
		});
		conn.onNotification('window/showMessage', (p) => {
			const m = p as lsp.ShowMessageParams;
			events.log(LOG_LEVELS[m.type] ?? 'info', m.message);
		});
		conn.onNotification('textDocument/publishDiagnostics', (p) => this.publishDiagnostics(p as lsp.PublishDiagnosticsParams));
		conn.onNotification('$/progress', (p) => {
			const v = (p as { value: lsp.WorkDoneProgressBegin | lsp.WorkDoneProgressReport | lsp.WorkDoneProgressEnd }).value;
			if (v.kind === 'begin') events.log('log', `${v.title}${v.message ? ': ' + v.message : ''}`);
		});
		conn.onNotification('$/logTrace', (p) => events.log('log', (p as lsp.LogTraceParams).message));
		conn.onNotification('telemetry/event', () => {});

		conn.onRequest('workspace/configuration', (p) =>
			(p as lsp.ConfigurationParams).items.map((item) => (item.section ? lookup(this.options.settings, item.section) : this.options.settings) ?? null),
		);
		conn.onRequest('workspace/workspaceFolders', () => [{ uri: this.options.rootUri, name: 'workspace' }]);
		conn.onRequest('client/registerCapability', () => null);
		conn.onRequest('client/unregisterCapability', () => null);
		conn.onRequest('window/workDoneProgress/create', () => null);
		conn.onRequest('window/showMessageRequest', (p) => {
			events.log('info', (p as lsp.ShowMessageRequestParams).message);
			return null;
		});
		conn.onRequest('window/showDocument', (p) => {
			const d = p as lsp.ShowDocumentParams;
			events.open(monaco.Uri.parse(d.uri), d.selection && c.toRange(d.selection));
			return { success: true };
		});
		conn.onRequest('workspace/applyEdit', (p) => ({ applied: this.applyEdit((p as lsp.ApplyWorkspaceEditParams).edit) }));
		conn.onRequest('workspace/semanticTokens/refresh', () => this.semanticTokensChanged.fire());
		for (const m of ['workspace/inlayHint/refresh', 'workspace/codeLens/refresh', 'workspace/diagnostic/refresh']) conn.onRequest(m, () => null);
	}

	private closed(error: Error | null): void {
		this.ready = false;
		for (const { model, listener } of this.models.values()) {
			listener.dispose();
			monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
		}
		this.models.clear();
		for (const d of this.disposables.splice(0)) d.dispose();
		this.semanticTokensChanged.dispose();
		this.options.events.loading(null);
		if (error && !this.stopping) {
			this.options.events.log('error', error.message);
			this.options.events.state({ kind: 'failed', reason: error.message });
		} else {
			this.options.events.state({ kind: 'stopped' });
		}
	}

	private changed(model: monaco.editor.ITextModel, e: monaco.editor.IModelContentChangedEvent): void {
		if (this.syncKind === 0) return;
		const contentChanges: lsp.TextDocumentContentChangeEvent[] =
			this.syncKind === 2
				? e.changes.map((ch) => ({ range: c.toLspRange(ch.range), rangeLength: ch.rangeLength, text: ch.text }))
				: [{ text: model.getValue() }];
		this.connection.notify('textDocument/didChange', {
			textDocument: { uri: model.uri.toString(), version: model.getVersionId() },
			contentChanges,
		} satisfies lsp.DidChangeTextDocumentParams);
	}

	private watched(uri: string, type: lsp.FileChangeType): void {
		this.connection.notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type }] } satisfies lsp.DidChangeWatchedFilesParams);
	}

	private publishDiagnostics(p: lsp.PublishDiagnosticsParams): void {
		const key = c.uriKey(p.uri);
		const entry = this.models.get(key);
		if (!entry) return;
		this.diagnostics.set(key, p.diagnostics);
		monaco.editor.setModelMarkers(entry.model, MARKER_OWNER, p.diagnostics.map(c.toMarker));
	}

	private applyEdit(edit: lsp.WorkspaceEdit): boolean {
		const { edit: converted, unsupported } = c.toWorkspaceEdit(edit);
		for (const u of unsupported) this.options.events.log('warning', `not applied (file operations are not supported): ${u}`);
		const byModel = new Map<monaco.editor.ITextModel, monaco.editor.IIdentifiedSingleEditOperation[]>();
		for (const e of converted.edits) {
			const model = monaco.editor.getModel(e.resource);
			if (!model) {
				this.options.events.log('warning', `not applied: no such file ${e.resource.toString()}`);
				return false;
			}
			const list = byModel.get(model) ?? [];
			list.push({ range: e.textEdit.range, text: e.textEdit.text });
			byModel.set(model, list);
		}
		for (const [model, edits] of byModel) model.pushEditOperations([], edits, () => null);
		return unsupported.length === 0;
	}

	/** Whether a model is one this server answers for. */
	private owns(model: monaco.editor.ITextModel): boolean {
		return this.models.has(model.uri.toString());
	}

	/**
	 * Sends a request on behalf of a Monaco provider. A cancelled request,
	 * or one for a model the server does not own, answers `null`; any other
	 * failure is written to the output panel and also answers `null`, since
	 * Monaco has no way to show a provider's error.
	 */
	private async ask<R>(model: monaco.editor.ITextModel, method: string, params: unknown, token: monaco.CancellationToken): Promise<R | null> {
		if (!this.owns(model)) return null;
		const controller = new AbortController();
		if (token.isCancellationRequested) return null;
		const sub = token.onCancellationRequested(() => controller.abort());
		try {
			return await this.connection.request<R>(method, params, controller.signal);
		} catch (e) {
			if (!(e instanceof ResponseError && e.code === REQUEST_CANCELLED) && !this.stopping) {
				this.options.events.log('error', `${method}: ${e instanceof Error ? e.message : String(e)}`);
			}
			return null;
		} finally {
			sub.dispose();
		}
	}

	private registerFeatures(): void {
		const caps = this.capabilities;
		const selector = [...this.options.languages];
		const doc = (model: monaco.editor.ITextModel) => ({ uri: model.uri.toString() });
		const at = (model: monaco.editor.ITextModel, position: monaco.IPosition) => ({ textDocument: doc(model), position: c.toPosition(position) });
		const add = (d: monaco.IDisposable) => this.disposables.push(d);
		const L = monaco.languages;

		if (caps.completionProvider) {
			const provider = caps.completionProvider;
			const original = new WeakMap<monaco.languages.CompletionItem, lsp.CompletionItem>();
			add(
				L.registerCompletionItemProvider(selector, {
					...(provider.triggerCharacters && { triggerCharacters: provider.triggerCharacters }),
					provideCompletionItems: async (model, position, context, token) => {
						const result = await this.ask<lsp.CompletionList | lsp.CompletionItem[]>(
							model,
							'textDocument/completion',
							{
								...at(model, position),
								context: {
									triggerKind: (context.triggerKind + 1) as lsp.CompletionTriggerKind,
									...(context.triggerCharacter !== undefined && { triggerCharacter: context.triggerCharacter }),
								},
							},
							token,
						);
						if (!result) return { suggestions: [] };
						const list = Array.isArray(result) ? { items: result, isIncomplete: false } : result;
						const word = model.getWordUntilPosition(position);
						const range = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: position.column };
						const suggestions = list.items.map((item) => {
							const s = c.toSuggestion(item, list.itemDefaults, range);
							original.set(s, item.data === undefined && list.itemDefaults?.data !== undefined ? { ...item, data: list.itemDefaults.data } : item);
							return s;
						});
						return { suggestions, incomplete: list.isIncomplete };
					},
					...(provider.resolveProvider && {
						resolveCompletionItem: async (item, token) => {
							const lspItem = original.get(item);
							const model = monaco.editor.getModels().find((m) => this.owns(m));
							if (!lspItem || !model) return item;
							const resolved = await this.ask<lsp.CompletionItem>(model, 'completionItem/resolve', lspItem, token);
							if (!resolved) return item;
							const documentation = c.toDocumentation(resolved.documentation);
							return {
								...item,
								...(resolved.detail != null && { detail: resolved.detail }),
								...(documentation !== undefined && { documentation }),
								...(resolved.additionalTextEdits && { additionalTextEdits: resolved.additionalTextEdits.map(c.toTextEdit) }),
							};
						},
					}),
				}),
			);
		}

		if (caps.hoverProvider) {
			add(
				L.registerHoverProvider(selector, {
					provideHover: async (model, position, token) => {
						const hover = await this.ask<lsp.Hover>(model, 'textDocument/hover', at(model, position), token);
						if (!hover) return null;
						const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
						return { contents: contents.map(c.toMarkdown), ...(hover.range && { range: c.toRange(hover.range) }) };
					},
				}),
			);
		}

		if (caps.signatureHelpProvider) {
			const provider = caps.signatureHelpProvider;
			add(
				L.registerSignatureHelpProvider(selector, {
					...(provider.triggerCharacters && { signatureHelpTriggerCharacters: provider.triggerCharacters }),
					...(provider.retriggerCharacters && { signatureHelpRetriggerCharacters: provider.retriggerCharacters }),
					provideSignatureHelp: async (model, position, token, context) => {
						const help = await this.ask<lsp.SignatureHelp>(
							model,
							'textDocument/signatureHelp',
							{
								...at(model, position),
								context: {
									triggerKind: context.triggerKind as lsp.SignatureHelpTriggerKind,
									isRetrigger: context.isRetrigger,
									...(context.triggerCharacter !== undefined && { triggerCharacter: context.triggerCharacter }),
								},
							},
							token,
						);
						if (!help || help.signatures.length === 0) return null;
						return {
							value: {
								activeSignature: help.activeSignature ?? 0,
								activeParameter: help.activeParameter ?? 0,
								signatures: help.signatures.map((s) => {
									const documentation = c.toDocumentation(s.documentation);
									return {
										label: s.label,
										...(documentation !== undefined && { documentation }),
										...(s.activeParameter != null && { activeParameter: s.activeParameter }),
										parameters: (s.parameters ?? []).map((p) => {
											const pdoc = c.toDocumentation(p.documentation);
											return { label: p.label, ...(pdoc !== undefined && { documentation: pdoc }) };
										}),
									};
								}),
							},
							dispose: () => {},
						};
					},
				}),
			);
		}

		const locations = (method: string) => async (model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken) =>
			c.toLocations(await this.ask<lsp.Location | lsp.Location[] | lsp.LocationLink[]>(model, method, at(model, position), token));
		if (caps.definitionProvider) add(L.registerDefinitionProvider(selector, { provideDefinition: locations('textDocument/definition') }));
		if (caps.declarationProvider) add(L.registerDeclarationProvider(selector, { provideDeclaration: locations('textDocument/declaration') }));
		if (caps.typeDefinitionProvider) add(L.registerTypeDefinitionProvider(selector, { provideTypeDefinition: locations('textDocument/typeDefinition') }));
		if (caps.implementationProvider) add(L.registerImplementationProvider(selector, { provideImplementation: locations('textDocument/implementation') }));

		if (caps.referencesProvider) {
			add(
				L.registerReferenceProvider(selector, {
					provideReferences: async (model, position, context, token) => {
						const refs = await this.ask<lsp.Location[]>(model, 'textDocument/references', { ...at(model, position), context }, token);
						return (refs ?? []).map((r) => ({ uri: monaco.Uri.parse(r.uri), range: c.toRange(r.range) }));
					},
				}),
			);
		}

		if (caps.documentHighlightProvider) {
			add(
				L.registerDocumentHighlightProvider(selector, {
					provideDocumentHighlights: async (model, position, token) => {
						const highlights = await this.ask<lsp.DocumentHighlight[]>(model, 'textDocument/documentHighlight', at(model, position), token);
						return (highlights ?? []).map((h) => ({ range: c.toRange(h.range), kind: ((h.kind ?? 1) - 1) as monaco.languages.DocumentHighlightKind }));
					},
				}),
			);
		}

		if (caps.documentSymbolProvider) {
			add(
				L.registerDocumentSymbolProvider(selector, {
					provideDocumentSymbols: async (model, token) => {
						const symbols = await this.ask<lsp.DocumentSymbol[] | lsp.SymbolInformation[]>(model, 'textDocument/documentSymbol', { textDocument: doc(model) }, token);
						return symbols ? c.toDocumentSymbols(symbols) : [];
					},
				}),
			);
		}

		if (caps.renameProvider) {
			const prepare = typeof caps.renameProvider === 'object' && caps.renameProvider.prepareProvider;
			add(
				L.registerRenameProvider(selector, {
					provideRenameEdits: async (model, position, newName, token) => {
						const edit = await this.ask<lsp.WorkspaceEdit>(model, 'textDocument/rename', { ...at(model, position), newName }, token);
						if (!edit) return { edits: [] };
						const { edit: converted, unsupported } = c.toWorkspaceEdit(edit);
						if (unsupported.length) return { edits: [], rejectReason: `the rename needs file operations: ${unsupported.join(', ')}` };
						return converted;
					},
					...(prepare && {
						resolveRenameLocation: async (model, position, token) => {
							const r = await this.ask<lsp.PrepareRenameResult>(model, 'textDocument/prepareRename', at(model, position), token);
							if (!r) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'This element cannot be renamed.' };
							if ('defaultBehavior' in r) {
								const w = model.getWordAtPosition(position);
								return w ? { range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), text: w.word } : { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'Nothing to rename here.' };
							}
							const range = 'range' in r ? r.range : r;
							return { range: c.toRange(range), text: 'placeholder' in r ? r.placeholder : model.getValueInRange(c.toRange(range)) };
						},
					}),
				}),
			);
		}

		const formatting = (model: monaco.editor.ITextModel, options: monaco.languages.FormattingOptions) => ({
			textDocument: doc(model),
			options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
		});
		if (caps.documentFormattingProvider) {
			add(
				L.registerDocumentFormattingEditProvider(selector, {
					provideDocumentFormattingEdits: async (model, options, token) =>
						((await this.ask<lsp.TextEdit[]>(model, 'textDocument/formatting', formatting(model, options), token)) ?? []).map(c.toTextEdit),
				}),
			);
		}
		if (caps.documentRangeFormattingProvider) {
			add(
				L.registerDocumentRangeFormattingEditProvider(selector, {
					provideDocumentRangeFormattingEdits: async (model, range, options, token) =>
						((await this.ask<lsp.TextEdit[]>(model, 'textDocument/rangeFormatting', { ...formatting(model, options), range: c.toLspRange(range) }, token)) ?? []).map(c.toTextEdit),
				}),
			);
		}

		if (caps.codeActionProvider) this.registerCodeActions(selector, typeof caps.codeActionProvider === 'object' && !!caps.codeActionProvider.resolveProvider);

		const legend = caps.semanticTokensProvider?.legend;
		if (legend && caps.semanticTokensProvider?.full) {
			add(
				L.registerDocumentSemanticTokensProvider(selector, {
					onDidChange: this.semanticTokensChanged.event,
					getLegend: () => legend,
					provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
						const tokens = await this.ask<lsp.SemanticTokens>(model, 'textDocument/semanticTokens/full', { textDocument: doc(model) }, token);
						return tokens ? { data: new Uint32Array(tokens.data), ...(tokens.resultId !== undefined && { resultId: tokens.resultId }) } : null;
					},
					releaseDocumentSemanticTokens: () => {},
				}),
			);
		}

		if (caps.inlayHintProvider) {
			add(
				L.registerInlayHintsProvider(selector, {
					provideInlayHints: async (model, range, token) => {
						const hints = await this.ask<lsp.InlayHint[]>(model, 'textDocument/inlayHint', { textDocument: doc(model), range: c.toLspRange(range) }, token);
						return {
							hints: (hints ?? []).map((h) => ({
								label: typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join(''),
								position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
								...(h.kind !== undefined && { kind: h.kind as monaco.languages.InlayHintKind }),
								...(h.paddingLeft !== undefined && { paddingLeft: h.paddingLeft }),
								...(h.paddingRight !== undefined && { paddingRight: h.paddingRight }),
							})),
							dispose: () => {},
						};
					},
				}),
			);
		}
	}

	private registerCodeActions(selector: string[], resolve: boolean): void {
		const commandId = `yukibana.lsp.command.${crypto.randomUUID()}`;
		this.disposables.push(
			monaco.editor.registerCommand(commandId, (_accessor, command: lsp.Command) => {
				this.connection.request('workspace/executeCommand', { command: command.command, arguments: command.arguments }).catch((e: unknown) => {
					this.options.events.log('error', `${command.command}: ${e instanceof Error ? e.message : String(e)}`);
				});
			}),
		);
		const toCommand = (cmd: lsp.Command): monaco.languages.Command => ({ id: commandId, title: cmd.title, arguments: [cmd] });
		const original = new WeakMap<monaco.languages.CodeAction, lsp.CodeAction>();
		const convert = (a: lsp.CodeAction): monaco.languages.CodeAction => {
			const action: monaco.languages.CodeAction = {
				title: a.title,
				...(a.kind !== undefined && { kind: a.kind }),
				...(a.isPreferred !== undefined && { isPreferred: a.isPreferred }),
				...(a.disabled && { disabled: a.disabled.reason }),
				...(a.diagnostics && { diagnostics: a.diagnostics.map(c.toMarker) }),
				...(a.edit && { edit: c.toWorkspaceEdit(a.edit).edit }),
				...(a.command && { command: toCommand(a.command) }),
			};
			original.set(action, a);
			return action;
		};
		this.disposables.push(
			monaco.languages.registerCodeActionProvider(selector, {
				provideCodeActions: async (model, range, context, token) => {
					const lspRange = c.toLspRange(range);
					const diagnostics = (this.diagnostics.get(model.uri.toString()) ?? []).filter((d) => c.rangesTouch(d.range, lspRange));
					const result = await this.ask<(lsp.Command | lsp.CodeAction)[]>(
						model,
						'textDocument/codeAction',
						{ textDocument: { uri: model.uri.toString() }, range: lspRange, context: { diagnostics, ...(context.only !== undefined && { only: [context.only] }), triggerKind: context.trigger } },
						token,
					);
					const actions = (result ?? []).map((a) => (typeof a.command === 'string' ? { title: a.title, command: toCommand(a as lsp.Command) } : convert(a as lsp.CodeAction)));
					return { actions, dispose: () => {} };
				},
				...(resolve && {
					resolveCodeAction: async (action, token) => {
						const a = original.get(action);
						const model = monaco.editor.getModels().find((m) => this.owns(m));
						if (!a || a.edit || !model) return action;
						const resolved = await this.ask<lsp.CodeAction>(model, 'codeAction/resolve', a, token);
						return resolved ? convert(resolved) : action;
					},
				}),
			}),
		);
	}
}

/** Reads `a.b.c` out of nested settings, `undefined` when any step is missing. */
function lookup(settings: Record<string, unknown>, section: string): unknown {
	let value: unknown = settings;
	for (const key of section.split('.')) {
		if (typeof value !== 'object' || value === null) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}
