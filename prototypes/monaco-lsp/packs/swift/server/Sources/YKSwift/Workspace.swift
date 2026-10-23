// The analysis half of the swift pack. Everything here is swift-syntax:
// the parser and its diagnostics, the classifier, SwiftLexicalLookup for
// unqualified names, BasicFormat. There is no type checker, no module
// loading and no standard library: a name resolves to a declaration in the
// open files or not at all. Positions are UTF-8 byte offsets into the file's
// text; the worker converts them to and from LSP's UTF-16 positions.

import SwiftBasicFormat
import SwiftDiagnostics
import SwiftIDEUtils
import SwiftLexicalLookup
import SwiftParser
import SwiftParserDiagnostics
import SwiftSyntax

// MARK: - Symbols

enum SymKind {
  case structType, classType, enumType, protocolType, actorType, extensionDecl
  case function, method, initializer, property, variable, constant, enumCase
  case typeAlias, associatedType, subscriptDecl, parameter

  /// LSP SymbolKind.
  var lsp: Int {
    switch self {
    case .structType: return 23
    case .classType, .actorType: return 5
    case .enumType: return 10
    case .protocolType: return 11
    case .extensionDecl: return 3
    case .function: return 12
    case .method, .subscriptDecl: return 6
    case .initializer: return 9
    case .property: return 7
    case .variable, .parameter: return 13
    case .constant: return 14
    case .enumCase: return 22
    case .typeAlias, .associatedType: return 26
    }
  }

  /// LSP CompletionItemKind.
  var completion: Int {
    switch self {
    case .structType: return 22
    case .classType, .actorType: return 7
    case .enumType: return 13
    case .protocolType: return 8
    case .extensionDecl: return 9
    case .function: return 3
    case .method, .subscriptDecl: return 2
    case .initializer: return 4
    case .property: return 10
    case .variable, .parameter: return 6
    case .constant: return 21
    case .enumCase: return 20
    case .typeAlias, .associatedType: return 25
    }
  }

  var isType: Bool {
    switch self {
    case .structType, .classType, .enumType, .protocolType, .actorType, .typeAlias, .associatedType: return true
    default: return false
    }
  }
}

/// One declaration: an indexed member or top-level declaration, or a local
/// (parameter, local variable) built on the fly by a lookup.
final class Decl {
  let name: String
  let kind: SymKind
  let uri: String
  /// Whole declaration, and its name token.
  let start: Int, end: Int, nameStart: Int, nameEnd: Int
  /// Name of the enclosing type or extended type, nil at top level.
  let container: String?
  let signature: String
  let doc: String
  /// The syntax node the declaration's type is read from.
  let node: Syntax
  var children: [Decl] = []
  var inherited: [String] = []

  init(name: String, kind: SymKind, uri: String, node: Syntax, nameToken: TokenSyntax?, container: String?, signature: String, doc: String) {
    self.name = name
    self.kind = kind
    self.uri = uri
    self.node = node
    self.start = node.positionAfterSkippingLeadingTrivia.utf8Offset
    self.end = node.endPositionBeforeTrailingTrivia.utf8Offset
    if let t = nameToken {
      nameStart = t.positionAfterSkippingLeadingTrivia.utf8Offset
      nameEnd = t.endPositionBeforeTrailingTrivia.utf8Offset
    } else {
      nameStart = start
      nameEnd = start
    }
    self.container = container
    self.signature = signature
    self.doc = doc
  }
}

/// What an expression evaluates to, as far as a syntax-only resolver can
/// tell: an instance of a named type, or the type itself (`Point.`).
struct TypeRef {
  var name: String
  var isMeta: Bool
}

final class SourceFile {
  let uri: String
  let text: String
  let bytes: [UInt8]
  let tree: SourceFileSyntax
  var decls: [Decl] = []  // flat: every indexed declaration
  var outline: [Decl] = []  // nested, for documentSymbol

  /// Why this file is not analysed, or nil when it is. A file with a reason
  /// is not indexed and every query on it answers nothing; its only
  /// diagnostic is the reason. Both reasons are about the browser, not about
  /// the code being wrong: see `maximumDepth` and `maximumSquareNesting`.
  let skipReason: String?
  var isSkipped: Bool { skipReason != nil }

  /// Brackets (`(`, `[`, `{`) nested deeper than this end the parse with the
  /// parser's own "too deeply nested" diagnostic. swift-syntax's default,
  /// 256, is more than the browser's native stack can take once the
  /// recursive visitors (diagnostics, classifier, formatter) walk the tree.
  static let maximumNestingLevel = 128

  /// The deepest syntax tree any query is run on. Not every deep tree comes
  /// from brackets: an `else if` chain or a long `a.b().c()...` member chain
  /// nests one or more nodes per link and the parser does not count them.
  /// swift-syntax's visitors recurse once per level, on the wasm shadow
  /// stack (8 MB, see Package.swift) and on the browser's native stack
  /// (about 1 MB for a worker), and running out of either kills the
  /// instance. A file deeper than this is skipped instead of trapping.
  /// Calibrated in Chromium 141 (README, "Limits"): the native stack runs
  /// out first ("Maximum call stack size exceeded"); a 1,000-branch
  /// `else if` chain, under 1,200 deep, already overflowed in one query,
  /// 600 branches did not. 700 leaves room for slower, smaller stacks.
  static let maximumDepth = 700

  /// swift-syntax 604's parser takes time exponential in the nesting of `[`
  /// directly followed by `[` or `(` (it looks ahead for a type at each
  /// one): `let t: [[[...Int]]]` 16 deep parses in 0.1 s, 18 in 0.4 s, 20 in
  /// 1.4 s, 30 would take about half an hour, and the worker would hang
  /// that long. So a file whose `[`s nest deeper than this is not parsed.
  static let maximumSquareNesting = 12

  init(uri: String, text: String) {
    self.uri = uri
    self.text = text
    self.bytes = Array(text.utf8)
    let square = squareNesting(bytes)
    if square > SourceFile.maximumSquareNesting {
      self.tree = Parser.parse(source: "")
      self.skipReason = "swift-syntax-ls does not analyse this file: its `[` brackets nest \(square) deep, and swift-syntax's parser takes time exponential in that depth (more than \(SourceFile.maximumSquareNesting) could stall the server for seconds to hours). No diagnostics, completion or navigation for this file until they nest less deeply."
      return
    }
    // (The String overload of parse takes no nesting level; the buffer is
    // copied into the tree's arena.)
    self.tree = bytes.withUnsafeBufferPointer {
      Parser.parse(source: $0, maximumNestingLevel: SourceFile.maximumNestingLevel)
    }
    // Iterative on purpose: this is what decides whether recursion is safe.
    var deepest = 0
    var stack: [(Syntax, Int)] = [(Syntax(tree), 1)]
    walk: while let (node, d) = stack.popLast() {
      if d > deepest {
        deepest = d
        if deepest > SourceFile.maximumDepth { break walk }
      }
      for child in node.children(viewMode: .all) { stack.append((child, d + 1)) }
    }
    if deepest > SourceFile.maximumDepth {
      self.skipReason = "swift-syntax-ls does not analyse this file: its syntax tree is nested more than \(SourceFile.maximumDepth) levels deep (a very long `else if` chain or member chain, or deeply nested blocks), which would overflow the server's stack in the browser. No diagnostics, completion or navigation for this file until it is shallower."
    } else {
      self.skipReason = nil
    }
  }

  func slice(_ s: Int, _ e: Int) -> String {
    let a = max(0, min(s, bytes.count)), b = max(a, min(e, bytes.count))
    return String(decoding: bytes[a..<b], as: UTF8.self)
  }
}

/// How deep `[` brackets nest in Swift source, outside comments and string
/// literals: a linear pre-scan, run before the parser (see
/// `SourceFile.maximumSquareNesting`). It only needs to be right for code
/// that nests `[` deeply; an unterminated literal just ends the scan.
func squareNesting(_ b: [UInt8]) -> Int {
  let n = b.count
  var i = 0, depth = 0, deepest = 0
  func at(_ j: Int) -> UInt8 { j < n ? b[j] : 0 }
  while i < n {
    let c = b[i]
    if c == UInt8(ascii: "/") && at(i + 1) == UInt8(ascii: "/") {
      while i < n && b[i] != 10 { i += 1 }
    } else if c == UInt8(ascii: "/") && at(i + 1) == UInt8(ascii: "*") {
      var level = 1
      i += 2
      while i < n && level > 0 {
        if b[i] == UInt8(ascii: "/") && at(i + 1) == UInt8(ascii: "*") { level += 1; i += 2 }
        else if b[i] == UInt8(ascii: "*") && at(i + 1) == UInt8(ascii: "/") { level -= 1; i += 2 }
        else { i += 1 }
      }
    } else if c == UInt8(ascii: "#") || c == UInt8(ascii: "\"") {
      // A string literal: `#`* then `"` or `"""`, closed by the same quotes
      // followed by as many `#`. Backslash escapes only count without `#`.
      var hashes = 0
      while at(i + hashes) == UInt8(ascii: "#") { hashes += 1 }
      if at(i + hashes) != UInt8(ascii: "\"") { i += max(hashes, 1); continue }
      i += hashes
      let quotes = (at(i + 1) == UInt8(ascii: "\"") && at(i + 2) == UInt8(ascii: "\"")) ? 3 : 1
      i += quotes
      scan: while i < n {
        if b[i] == UInt8(ascii: "\\") && hashes == 0 { i += 2; continue }
        if quotes == 1 && b[i] == 10 { break scan }
        if b[i] == UInt8(ascii: "\"") {
          var q = 0
          while q < quotes && at(i + q) == UInt8(ascii: "\"") { q += 1 }
          var h = 0
          while h < hashes && at(i + q + h) == UInt8(ascii: "#") { h += 1 }
          if q == quotes && h == hashes { i += q + h; break scan }
        }
        i += 1
      }
    } else {
      if c == UInt8(ascii: "[") { depth += 1; deepest = max(deepest, depth) }
      else if c == UInt8(ascii: "]") { depth = max(0, depth - 1) }
      i += 1
    }
  }
  return deepest
}

// MARK: - Indexing

private func docComment(_ node: some SyntaxProtocol) -> String {
  var lines: [String] = []
  for piece in node.leadingTrivia {
    switch piece {
    case .docLineComment(let s):
      var l = Substring(s).dropFirst(3)
      if l.hasPrefix(" ") { l = l.dropFirst() }
      lines.append(String(l))
    case .docBlockComment(let s):
      var body = Substring(s).dropFirst(3)
      if body.hasSuffix("*/") { body = body.dropLast(2) }
      lines.append(contentsOf: body.split(separator: "\n", omittingEmptySubsequences: false).map {
        var l = $0.drop(while: { $0 == " " || $0 == "\t" })
        if l.hasPrefix("*") { l = l.dropFirst(); if l.hasPrefix(" ") { l = l.dropFirst() } }
        return String(l)
      })
    case .newlines, .spaces, .tabs, .carriageReturns, .carriageReturnLineFeeds: break
    default: lines.removeAll()  // a plain comment between doc and decl breaks the doc
    }
  }
  return lines.joined(separator: "\n").trimmingSpaces()
}

extension String {
  func trimmingSpaces() -> String {
    let isSpace: (Character) -> Bool = { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" }
    return String(self.drop(while: isSpace).reversed().drop(while: isSpace).reversed())
  }
  /// One line, single spaces: signatures are shown in hovers and details.
  func collapsingWhitespace() -> String {
    var out = ""
    var space = false
    for c in self {
      if c == " " || c == "\n" || c == "\t" || c == "\r" { space = true; continue }
      if space && !out.isEmpty { out.append(" ") }
      space = false
      out.append(c)
    }
    return out
  }
}

/// Type name as the member index keys it: `Foo<Int>?` is `Foo`, `[Foo]`
/// stays an array so `for x in xs` can take its element.
func normalizeType(_ raw: String) -> String {
  var t = raw.collapsingWhitespace()
  while t.hasSuffix("?") || t.hasSuffix("!") { t.removeLast() }
  if t.hasPrefix("Optional<") && t.hasSuffix(">") { t = String(t.dropFirst(9).dropLast()) }
  if t.hasPrefix("some ") { t = String(t.dropFirst(5)) }
  if t.hasPrefix("any ") { t = String(t.dropFirst(4)) }
  if t.hasPrefix("[") && t.hasSuffix("]") && !t.contains(":") {
    return "[" + normalizeType(String(t.dropFirst().dropLast())) + "]"
  }
  if let lt = t.firstIndex(of: "<") { t = String(t[..<lt]) }
  if let dot = t.lastIndex(of: ".") { t = String(t[t.index(after: dot)...]) }
  return t
}

final class Indexer {
  let file: SourceFile
  init(_ file: SourceFile) { self.file = file }

  /// Text of a declaration up to its body or member block: its signature.
  func header(_ node: some SyntaxProtocol, upTo stop: (some SyntaxProtocol)?) -> String {
    let s = node.positionAfterSkippingLeadingTrivia.utf8Offset
    let e = stop.map { $0.positionAfterSkippingLeadingTrivia.utf8Offset } ?? node.endPositionBeforeTrailingTrivia.utf8Offset
    return file.slice(s, e).collapsingWhitespace()
  }

  func run() {
    file.outline = items(file.tree.statements.map { Syntax($0) }, container: nil, inType: false)
  }

  private func items(_ items: [Syntax], container: String?, inType: Bool) -> [Decl] {
    var out: [Decl] = []
    for item in items {
      for child in item.children(viewMode: .sourceAccurate) {
        if let d = child.as(DeclSyntax.self) { out.append(contentsOf: decl(d, container: container, inType: inType)) }
      }
    }
    return out
  }

  private func members(_ block: MemberBlockSyntax, container: String) -> [Decl] {
    items(block.members.map { Syntax($0) }, container: container, inType: true)
  }

  private func add(_ d: Decl) -> Decl {
    file.decls.append(d)
    return d
  }

  private func inheritedNames(_ clause: InheritanceClauseSyntax?) -> [String] {
    clause?.inheritedTypes.map { normalizeType($0.type.trimmedDescription) } ?? []
  }

  private func decl(_ d: DeclSyntax, container: String?, inType: Bool) -> [Decl] {
    let uri = file.uri
    func type(_ kind: SymKind, _ name: TokenSyntax, _ block: MemberBlockSyntax, _ inh: InheritanceClauseSyntax?) -> [Decl] {
      let n = name.text
      let x = add(Decl(name: n, kind: kind, uri: uri, node: Syntax(d), nameToken: name, container: container,
                       signature: header(d, upTo: block), doc: docComment(d)))
      x.inherited = inheritedNames(inh)
      x.children = members(block, container: n)
      return [x]
    }
    if let s = d.as(StructDeclSyntax.self) { return type(.structType, s.name, s.memberBlock, s.inheritanceClause) }
    if let s = d.as(ClassDeclSyntax.self) { return type(.classType, s.name, s.memberBlock, s.inheritanceClause) }
    if let s = d.as(EnumDeclSyntax.self) { return type(.enumType, s.name, s.memberBlock, s.inheritanceClause) }
    if let s = d.as(ProtocolDeclSyntax.self) { return type(.protocolType, s.name, s.memberBlock, s.inheritanceClause) }
    if let s = d.as(ActorDeclSyntax.self) { return type(.actorType, s.name, s.memberBlock, s.inheritanceClause) }
    if let s = d.as(ExtensionDeclSyntax.self) {
      let n = normalizeType(s.extendedType.trimmedDescription)
      let x = Decl(name: n, kind: .extensionDecl, uri: uri, node: Syntax(d), nameToken: s.extendedType.lastToken(viewMode: .sourceAccurate),
                   container: nil, signature: header(d, upTo: s.memberBlock), doc: docComment(d))
      x.inherited = inheritedNames(s.inheritanceClause)
      file.decls.append(x)
      x.children = members(s.memberBlock, container: n)
      return [x]
    }
    if let f = d.as(FunctionDeclSyntax.self) {
      return [add(Decl(name: f.name.text, kind: inType ? .method : .function, uri: uri, node: Syntax(d), nameToken: f.name,
                       container: container, signature: header(d, upTo: f.body), doc: docComment(d)))]
    }
    if let f = d.as(InitializerDeclSyntax.self) {
      return [add(Decl(name: "init", kind: .initializer, uri: uri, node: Syntax(d), nameToken: f.initKeyword,
                       container: container, signature: header(d, upTo: f.body), doc: docComment(d)))]
    }
    if let f = d.as(SubscriptDeclSyntax.self) {
      return [add(Decl(name: "subscript", kind: .subscriptDecl, uri: uri, node: Syntax(d), nameToken: f.subscriptKeyword,
                       container: container, signature: header(d, upTo: f.accessorBlock), doc: docComment(d)))]
    }
    if let v = d.as(VariableDeclSyntax.self) {
      let isLet = v.bindingSpecifier.tokenKind == .keyword(.let)
      var out: [Decl] = []
      for b in v.bindings {
        for tok in b.pattern.tokens(viewMode: .sourceAccurate) {
          guard case .identifier = tok.tokenKind else { continue }
          let kind: SymKind = inType ? .property : (isLet ? .constant : .variable)
          var sig = v.bindingSpecifier.text + " " + b.pattern.trimmedDescription
          if let t = b.typeAnnotation { sig += t.trimmedDescription }
          if let i = b.initializer, i.value.trimmedDescription.count <= 60 { sig += " " + i.trimmedDescription }
          if !v.modifiers.isEmpty { sig = v.modifiers.trimmedDescription + " " + sig }
          out.append(add(Decl(name: tok.text, kind: kind, uri: uri, node: Syntax(b), nameToken: tok, container: container,
                              signature: sig.collapsingWhitespace(), doc: docComment(v))))
        }
      }
      return out
    }
    if let c = d.as(EnumCaseDeclSyntax.self) {
      return c.elements.map { el in
        add(Decl(name: el.name.text, kind: .enumCase, uri: uri, node: Syntax(el), nameToken: el.name, container: container,
                 signature: "case " + el.trimmedDescription, doc: docComment(c)))
      }
    }
    if let t = d.as(TypeAliasDeclSyntax.self) {
      return [add(Decl(name: t.name.text, kind: .typeAlias, uri: uri, node: Syntax(d), nameToken: t.name, container: container,
                       signature: t.trimmedDescription.collapsingWhitespace(), doc: docComment(d)))]
    }
    if let t = d.as(AssociatedTypeDeclSyntax.self) {
      return [add(Decl(name: t.name.text, kind: .associatedType, uri: uri, node: Syntax(d), nameToken: t.name, container: container,
                       signature: t.trimmedDescription.collapsingWhitespace(), doc: docComment(d)))]
    }
    if let c = d.as(IfConfigDeclSyntax.self) {
      var out: [Decl] = []
      for clause in c.clauses {
        guard let el = clause.elements else { continue }
        if let st = el.as(CodeBlockItemListSyntax.self) { out += items(st.map { Syntax($0) }, container: container, inType: inType) }
        if let ms = el.as(MemberBlockItemListSyntax.self) { out += items(ms.map { Syntax($0) }, container: container, inType: inType) }
      }
      return out
    }
    return []
  }
}

// MARK: - Workspace

final class Workspace {
  var files: [String: SourceFile] = [:]
  var order: [String] = []

  func set(_ uri: String, _ text: String) -> SourceFile {
    let f = SourceFile(uri: uri, text: text)
    if !f.isSkipped { Indexer(f).run() }
    if files[uri] == nil { order.append(uri) }
    files[uri] = f
    return f
  }

  func remove(_ uri: String) {
    files[uri] = nil
    order.removeAll { $0 == uri }
  }

  var allDecls: [Decl] { order.flatMap { files[$0]?.decls ?? [] } }

  // MARK: Types and members

  func typeDecls(named name: String) -> [Decl] {
    allDecls.filter { $0.name == name && ($0.kind.isType || $0.kind == .extensionDecl) }
  }

  /// Members of a type and of what it inherits (superclass, protocols, via
  /// the inheritance clauses of the type and its extensions), nearest first.
  func members(of type: String) -> [Decl] {
    var seen: Set<String> = []
    var out: [Decl] = []
    var queue = [type]
    while let t = queue.first {
      queue.removeFirst()
      if seen.contains(t) { continue }
      seen.insert(t)
      let all = allDecls
      out += all.filter { $0.container == t && $0.kind != .extensionDecl }
      for d in all where d.name == t && (d.kind.isType || d.kind == .extensionDecl) {
        queue += d.inherited
        if d.kind == .typeAlias, let a = d.node.as(TypeAliasDeclSyntax.self) {
          queue.append(normalizeType(a.initializer.value.trimmedDescription))
        }
      }
    }
    return out
  }

  func enclosingTypeName(_ node: Syntax) -> String? {
    var n: Syntax? = node.parent
    while let cur = n {
      if let s = cur.as(StructDeclSyntax.self) { return s.name.text }
      if let s = cur.as(ClassDeclSyntax.self) { return s.name.text }
      if let s = cur.as(EnumDeclSyntax.self) { return s.name.text }
      if let s = cur.as(ActorDeclSyntax.self) { return s.name.text }
      if let s = cur.as(ProtocolDeclSyntax.self) { return s.name.text }
      if let s = cur.as(ExtensionDeclSyntax.self) { return normalizeType(s.extendedType.trimmedDescription) }
      n = cur.parent
    }
    return nil
  }

  // MARK: Expression types

  /// The type an expression evaluates to, or nil when the answer needs a
  /// type checker (operators, overloads, generics, the standard library).
  func typeOf(_ expr: ExprSyntax, _ file: SourceFile, depth: Int = 0) -> TypeRef? {
    if depth > 12 { return nil }
    if expr.is(StringLiteralExprSyntax.self) { return TypeRef(name: "String", isMeta: false) }
    if expr.is(IntegerLiteralExprSyntax.self) { return TypeRef(name: "Int", isMeta: false) }
    if expr.is(FloatLiteralExprSyntax.self) { return TypeRef(name: "Double", isMeta: false) }
    if expr.is(BooleanLiteralExprSyntax.self) { return TypeRef(name: "Bool", isMeta: false) }
    if let e = expr.as(TupleExprSyntax.self), e.elements.count == 1, let only = e.elements.first {
      return typeOf(only.expression, file, depth: depth + 1)
    }
    if let e = expr.as(ForceUnwrapExprSyntax.self) { return typeOf(e.expression, file, depth: depth + 1) }
    if let e = expr.as(OptionalChainingExprSyntax.self) { return typeOf(e.expression, file, depth: depth + 1) }
    if let e = expr.as(AwaitExprSyntax.self) { return typeOf(e.expression, file, depth: depth + 1) }
    if let e = expr.as(TryExprSyntax.self) { return typeOf(e.expression, file, depth: depth + 1) }
    if let e = expr.as(AsExprSyntax.self) { return TypeRef(name: normalizeType(e.type.trimmedDescription), isMeta: false) }
    if let e = expr.as(SubscriptCallExprSyntax.self), let base = typeOf(e.calledExpression, file, depth: depth + 1),
      base.name.hasPrefix("[") {
      return TypeRef(name: String(base.name.dropFirst().dropLast()), isMeta: false)
    }
    if let e = expr.as(ArrayExprSyntax.self), let first = e.elements.first,
      let t = typeOf(first.expression, file, depth: depth + 1), !t.isMeta {
      return TypeRef(name: "[" + t.name + "]", isMeta: false)
    }
    if let e = expr.as(DeclReferenceExprSyntax.self) {
      let tok = e.baseName
      if tok.tokenKind == .keyword(.self) { return enclosingTypeName(Syntax(e)).map { TypeRef(name: $0, isMeta: false) } }
      if tok.tokenKind == .keyword(.Self) { return enclosingTypeName(Syntax(e)).map { TypeRef(name: $0, isMeta: true) } }
      guard let d = resolve(tok, file, depth: depth + 1).first else { return nil }
      return typeOf(decl: d, depth: depth + 1)
    }
    if let e = expr.as(MemberAccessExprSyntax.self) {
      guard let base = e.base else { return nil }
      guard let bt = typeOf(base, file, depth: depth + 1) else { return nil }
      guard let m = members(of: bt.name).first(where: { $0.name == e.declName.baseName.text }) else { return nil }
      if m.kind == .enumCase { return TypeRef(name: m.container ?? bt.name, isMeta: false) }
      return typeOf(decl: m, depth: depth + 1)
    }
    if let e = expr.as(FunctionCallExprSyntax.self) {
      let callee = e.calledExpression
      if let t = typeOf(callee, file, depth: depth + 1) {
        if t.isMeta { return TypeRef(name: t.name, isMeta: false) }  // Point(...) is a Point
        return t  // a function's type is its return type here
      }
      return nil
    }
    return nil
  }

  /// The type a declaration gives its name: a variable's annotation or
  /// initializer, a function's return type, a type itself.
  func typeOf(decl d: Decl, depth: Int = 0) -> TypeRef? {
    if depth > 12 { return nil }
    if d.kind.isType {
      if d.kind == .typeAlias, let a = d.node.as(TypeAliasDeclSyntax.self) {
        return TypeRef(name: normalizeType(a.initializer.value.trimmedDescription), isMeta: true)
      }
      return TypeRef(name: d.name, isMeta: true)
    }
    guard let file = files[d.uri] else { return nil }
    let n = d.node
    if let b = n.as(PatternBindingSyntax.self) {
      if let t = b.typeAnnotation { return TypeRef(name: normalizeType(t.type.trimmedDescription), isMeta: false) }
      if let i = b.initializer { return typeOf(i.value, file, depth: depth + 1) }
      return nil
    }
    if let f = n.as(FunctionDeclSyntax.self) {
      guard let r = f.signature.returnClause else { return nil }
      return TypeRef(name: normalizeType(r.type.trimmedDescription), isMeta: false)
    }
    if n.is(InitializerDeclSyntax.self) { return d.container.map { TypeRef(name: $0, isMeta: false) } }
    if let p = n.as(FunctionParameterSyntax.self) { return TypeRef(name: normalizeType(p.type.trimmedDescription), isMeta: false) }
    if let c = n.as(OptionalBindingConditionSyntax.self) {
      if let t = c.typeAnnotation { return TypeRef(name: normalizeType(t.type.trimmedDescription), isMeta: false) }
      if let i = c.initializer { return typeOf(i.value, file, depth: depth + 1) }
      if let id = c.pattern.as(IdentifierPatternSyntax.self), let outer = resolve(id.identifier, file, depth: depth + 1, skipping: n).first {
        return typeOf(decl: outer, depth: depth + 1)
      }
      return nil
    }
    if let f = n.as(ForStmtSyntax.self), let t = typeOf(f.sequence, file, depth: depth + 1), t.name.hasPrefix("[") {
      return TypeRef(name: String(t.name.dropFirst().dropLast()), isMeta: false)
    }
    if n.is(EnumCaseElementSyntax.self) { return d.container.map { TypeRef(name: $0, isMeta: false) } }
    return nil
  }

  // MARK: Name resolution

  /// The declaration a local name found by SwiftLexicalLookup stands for.
  func localDecl(_ name: LookupName, _ file: SourceFile) -> Decl? {
    let syn = Syntax(fromProtocol: name.syntax)
    let text = name.identifier.name
    // An indexed declaration at that spot (a member or a top-level one).
    let pos = name.position.utf8Offset
    if let d = file.decls.first(where: { $0.nameStart == pos }) { return d }
    if let p = syn.as(FunctionParameterSyntax.self) {
      let tok = p.secondName ?? p.firstName
      return Decl(name: tok.text, kind: .parameter, uri: file.uri, node: syn, nameToken: tok, container: nil,
                  signature: "(parameter) " + p.trimmedDescription.collapsingWhitespace().trimmingTrailingComma(), doc: "")
    }
    if let id = syn.as(IdentifierPatternSyntax.self) {
      // A local `let`/`var`, an `if let`, a `for` variable, a closure capture.
      var n: Syntax? = syn.parent
      while let cur = n {
        if let b = cur.as(PatternBindingSyntax.self) {
          let v = b.parent?.parent?.as(VariableDeclSyntax.self)
          var sig = (v?.bindingSpecifier.text ?? "let") + " " + b.pattern.trimmedDescription
          if let t = b.typeAnnotation { sig += t.trimmedDescription }
          if let i = b.initializer, i.value.trimmedDescription.count <= 60 { sig += " " + i.trimmedDescription }
          return Decl(name: text, kind: v?.bindingSpecifier.tokenKind == .keyword(.var) ? .variable : .constant, uri: file.uri,
                      node: cur, nameToken: id.identifier, container: nil, signature: sig.collapsingWhitespace(),
                      doc: v.map { docComment($0) } ?? "")
        }
        if let c = cur.as(OptionalBindingConditionSyntax.self) {
          return Decl(name: text, kind: .constant, uri: file.uri, node: cur, nameToken: id.identifier, container: nil,
                      signature: c.trimmedDescription.collapsingWhitespace(), doc: "")
        }
        if let f = cur.as(ForStmtSyntax.self) {
          return Decl(name: text, kind: .constant, uri: file.uri, node: cur, nameToken: id.identifier, container: nil,
                      signature: "for " + f.pattern.trimmedDescription + " in " + f.sequence.trimmedDescription.collapsingWhitespace(), doc: "")
        }
        if cur.is(CodeBlockItemSyntax.self) || cur.is(MemberBlockItemSyntax.self) { break }
        n = cur.parent
      }
      return Decl(name: text, kind: .constant, uri: file.uri, node: syn, nameToken: id.identifier, container: nil,
                  signature: text, doc: "")
    }
    if let tok = syn.as(TokenSyntax.self) {
      return Decl(name: text, kind: .parameter, uri: file.uri, node: syn, nameToken: tok, container: nil, signature: text, doc: "")
    }
    if let p = syn.as(ClosureShorthandParameterSyntax.self) {
      return Decl(name: text, kind: .parameter, uri: file.uri, node: syn, nameToken: p.name, container: nil,
                  signature: "(closure parameter) " + text, doc: "")
    }
    if let p = syn.as(ClosureParameterSyntax.self) {
      let tok = p.secondName ?? p.firstName
      return Decl(name: text, kind: .parameter, uri: file.uri, node: syn, nameToken: tok, container: nil,
                  signature: "(closure parameter) " + p.trimmedDescription.trimmingTrailingComma(), doc: "")
    }
    if let g = syn.as(GenericParameterSyntax.self) {
      return Decl(name: text, kind: .typeAlias, uri: file.uri, node: syn, nameToken: g.name, container: nil,
                  signature: "(generic parameter) " + g.trimmedDescription.trimmingTrailingComma(), doc: "")
    }
    return nil
  }

  /// Declarations a name token refers to. Members after `.` go through the
  /// base expression's type; other names through SwiftLexicalLookup (locals,
  /// parameters, members of the enclosing type), then the top-level
  /// declarations of every open file.
  func resolve(_ tok: TokenSyntax, _ file: SourceFile, depth: Int = 0, skipping: Syntax? = nil) -> [Decl] {
    let name = tok.text
    let pos = tok.positionAfterSkippingLeadingTrivia.utf8Offset
    // The token is the name of a declaration: it is its own definition.
    if skipping == nil, let d = file.decls.first(where: { $0.nameStart == pos && $0.kind != .extensionDecl }) { return [d] }
    if tok.tokenKind == .keyword(.`init`) {
      if let d = file.decls.first(where: { $0.nameStart == pos }) { return [d] }
    }
    if tok.tokenKind == .keyword(.self) || tok.tokenKind == .keyword(.Self) {
      if let t = enclosingTypeName(Syntax(tok)) { return typeDecls(named: t).filter { $0.kind != .extensionDecl } }
      return []
    }
    guard case .identifier = tok.tokenKind else { return [] }

    // `base.name`
    if let ref = tok.parent?.as(DeclReferenceExprSyntax.self), let ma = ref.parent?.as(MemberAccessExprSyntax.self),
      ma.declName.id == ref.id {
      if let base = ma.base {
        if let bt = typeOf(base, file, depth: depth + 1) {
          // The nearest type that declares the name wins: a class's own
          // `area()` over the protocol requirement it implements.
          let ms = members(of: bt.name).filter { $0.name == name }
          if let first = ms.first { return ms.filter { $0.container == first.container } }
        }
      }
      // Unknown base type, or `.case` with an implied type: every member of
      // that name, which is what a reader without a type checker can offer.
      return allDecls.filter { $0.name == name && $0.container != nil && $0.kind != .extensionDecl }
    }
    // A type in type position: `Point`, `Shapes.Point`.
    if let it = tok.parent?.as(IdentifierTypeSyntax.self), it.name.id == tok.id {
      let ts = typeDecls(named: name).filter { $0.kind != .extensionDecl }
      if !ts.isEmpty { return ts }
    }
    if let mt = tok.parent?.as(MemberTypeSyntax.self), mt.name.id == tok.id {
      let base = normalizeType(mt.baseType.trimmedDescription)
      return members(of: base).filter { $0.name == name }
    }
    // Lexical scopes in this file.
    for result in tok.lookup(Identifier(tok)) {
      switch result {
      case .lookForMembers(let typeSyntax):
        if let t = nameOfType(typeSyntax) {
          let ms = members(of: t).filter { $0.name == name }
          if !ms.isEmpty { return ms }
        }
      default:
        for n in result.names {
          if let s = skipping, Syntax(fromProtocol: n.syntax).id == s.id { continue }
          if case .implicit = n { continue }
          if case .equivalentNames(let names) = n, let first = names.first {
            if let d = localDecl(first, file) { return [d] }
            continue
          }
          if let d = localDecl(n, file) { return [d] }
        }
      }
    }
    // Top level, all files.
    let top = allDecls.filter { $0.name == name && $0.container == nil && $0.kind != .extensionDecl }
    return top
  }

  func nameOfType(_ s: Syntax) -> String? {
    if let x = s.as(StructDeclSyntax.self) { return x.name.text }
    if let x = s.as(ClassDeclSyntax.self) { return x.name.text }
    if let x = s.as(EnumDeclSyntax.self) { return x.name.text }
    if let x = s.as(ActorDeclSyntax.self) { return x.name.text }
    if let x = s.as(ProtocolDeclSyntax.self) { return x.name.text }
    if let x = s.as(ExtensionDeclSyntax.self) { return normalizeType(x.extendedType.trimmedDescription) }
    return nil
  }

  // MARK: Tokens at positions

  /// The token whose text contains `offset`, or ends right at it.
  func token(at offset: Int, in file: SourceFile) -> TokenSyntax? {
    let len = file.bytes.count
    for o in [offset, offset - 1] where o >= 0 && o < len {
      guard let t = file.tree.token(at: AbsolutePosition(utf8Offset: o)) else { continue }
      let s = t.positionAfterSkippingLeadingTrivia.utf8Offset, e = t.endPositionBeforeTrailingTrivia.utf8Offset
      if s <= offset && offset <= e && e > s {
        if o == offset - 1 || isWordToken(t) { return t }
      }
    }
    return nil
  }

  func isWordToken(_ t: TokenSyntax) -> Bool {
    switch t.tokenKind {
    case .identifier, .keyword, .dollarIdentifier: return true
    default: return false
    }
  }
}

extension String {
  func trimmingTrailingComma() -> String {
    var s = self.trimmingSpaces()
    if s.hasSuffix(",") { s.removeLast() }
    return s
  }
}
