// One file's syntax tree, parsed only when walking it is safe in a browser
// worker, and the declaration names semantic tokens colour.

import SwiftParser
import SwiftSyntax

final class SourceFile {
  let text: String
  let bytes: [UInt8]
  let tree: SourceFileSyntax

  /// Whether this file is too deep to walk; its formatting is then the text
  /// unchanged and it has no semantic tokens. Both limits are about the
  /// browser, not about the code being wrong: see `maximumDepth` and
  /// `maximumSquareNesting`.
  let isSkipped: Bool

  /// Brackets (`(`, `[`, `{`) nested deeper than this end the parse.
  /// swift-syntax's default, 256, is more than the browser's native stack can
  /// take once the recursive visitors (classifier, formatter) walk the tree.
  static let maximumNestingLevel = 128

  /// The deepest syntax tree any request walks. Not every deep tree comes
  /// from brackets: an `else if` chain or a long `a.b().c()...` member chain
  /// nests one or more nodes per link and the parser does not count them.
  /// swift-syntax's visitors recurse once per level, on the wasm shadow
  /// stack (8 MB, see Package.swift) and on the browser's native stack
  /// (about 1 MB for a worker), and running out of either kills the
  /// instance. Calibrated in Chromium 141 (README, "Limits"): a 1,000-branch
  /// `else if` chain, under 1,200 deep, already overflowed; 600 did not.
  static let maximumDepth = 700

  /// swift-syntax 604's parser takes time exponential in the nesting of `[`
  /// directly followed by `[` or `(` (it looks ahead for a type at each
  /// one): `let t: [[[...Int]]]` 16 deep parses in 0.1 s, 20 in 1.4 s, 30
  /// would take about half an hour. So a file whose `[`s nest deeper than
  /// this is not parsed. (The compiler's own parser has the same problem;
  /// server.js asks `nesting` and keeps such files from sourcekitd.)
  static let maximumSquareNesting = 12

  init(text: String) {
    self.text = text
    self.bytes = Array(text.utf8)
    if squareNesting(bytes) > SourceFile.maximumSquareNesting {
      self.tree = Parser.parse(source: "")
      self.isSkipped = true
      return
    }
    self.tree = bytes.withUnsafeBufferPointer {
      Parser.parse(source: $0, maximumNestingLevel: SourceFile.maximumNestingLevel)
    }
    // Iterative on purpose: this is what decides whether recursion is safe.
    var deepest = 0
    var stack: [(Syntax, Int)] = [(Syntax(tree), 1)]
    while let (node, d) = stack.popLast() {
      deepest = max(deepest, d)
      if deepest > SourceFile.maximumDepth { break }
      for child in node.children(viewMode: .all) { stack.append((child, d + 1)) }
    }
    self.isSkipped = deepest > SourceFile.maximumDepth
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

/// The semantic token type of a name a declaration introduces, by the
/// legend's index in server.js.
enum DeclaredKind: Int {
  case variable = 5, type = 1, function = 10, property = 11, enumMember = 12, parameter = 13
}

/// Every name a declaration introduces, by its byte offset: what the
/// classifier calls a plain identifier but an editor colours as a function,
/// property, type, case or parameter.
final class DeclaredNames: SyntaxVisitor {
  private(set) var kinds: [Int: DeclaredKind] = [:]

  init(_ tree: SourceFileSyntax) {
    super.init(viewMode: .sourceAccurate)
    walk(tree)
  }

  private func add(_ token: TokenSyntax, _ kind: DeclaredKind) {
    guard case .identifier = token.tokenKind else { return }
    kinds[token.positionAfterSkippingLeadingTrivia.utf8Offset] = kind
  }

  private func type(_ name: TokenSyntax) -> SyntaxVisitorContinueKind {
    add(name, .type)
    return .visitChildren
  }

  override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind { type(node.name) }
  override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind { type(node.name) }
  override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind { type(node.name) }
  override func visit(_ node: ProtocolDeclSyntax) -> SyntaxVisitorContinueKind { type(node.name) }
  override func visit(_ node: ActorDeclSyntax) -> SyntaxVisitorContinueKind { type(node.name) }

  override func visit(_ node: TypeAliasDeclSyntax) -> SyntaxVisitorContinueKind {
    add(node.name, .type)
    return .visitChildren
  }
  override func visit(_ node: AssociatedTypeDeclSyntax) -> SyntaxVisitorContinueKind {
    add(node.name, .type)
    return .visitChildren
  }
  override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind {
    add(node.name, .function)
    return .visitChildren
  }
  override func visit(_ node: EnumCaseElementSyntax) -> SyntaxVisitorContinueKind {
    add(node.name, .enumMember)
    return .visitChildren
  }
  override func visit(_ node: FunctionParameterSyntax) -> SyntaxVisitorContinueKind {
    add(node.secondName ?? node.firstName, .parameter)
    return .visitChildren
  }
  /// A stored or computed property directly in a type, otherwise a variable.
  override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
    let member = node.parent?.is(MemberBlockItemSyntax.self) ?? false
    for binding in node.bindings {
      for token in binding.pattern.tokens(viewMode: .sourceAccurate) {
        add(token, member ? .property : .variable)
      }
    }
    return .visitChildren
  }
}
