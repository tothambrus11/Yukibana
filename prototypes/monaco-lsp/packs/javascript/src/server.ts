/**
 * The JavaScript/TypeScript language pack: an LSP server in a module Web
 * Worker, written directly over TypeScript's own LanguageService (the same
 * service tsserver and VS Code use), with an in-memory file system holding
 * the project's documents and the bundled lib.*.d.ts files.
 *
 * Transport (packs/CONTRACT.md): every postMessage is one JSON-RPC 2.0
 * message as a plain object. Before `initialize` is answered the worker
 * downloads typescript.js and the lib bundle, reporting `yukibana/loading`.
 *
 * Why hand-written rather than Volar's @volar/language-server +
 * volar-service-typescript: see README.md ("Why not Volar"). In short, the
 * adapter is ~18 KB minified against Volar's ~590 KB, and it is synchronous
 * over an in-memory map where Volar's browser server reads files through
 * async fetch-backed providers built for CDN-hosted typings.
 */

import type * as TS from 'typescript';
import type * as P from 'vscode-languageserver-protocol';

// Injected by build.sh (esbuild --define): file names next to this script and
// their uncompressed sizes, so progress has a total even when the host serves
// a compressed sibling and Content-Length is the compressed size.
declare const __TS_FILE__: string;
declare const __TS_SIZE__: number;
declare const __LIBS_FILE__: string;
declare const __LIBS_SIZE__: number;
declare const __PACK_VERSION__: string;
/** src/node/builtins.d.ts, embedded by build.sh. */
declare const __NODE_TYPES__: string;
/**
 * The declarations of the npm packages the runner ships (fast-check and the
 * pure-rand types it imports), made by tools/package-types.mjs: a JSON
 * object from `/node_modules/...` path to text, and its uncompressed size.
 */
declare const __PACKAGES_FILE__: string;
declare const __PACKAGES_SIZE__: number;

/** Libraries a project gets when its config names none. Must be in the bundle. */
const DEFAULT_LIBS = ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.dom.asynciterable.d.ts'];
/** Where the bundled libs live in the virtual file system; never a project path. */
const LIB_DIR = '/typescript/lib';
/**
 * Types of the `node:test` and `node:assert` modules the runner provides,
 * a root file of every project (there is no @types/node), kept with the libs
 * so that results pointing into it are dropped like those into a lib.
 */
const NODE_TYPES = `${LIB_DIR}/yukibana-node.d.ts`;
const SCRIPT_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

type Message = P.RequestMessage | P.NotificationMessage | P.ResponseMessage;
type Json = P.LSPAny;

// ---------------------------------------------------------------------------
// Transport

const scope = self as unknown as DedicatedWorkerGlobalScope;

function send(message: object): void {
  scope.postMessage({ jsonrpc: '2.0', ...message });
}
function notify(method: string, params: Json): void {
  send({ method, params });
}
function log(type: P.MessageType, message: string): void {
  notify('window/logMessage', { type, message });
}

class ResponseError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

// Messages are queued and drained in a later task, so a `$/cancelRequest`
// that arrives right behind a request (fast typing) cancels it before it runs.
const inbox: Message[] = [];
let ready = false;
let drainScheduled = false;

/** The one place an incoming postMessage is trusted: a JSON-RPC 2.0 object, or logged and dropped. */
function messageOf(data: unknown): Message | undefined {
  if (typeof data !== 'object' || data === null || (data as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
    log(1, `ignored a message that is not JSON-RPC 2.0: ${JSON.stringify(data)?.slice(0, 200)}`);
    return undefined;
  }
  return data as Message;
}

scope.onmessage = (event: MessageEvent<unknown>) => {
  const m = messageOf(event.data);
  if (!m) return;
  inbox.push(m);
  scheduleDrain();
};

function scheduleDrain(): void {
  if (!ready || drainScheduled) return;
  drainScheduled = true;
  setTimeout(drain, 0);
}

function drain(): void {
  drainScheduled = false;
  const batch = inbox.splice(0);
  const cancelled = new Set<string | number>();
  for (const m of batch) {
    if ('method' in m && m.method === '$/cancelRequest') {
      const id = (m.params as { id?: number | string } | undefined)?.id;
      if (id !== undefined) cancelled.add(id);
    }
  }
  for (const m of batch) {
    if (!('method' in m)) continue; // a response to a request we never send
    if ('id' in m && m.id !== null && m.id !== undefined) {
      if (cancelled.has(m.id)) {
        send({ id: m.id, error: { code: -32800, message: 'Request cancelled' } });
        continue;
      }
      try {
        const handler = requests[m.method];
        if (!handler) {
          send({ id: m.id, error: { code: -32601, message: `Unhandled method ${m.method}` } });
          continue;
        }
        send({ id: m.id, result: call(handler, m.params) ?? null });
      } catch (e) {
        const err = e instanceof ResponseError ? e : null;
        if (!err) log(1, `${m.method} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        send({ id: m.id, error: { code: err?.code ?? -32603, message: e instanceof Error ? e.message : String(e) } });
      }
    } else {
      try {
        const handler = notifications[m.method];
        if (handler) call(handler, m.params);
      } catch (e) {
        log(1, `${m.method} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Loading

/** Fetches `file` next to this script, reporting progress as `label`. */
async function download(file: string, total: number): Promise<Uint8Array> {
  const response = await fetch(new URL(file, import.meta.url));
  if (!response.ok || !response.body) throw new Error(`GET ${file}: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let reported = -1;
  notify('yukibana/loading', { label: file, loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    // About fifty notifications per file is a smooth bar without flooding.
    const step = Math.floor((loaded / Math.max(total, 1)) * 50);
    if (step !== reported) {
      reported = step;
      notify('yukibana/loading', { label: file, loaded, total });
    }
  }
  notify('yukibana/loading', { label: file, loaded, total: Math.max(total, loaded) });
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

let ts: typeof TS;
const libs = new Map<string, TS.IScriptSnapshot>();

async function load(): Promise<void> {
  const started = performance.now();
  const [tsBytes, libBytes, packageBytes] = await Promise.all([
    download(__TS_FILE__, __TS_SIZE__),
    download(__LIBS_FILE__, __LIBS_SIZE__),
    download(__PACKAGES_FILE__, __PACKAGES_SIZE__),
  ]);
  // typescript.js is fetched by hand (for progress) and imported from the
  // bytes we already have, so it is downloaded exactly once.
  const url = URL.createObjectURL(new Blob([tsBytes as BlobPart], { type: 'text/javascript' }));
  try {
    ts = ((await import(/* @vite-ignore */ url)) as { default: typeof TS }).default;
  } finally {
    URL.revokeObjectURL(url);
  }
  const bundle = JSON.parse(new TextDecoder().decode(libBytes)) as Record<string, string>;
  for (const [name, text] of Object.entries(bundle)) libs.set(`${LIB_DIR}/${name}`, ts.ScriptSnapshot.fromString(text));
  libs.set(NODE_TYPES, ts.ScriptSnapshot.fromString(__NODE_TYPES__));
  // The shipped packages as they are installed: `/node_modules/<name>/` is
  // where TypeScript's own resolution (Bundler, the `import` condition)
  // looks for `import fc from 'fast-check'` from any project directory, so
  // nothing about them is special-cased. Kept with the libs, so results
  // pointing into them are dropped like those into a lib.
  const packages = JSON.parse(new TextDecoder().decode(packageBytes)) as Record<string, string>;
  for (const [path, text] of Object.entries(packages)) libs.set(path, ts.ScriptSnapshot.fromString(text));
  log(3, `TypeScript ${ts.version} loaded with ${libs.size} lib files in ${Math.round(performance.now() - started)} ms`);
}

load().then(
  () => {
    ready = true;
    scheduleDrain();
  },
  (e: unknown) => {
    const message = `could not load the JavaScript language server: ${e instanceof Error ? e.message : String(e)}`;
    log(1, message);
    // Answer whatever is waiting (initialize, above all) instead of hanging.
    for (const m of inbox.splice(0)) {
      if ('id' in m && 'method' in m) send({ id: m.id, error: { code: -32603, message } });
    }
    scope.onmessage = (event: MessageEvent<unknown>) => {
      const m = messageOf(event.data);
      if (m && 'id' in m && 'method' in m) send({ id: m.id, error: { code: -32603, message } });
    };
  },
);

// ---------------------------------------------------------------------------
// Documents and the virtual file system

/** One project file. `text` is the client's latest full text. */
interface Doc {
  readonly uri: string;
  text: string;
  /** The client's version, echoed in publishDiagnostics. */
  version: number;
  /** Ours, bumped on every change; TypeScript's script version. */
  rev: number;
  snapshot?: TS.IScriptSnapshot;
  lineStarts?: number[];
}

let root = '/workspace';
const docs = new Map<string, Doc>();
let projectVersion = 0;
let compilerOptions: TS.CompilerOptions | undefined;
let configErrors: readonly TS.Diagnostic[] = [];
let configPath: string | undefined;
let clientSnippets = false;

function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) throw new ResponseError(-32602, `not a file: URI: ${uri}`);
  return decodeURIComponent(new URL(uri).pathname);
}
function pathToUri(path: string): string {
  return docs.get(path)?.uri ?? `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}
function docOf(uri: string): [string, Doc] | undefined {
  const path = uriToPath(uri);
  const doc = docs.get(path);
  return doc ? [path, doc] : undefined;
}

function lineStarts(doc: Doc): number[] {
  if (doc.lineStarts) return doc.lineStarts;
  const starts = [0];
  const t = doc.text;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 13 /* \r */) {
      if (t.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10) starts.push(i + 1);
  }
  return (doc.lineStarts = starts);
}
/**
 * LSP position (UTF-16, like JS strings) to an offset, clamped into the text.
 * A character past the end of its line means the end of that line, before
 * its terminator (LSP spec); it once clamped to the start of the next line,
 * so a hover at {line: 0, character: 999} answered for line 1.
 */
function offsetAt(doc: Doc, pos: P.Position): number {
  const starts = lineStarts(doc);
  if (pos.line >= starts.length) return doc.text.length;
  const start = starts[pos.line]!;
  let end = doc.text.length;
  if (pos.line + 1 < starts.length) {
    end = starts[pos.line + 1]!;
    if (doc.text.charCodeAt(end - 1) === 10 /* \n */) end--;
    if (end > start && doc.text.charCodeAt(end - 1) === 13 /* \r */) end--;
  }
  return Math.min(start + Math.max(0, pos.character), end);
}
function positionAt(doc: Doc, offset: number): P.Position {
  const starts = lineStarts(doc);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo]! };
}
function rangeOf(doc: Doc, span: TS.TextSpan): P.Range {
  return { start: positionAt(doc, span.start), end: positionAt(doc, span.start + span.length) };
}

/** A location in the project, or undefined for one outside it (a lib file). */
function locationOf(fileName: string, span: TS.TextSpan): P.Location | undefined {
  const doc = docs.get(fileName);
  return doc ? { uri: doc.uri, range: rangeOf(doc, span) } : undefined;
}

function filesUnder(dir: string): string[] {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const all = [...docs.keys(), ...libs.keys()];
  return all.filter((p) => p.startsWith(prefix));
}

const fsHost = {
  fileExists: (p: string) => docs.has(p) || libs.has(p),
  readFile: (p: string) => docs.get(p)?.text ?? (libs.has(p) ? libs.get(p)!.getText(0, libs.get(p)!.getLength()) : undefined),
  directoryExists: (d: string) => d === '/' || filesUnder(d).length > 0,
  getDirectories(d: string): string[] {
    const prefix = d.endsWith('/') ? d : `${d}/`;
    const dirs = new Set<string>();
    for (const p of filesUnder(d)) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash > 0) dirs.add(rest.slice(0, slash));
    }
    return [...dirs];
  },
  // Used for path completions in import specifiers and by config parsing.
  // include/exclude globs are not applied: the project is every file the
  // client opened, which is what an editor over a handful of files wants.
  readDirectory(d: string, extensions?: readonly string[], _excl?: readonly string[], _incl?: readonly string[], depth?: number): string[] {
    const prefix = d.endsWith('/') ? d : `${d}/`;
    return [...docs.keys()].filter(
      (p) =>
        p.startsWith(prefix) &&
        (!extensions || extensions.some((e) => p.endsWith(e))) &&
        (depth === undefined || p.slice(prefix.length).split('/').length <= depth + 1),
    );
  },
};

function changed(): void {
  projectVersion++;
  scheduleDiagnostics();
}

function setDoc(uri: string, text: string, version: number): void {
  const path = uriToPath(uri);
  const old = docs.get(path);
  if (old) {
    old.text = text;
    old.version = version;
    old.rev++;
    delete old.snapshot;
    delete old.lineStarts;
  } else docs.set(path, { uri, text, version, rev: 1 });
  if (isConfig(path)) compilerOptions = undefined;
  changed();
}

function isConfig(path: string): boolean {
  return CONFIG_NAMES.some((n) => path === `${root}/${n}`);
}

/**
 * The project's compiler options: tsconfig.json, else jsconfig.json, at the
 * workspace root, parsed by TypeScript itself (so jsconfig gets jsconfig's
 * defaults); without either, an editor's defaults for loose JS/TS files.
 * Either way `lib` defaults to DEFAULT_LIBS, since only those are bundled,
 * and `noEmit` is forced.
 */
function options(): TS.CompilerOptions {
  if (compilerOptions) return compilerOptions;
  configPath = CONFIG_NAMES.map((n) => `${root}/${n}`).find((p) => docs.has(p));
  let opts: TS.CompilerOptions;
  if (configPath) {
    const parsed = ts.parseJsonSourceFileConfigFileContent(
      ts.parseJsonText(configPath, docs.get(configPath)!.text),
      { ...fsHost, useCaseSensitiveFileNames: true },
      root,
      undefined,
      configPath,
    );
    // "No inputs were found" only means the config's include globs (which we
    // do not apply) matched nothing in our listing; it is not the user's error.
    configErrors = parsed.errors.filter((d) => d.code !== 18003);
    opts = parsed.options;
  } else {
    configErrors = [];
    opts = {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      // Untyped JS parameters are the norm, not an error, in loose files.
      noImplicitAny: false,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      noEmit: true,
      skipLibCheck: true,
    };
  }
  // Nothing is ever emitted here, so emit-only complaints ("Cannot write file
  // … would overwrite input file" for allowJs without outDir) are noise.
  opts = { allowNonTsExtensions: true, ...opts, noEmit: true, lib: opts.lib ?? DEFAULT_LIBS, types: opts.types ?? [] };
  return (compilerOptions = opts);
}

function scriptFiles(): string[] {
  return [...[...docs.keys()].filter((p) => SCRIPT_EXT.test(p)), NODE_TYPES];
}

let service: TS.LanguageService | undefined;
function ls(): TS.LanguageService {
  if (service) return service;
  const host: TS.LanguageServiceHost = {
    ...fsHost,
    getProjectVersion: () => String(projectVersion),
    getCompilationSettings: options,
    getScriptFileNames: scriptFiles,
    getScriptVersion: (p) => String(docs.get(p)?.rev ?? (libs.has(p) ? 1 : 0)),
    getScriptSnapshot(p) {
      const doc = docs.get(p);
      if (doc) return (doc.snapshot ??= ts.ScriptSnapshot.fromString(doc.text));
      return libs.get(p);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (o) => `${LIB_DIR}/${ts.getDefaultLibFileName(o)}`,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  return (service = ts.createLanguageService(host, ts.createDocumentRegistry(true, root)));
}

// ---------------------------------------------------------------------------
// Diagnostics: recomputed for the whole project after a quiet moment, a file
// at a time, yielding between files so requests are answered in between.

let diagTimer: ReturnType<typeof setTimeout> | undefined;
/** What was last published per file, so unchanged diagnostics are not resent. */
const published = new Map<string, string>();

function scheduleDiagnostics(): void {
  if (diagTimer !== undefined) clearTimeout(diagTimer);
  diagTimer = setTimeout(() => {
    diagTimer = undefined;
    publishDiagnostics().catch((e: unknown) => log(1, `diagnostics failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  }, 200);
}

async function publishDiagnostics(): Promise<void> {
  const version = projectVersion;
  const service = ls();
  options(); // refreshes configErrors
  const files = [...docs.keys()];
  for (const path of files) {
    if (projectVersion !== version) return; // a newer run is scheduled
    const doc = docs.get(path);
    if (!doc) continue;
    let diags: TS.Diagnostic[] = [];
    if (SCRIPT_EXT.test(path)) {
      diags = [
        ...service.getSyntacticDiagnostics(path),
        ...service.getSemanticDiagnostics(path),
        ...service.getSuggestionDiagnostics(path),
      ];
    } else if (path === configPath) {
      // Option errors (an unknown or unbundled "lib", say) belong to no
      // script; they point into the config file, so they are shown there.
      const global = service.getCompilerOptionsDiagnostics().filter((d) => !d.file || d.file.fileName === path);
      diags = [...configErrors, ...global];
    }
    const items = diags.map((d) => diagnostic(doc, d));
    const key = JSON.stringify(items);
    if (published.get(path) !== key) {
      published.set(path, key);
      notify('textDocument/publishDiagnostics', { uri: doc.uri, version: doc.version, diagnostics: items });
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

function diagnostic(doc: Doc, d: TS.Diagnostic): P.Diagnostic {
  const C = ts.DiagnosticCategory;
  const severity = d.category === C.Error ? 1 : d.category === C.Warning ? 2 : d.category === C.Message ? 3 : 4;
  const tags: P.DiagnosticTag[] = [];
  if (d.reportsUnnecessary) tags.push(1);
  if (d.reportsDeprecated) tags.push(2);
  const start = d.start ?? 0;
  const result: P.Diagnostic = {
    range: rangeOf(doc, { start, length: d.length ?? 0 }),
    severity: severity as P.DiagnosticSeverity,
    code: d.code,
    source: 'ts',
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  };
  if (tags.length) result.tags = tags;
  const related = (d.relatedInformation ?? []).flatMap((r) => {
    const loc = r.file && r.start !== undefined ? locationOf(r.file.fileName, { start: r.start, length: r.length ?? 0 }) : undefined;
    return loc ? [{ location: loc, message: ts.flattenDiagnosticMessageText(r.messageText, '\n') }] : [];
  });
  if (related.length) result.relatedInformation = related;
  return result;
}

// ---------------------------------------------------------------------------
// Conversions

function display(parts: readonly TS.SymbolDisplayPart[] | undefined): string {
  return ts.displayPartsToString(parts as TS.SymbolDisplayPart[] | undefined);
}

function tagText(tag: TS.JSDocTagInfo): string {
  const text = display(tag.text);
  if (tag.name === 'param' || tag.name === 'template') {
    const [name, ...rest] = text.split(/\s+/);
    return `*@${tag.name}* \`${name}\`${rest.length ? ` — ${rest.join(' ')}` : ''}`;
  }
  if (tag.name === 'example') return `*@example*\n\`\`\`js\n${text}\n\`\`\``;
  return `*@${tag.name}*${text ? ` — ${text}` : ''}`;
}

function documentation(doc: readonly TS.SymbolDisplayPart[] | undefined, tags: readonly TS.JSDocTagInfo[] | undefined): string {
  const parts = [display(doc)];
  if (tags?.length) parts.push(tags.map(tagText).join('\n\n'));
  return parts.filter(Boolean).join('\n\n');
}

function markdown(code: string, doc: string): P.MarkupContent {
  const value = [code ? '```typescript\n' + code + '\n```' : '', doc].filter(Boolean).join('\n\n');
  return { kind: 'markdown', value };
}

function completionKind(kind: string): P.CompletionItemKind {
  const K = ts.ScriptElementKind;
  switch (kind) {
    case K.primitiveType:
    case K.keyword:
      return 14;
    case K.constElement:
    case K.letElement:
    case K.variableElement:
    case K.localVariableElement:
    case K.variableUsingElement:
    case K.variableAwaitUsingElement:
    case K.alias:
    case K.parameterElement:
      return 6;
    case K.memberVariableElement:
    case K.memberGetAccessorElement:
    case K.memberSetAccessorElement:
    case K.memberAccessorVariableElement:
    case K.jsxAttribute:
      return 10;
    case K.functionElement:
    case K.localFunctionElement:
      return 3;
    case K.memberFunctionElement:
    case K.constructSignatureElement:
    case K.callSignatureElement:
    case K.indexSignatureElement:
      return 2;
    case K.enumElement:
      return 13;
    case K.enumMemberElement:
      return 20;
    case K.moduleElement:
    case K.externalModuleName:
      return 9;
    case K.classElement:
    case K.localClassElement:
    case K.typeElement:
      return 7;
    case K.interfaceElement:
      return 8;
    case K.warning:
      return 1;
    case K.scriptElement:
      return 17;
    case K.directory:
      return 19;
    case K.string:
      return 21;
    case K.typeParameterElement:
      return 25;
    case K.constructorImplementationElement:
      return 4;
    default:
      return 10;
  }
}

function symbolKind(kind: string): P.SymbolKind {
  const K = ts.ScriptElementKind;
  switch (kind) {
    case K.moduleElement:
      return 2;
    case K.classElement:
    case K.localClassElement:
      return 5;
    case K.enumElement:
      return 10;
    case K.interfaceElement:
      return 11;
    case K.memberFunctionElement:
      return 6;
    case K.memberVariableElement:
    case K.memberGetAccessorElement:
    case K.memberSetAccessorElement:
    case K.memberAccessorVariableElement:
      return 7;
    case K.constructorImplementationElement:
      return 9;
    case K.enumMemberElement:
      return 22;
    case K.functionElement:
    case K.localFunctionElement:
      return 12;
    case K.constElement:
      return 14;
    case K.typeElement:
      return 26;
    case K.typeParameterElement:
      return 26;
    default:
      return 13;
  }
}

/** TypeScript's file edits as a WorkspaceEdit; edits outside the project are dropped. */
function workspaceEdit(changes: readonly TS.FileTextChanges[]): P.WorkspaceEdit | undefined {
  const out: Record<string, P.TextEdit[]> = {};
  for (const change of changes) {
    const doc = docs.get(change.fileName);
    if (!doc || change.isNewFile) return undefined;
    (out[doc.uri] ??= []).push(...change.textChanges.map((t) => ({ range: rangeOf(doc, t.span), newText: t.newText })));
  }
  return { changes: out };
}

function formatSettings(o?: P.FormattingOptions): TS.FormatCodeSettings {
  const tabSize = o?.tabSize ?? 2;
  return {
    ...ts.getDefaultFormatCodeSettings('\n'),
    tabSize,
    indentSize: tabSize,
    convertTabsToSpaces: o?.insertSpaces ?? true,
    trimTrailingWhitespace: o?.trimTrailingWhitespace ?? true,
  };
}

const preferences = (): TS.UserPreferences => ({
  quotePreference: 'auto',
  // Always the extension: the project runs as native ES modules in the
  // browser (runner.ts resolves specifiers exactly as written), where './math'
  // is not './math.js'. 'auto' wrote './math' under Bundler resolution
  // whenever the file had no import to copy the style from.
  importModuleSpecifierEnding: 'js',
  includeCompletionsForModuleExports: true,
  includeCompletionsForImportStatements: true,
  includeCompletionsWithInsertText: true,
  includeCompletionsWithSnippetText: clientSnippets,
  includeAutomaticOptionalChainCompletions: true,
  includeCompletionsWithClassMemberSnippets: clientSnippets,
  allowIncompleteCompletions: true,
  // A rename edits the declaration and every use, in every file, whichever
  // use it starts from. With prefix and suffix text (VS Code's default,
  // `useAliasesForRenames`), renaming a call of an imported function only
  // aliased it locally (`import { distance as dist3 }`), which is not what a
  // beginner who asked for a rename expects.
  providePrefixAndSuffixTextForRename: false,
  allowRenameOfImportPath: false,
});

let fixable: Set<string> | undefined;
const supportedFixes = () => (fixable ??= new Set(ts.getSupportedCodeFixes()));

const TS_TRIGGERS = new Set(['.', '"', "'", '`', '/', '@', '<', '#', ' ']);

const TOKEN_TYPES = ['class', 'enum', 'interface', 'namespace', 'typeParameter', 'type', 'parameter', 'variable', 'enumMember', 'property', 'function', 'method'];
const TOKEN_MODIFIERS = ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'];

interface CompletionData {
  uri: string;
  offset: number;
  name: string;
  source?: string;
  data?: TS.CompletionEntryData;
}

// ---------------------------------------------------------------------------
// Handlers

/**
 * A method handler. Params arrive as untyped JSON; each handler declares the
 * LSP type it expects, and `call` is the one place that trusts the client.
 */
type Handler = (params: never) => unknown;
const call = (h: Handler, params: unknown): unknown => (h as (p: unknown) => unknown)(params);

function at(params: P.TextDocumentPositionParams): [string, Doc, number] | undefined {
  const found = docOf(params.textDocument.uri);
  return found && SCRIPT_EXT.test(found[0]) ? [found[0], found[1], offsetAt(found[1], params.position)] : undefined;
}
function scriptDoc(uri: string): [string, Doc] | undefined {
  const found = docOf(uri);
  return found && SCRIPT_EXT.test(found[0]) ? found : undefined;
}

/** Set by the first initialize; a worker serves one session (see initialize). */
let initialized = false;

const requests: Record<string, Handler> = {
  /**
   * Answered once per worker. A second initialize, even after shutdown, is
   * refused rather than half-honoured: the documents, the cached service and
   * its registry all belong to the first session's root, and the app starts a
   * fresh worker for a new session anyway (shutdown, exit, new Worker).
   */
  initialize(params: P.InitializeParams): P.InitializeResult {
    if (initialized) throw new ResponseError(-32600, 'initialize was already received; start a new worker for a new session');
    initialized = true;
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    if (folder) root = uriToPath(folder).replace(/\/$/, '') || '/';
    clientSnippets = params.capabilities.textDocument?.completion?.completionItem?.snippetSupport === true;
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1 },
        completionProvider: { triggerCharacters: ['.', '"', "'", '`', '/', '@', '<', '#'], resolveProvider: true },
        hoverProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ',', '<'], retriggerCharacters: [')'] },
        definitionProvider: true,
        typeDefinitionProvider: true,
        implementationProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        codeActionProvider: { codeActionKinds: ['quickfix', 'source.organizeImports'] },
        semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS }, full: true },
      },
      serverInfo: { name: 'yukibana-typescript-ls', version: `${__PACK_VERSION__} (TypeScript ${ts.version})` },
    };
  },

  shutdown: () => null,

  'textDocument/completion'(params: P.CompletionParams): P.CompletionList | null {
    const here = at(params);
    if (!here) return null;
    const [path, doc, offset] = here;
    const trigger = params.context?.triggerCharacter;
    const info = ls().getCompletionsAtPosition(path, offset, {
      ...preferences(),
      ...(trigger && TS_TRIGGERS.has(trigger) ? { triggerCharacter: trigger as TS.CompletionsTriggerCharacter } : {}),
      ...(params.context ? { triggerKind: params.context.triggerKind as TS.CompletionTriggerKind } : {}),
    });
    if (!info) return null;
    const optionalReplacement = info.optionalReplacementSpan ? rangeOf(doc, info.optionalReplacementSpan) : undefined;
    const items = info.entries.map((e): P.CompletionItem => {
      const item: P.CompletionItem = { label: e.name, kind: completionKind(e.kind), sortText: e.sortText };
      if (e.labelDetails) item.labelDetails = { ...e.labelDetails };
      if (e.filterText) item.filterText = e.filterText;
      if (e.isSnippet) item.insertTextFormat = 2;
      if (e.kindModifiers?.includes('deprecated')) item.tags = [1];
      if (e.isRecommended) item.preselect = true;
      const newText = e.insertText ?? e.name;
      const range = e.replacementSpan ? rangeOf(doc, e.replacementSpan) : optionalReplacement;
      if (range) item.textEdit = { range, newText };
      else if (e.insertText) item.insertText = e.insertText;
      const data: CompletionData = { uri: doc.uri, offset, name: e.name };
      if (e.source) data.source = e.source;
      if (e.data) data.data = e.data;
      item.data = data as unknown as Json;
      return item;
    });
    return { isIncomplete: !!info.isIncomplete, items };
  },

  'completionItem/resolve'(item: P.CompletionItem): P.CompletionItem {
    const data = item.data as CompletionData | undefined;
    const found = data && docOf(data.uri);
    if (!data || !found) return item;
    const [path, doc] = found;
    const details = ls().getCompletionEntryDetails(path, data.offset, data.name, formatSettings(), data.source, preferences(), data.data);
    if (!details) return item;
    item.detail = display(details.displayParts);
    const docs = documentation(details.documentation, details.tags);
    if (docs) item.documentation = { kind: 'markdown', value: docs };
    const edits = (details.codeActions ?? []).flatMap((a) =>
      a.changes.filter((c) => c.fileName === path).flatMap((c) => c.textChanges.map((t) => ({ range: rangeOf(doc, t.span), newText: t.newText }))),
    );
    if (edits.length) item.additionalTextEdits = edits;
    return item;
  },

  'textDocument/hover'(params: P.HoverParams): P.Hover | null {
    const here = at(params);
    if (!here) return null;
    const info = ls().getQuickInfoAtPosition(here[0], here[2]);
    if (!info) return null;
    return { contents: markdown(display(info.displayParts), documentation(info.documentation, info.tags)), range: rangeOf(here[1], info.textSpan) };
  },

  'textDocument/signatureHelp'(params: P.SignatureHelpParams): P.SignatureHelp | null {
    const here = at(params);
    if (!here) return null;
    const ch = params.context?.triggerCharacter;
    const reason: TS.SignatureHelpTriggerReason | undefined = params.context?.isRetrigger
      ? { kind: 'retrigger', ...(ch ? { triggerCharacter: ch as TS.SignatureHelpRetriggerCharacter } : {}) }
      : ch
        ? { kind: 'characterTyped', triggerCharacter: ch as TS.SignatureHelpTriggerCharacter }
        : { kind: 'invoked' };
    const help = ls().getSignatureHelpItems(here[0], here[2], { triggerReason: reason });
    if (!help) return null;
    const signatures = help.items.map((item): P.SignatureInformation => {
      let label = display(item.prefixDisplayParts);
      const sep = display(item.separatorDisplayParts);
      const parameters = item.parameters.map((p, i): P.ParameterInformation => {
        if (i > 0) label += sep;
        const start = label.length;
        label += display(p.displayParts);
        const info: P.ParameterInformation = { label: [start, label.length] };
        const d = display(p.documentation);
        if (d) info.documentation = { kind: 'markdown', value: d };
        return info;
      });
      label += display(item.suffixDisplayParts);
      const sig: P.SignatureInformation = { label, parameters };
      const d = documentation(item.documentation, item.tags);
      if (d) sig.documentation = { kind: 'markdown', value: d };
      return sig;
    });
    return { signatures, activeSignature: help.selectedItemIndex, activeParameter: help.argumentIndex };
  },

  'textDocument/definition'(params: P.DefinitionParams): P.Location[] | null {
    const here = at(params);
    if (!here) return null;
    const found = ls().getDefinitionAndBoundSpan(here[0], here[2]);
    return (found?.definitions ?? []).flatMap((d) => locationOf(d.fileName, d.textSpan) ?? []);
  },

  'textDocument/typeDefinition'(params: P.TypeDefinitionParams): P.Location[] | null {
    const here = at(params);
    if (!here) return null;
    return (ls().getTypeDefinitionAtPosition(here[0], here[2]) ?? []).flatMap((d) => locationOf(d.fileName, d.textSpan) ?? []);
  },

  'textDocument/implementation'(params: P.ImplementationParams): P.Location[] | null {
    const here = at(params);
    if (!here) return null;
    return (ls().getImplementationAtPosition(here[0], here[2]) ?? []).flatMap((d) => locationOf(d.fileName, d.textSpan) ?? []);
  },

  'textDocument/references'(params: P.ReferenceParams): P.Location[] | null {
    const here = at(params);
    if (!here) return null;
    const symbols = ls().findReferences(here[0], here[2]) ?? [];
    return symbols.flatMap((s) =>
      s.references
        .filter((r) => params.context.includeDeclaration || !r.isDefinition)
        .flatMap((r) => locationOf(r.fileName, r.textSpan) ?? []),
    );
  },

  'textDocument/documentHighlight'(params: P.DocumentHighlightParams): P.DocumentHighlight[] | null {
    const here = at(params);
    if (!here) return null;
    const [path, doc, offset] = here;
    const found = ls().getDocumentHighlights(path, offset, [path]) ?? [];
    return found
      .filter((f) => f.fileName === path)
      .flatMap((f) => f.highlightSpans.map((h) => ({ range: rangeOf(doc, h.textSpan), kind: (h.kind === 'writtenReference' ? 3 : 2) as P.DocumentHighlightKind })));
  },

  'textDocument/documentSymbol'(params: P.DocumentSymbolParams): P.DocumentSymbol[] | null {
    const found = scriptDoc(params.textDocument.uri);
    if (!found) return null;
    const [path, doc] = found;
    const convert = (item: TS.NavigationTree): P.DocumentSymbol[] => {
      const span = item.spans[0];
      if (!span || item.kind === ts.ScriptElementKind.alias) return [];
      const range = rangeOf(doc, { start: Math.min(...item.spans.map((s) => s.start)), length: 0 });
      range.end = positionAt(doc, Math.max(...item.spans.map((s) => s.start + s.length)));
      const symbol: P.DocumentSymbol = {
        name: item.text,
        kind: symbolKind(item.kind),
        range,
        selectionRange: rangeOf(doc, item.nameSpan ?? span),
        children: (item.childItems ?? []).flatMap(convert),
      };
      if (item.kindModifiers.includes('deprecated')) symbol.tags = [1];
      return [symbol];
    };
    return (ls().getNavigationTree(path).childItems ?? []).flatMap(convert);
  },

  'workspace/symbol'(params: P.WorkspaceSymbolParams): P.SymbolInformation[] {
    return ls()
      .getNavigateToItems(params.query, 200, undefined, true)
      .flatMap((item) => {
        const location = locationOf(item.fileName, item.textSpan);
        return location ? [{ name: item.name, kind: symbolKind(item.kind), location, ...(item.containerName ? { containerName: item.containerName } : {}) }] : [];
      });
  },

  'textDocument/prepareRename'(params: P.PrepareRenameParams): P.PrepareRenameResult | null {
    const here = at(params);
    if (!here) return null;
    const info = ls().getRenameInfo(here[0], here[2], preferences());
    if (!info.canRename) throw new ResponseError(-32803, info.localizedErrorMessage);
    return { range: rangeOf(here[1], info.triggerSpan), placeholder: info.displayName };
  },

  'textDocument/rename'(params: P.RenameParams): P.WorkspaceEdit | null {
    const here = at(params);
    if (!here) return null;
    const info = ls().getRenameInfo(here[0], here[2], preferences());
    if (!info.canRename) throw new ResponseError(-32803, info.localizedErrorMessage);
    const locations = ls().findRenameLocations(here[0], here[2], false, false, preferences()) ?? [];
    const changes: Record<string, P.TextEdit[]> = {};
    for (const l of locations) {
      const doc = docs.get(l.fileName);
      if (!doc) throw new ResponseError(-32803, `cannot rename: ${l.fileName} is not part of the project`);
      (changes[doc.uri] ??= []).push({ range: rangeOf(doc, l.textSpan), newText: `${l.prefixText ?? ''}${params.newName}${l.suffixText ?? ''}` });
    }
    return { changes };
  },

  'textDocument/formatting'(params: P.DocumentFormattingParams): P.TextEdit[] | null {
    const found = scriptDoc(params.textDocument.uri);
    if (!found) return null;
    const [path, doc] = found;
    return ls()
      .getFormattingEditsForDocument(path, formatSettings(params.options))
      .map((t) => ({ range: rangeOf(doc, t.span), newText: t.newText }));
  },

  'textDocument/rangeFormatting'(params: P.DocumentRangeFormattingParams): P.TextEdit[] | null {
    const found = scriptDoc(params.textDocument.uri);
    if (!found) return null;
    const [path, doc] = found;
    return ls()
      .getFormattingEditsForRange(path, offsetAt(doc, params.range.start), offsetAt(doc, params.range.end), formatSettings(params.options))
      .map((t) => ({ range: rangeOf(doc, t.span), newText: t.newText }));
  },

  'textDocument/codeAction'(params: P.CodeActionParams): P.CodeAction[] | null {
    const found = scriptDoc(params.textDocument.uri);
    if (!found) return null;
    const [path, doc] = found;
    const actions: P.CodeAction[] = [];
    const only = params.context.only;
    const wants = (kind: string) => !only || only.some((o) => kind === o || kind.startsWith(`${o}.`));
    if (wants('quickfix')) {
      for (const d of params.context.diagnostics) {
        if (d.source !== 'ts' || typeof d.code !== 'number' || !supportedFixes().has(String(d.code))) continue;
        const fixes = ls().getCodeFixesAtPosition(path, offsetAt(doc, d.range.start), offsetAt(doc, d.range.end), [d.code], formatSettings(), preferences());
        for (const fix of fixes) {
          // Fixes that need a command (e.g. installing @types) cannot run here.
          if (fix.commands?.length) continue;
          const edit = workspaceEdit(fix.changes);
          if (edit) actions.push({ title: fix.description, kind: 'quickfix', diagnostics: [d], edit });
        }
      }
    }
    // Organize imports is computed only when asked for by kind: it is not
    // free, and codeAction requests come with every cursor move.
    if (only?.some((o) => o === 'source' || o === 'source.organizeImports')) {
      const changes = ls().organizeImports({ type: 'file', fileName: path }, formatSettings(), preferences());
      const edit = changes.some((c) => c.textChanges.length > 0) ? workspaceEdit(changes) : undefined;
      if (edit) actions.push({ title: 'Organize imports', kind: 'source.organizeImports', edit });
    }
    return actions;
  },

  'textDocument/semanticTokens/full'(params: P.SemanticTokensParams): P.SemanticTokens | null {
    const found = scriptDoc(params.textDocument.uri);
    if (!found) return null;
    const [path, doc] = found;
    const spans = ls().getEncodedSemanticClassifications(path, { start: 0, length: doc.text.length }, ts.SemanticClassificationFormat.TwentyTwenty).spans;
    const data: number[] = [];
    let prevLine = 0;
    let prevChar = 0;
    for (let i = 0; i + 2 < spans.length; i += 3) {
      const type = (spans[i + 2]! >> 8) - 1;
      if (type < 0 || type >= TOKEN_TYPES.length) continue;
      const pos = positionAt(doc, spans[i]!);
      data.push(pos.line - prevLine, pos.line === prevLine ? pos.character - prevChar : pos.character, spans[i + 1]!, type, spans[i + 2]! & 0xff);
      prevLine = pos.line;
      prevChar = pos.character;
    }
    return { data };
  },
};

const notifications: Record<string, Handler> = {
  initialized: () => undefined,
  exit: () => scope.close(),
  '$/cancelRequest': () => undefined,
  '$/setTrace': () => undefined,
  'workspace/didChangeConfiguration': () => undefined,
  'textDocument/didOpen'(params: P.DidOpenTextDocumentParams) {
    setDoc(params.textDocument.uri, params.textDocument.text, params.textDocument.version);
  },
  'textDocument/didChange'(params: P.DidChangeTextDocumentParams) {
    const found = docOf(params.textDocument.uri);
    let text = found?.[1].text ?? '';
    for (const change of params.contentChanges) {
      if ('range' in change) {
        // Not advertised (we ask for full text), but cheap to honour.
        const doc: Doc = { uri: '', text, version: 0, rev: 0 };
        text = text.slice(0, offsetAt(doc, change.range.start)) + change.text + text.slice(offsetAt(doc, change.range.end));
      } else text = change.text;
    }
    setDoc(params.textDocument.uri, text, params.textDocument.version);
  },
  // In this app a closed document is a deleted file: every project file stays
  // open for the session (CONTRACT.md), so close removes it from the project.
  'textDocument/didClose'(params: P.DidCloseTextDocumentParams) {
    const path = uriToPath(params.textDocument.uri);
    if (!docs.delete(path)) return;
    if (isConfig(path)) compilerOptions = undefined;
    const last = published.get(path);
    published.delete(path);
    if (last && last !== '[]') notify('textDocument/publishDiagnostics', { uri: params.textDocument.uri, diagnostics: [] });
    changed();
  },
  // Creations and deletions also arrive as didOpen/didClose, which is what
  // the project follows; there is no disk to re-read.
  'workspace/didChangeWatchedFiles': () => undefined,
};
