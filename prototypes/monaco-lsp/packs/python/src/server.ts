/*
 * Yukibana's Python pack: basedpyright's language server in one module Web
 * Worker, speaking the pack contract (packs/CONTRACT.md): one JSON-RPC
 * message object per postMessage, `yukibana/loading` while the typeshed stubs
 * download, `file:///workspace/` as the project root.
 *
 * This differs from upstream's `packages/browser-pyright/src/worker.ts` in
 * three ways, each because the contract asks for something upstream does not:
 *
 * 1. It starts at once instead of waiting for a `browser/boot` message, and
 *    runs analysis in this worker instead of asking the page to spawn a
 *    second "background" worker (`browser/newWorker`). The whole server is
 *    already off the main thread, and the app's client knows nothing about
 *    pyright's private boot protocol.
 * 2. Typeshed is not compiled into the bundle and not sent by the client in
 *    `initializationOptions.files`. Only the stdlib stubs ship, as
 *    `typeshed-stdlib.tar.gz` next to this file, mounted lazily (tarResolver).
 * 3. Open documents are mirrored into the in-memory file system, so that
 *    `import other` finds `other.py`: pyright resolves imports against the
 *    file system, not against the set of open documents.
 */

import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser';
import {
    Connection,
    DidChangeTextDocumentParams,
    DidChangeWatchedFilesParams,
    DidCloseTextDocumentParams,
    DidOpenTextDocumentParams,
    FileChangeType,
    InitializeParams,
    InitializeResult,
    ResponseError,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { InvalidatedReason } from 'pyright-internal/analyzer/backgroundAnalysisProgram';
import { ImportResolver } from 'pyright-internal/analyzer/importResolver';
import { DefaultCancellationProvider } from 'pyright-internal/common/cancellationUtils';
import { ConfigOptions } from 'pyright-internal/common/configOptions';
import { nullFileWatcherHandler } from 'pyright-internal/common/fileWatcher';
import { Host, NoAccessHost } from 'pyright-internal/common/host';
import { ServerSettings } from 'pyright-internal/common/languageServerInterface';
import { normalizeSlashes } from 'pyright-internal/common/pathUtils';
import { ServiceProvider } from 'pyright-internal/common/serviceProvider';
import { initializeWorkersHost } from 'pyright-internal/common/workersHost';
import { RealLanguageServer } from 'pyright-internal/realLanguageServer';
import { TestFileSystem } from 'pyright-internal/tests/harness/vfs/filesystem';
import { Workspace } from 'pyright-internal/workspaceFactory';

import { BrowserWorkersHost } from '../src/browserWorkersHost';
import { TarResolver } from './tarResolver';

declare const self: DedicatedWorkerGlobalScope;

/** Where pyright looks for its bundled typeshed: `<module path>/typeshed-fallback`, module path `/` in the vfs. */
const TYPESHED_MOUNT = '/typeshed-fallback';
const STUBS_FILE = 'typeshed-stdlib.tar.gz';

/** Posts a `yukibana/loading` progress notification (contract: may precede the initialize response). */
function reportLoading(label: string, loaded: number, total: number) {
    self.postMessage({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label, loaded, total } });
}

/**
 * Downloads and decompresses the stdlib stubs. Progress counts bytes as they
 * arrive over the wire. A host may serve the `.gz` with `Content-Encoding:
 * gzip`, in which case the browser has already inflated it; the gzip magic
 * number tells the two cases apart.
 */
async function loadStubs(): Promise<TarResolver> {
    const url = new URL(STUBS_FILE, self.location.href);
    const response = await fetch(url);
    if (!response.ok || !response.body) {
        throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
    }
    const encoded = response.headers.get('content-encoding');
    const lengthHeader = Number(response.headers.get('content-length') ?? 0);
    const total = encoded ? 0 : lengthHeader;
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    const reader = response.body.getReader();
    reportLoading(STUBS_FILE, 0, total);
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        reportLoading(STUBS_FILE, loaded, total);
    }
    let bytes: Uint8Array = new Uint8Array(await new Blob(chunks).arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(inflated).arrayBuffer());
    }
    return new TarResolver(bytes);
}

/**
 * The client opens every project file, whatever its language; pyright would
 * parse a README as Python. Other files are only mirrored into the vfs, where
 * pyright reads `pyproject.toml` and `pyrightconfig.json` from.
 */
function isPython(uri: string): boolean {
    return /\.pyi?$/.test(uri);
}

function isConfigFile(uri: string): boolean {
    return /\/(pyproject\.toml|pyrightconfig\.json)$/.test(uri);
}

class YukibanaPyrightServer extends RealLanguageServer {
    /** Open documents that are not Python, kept only to apply incremental changes. */
    private readonly _otherFiles = new Map<string, TextDocument>();

    constructor(connection: Connection, private readonly _vfs: TestFileSystem, private readonly _stubs: Promise<TarResolver>) {
        super(connection, 0, _vfs, new DefaultCancellationProvider(), _vfs, nullFileWatcherHandler);
    }

    /** No second worker: analysis runs here, in time slices between requests. */
    createBackgroundAnalysis() {
        return undefined;
    }

    protected override createHost(): Host {
        return new NoAccessHost();
    }

    protected override createImportResolver(serviceProvider: ServiceProvider, options: ConfigOptions, host: Host) {
        return new ImportResolver(serviceProvider, options, host);
    }

    protected override async initialize(
        params: InitializeParams,
        supportedCommands: string[],
        supportedCodeActions: string[]
    ): Promise<InitializeResult> {
        let stubs: TarResolver;
        try {
            stubs = await this._stubs;
        } catch (e) {
            const message = `basedpyright: typeshed stubs unavailable: ${e instanceof Error ? e.message : String(e)}`;
            this.console.error(message);
            throw new ResponseError(-32603, message);
        }
        this._vfs.mountSync('/', TYPESHED_MOUNT, stubs);
        this.console.info(`typeshed stdlib: ${stubs.fileCount} stub files mounted at ${TYPESHED_MOUNT}`);
        return super.initialize(params, supportedCommands, supportedCodeActions);
    }

    /**
     * basedpyright's default mode is 'recommended', which reports every
     * unannotated or partially-unknown value; for a teaching IDE we default to
     * pyright's 'standard' unless the client or a pyproject/pyrightconfig says
     * otherwise (config files still override this, as in pyright).
     */
    override async getSettings(workspace: Workspace): Promise<ServerSettings> {
        const settings = await super.getSettings(workspace);
        const section = await this.getConfiguration(workspace.rootUri, 'basedpyright');
        if (!section?.analysis?.typeCheckingMode) {
            settings.typeCheckingMode = 'standard';
        }
        return settings;
    }

    protected override async onDidOpenTextDocument(params: DidOpenTextDocumentParams) {
        const { uri, text, version, languageId } = params.textDocument;
        const created = this._mirror(uri, text);
        if (isPython(uri)) {
            await super.onDidOpenTextDocument(params);
        } else {
            this._otherFiles.set(uri, TextDocument.create(uri, languageId, version, text));
        }
        if (isConfigFile(uri)) {
            this.updateSettingsForAllWorkspaces();
        } else if (created) {
            this._invalidate();
        }
    }

    protected override async onDidChangeTextDocument(params: DidChangeTextDocumentParams) {
        const { uri, version } = params.textDocument;
        let text: string | undefined;
        if (isPython(uri)) {
            await super.onDidChangeTextDocument(params);
            text = this.openFileMap.get(this.convertLspUriStringToUri(uri).key)?.getText();
        } else {
            const doc = this._otherFiles.get(uri);
            if (doc) {
                TextDocument.update(doc, params.contentChanges, version);
                text = doc.getText();
            }
        }
        if (text !== undefined) {
            this._mirror(uri, text);
        }
        if (isConfigFile(uri)) {
            this.updateSettingsForAllWorkspaces();
        }
    }

    protected override async onDidCloseTextDocument(params: DidCloseTextDocumentParams, cellIndex?: number) {
        if (isPython(params.textDocument.uri)) {
            await super.onDidCloseTextDocument(params, cellIndex);
        } else {
            this._otherFiles.delete(params.textDocument.uri);
        }
    }

    /**
     * The contract sends `didChangeWatchedFiles` when a project file is added
     * or deleted. There is no real file watcher, so this is where a deletion
     * reaches the vfs and where cached import resolutions are dropped.
     */
    protected override onDidChangeWatchedFiles(params: DidChangeWatchedFilesParams) {
        let configChanged = false;
        for (const change of params.changes) {
            configChanged ||= isConfigFile(change.uri);
            if (change.type !== FileChangeType.Deleted) continue;
            const uri = this.convertLspUriStringToUri(change.uri);
            if (uri.scheme === 'file' && this._vfs.existsSync(uri)) {
                this._vfs.unlinkSync(uri);
            }
        }
        if (configChanged) {
            this.updateSettingsForAllWorkspaces();
        } else {
            this._invalidate();
        }
    }

    /** Writes a document's text to the vfs; returns true when the file is new. */
    private _mirror(uriString: string, text: string): boolean {
        const uri = this.convertLspUriStringToUri(uriString);
        if (uri.scheme !== 'file') {
            return false;
        }
        const created = !this._vfs.existsSync(uri);
        this._vfs.mkdirSync(uri.getDirectory(), { recursive: true });
        this._vfs.writeFileSync(uri, text, 'utf8');
        return created;
    }

    /** What pyright does when its own file watcher sees a source file appear or vanish. */
    private _invalidate() {
        for (const workspace of this.workspaceFactory.items()) {
            workspace.service.invalidateAndForceReanalysis(InvalidatedReason.SourceWatcherChanged);
        }
    }
}

// Start the download before `initialize` arrives; the server awaits it there.
const stubs = loadStubs();
stubs.catch(() => {
    /* reported when initialize awaits it */
});

initializeWorkersHost(new BrowserWorkersHost());
const vfs = new TestFileSystem(/* ignoreCase */ false, { cwd: normalizeSlashes('/') });
new YukibanaPyrightServer(createConnection(new BrowserMessageReader(self), new BrowserMessageWriter(self)), vfs, stubs);
