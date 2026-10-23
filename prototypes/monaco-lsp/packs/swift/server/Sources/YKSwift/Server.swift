// The queries the worker asks, answered as JSON text, and the WebAssembly
// exports it calls them through. JSON is written by hand: the module links
// no Foundation, which keeps it a few megabytes instead of tens.

import SwiftBasicFormat
import SwiftDiagnostics
import SwiftIDEUtils
import SwiftParser
import SwiftParserDiagnostics
import SwiftSyntax

func jstr(_ s: String) -> String {
  var o = "\""
  for u in s.unicodeScalars {
    switch u {
    case "\"": o += "\\\""
    case "\\": o += "\\\\"
    case "\n": o += "\\n"
    case "\r": o += "\\r"
    case "\t": o += "\\t"
    default:
      if u.value < 0x20 {
        let h = String(u.value, radix: 16)
        o += "\\u" + String(repeating: "0", count: 4 - h.count) + h
      } else {
        o.unicodeScalars.append(u)
      }
    }
  }
  return o + "\""
}

let keywords = [
  "associatedtype", "actor", "as", "async", "await", "break", "case", "catch", "class", "continue", "default", "defer",
  "deinit", "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate", "final", "for", "func", "guard",
  "if", "import", "in", "init", "inout", "internal", "is", "lazy", "let", "mutating", "nil", "open", "operator",
  "override", "private", "protocol", "public", "repeat", "rethrows", "return", "self", "Self", "some", "any", "static",
  "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while",
]

final class Server {
  let ws = Workspace()

  // MARK: diagnostics (syntax only)

  func diagnostics(_ f: SourceFile) -> String {
    let diags = ParseDiagnosticsGenerator.diagnostics(for: f.tree)
    var items: [String] = []
    for d in diags {
      var s = d.position.utf8Offset, e = s
      if let h = d.highlights.first {
        s = h.positionAfterSkippingLeadingTrivia.utf8Offset
        e = h.endPositionBeforeTrailingTrivia.utf8Offset
      }
      if e <= s {  // a missing token: mark the character before it
        e = s
        if s > 0 { s -= 1 }
      }
      let sev: Int
      switch d.diagMessage.severity {
      case .error: sev = 1
      case .warning: sev = 2
      case .note: sev = 3
      case .remark: sev = 4
      }
      let fixes = d.fixIts.map { fix -> String in
        let edits = fix.edits.map { "{\"s\":\($0.range.lowerBound.utf8Offset),\"e\":\($0.range.upperBound.utf8Offset),\"t\":\(jstr($0.replacement))}" }
        return "{\"title\":\(jstr(fix.message.message)),\"edits\":[\(edits.joined(separator: ","))]}"
      }
      items.append("{\"s\":\(s),\"e\":\(e),\"sev\":\(sev),\"msg\":\(jstr(d.message)),\"fix\":[\(fixes.joined(separator: ","))]}")
    }
    return "[" + items.joined(separator: ",") + "]"
  }

  // MARK: outline

  func symbols(_ f: SourceFile) -> String {
    func one(_ d: Decl) -> String {
      let kids = d.children.map(one).joined(separator: ",")
      let detail = d.kind == .extensionDecl ? "extension" : d.signature
      return "{\"name\":\(jstr(d.kind == .extensionDecl ? "extension " + d.name : d.name)),\"kind\":\(d.kind.lsp),\"detail\":\(jstr(detail)),\"s\":\(d.start),\"e\":\(d.end),\"ss\":\(d.nameStart),\"se\":\(d.nameEnd),\"children\":[\(kids)]}"
    }
    return "[" + f.outline.map(one).joined(separator: ",") + "]"
  }

  // MARK: completion

  func item(_ d: Decl, sort: String) -> String {
    var label = d.name
    if d.kind == .initializer, let i = d.node.as(InitializerDeclSyntax.self) {
      label = "init" + i.signature.parameterClause.trimmedDescription.collapsingWhitespace()
    }
    return "{\"label\":\(jstr(label)),\"kind\":\(d.kind.completion),\"detail\":\(jstr(d.signature)),\"doc\":\(jstr(d.doc)),\"sort\":\(jstr(sort + d.name))}"
  }

  func complete(_ f: SourceFile, _ offset: Int) -> String {
    var items: [String] = []
    var seen: Set<String> = []
    func push(_ d: Decl, _ sort: String) {
      let key = d.name + "|" + d.signature
      if seen.insert(key).inserted { items.append(item(d, sort: sort)) }
    }
    // Member access: the token before the cursor is `.`, or the word being
    // typed right after one.
    var memberBase: ExprSyntax?? = nil  // .some(nil): implicit `.member`
    if let t = ws.token(at: offset, in: f) ?? prevToken(f, offset) {
      var period: TokenSyntax? = nil
      if t.tokenKind == .period && t.endPositionBeforeTrailingTrivia.utf8Offset <= offset { period = t }
      else if ws.isWordToken(t), let p = t.previousToken(viewMode: .sourceAccurate), p.tokenKind == .period,
        p.endPositionBeforeTrailingTrivia.utf8Offset == t.positionAfterSkippingLeadingTrivia.utf8Offset {
        period = p
      }
      if let p = period {
        // `c.` at the end of a line leaves the period in the member access's
        // unexpected nodes (with a missing period and name after them).
        var parent = p.parent
        if parent?.is(UnexpectedNodesSyntax.self) == true { parent = parent?.parent }
        if let ma = parent?.as(MemberAccessExprSyntax.self) { memberBase = .some(ma.base) }
        else if let mt = parent?.as(MemberTypeSyntax.self) {
          memberBase = .some(ExprSyntax(DeclReferenceExprSyntax(baseName: .identifier(normalizeType(mt.baseType.trimmedDescription)))))
          if let bt = Optional(normalizeType(mt.baseType.trimmedDescription)) {
            for m in ws.members(of: bt) { push(m, "0") }
            return "{\"items\":[\(items.joined(separator: ","))]}"
          }
        } else { memberBase = .some(nil) }
      }
    }
    if let mb = memberBase {
      if let base = mb {
        if let bt = ws.typeOf(base, f) {
          for m in ws.members(of: bt.name) where !(m.kind == .initializer && !bt.isMeta) { push(m, "0") }
        } else {
          // Unknown base: every member in the workspace, ranked after nothing.
          for m in ws.allDecls where m.container != nil && m.kind != .extensionDecl { push(m, "1") }
        }
      } else {
        for m in ws.allDecls where m.kind == .enumCase { push(m, "0") }
      }
      return "{\"items\":[\(items.joined(separator: ","))]}"
    }
    // Plain names: what is in scope here, then every file's top level, then
    // keywords.
    let anchor = prevToken(f, offset) ?? f.tree.firstToken(viewMode: .sourceAccurate)
    if let a = anchor {
      for result in a.lookup(nil) {
        switch result {
        case .lookForMembers(let typeSyntax):
          if let t = ws.nameOfType(typeSyntax) { for m in ws.members(of: t) where m.kind != .initializer { push(m, "1") } }
        default:
          for n in result.names {
            if case .implicit = n { continue }
            if let d = ws.localDecl(n, f) { push(d, "0") }
          }
        }
      }
    }
    for d in ws.allDecls where d.container == nil && d.kind != .extensionDecl { push(d, "2") }
    for k in keywords {
      items.append("{\"label\":\(jstr(k)),\"kind\":14,\"detail\":\"keyword\",\"doc\":\"\",\"sort\":\(jstr("3" + k))}")
    }
    return "{\"items\":[\(items.joined(separator: ","))]}"
  }

  func prevToken(_ f: SourceFile, _ offset: Int) -> TokenSyntax? {
    var o = offset - 1
    while o >= 0 {
      if let t = f.tree.token(at: AbsolutePosition(utf8Offset: o)) {
        if t.positionAfterSkippingLeadingTrivia.utf8Offset <= o && t.presence == .present { return t }
        if let p = t.previousToken(viewMode: .sourceAccurate) { return p }
        return nil
      }
      o -= 1
    }
    return nil
  }

  // MARK: hover, definition, references

  func hover(_ f: SourceFile, _ offset: Int) -> String {
    guard let t = ws.token(at: offset, in: f) else { return "null" }
    let ds = ws.resolve(t, f)
    guard let d = ds.first else { return "null" }
    var md = "```swift\n" + d.signature + "\n```"
    if let c = d.container, d.kind != .extensionDecl { md = "```swift\n// in " + c + "\n" + d.signature + "\n```" }
    if ds.count > 1 { md += "\n\n(" + String(ds.count) + " declarations with this name)" }
    if !d.doc.isEmpty { md += "\n\n---\n\n" + d.doc }
    return "{\"s\":\(t.positionAfterSkippingLeadingTrivia.utf8Offset),\"e\":\(t.endPositionBeforeTrailingTrivia.utf8Offset),\"md\":\(jstr(md))}"
  }

  func loc(_ d: Decl) -> String { "{\"uri\":\(jstr(d.uri)),\"s\":\(d.nameStart),\"e\":\(d.nameEnd)}" }

  func definition(_ f: SourceFile, _ offset: Int) -> String {
    guard let t = ws.token(at: offset, in: f) else { return "[]" }
    return "[" + ws.resolve(t, f).map(loc).joined(separator: ",") + "]"
  }

  /// Every token that resolves to the same declaration as the one at
  /// `offset`, in every open file (`onlyFile` for document highlight).
  func referenceTokens(_ f: SourceFile, _ offset: Int, onlyFile: Bool) -> [(String, Int, Int)] {
    guard let t = ws.token(at: offset, in: f), let target = ws.resolve(t, f).first else { return [] }
    let name = target.name
    var out: [(String, Int, Int)] = []
    for uri in ws.order where !onlyFile || uri == f.uri {
      guard let file = ws.files[uri], !file.isSkipped else { continue }
      for tok in file.tree.tokens(viewMode: .sourceAccurate) where tok.text == name {
        let ds = ws.resolve(tok, file)
        if ds.contains(where: { $0.uri == target.uri && $0.nameStart == target.nameStart }) {
          out.append((uri, tok.positionAfterSkippingLeadingTrivia.utf8Offset, tok.endPositionBeforeTrailingTrivia.utf8Offset))
        }
      }
    }
    return out
  }

  func references(_ f: SourceFile, _ offset: Int, onlyFile: Bool) -> String {
    "[" + referenceTokens(f, offset, onlyFile: onlyFile).map { "{\"uri\":\(jstr($0.0)),\"s\":\($0.1),\"e\":\($0.2)}" }.joined(separator: ",") + "]"
  }

  // MARK: signature help

  func signatureHelp(_ f: SourceFile, _ offset: Int) -> String {
    guard let t = prevToken(f, offset) else { return "null" }
    var n: Syntax? = Syntax(t)
    while let cur = n {
      if let call = cur.as(FunctionCallExprSyntax.self), let l = call.leftParen,
        l.endPositionBeforeTrailingTrivia.utf8Offset <= offset,
        call.rightParen.map({ $0.presence == .missing || offset <= $0.positionAfterSkippingLeadingTrivia.utf8Offset }) ?? true {
        var decls: [Decl] = []
        let callee = call.calledExpression
        if let tok = callee.lastToken(viewMode: .sourceAccurate) {
          let ds = ws.resolve(tok, f)
          for d in ds {
            if d.kind.isType { decls += ws.members(of: d.name).filter { $0.kind == .initializer } }
            else if d.kind == .function || d.kind == .method || d.kind == .initializer || d.kind == .enumCase { decls.append(d) }
          }
        }
        if decls.isEmpty { return "null" }
        var active = 0
        for arg in call.arguments where arg.trailingComma.map({ $0.endPositionBeforeTrailingTrivia.utf8Offset <= offset }) ?? false {
          active += 1
        }
        let sigs = decls.map { d -> String in
          var params: [String] = []
          if let fd = d.node.as(FunctionDeclSyntax.self) { params = fd.signature.parameterClause.parameters.map { $0.trimmedDescription.trimmingTrailingComma() } }
          if let fd = d.node.as(InitializerDeclSyntax.self) { params = fd.signature.parameterClause.parameters.map { $0.trimmedDescription.trimmingTrailingComma() } }
          if let el = d.node.as(EnumCaseElementSyntax.self), let pc = el.parameterClause { params = pc.parameters.map { $0.trimmedDescription.trimmingTrailingComma() } }
          let label = d.signature
          let ps = params.map { "{\"label\":\(jstr($0.collapsingWhitespace()))}" }.joined(separator: ",")
          return "{\"label\":\(jstr(label)),\"doc\":\(jstr(d.doc)),\"params\":[\(ps)]}"
        }
        return "{\"signatures\":[\(sigs.joined(separator: ","))],\"active\":\(active)}"
      }
      if cur.is(CodeBlockItemSyntax.self) || cur.is(MemberBlockItemSyntax.self) { break }
      n = cur.parent
    }
    return "null"
  }

  // MARK: formatting, tokens, code actions

  /// BasicFormat over the file with its line indentation removed first.
  /// BasicFormat indents a line that has none and adds its indentation to
  /// whatever a line already has, so running it on hand-indented code left
  /// lines misaligned (a review found `func f` at 10 spaces, its body at 8).
  /// With every line's leading spaces and tabs stripped, all indentation is
  /// BasicFormat's and consistent. `options` is `s<n>` (n spaces) or `t`.
  func format(_ f: SourceFile, _ options: String) -> String {
    let unit: Trivia
    if options == "t" { unit = .tabs(1) }
    else { unit = .spaces(max(1, min(16, Int(options.dropFirst()) ?? 4))) }
    let flat = IndentStripper(viewMode: .sourceAccurate).rewrite(f.tree)
    let out = flat.formatted(using: BasicFormat(indentationWidth: unit)).description
    return "{\"text\":\(jstr(out))}"
  }

  /// Semantic tokens as [start, length, type] triples (legend in server.js).
  func tokens(_ f: SourceFile) -> String {
    var nums: [String] = []
    let declKinds = Dictionary(f.decls.map { ($0.nameStart, $0.kind) }, uniquingKeysWith: { a, _ in a })
    for c in f.tree.classifications {
      let type: Int
      switch c.kind {
      case .keyword: type = 0
      case .type: type = 1
      case .stringLiteral: type = 2
      case .integerLiteral, .floatLiteral: type = 3
      case .lineComment, .blockComment, .docLineComment, .docBlockComment: type = 4
      case .operator: type = 6
      case .ifConfigDirective: type = 7
      case .attribute: type = 8
      case .regexLiteral: type = 9
      case .identifier:
        guard let k = declKinds[c.offset] else { continue }
        switch k {
        case .function, .method, .initializer, .subscriptDecl: type = 10
        case .property: type = 11
        case .enumCase: type = 12
        case .parameter: type = 13
        case .variable, .constant: type = 5
        default: type = 1
        }
      default: continue
      }
      nums.append("\(c.offset),\(c.length),\(type)")
    }
    return "[" + nums.joined(separator: ",") + "]"
  }

  /// The one diagnostic of a file the server skips: a warning on its first
  /// line saying why (`SourceFile.skipReason`).
  func skippedDiagnostic(_ f: SourceFile) -> String {
    var e = 0
    while e < f.bytes.count && f.bytes[e] != 10 && f.bytes[e] != 13 { e += 1 }
    let msg = f.skipReason ?? ""
    return "[{\"s\":0,\"e\":\(e),\"sev\":2,\"msg\":\(jstr(msg)),\"fix\":[]}]"
  }

  /// Whether `name` is one Swift identifier, as the parser reads it:
  /// Unicode letters, and backticked keywords such as `` `default` ``.
  func isIdentifier(_ name: String) -> Bool {
    if name.isEmpty || name.contains(where: { $0.isNewline }) { return false }
    let tree = Parser.parse(source: "let " + name + " = 0")
    guard !tree.hasError, tree.statements.count == 1,
      let v = tree.statements.first?.item.as(VariableDeclSyntax.self), v.bindings.count == 1,
      let id = v.bindings.first?.pattern.as(IdentifierPatternSyntax.self)
    else { return false }
    guard case .identifier = id.identifier.tokenKind else { return false }
    return id.identifier.text == name
  }

  // MARK: dispatch

  /// One request: `cmd\nuri\noffset\n` then a payload (the text for `set`).
  func call(_ input: String) -> String {
    var parts = input.split(separator: "\n", maxSplits: 3, omittingEmptySubsequences: false)
    while parts.count < 4 { parts.append("") }
    let cmd = String(parts[0]), uri = String(parts[1]), offset = Int(parts[2]) ?? 0, payload = String(parts[3])
    if cmd == "set" {
      let f = ws.set(uri, payload)
      return f.isSkipped ? skippedDiagnostic(f) : diagnostics(f)
    }
    if cmd == "remove" { ws.remove(uri); return "null" }
    if cmd == "isname" { return isIdentifier(payload) ? "true" : "false" }
    guard let f = ws.files[uri] else { return "null" }
    if f.isSkipped {  // answer nothing rather than walk it (see SourceFile.skipReason)
      switch cmd {
      case "complete": return "{\"items\":[]}"
      case "symbols", "definition", "references", "highlight", "tokens", "diagnostics": return "[]"
      case "format": return "{\"text\":\(jstr(f.text))}"
      default: return "null"
      }
    }
    switch cmd {
    case "diagnostics": return diagnostics(f)
    case "symbols": return symbols(f)
    case "complete": return complete(f, offset)
    case "hover": return hover(f, offset)
    case "definition": return definition(f, offset)
    case "references": return references(f, offset, onlyFile: false)
    case "highlight": return references(f, offset, onlyFile: true)
    case "signature": return signatureHelp(f, offset)
    case "format": return format(f, payload)
    case "tokens": return tokens(f)
    case "debug":  // the syntax around an offset, for diagnosing the server
      guard let t = ws.token(at: offset, in: f) ?? prevToken(f, offset) else { return "null" }
      var chain: [String] = ["\(t.tokenKind)"]
      var n = t.parent
      while let c = n, chain.count < 8 { chain.append("\(c.kind)"); n = c.parent }
      return "[" + chain.map(jstr).joined(separator: ",") + "]"
    default: return "null"
    }
  }
}

/// Drops the spaces and tabs that start each line (the leading trivia right
/// after a newline, and at the start of the file). Text inside string
/// literals and block comments is not trivia and is left alone.
final class IndentStripper: SyntaxRewriter {
  private var atFileStart = true

  override func visit(_ token: TokenSyntax) -> TokenSyntax {
    var pieces: [TriviaPiece] = []
    var lineStart = atFileStart
    atFileStart = false
    for piece in token.leadingTrivia {
      switch piece {
      case .newlines, .carriageReturns, .carriageReturnLineFeeds:
        lineStart = true
        pieces.append(piece)
      case .spaces, .tabs:
        if !lineStart { pieces.append(piece) }
      default:
        lineStart = false
        pieces.append(piece)
      }
    }
    return token.with(\.leadingTrivia, Trivia(pieces: pieces))
  }
}

// MARK: - WebAssembly exports

nonisolated(unsafe) let server = Server()
nonisolated(unsafe) var output = UnsafeMutableRawBufferPointer.allocate(byteCount: 1, alignment: 1)

@_expose(wasm, "yk_alloc")
@_cdecl("yk_alloc")
public func yk_alloc(_ n: Int32) -> UnsafeMutableRawPointer {
  UnsafeMutableRawPointer.allocate(byteCount: Int(max(n, 1)), alignment: 1)
}

@_expose(wasm, "yk_free")
@_cdecl("yk_free")
public func yk_free(_ p: UnsafeMutableRawPointer) { p.deallocate() }

/// Runs one request read from `len` bytes at `p` (which it frees) and
/// returns the length of the answer, read through `yk_output`.
@_expose(wasm, "yk_call")
@_cdecl("yk_call")
public func yk_call(_ p: UnsafeMutableRawPointer, _ len: Int32) -> Int32 {
  let input = String(decoding: UnsafeRawBufferPointer(start: p, count: Int(len)), as: UTF8.self)
  p.deallocate()
  let bytes = Array(server.call(input).utf8)
  output.deallocate()
  output = UnsafeMutableRawBufferPointer.allocate(byteCount: max(bytes.count, 1), alignment: 1)
  output.copyBytes(from: bytes)
  return Int32(bytes.count)
}

@_expose(wasm, "yk_output")
@_cdecl("yk_output")
public func yk_output() -> UnsafeRawPointer {
  UnsafeRawPointer(output.baseAddress!)
}
