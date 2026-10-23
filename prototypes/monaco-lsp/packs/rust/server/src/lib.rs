//! rust-analyzer's IDE crates (`ra_ap_ide` and friends, the library half of
//! rust-analyzer) behind a language server small enough to run in a Web
//! Worker: one thread, no file system, no cargo, no proc-macro server.
//!
//! rust-analyzer's own binary cannot be used: its main loop is threads and
//! channels, it learns the project from `cargo metadata` and the sysroot from
//! `rustc --print sysroot`, and it reads files from disk. What it is built
//! on, `ide::AnalysisHost`, needs none of that: it is a database of file
//! texts, source roots and a crate graph. This crate fills it the way
//! rust-analyzer's project model would for a Cargo package (see
//! `Server::crate_graph`), answers LSP requests from it (`Server::request`),
//! and converts between the protocol and rust-analyzer's types the way
//! rust-analyzer's `to_proto`/`from_proto` do, for the subset the app uses.
//!
//! The host (server.js) talks to it through four exports: `yk_alloc` for a
//! buffer to write into, `yk_sysroot_file` for each file of the standard
//! library's sources (before the first message), `yk_message` for one
//! JSON-RPC message, and `yk_idle` when the client has been quiet for a
//! moment, which publishes diagnostics. Each returns a JSON array of
//! messages for the client, read with `yk_output_ptr` and `yk_output_len`.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use base_db::{
    CrateDisplayName, CrateName, CrateOrigin, CrateWorkspaceData, DependencyBuilder, Env, LangCrateOrigin,
    target::{Arch, TargetData},
};
use cfg::CfgOptions;
use ide::{
    AnalysisHost, AssistConfig, AssistKind, AssistResolveStrategy, CallableSnippets, CompletionConfig,
    CompletionFieldsToResolve, CompletionItemImport, CompletionItemKind, CrateGraphBuilder, DiagnosticsConfig, Edition,
    FileId, FilePosition, FileRange, FileStructureConfig, FindAllRefsConfig, GotoDefinitionConfig,
    GotoImplementationConfig, HighlightConfig, HighlightRelatedConfig, HlMod, HlTag, HoverConfig, HoverDocFormat,
    InlayHintPosition, InlayHintsConfig, InlayKind, RaFixtureConfig, RenameConfig, Severity, SourceChange, SourceRoot,
    StructureNodeKind, SubstTyLen, SymbolKind, TextRange, TextSize,
};
use ide_db::{
    ChangeWithProcMacros, SnippetCap,
    assists::ExprFillDefaultMode,
    imports::insert_use::{ImportGranularity, InsertUseConfig},
    line_index::{LineCol, LineIndex, WideEncoding, WideLineCol},
    search::ReferenceCategory,
};
use intern::Symbol;
use paths::AbsPathBuf;
use serde_json::{Value, json};
use triomphe::Arc;
use vfs::{file_set::FileSet, VfsPath};

const ROOT_URI: &str = "file:///workspace/";
const WORKSPACE: &str = "/workspace/";
const SYSROOT: &str = "/sysroot/library/";
/// x86_64-unknown-linux-gnu, the target the runner's Miri interprets for: the
/// layout gives hover its sizes, the cfgs pick the standard library's code.
const DATA_LAYOUT: &str = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
const TARGET_CFG: &[(&str, Option<&str>)] = &[
    ("unix", None),
    ("target_os", Some("linux")),
    ("target_family", Some("unix")),
    ("target_arch", Some("x86_64")),
    ("target_env", Some("gnu")),
    ("target_vendor", Some("unknown")),
    ("target_endian", Some("little")),
    ("target_pointer_width", Some("64")),
    ("target_has_atomic", Some("8")),
    ("target_has_atomic", Some("16")),
    ("target_has_atomic", Some("32")),
    ("target_has_atomic", Some("64")),
    ("target_has_atomic", Some("ptr")),
    ("panic", Some("unwind")),
];
/// The standard library's crates this server knows, with their
/// dependencies, as rust-analyzer's sysroot loader stitches them together
/// when there is no `cargo metadata` for the sysroot.
const SYSROOT_CRATES: &[(&str, LangCrateOrigin, &[&str])] = &[
    ("core", LangCrateOrigin::Core, &[]),
    ("alloc", LangCrateOrigin::Alloc, &["core"]),
    ("std", LangCrateOrigin::Std, &["alloc", "core"]),
];

thread_local! {
    static SERVER: RefCell<Server> = RefCell::new(Server::new());
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

// ---- exports

/// A buffer of `len` bytes for the host to write a string into; it is
/// freed by the call it is passed to.
#[unsafe(no_mangle)]
pub extern "C" fn yk_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

fn take(ptr: *mut u8, len: usize) -> String {
    // SAFETY: the host wrote `len` bytes into a buffer `yk_alloc(len)` gave it.
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) };
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn reply(messages: Vec<Value>) {
    let text = serde_json::to_vec(&messages).unwrap_or_else(|_| b"[]".to_vec());
    OUTPUT.with(|o| *o.borrow_mut() = text);
}

#[unsafe(no_mangle)]
pub extern "C" fn yk_output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn yk_output_len() -> usize {
    OUTPUT.with(|o| o.borrow().len())
}

/// One file of the standard library's sources, `path` relative to
/// `library/` (`core/src/lib.rs`). Only before the first message.
#[unsafe(no_mangle)]
pub extern "C" fn yk_sysroot_file(path: *mut u8, path_len: usize, text: *mut u8, text_len: usize) {
    let (path, text) = (take(path, path_len), take(text, text_len));
    SERVER.with(|s| s.borrow_mut().add_sysroot_file(path, text));
}

/// One JSON-RPC message from the client.
#[unsafe(no_mangle)]
pub extern "C" fn yk_message(ptr: *mut u8, len: usize) {
    let text = take(ptr, len);
    let out = SERVER.with(|s| {
        let mut s = s.borrow_mut();
        match serde_json::from_str::<Value>(&text) {
            Ok(message) => s.handle(message),
            Err(e) => vec![log(1, &format!("unreadable message: {e}"))],
        }
    });
    reply(out);
}

/// The client has been quiet: publish diagnostics if anything changed.
#[unsafe(no_mangle)]
pub extern "C" fn yk_idle() {
    let out = SERVER.with(|s| s.borrow_mut().publish_diagnostics());
    reply(out);
}

fn log(kind: u8, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "method": "window/logMessage", "params": { "type": kind, "message": message } })
}

// ---- the server

struct Server {
    host: AnalysisHost,
    next_file: u32,
    /// Sysroot files, by path relative to `library/`, until the first
    /// crate graph takes them.
    sysroot: BTreeMap<String, FileId>,
    sysroot_pending: Vec<(FileId, String)>,
    /// Workspace files by path relative to the root (`src/main.rs`).
    files: BTreeMap<String, FileId>,
    /// Text of the workspace's Cargo.toml, for the package's name and edition.
    manifest: String,
    /// The set of files or the manifest changed: rebuild roots and crates.
    graph_dirty: bool,
    /// Files changed since diagnostics were last published.
    diagnostics_dirty: bool,
    /// What was last published for each file (its diagnostics as JSON):
    /// a file is published after it is opened or edited, and when its list
    /// changes (an edit elsewhere can break or fix it).
    published: BTreeMap<String, String>,
    shutdown: bool,
    /// File changes not yet given to rust-analyzer (see `rebuild`).
    pending: Vec<(FileId, Option<String>)>,
}

/// What a request failed with, as a JSON-RPC error.
struct Failure(i64, String);

type Answer = Result<Value, Failure>;

impl Server {
    fn new() -> Server {
        Server {
            host: AnalysisHost::new(None),
            next_file: 0,
            sysroot: BTreeMap::new(),
            sysroot_pending: Vec::new(),
            files: BTreeMap::new(),
            manifest: String::new(),
            graph_dirty: true,
            diagnostics_dirty: true,
            published: BTreeMap::new(),
            shutdown: false,
            pending: Vec::new(),
        }
    }

    fn file_id(&mut self) -> FileId {
        let id = FileId::from_raw(self.next_file);
        self.next_file += 1;
        id
    }

    fn add_sysroot_file(&mut self, path: String, text: String) {
        let id = self.file_id();
        self.sysroot.insert(path, id);
        self.sysroot_pending.push((id, text));
    }

    fn handle(&mut self, message: Value) -> Vec<Value> {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("").to_owned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match message.get("id").cloned() {
            Some(id) if !method.is_empty() => {
                let answer = if self.shutdown && method != "shutdown" {
                    Err(Failure(-32600, "shut down".into()))
                } else {
                    self.request(&method, &params)
                };
                let mut out = Vec::new();
                match answer {
                    Ok(result) => out.push(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
                    Err(Failure(code, message)) => {
                        out.push(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
                    }
                }
                out
            }
            Some(_) => Vec::new(), // a response to a request of ours: none are sent
            None => {
                self.notification(&method, &params);
                Vec::new()
            }
        }
    }

    fn notification(&mut self, method: &str, params: &Value) {
        match method {
            "textDocument/didOpen" => {
                let doc = &params["textDocument"];
                if let (Some(uri), Some(text)) = (doc["uri"].as_str(), doc["text"].as_str()) {
                    self.set_file(uri, Some(text.to_owned()));
                }
            }
            "textDocument/didChange" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_owned();
                // Full sync: the last change is the whole text.
                if let Some(text) = params["contentChanges"].as_array().and_then(|c| c.last()).and_then(|c| c["text"].as_str()) {
                    self.set_file(&uri, Some(text.to_owned()));
                }
            }
            // The client closes a document only when the file is deleted.
            "textDocument/didClose" => {
                if let Some(uri) = params["textDocument"]["uri"].as_str() {
                    self.set_file(uri, None);
                }
            }
            "exit" => self.shutdown = true,
            _ => {}
        }
    }

    // ---- files and crates

    fn set_file(&mut self, uri: &str, text: Option<String>) {
        let Some(path) = path_of(uri) else { return };
        self.diagnostics_dirty = true;
        // An edited file is published again even if its list is the same, so
        // that a client sees diagnostics for the text it now has.
        if text.is_some() {
            self.published.remove(&format!("{ROOT_URI}{}", encode(&path)));
        }
        if path == "Cargo.toml" {
            self.manifest = text.unwrap_or_default();
            self.graph_dirty = true;
            return;
        }
        if !path.ends_with(".rs") {
            return;
        }
        // Applied by `rebuild`, with the roots when the set of files
        // changed: rust-analyzer must never see a file outside a root.
        match text {
            Some(text) => {
                let id = match self.files.get(&path) {
                    Some(id) => *id,
                    None => {
                        let id = self.file_id();
                        self.files.insert(path, id);
                        self.graph_dirty = true;
                        id
                    }
                };
                self.pending.push((id, Some(text)));
            }
            None => {
                if let Some(id) = self.files.remove(&path) {
                    self.pending.push((id, None));
                    self.graph_dirty = true;
                }
            }
        }
    }

    /// `[package] name` and `edition` of Cargo.toml, read line by line as
    /// the runner reads them.
    fn package(&self) -> (String, Edition) {
        let mut section = String::new();
        let (mut name, mut edition) = (None, None);
        for raw in self.manifest.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.starts_with('[') && line.ends_with(']') {
                section = line[1..line.len() - 1].trim().to_owned();
            } else if section == "package" {
                if let Some((key, value)) = line.split_once('=') {
                    let value = value.trim().trim_matches('"').to_owned();
                    match key.trim() {
                        "name" => name = Some(value),
                        "edition" => edition = Some(value),
                        _ => {}
                    }
                }
            }
        }
        let edition = match edition.as_deref() {
            Some("2015") => Edition::Edition2015,
            Some("2018") => Edition::Edition2018,
            Some("2024") => Edition::Edition2024,
            _ => Edition::Edition2021,
        };
        (name.unwrap_or_else(|| "app".into()).replace('-', "_"), edition)
    }

    /// Source roots and the crate graph, as rust-analyzer's project model
    /// builds them for a Cargo package with one library and binaries:
    /// `src/lib.rs` is a library crate named after the package, and
    /// `src/main.rs` (or `main.rs` without it), `src/bin/*.rs` and
    /// `tests/*.rs` are crates that depend on it. Every crate depends on the
    /// standard library's, and the project's are analysed with `cfg(test)`
    /// on, as rust-analyzer does for workspace members.
    fn rebuild(&mut self) {
        let mut change = ChangeWithProcMacros::default();
        for (id, text) in self.pending.drain(..) {
            change.change_file(id, text);
        }
        if !self.graph_dirty {
            self.host.apply_change(change);
            return;
        }
        self.graph_dirty = false;
        for (id, text) in self.sysroot_pending.drain(..) {
            change.change_file(id, Some(text));
        }

        let mut local = FileSet::default();
        for (path, id) in &self.files {
            local.insert(*id, VfsPath::new_virtual_path(format!("{WORKSPACE}{path}")));
        }
        let mut library = FileSet::default();
        for (path, id) in &self.sysroot {
            library.insert(*id, VfsPath::new_virtual_path(format!("{SYSROOT}{path}")));
        }
        change.set_roots(vec![SourceRoot::new_local(local), SourceRoot::new_library(library)]);

        let mut graph = CrateGraphBuilder::default();
        let cwd = Arc::new(AbsPathBuf::try_from("/workspace").expect("absolute"));
        let ws = Arc::new(CrateWorkspaceData {
            target: Ok(TargetData { data_layout: DATA_LAYOUT.into(), arch: Arch::Other }),
            toolchain: Some(semver::Version::new(1, 98, 0)),
        });
        let mut target_cfg = CfgOptions::default();
        for (key, value) in TARGET_CFG {
            match value {
                Some(v) => target_cfg.insert_key_value(Symbol::intern(key), Symbol::intern(v)),
                None => target_cfg.insert_atom(Symbol::intern(key)),
            }
        }

        let mut lang = HashMap::new();
        for (name, origin, deps) in SYSROOT_CRATES {
            let Some(root) = self.sysroot.get(&format!("{name}/src/lib.rs")) else { continue };
            let id = graph.add_crate_root(
                *root,
                Edition::Edition2021,
                Some(CrateDisplayName::from_canonical_name(name)),
                None,
                target_cfg.clone(),
                None,
                Env::default(),
                CrateOrigin::Lang(*origin),
                Vec::new(),
                false,
                cwd.clone(),
                ws.clone(),
            );
            for dep in *deps {
                if let Some(to) = lang.get(dep) {
                    let _ = graph.add_dep(id, DependencyBuilder::new(CrateName::new(dep).expect("name"), *to));
                }
            }
            lang.insert(*name, id);
        }

        let (package, edition) = self.package();
        let mut local_cfg = target_cfg.clone();
        local_cfg.insert_atom(Symbol::intern("test"));
        local_cfg.insert_atom(Symbol::intern("debug_assertions"));
        let add_local = |graph: &mut CrateGraphBuilder, root: FileId, name: &str| {
            let id = graph.add_crate_root(
                root,
                edition,
                Some(CrateDisplayName::from_canonical_name(name)),
                Some("0.1.0".into()),
                local_cfg.clone(),
                None,
                Env::default(),
                CrateOrigin::Local { repo: None, name: Some(Symbol::intern(name)) },
                Vec::new(),
                false,
                cwd.clone(),
                ws.clone(),
            );
            for (dep, prelude) in [("core", true), ("alloc", false), ("std", true)] {
                if let Some(to) = lang.get(dep) {
                    let _ = graph.add_dep(
                        id,
                        DependencyBuilder::with_prelude(CrateName::new(dep).expect("name"), *to, prelude, true),
                    );
                }
            }
            id
        };
        let lib = self.files.get("src/lib.rs").map(|root| add_local(&mut graph, *root, &package));
        let mut others = Vec::new();
        let main = self.files.get("src/main.rs").or_else(|| self.files.get("main.rs"));
        if let Some(root) = main {
            others.push((*root, package.clone()));
        }
        for (path, id) in &self.files {
            let stem = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".rs").replace('-', "_");
            let parent = &path[..path.len() - path.rsplit('/').next().unwrap_or(path).len()];
            if parent == "tests/" || parent == "src/bin/" {
                others.push((*id, stem));
            }
        }
        for (root, name) in others {
            let id = add_local(&mut graph, root, &name);
            if let (Some(lib), Ok(dep)) = (lib, CrateName::new(&package)) {
                let _ = graph.add_dep(id, DependencyBuilder::new(dep, lib));
            }
        }
        change.set_crate_graph(graph);
        self.host.apply_change(change);
    }

    // ---- requests

    fn request(&mut self, method: &str, params: &Value) -> Answer {
        if method == "initialize" {
            return Ok(initialize_result());
        }
        if method == "shutdown" {
            self.shutdown = true;
            return Ok(Value::Null);
        }
        self.rebuild();
        let result = match method {
            "textDocument/completion" => self.completion(params),
            "completionItem/resolve" => self.completion_resolve(params),
            "textDocument/hover" => self.hover(params),
            "textDocument/signatureHelp" => self.signature_help(params),
            "textDocument/definition" => self.navigation(params, Nav::Definition),
            "textDocument/typeDefinition" => self.navigation(params, Nav::TypeDefinition),
            "textDocument/implementation" => self.navigation(params, Nav::Implementation),
            "textDocument/references" => self.references(params),
            "textDocument/documentHighlight" => self.document_highlight(params),
            "textDocument/documentSymbol" => self.document_symbols(params),
            "textDocument/prepareRename" => self.prepare_rename(params),
            "textDocument/rename" => self.rename(params),
            "textDocument/codeAction" => self.code_actions(params),
            "textDocument/semanticTokens/full" => self.semantic_tokens(params),
            "textDocument/inlayHint" => self.inlay_hints(params),
            _ => return Err(Failure(-32601, format!("{method} is not supported"))),
        };
        // rust-analyzer reports its queries being cancelled, which cannot
        // happen with one thread; anything else is an internal error.
        result.or_else(|e| Err(Failure(-32603, e)))
    }

    fn uri_of(&self, id: FileId) -> Option<String> {
        self.files.iter().find(|(_, f)| **f == id).map(|(path, _)| format!("{ROOT_URI}{}", encode(path)))
    }

    fn file_of(&self, params: &Value) -> Result<FileId, String> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
        path_of(uri).and_then(|p| self.files.get(&p).copied()).ok_or_else(|| format!("unknown document {uri}"))
    }

    fn line_index(&self, id: FileId) -> Result<Arc<LineIndex>, String> {
        self.host.analysis().file_line_index(id).map_err(cancelled)
    }

    fn position(&self, params: &Value) -> Result<(FilePosition, Arc<LineIndex>), String> {
        let file_id = self.file_of(params)?;
        let index = self.line_index(file_id)?;
        let offset = offset(&index, &params["position"]);
        Ok((FilePosition { file_id, offset }, index))
    }

    fn range_of(&self, params: &Value) -> Result<(FileRange, Arc<LineIndex>), String> {
        let file_id = self.file_of(params)?;
        let index = self.line_index(file_id)?;
        let range = TextRange::new(offset(&index, &params["range"]["start"]), offset(&index, &params["range"]["end"]));
        Ok((FileRange { file_id, range }, index))
    }

    /// An LSP location in the workspace; None for one in the standard
    /// library, which the client cannot open.
    fn location(&self, id: FileId, range: TextRange) -> Option<Value> {
        let uri = self.uri_of(id)?;
        let index = self.line_index(id).ok()?;
        Some(json!({ "uri": uri, "range": lsp_range(&index, range) }))
    }

    fn workspace_edit(&self, change: &SourceChange) -> Value {
        let mut changes = serde_json::Map::new();
        for (id, (edit, _)) in change.source_file_edits.iter() {
            let (Some(uri), Ok(index)) = (self.uri_of(*id), self.line_index(*id)) else { continue };
            let edits: Vec<Value> = edit.iter().map(|indel| text_edit(&index, indel.delete, &indel.insert)).collect();
            changes.insert(uri, Value::Array(edits));
        }
        json!({ "changes": changes })
    }

    fn completion(&self, params: &Value) -> Result<Value, String> {
        let (position, index) = self.position(params)?;
        let trigger = params["context"]["triggerCharacter"].as_str().and_then(|s| s.chars().next());
        let config = completion_config();
        let analysis = self.host.analysis();
        let Some(items) = analysis.completions(&config, position, trigger).map_err(cancelled)? else {
            return Ok(Value::Null);
        };
        let uri = params["textDocument"]["uri"].clone();
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let mut primary = None;
            let mut additional = Vec::new();
            for indel in item.text_edit.iter() {
                if primary.is_none() && indel.delete.contains_range(item.source_range) || indel.delete == item.source_range {
                    primary = Some(text_edit(&index, indel.delete, &indel.insert));
                } else if primary.is_none() && indel.delete.contains(position.offset) {
                    primary = Some(text_edit(&index, indel.delete, &indel.insert));
                } else {
                    additional.push(text_edit(&index, indel.delete, &indel.insert));
                }
            }
            let primary = primary.unwrap_or_else(|| text_edit(&index, item.source_range, item.label.primary.as_str()));
            let mut label_details = serde_json::Map::new();
            if let Some(left) = &item.label.detail_left {
                label_details.insert("detail".into(), json!(format!(" {left}")));
            }
            if let Some(right) = &item.label.detail_right {
                label_details.insert("description".into(), json!(right));
            }
            let score = item.relevance.score();
            let mut lsp = json!({
                "label": item.label.primary.as_str(),
                "kind": completion_kind(&item.kind),
                "filterText": item.lookup(),
                "sortText": format!("{:08x}", u32::MAX - score),
                "textEdit": primary,
                "insertTextFormat": if item.is_snippet { 2 } else { 1 },
            });
            if !label_details.is_empty() {
                lsp["labelDetails"] = Value::Object(label_details);
            }
            if let Some(detail) = &item.detail {
                lsp["detail"] = json!(detail);
            }
            if let Some(doc) = &item.documentation {
                lsp["documentation"] = json!({ "kind": "markdown", "value": doc.as_str() });
            }
            if item.deprecated {
                lsp["tags"] = json!([1]);
            }
            if !additional.is_empty() {
                lsp["additionalTextEdits"] = Value::Array(additional);
            }
            if item.trigger_call_info {
                lsp["command"] = json!({ "title": "triggerParameterHints", "command": "editor.action.triggerParameterHints" });
            }
            if !item.import_to_add.is_empty() {
                let imports: Vec<Value> =
                    item.import_to_add.iter().map(|i| json!({ "path": i.path, "underscore": i.as_underscore })).collect();
                lsp["data"] = json!({ "textDocument": { "uri": uri }, "position": params["position"], "imports": imports });
            }
            out.push(lsp);
        }
        Ok(json!({ "isIncomplete": true, "items": out }))
    }

    /// Completions of names not in scope (rust-analyzer's "flyimport") add
    /// their `use` here, when the client resolves the chosen item.
    fn completion_resolve(&self, item: &Value) -> Result<Value, String> {
        let data = &item["data"];
        let Some(imports) = data["imports"].as_array() else { return Ok(item.clone()) };
        let (position, index) = self.position(data)?;
        let imports: Vec<CompletionItemImport> = imports
            .iter()
            .map(|i| CompletionItemImport {
                path: i["path"].as_str().unwrap_or_default().to_owned(),
                as_underscore: i["underscore"].as_bool().unwrap_or(false),
            })
            .collect();
        let edits = self
            .host
            .analysis()
            .resolve_completion_edits(&completion_config(), position, imports)
            .map_err(cancelled)?;
        let mut resolved = item.clone();
        let mut additional: Vec<Value> = resolved["additionalTextEdits"].as_array().cloned().unwrap_or_default();
        for edit in edits {
            for indel in edit.iter() {
                additional.push(text_edit(&index, indel.delete, &indel.insert));
            }
        }
        resolved["additionalTextEdits"] = Value::Array(additional);
        Ok(resolved)
    }

    fn hover(&self, params: &Value) -> Result<Value, String> {
        let (position, index) = self.position(params)?;
        let config = HoverConfig {
            links_in_hover: true,
            memory_layout: Some(ide::MemoryLayoutHoverConfig {
                size: Some(ide::MemoryLayoutHoverRenderKind::Both),
                offset: Some(ide::MemoryLayoutHoverRenderKind::Both),
                alignment: Some(ide::MemoryLayoutHoverRenderKind::Both),
                padding: None,
                niches: false,
            }),
            documentation: true,
            format: HoverDocFormat::Markdown,
            keywords: true,
            max_trait_assoc_items_count: None,
            max_fields_count: Some(5),
            max_enum_variants_count: Some(5),
            max_subst_ty_len: SubstTyLen::Unlimited,
            show_drop_glue: true,
            ra_fixture: RaFixtureConfig::default(),
        };
        let range = FileRange { file_id: position.file_id, range: TextRange::empty(position.offset) };
        let Some(hover) = self.host.analysis().hover(&config, range).map_err(cancelled)? else { return Ok(Value::Null) };
        Ok(json!({
            "contents": { "kind": "markdown", "value": hover.info.markup.as_str() },
            "range": lsp_range(&index, hover.range),
        }))
    }

    fn signature_help(&self, params: &Value) -> Result<Value, String> {
        let (position, _) = self.position(params)?;
        let Some(help) = self.host.analysis().signature_help(position).map_err(cancelled)? else {
            return Ok(Value::Null);
        };
        let utf16 = |byte: TextSize| help.signature[..usize::from(byte)].encode_utf16().count();
        let parameters: Vec<Value> = help
            .parameter_ranges()
            .iter()
            .map(|r| json!({ "label": [utf16(r.start()), utf16(r.end())] }))
            .collect();
        let mut signature = json!({ "label": help.signature, "parameters": parameters });
        if let Some(doc) = &help.doc {
            signature["documentation"] = json!({ "kind": "markdown", "value": doc.as_str() });
        }
        if let Some(active) = help.active_parameter {
            signature["activeParameter"] = json!(active);
        }
        Ok(json!({ "signatures": [signature], "activeSignature": 0, "activeParameter": help.active_parameter }))
    }

    fn navigation(&self, params: &Value, kind: Nav) -> Result<Value, String> {
        let (position, _) = self.position(params)?;
        let analysis = self.host.analysis();
        let config = GotoDefinitionConfig { ra_fixture: RaFixtureConfig::default() };
        let targets = match kind {
            Nav::Definition => analysis.goto_definition(position, &config),
            Nav::TypeDefinition => analysis.goto_type_definition(position),
            Nav::Implementation => analysis.goto_implementation(&GotoImplementationConfig { filter_adjacent_derive_implementations: false }, position),
        }
        .map_err(cancelled)?;
        let Some(targets) = targets else { return Ok(Value::Null) };
        let locations: Vec<Value> = targets
            .info
            .iter()
            .filter_map(|nav| self.location(nav.file_id, nav.focus_range.unwrap_or(nav.full_range)))
            .collect();
        Ok(Value::Array(locations))
    }

    fn references(&self, params: &Value) -> Result<Value, String> {
        let (position, _) = self.position(params)?;
        let include_declaration = params["context"]["includeDeclaration"].as_bool().unwrap_or(true);
        let config = FindAllRefsConfig {
            search_scope: None,
            ra_fixture: RaFixtureConfig::default(),
            exclude_imports: false,
            exclude_tests: false,
        };
        let Some(results) = self.host.analysis().find_all_refs(position, &config).map_err(cancelled)? else {
            return Ok(Value::Null);
        };
        let mut out = Vec::new();
        for result in results {
            if include_declaration {
                if let Some(decl) = &result.declaration {
                    out.extend(self.location(decl.nav.file_id, decl.nav.focus_range.unwrap_or(decl.nav.full_range)));
                }
            }
            for (id, refs) in result.references.iter() {
                for (range, _) in refs {
                    out.extend(self.location(*id, *range));
                }
            }
        }
        Ok(Value::Array(out))
    }

    fn document_highlight(&self, params: &Value) -> Result<Value, String> {
        let (position, index) = self.position(params)?;
        let config = HighlightRelatedConfig {
            references: true,
            exit_points: true,
            break_points: true,
            closure_captures: true,
            yield_points: true,
            branch_exit_points: true,
        };
        let Some(ranges) = self.host.analysis().highlight_related(config, position).map_err(cancelled)? else {
            return Ok(Value::Null);
        };
        Ok(Value::Array(
            ranges
                .into_iter()
                .map(|h| {
                    let kind = if h.category.contains(ReferenceCategory::WRITE) {
                        3
                    } else if h.category.contains(ReferenceCategory::READ) {
                        2
                    } else {
                        1
                    };
                    json!({ "range": lsp_range(&index, h.range), "kind": kind })
                })
                .collect(),
        ))
    }

    fn document_symbols(&self, params: &Value) -> Result<Value, String> {
        let file_id = self.file_of(params)?;
        let index = self.line_index(file_id)?;
        let nodes = self
            .host
            .analysis()
            .file_structure(&FileStructureConfig { exclude_locals: true }, file_id)
            .map_err(cancelled)?;
        // Children follow their parent, so a node's parent is built first;
        // assemble bottom-up.
        let mut symbols: Vec<Option<Value>> = nodes
            .iter()
            .map(|n| {
                let mut s = json!({
                    "name": n.label,
                    "kind": symbol_kind(&n.kind),
                    "range": lsp_range(&index, n.node_range),
                    "selectionRange": lsp_range(&index, n.navigation_range),
                    "children": [],
                });
                if let Some(detail) = &n.detail {
                    s["detail"] = json!(detail);
                }
                if n.deprecated {
                    s["tags"] = json!([1]);
                }
                Some(s)
            })
            .collect();
        for i in (0..nodes.len()).rev() {
            if let Some(parent) = nodes[i].parent {
                if let Some(child) = symbols[i].take() {
                    if let Some(Value::Array(children)) = symbols[parent].as_mut().map(|p| &mut p["children"]) {
                        children.insert(0, child);
                    }
                }
            }
        }
        Ok(Value::Array(symbols.into_iter().flatten().collect()))
    }

    fn prepare_rename(&self, params: &Value) -> Result<Value, String> {
        let (position, index) = self.position(params)?;
        match self.host.analysis().prepare_rename(position).map_err(cancelled)? {
            Ok(range) => Ok(lsp_range(&index, range.range)),
            Err(e) => Err(e.to_string()),
        }
    }

    fn rename(&self, params: &Value) -> Result<Value, String> {
        let (position, _) = self.position(params)?;
        let name = params["newName"].as_str().unwrap_or_default();
        let config = RenameConfig { prefer_no_std: false, prefer_prelude: true, prefer_absolute: false, show_conflicts: true };
        match self.host.analysis().rename(position, name, &config).map_err(cancelled)? {
            Ok(change) => Ok(self.workspace_edit(&change)),
            Err(e) => Err(e.to_string()),
        }
    }

    fn code_actions(&self, params: &Value) -> Result<Value, String> {
        let (range, _) = self.range_of(params)?;
        let assist_config = AssistConfig {
            snippet_cap: None,
            allowed: None,
            insert_use: insert_use(),
            prefer_no_std: false,
            prefer_prelude: true,
            prefer_absolute: false,
            assist_emit_must_use: false,
            term_search_fuel: 400,
            code_action_grouping: false,
            expr_fill_default: ExprFillDefaultMode::Todo,
            prefer_self_ty: false,
            show_rename_conflicts: true,
        };
        let assists = self
            .host
            .analysis()
            .assists_with_fixes(&assist_config, &diagnostics_config(), AssistResolveStrategy::All, range)
            .map_err(cancelled)?;
        let mut out = Vec::new();
        for assist in assists {
            let Some(change) = &assist.source_change else { continue };
            let kind = match assist.id.1 {
                AssistKind::QuickFix => "quickfix",
                AssistKind::Refactor => "refactor",
                AssistKind::RefactorExtract => "refactor.extract",
                AssistKind::RefactorInline => "refactor.inline",
                AssistKind::RefactorRewrite => "refactor.rewrite",
                AssistKind::Generate => "refactor",
            };
            out.push(json!({ "title": assist.label.to_string(), "kind": kind, "edit": self.workspace_edit(change) }));
        }
        Ok(Value::Array(out))
    }

    fn semantic_tokens(&self, params: &Value) -> Result<Value, String> {
        let file_id = self.file_of(params)?;
        let index = self.line_index(file_id)?;
        let config = HighlightConfig {
            strings: true,
            comments: true,
            punctuation: false,
            specialize_punctuation: false,
            operator: true,
            specialize_operator: false,
            inject_doc_comment: true,
            macro_bang: true,
            syntactic_name_ref_highlighting: false,
            ra_fixture: RaFixtureConfig::default(),
        };
        let ranges = self.host.analysis().highlight(config, file_id).map_err(cancelled)?;
        let text = self.host.analysis().file_text(file_id).map_err(cancelled)?;
        let mut data = Vec::new();
        let (mut last_line, mut last_col) = (0u32, 0u32);
        for hl in ranges {
            let Some(ty) = token_type(hl.highlight.tag) else { continue };
            let mut mods = 0u32;
            for (bit, m) in [HlMod::Definition, HlMod::Static, HlMod::DefaultLibrary, HlMod::Mutable, HlMod::Deprecated, HlMod::Unsafe]
                .into_iter()
                .enumerate()
            {
                if hl.highlight.mods.contains(m) {
                    mods |= 1 << bit;
                }
            }
            // One token per line: LSP tokens do not span lines.
            let mut start = hl.range.start();
            let end = hl.range.end();
            while start < end {
                let line_end = text[usize::from(start)..usize::from(end)].find('\n').map(|i| start + TextSize::from(i as u32)).unwrap_or(end);
                if line_end > start {
                    let s = wide(&index, start);
                    let e = wide(&index, line_end);
                    let delta_line = s.line - last_line;
                    let delta_col = if delta_line == 0 { s.col - last_col } else { s.col };
                    data.extend([delta_line, delta_col, e.col - s.col, ty, mods]);
                    last_line = s.line;
                    last_col = s.col;
                }
                start = line_end + TextSize::from(1);
            }
        }
        Ok(json!({ "data": data }))
    }

    fn inlay_hints(&self, params: &Value) -> Result<Value, String> {
        let (range, index) = self.range_of(params)?;
        let config = InlayHintsConfig {
            discriminant_hints: ide::DiscriminantHints::Never,
            render_colons: true,
            type_hints: true,
            type_hints_placement: ide::TypeHintsPlacement::Inline,
            parameter_hints: true,
            parameter_hints_for_missing_arguments: false,
            sized_bound: false,
            generic_parameter_hints: ide::GenericParameterHints { type_hints: false, lifetime_hints: false, const_hints: false },
            chaining_hints: true,
            lifetime_elision_hints: ide::LifetimeElisionHints::Never,
            closure_return_type_hints: ide::ClosureReturnTypeHints::WithBlock,
            closure_capture_hints: false,
            adjustment_hints: ide::AdjustmentHints::Never,
            adjustment_hints_disable_reborrows: true,
            adjustment_hints_mode: ide::AdjustmentHintsMode::Prefix,
            adjustment_hints_hide_outside_unsafe: false,
            binding_mode_hints: false,
            hide_inferred_type_hints: false,
            hide_named_constructor_hints: false,
            hide_closure_initialization_hints: false,
            hide_closure_parameter_hints: false,
            closure_style: hir::ClosureStyle::ImplFn,
            param_names_for_lifetime_elision_hints: false,
            max_length: Some(25),
            closing_brace_hints_min_lines: None,
            fields_to_resolve: ide::InlayFieldsToResolve::empty(),
            implicit_drop_hints: false,
            implied_dyn_trait_hints: false,
            range_exclusive_hints: false,
            ra_fixture: RaFixtureConfig::default(),
        };
        let hints = self.host.analysis().inlay_hints(&config, range.file_id, Some(range.range)).map_err(cancelled)?;
        Ok(Value::Array(
            hints
                .into_iter()
                .map(|h| {
                    let at = match h.position {
                        InlayHintPosition::Before => h.range.start(),
                        InlayHintPosition::After => h.range.end(),
                    };
                    let label: String = h.label.parts.iter().map(|p| p.text.as_str()).collect();
                    let kind = match h.kind {
                        InlayKind::Type | InlayKind::Chaining => 1,
                        InlayKind::Parameter => 2,
                        _ => 1,
                    };
                    json!({
                        "position": lsp_position(&index, at),
                        "label": label,
                        "kind": kind,
                        "paddingLeft": h.pad_left,
                        "paddingRight": h.pad_right,
                    })
                })
                .collect(),
        ))
    }

    // ---- diagnostics

    fn publish_diagnostics(&mut self) -> Vec<Value> {
        if !self.diagnostics_dirty || self.shutdown {
            return Vec::new();
        }
        self.diagnostics_dirty = false;
        self.rebuild();
        let analysis = self.host.analysis();
        let config = diagnostics_config();
        let mut out = Vec::new();
        let mut published = BTreeMap::new();
        for (path, id) in &self.files {
            let uri = format!("{ROOT_URI}{}", encode(path));
            let diagnostics = match analysis.full_diagnostics(&config, AssistResolveStrategy::None, *id) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let Ok(index) = analysis.file_line_index(*id) else { continue };
            let list: Vec<Value> = diagnostics
                .into_iter()
                .filter(|d| d.range.file_id == *id && d.severity != Severity::Allow)
                .map(|d| {
                    let severity = match d.severity {
                        Severity::Error => 1,
                        Severity::Warning => 2,
                        Severity::WeakWarning => 4,
                        Severity::Allow => 4,
                    };
                    let mut lsp = json!({
                        "range": lsp_range(&index, d.range.range),
                        "severity": severity,
                        "code": d.code.as_str(),
                        "codeDescription": { "href": d.code.url() },
                        "source": "rust-analyzer",
                        "message": d.message,
                    });
                    if d.unused {
                        lsp["tags"] = json!([1]);
                    }
                    lsp
                })
                .collect();
            let key = Value::Array(list.clone()).to_string();
            let unchanged = self.published.get(&uri) == Some(&key);
            published.insert(uri.clone(), key);
            if unchanged {
                continue;
            }
            out.push(json!({
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": { "uri": uri, "diagnostics": list },
            }));
        }
        // Files that are gone: clear what was published for them.
        for uri in self.published.keys().filter(|u| !published.contains_key(*u)) {
            if !out.iter().any(|m| m["params"]["uri"] == *uri) {
                out.push(json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": { "uri": uri, "diagnostics": [] } }));
            }
        }
        self.published = published;
        out
    }
}

#[derive(Clone, Copy)]
enum Nav {
    Definition,
    TypeDefinition,
    Implementation,
}

fn cancelled<E>(_: E) -> String {
    "cancelled".into()
}

// ---- configuration, as rust-analyzer's defaults

fn insert_use() -> InsertUseConfig {
    InsertUseConfig {
        granularity: ImportGranularity::Crate,
        enforce_granularity: false,
        prefix_kind: hir::PrefixKind::Plain,
        group: true,
        skip_glob_imports: true,
    }
}

fn completion_config() -> CompletionConfig<'static> {
    CompletionConfig {
        enable_postfix_completions: true,
        enable_imports_on_the_fly: true,
        enable_self_on_the_fly: true,
        enable_private_editable: false,
        enable_term_search: false,
        enable_turbofish: true,
        term_search_fuel: 1000,
        full_function_signatures: false,
        callable: Some(CallableSnippets::FillArguments),
        add_colons_to_module: true,
        add_semicolon_to_unit: true,
        snippet_cap: SnippetCap::new(true),
        insert_use: insert_use(),
        prefer_no_std: false,
        prefer_prelude: true,
        prefer_absolute: false,
        snippets: Vec::new(),
        limit: Some(200),
        fields_to_resolve: CompletionFieldsToResolve::empty(),
        exclude_flyimport: vec![],
        exclude_traits: &[],
        enable_auto_await: true,
        enable_auto_iter: true,
        ra_fixture: RaFixtureConfig::default(),
    }
}

fn diagnostics_config() -> DiagnosticsConfig {
    let mut config = DiagnosticsConfig::test_sample();
    // Style lints off, as in rust-analyzer's defaults. Experimental
    // diagnostics on, unlike them: in an editor rust-analyzer leaves
    // unresolved names (E0425), methods (E0599) and fields to `cargo check`,
    // which has no counterpart here, and without these a typo in a name would
    // be silent until Run. They can be wrong where rust-analyzer's type
    // inference gives up; that is the price of seeing typos at all.
    config.disable_experimental = false;
    // Except "type annotations needed": it fires wherever inference gives up,
    // which in this build includes a plain `let m: HashMap<String, usize> =
    // HashMap::new();` in a body that also reads stdin.
    config.disabled.insert("E0282".to_owned());
    config.style_lints = false;
    config.snippet_cap = None;
    config.insert_use = insert_use();
    config
}

fn initialize_result() -> Value {
    json!({
        "capabilities": {
            "positionEncoding": "utf-16",
            "textDocumentSync": { "openClose": true, "change": 1 },
            "completionProvider": { "triggerCharacters": [".", ":", "'", "("], "resolveProvider": true },
            "hoverProvider": true,
            "signatureHelpProvider": { "triggerCharacters": ["(", ","], "retriggerCharacters": [","] },
            "definitionProvider": true,
            "typeDefinitionProvider": true,
            "implementationProvider": true,
            "referencesProvider": true,
            "documentHighlightProvider": true,
            "documentSymbolProvider": true,
            "renameProvider": { "prepareProvider": true },
            "codeActionProvider": { "codeActionKinds": ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite"] },
            "semanticTokensProvider": {
                "legend": { "tokenTypes": TOKEN_TYPES, "tokenModifiers": ["declaration", "static", "defaultLibrary", "mutable", "deprecated", "unsafe"] },
                "full": true,
            },
            "inlayHintProvider": true,
        },
        "serverInfo": { "name": "rust-analyzer (ra_ap_ide, Yukibana)", "version": "0.0.358" },
    })
}

// ---- conversions

const TOKEN_TYPES: &[&str] = &[
    "namespace", "type", "struct", "enum", "interface", "typeParameter", "parameter", "variable", "property",
    "enumMember", "function", "method", "macro", "keyword", "comment", "string", "number", "operator", "decorator",
];

fn token_type(tag: HlTag) -> Option<u32> {
    let name = match tag {
        HlTag::Symbol(kind) => match kind {
            SymbolKind::Module | SymbolKind::CrateRoot | SymbolKind::ToolModule => "namespace",
            SymbolKind::Struct | SymbolKind::Union => "struct",
            SymbolKind::Enum => "enum",
            SymbolKind::Trait => "interface",
            SymbolKind::TypeAlias | SymbolKind::SelfType => "type",
            SymbolKind::TypeParam | SymbolKind::LifetimeParam | SymbolKind::ConstParam => "typeParameter",
            SymbolKind::ValueParam | SymbolKind::SelfParam => "parameter",
            SymbolKind::Local => "variable",
            SymbolKind::Field => "property",
            SymbolKind::Variant => "enumMember",
            SymbolKind::Function => "function",
            SymbolKind::Method => "method",
            SymbolKind::Macro | SymbolKind::ProcMacro | SymbolKind::Derive => "macro",
            SymbolKind::Const | SymbolKind::Static => "variable",
            SymbolKind::Attribute | SymbolKind::BuiltinAttr | SymbolKind::DeriveHelper => "decorator",
            _ => return None,
        },
        HlTag::BuiltinType => "type",
        HlTag::Keyword | HlTag::BoolLiteral => "keyword",
        HlTag::Comment => "comment",
        HlTag::StringLiteral | HlTag::CharLiteral | HlTag::ByteLiteral => "string",
        HlTag::NumericLiteral => "number",
        HlTag::Operator(_) => "operator",
        _ => return None,
    };
    TOKEN_TYPES.iter().position(|t| *t == name).map(|i| i as u32)
}

fn completion_kind(kind: &CompletionItemKind) -> u8 {
    // LSP CompletionItemKind numbers.
    match kind {
        CompletionItemKind::SymbolKind(s) => match s {
            SymbolKind::Function => 3,
            SymbolKind::Method => 2,
            SymbolKind::Field => 5,
            SymbolKind::Local | SymbolKind::ValueParam | SymbolKind::SelfParam => 6,
            SymbolKind::Struct | SymbolKind::Union => 22,
            SymbolKind::Enum => 13,
            SymbolKind::Variant => 20,
            SymbolKind::Trait => 8,
            SymbolKind::Module | SymbolKind::CrateRoot => 9,
            SymbolKind::Const | SymbolKind::ConstParam => 21,
            SymbolKind::Static => 6,
            SymbolKind::Macro | SymbolKind::ProcMacro | SymbolKind::Derive => 3,
            SymbolKind::TypeAlias | SymbolKind::TypeParam | SymbolKind::SelfType => 25,
            _ => 1,
        },
        CompletionItemKind::Binding => 6,
        CompletionItemKind::BuiltinType => 7,
        CompletionItemKind::InferredType => 7,
        CompletionItemKind::Keyword => 14,
        CompletionItemKind::Snippet => 15,
        CompletionItemKind::Expression => 15,
        CompletionItemKind::UnresolvedReference => 1,
    }
}

fn symbol_kind(kind: &StructureNodeKind) -> u8 {
    // LSP SymbolKind numbers.
    match kind {
        StructureNodeKind::SymbolKind(s) => match s {
            SymbolKind::Module | SymbolKind::CrateRoot => 2,
            SymbolKind::Struct | SymbolKind::Union => 23,
            SymbolKind::Enum => 10,
            SymbolKind::Variant => 22,
            SymbolKind::Trait => 11,
            SymbolKind::Function => 12,
            SymbolKind::Method => 6,
            SymbolKind::Field => 8,
            SymbolKind::Const => 14,
            SymbolKind::Static | SymbolKind::Local => 13,
            SymbolKind::Macro => 12,
            SymbolKind::TypeAlias | SymbolKind::TypeParam => 26,
            SymbolKind::Impl => 5,
            _ => 13,
        },
        StructureNodeKind::ExternBlock => 2,
        StructureNodeKind::Region => 2,
    }
}

fn wide(index: &LineIndex, offset: TextSize) -> WideLineCol {
    let offset = offset.min(index.len());
    let lc = index.line_col(offset);
    index.to_wide(WideEncoding::Utf16, lc).unwrap_or(WideLineCol { line: lc.line, col: lc.col })
}

fn lsp_position(index: &LineIndex, offset: TextSize) -> Value {
    let w = wide(index, offset);
    json!({ "line": w.line, "character": w.col })
}

fn lsp_range(index: &LineIndex, range: TextRange) -> Value {
    json!({ "start": lsp_position(index, range.start()), "end": lsp_position(index, range.end()) })
}

fn text_edit(index: &LineIndex, range: TextRange, text: &str) -> Value {
    json!({ "range": lsp_range(index, range), "newText": text })
}

/// The byte offset of an LSP position, clamped into the file.
fn offset(index: &LineIndex, position: &Value) -> TextSize {
    let line = position["line"].as_u64().unwrap_or(0) as u32;
    let col = position["character"].as_u64().unwrap_or(0) as u32;
    let lc = index.to_utf8(WideEncoding::Utf16, WideLineCol { line, col }).unwrap_or(LineCol { line, col });
    index.offset(lc).or_else(|| index.offset(LineCol { line, col: 0 })).unwrap_or(index.len()).min(index.len())
}

/// The workspace-relative path of a `file:///workspace/...` URI.
fn path_of(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix(ROOT_URI)?;
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// A path as a URI path: what is not unreserved is percent-encoded, `/` kept.
fn encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
