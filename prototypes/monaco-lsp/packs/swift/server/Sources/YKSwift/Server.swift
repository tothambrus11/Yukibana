// swift-ls.wasm: what swift-syntax gives the Swift pack that sourcekitd does
// not. sourcekitd (swift-frontend-lsp.wasm) answers every language question;
// this module only formats (BasicFormat), classifies tokens for semantic
// highlighting, and measures how deep `[` nests (`nesting`, which server.js
// uses to keep files sourcekitd's parser would take minutes on away from
// it). All are functions of one file's text, so the module keeps no state:
// each request carries the text it is about.
//
// Requests are `cmd\noptions\n<text>`, answered as JSON text, through the
// WebAssembly exports at the end. JSON is written by hand: the module links
// no Foundation, which keeps it a few megabytes instead of tens.

import SwiftBasicFormat
import SwiftIDEUtils
import SwiftParser
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

/// BasicFormat over the file with its line indentation removed first.
/// BasicFormat indents a line that has none and adds its indentation to
/// whatever a line already has, so running it on hand-indented code left
/// lines misaligned (a review found `func f` at 10 spaces, its body at 8).
/// With every line's leading spaces and tabs stripped, all indentation is
/// BasicFormat's and consistent. `options` is `s<n>` (n spaces) or `t`.
func format(_ f: SourceFile, _ options: String) -> String {
  guard !f.isSkipped else { return "{\"text\":\(jstr(f.text))}" }
  let unit: Trivia
  if options == "t" { unit = .tabs(1) }
  else { unit = .spaces(max(1, min(16, Int(options.dropFirst()) ?? 4))) }
  let flat = IndentStripper(viewMode: .sourceAccurate).rewrite(f.tree)
  let out = flat.formatted(using: BasicFormat(indentationWidth: unit)).description
  return "{\"text\":\(jstr(out))}"
}

/// Semantic tokens as [start, length, type] triples (legend in server.js):
/// swift-syntax's classifier, plus the names declarations introduce.
func tokens(_ f: SourceFile) -> String {
  guard !f.isSkipped else { return "[]" }
  let declared = DeclaredNames(f.tree).kinds
  var nums: [String] = []
  for c in f.tree.classifications {
    let start = c.range.lowerBound.utf8Offset
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
      guard let k = declared[start] else { continue }
      type = k.rawValue
    default: continue
    }
    nums.append("\(start),\(c.range.upperBound.utf8Offset - start),\(type)")
  }
  return "[" + nums.joined(separator: ",") + "]"
}

/// One request: `cmd\noptions\n` then the file's text.
func call(_ input: String) -> String {
  var parts = input.split(separator: "\n", maxSplits: 2, omittingEmptySubsequences: false)
  while parts.count < 3 { parts.append("") }
  // Before parsing: what it measures is whether parsing is safe.
  if parts[0] == "nesting" { return String(squareNesting(Array(parts[2].utf8))) }
  let f = SourceFile(text: String(parts[2]))
  switch parts[0] {
  case "format": return format(f, String(parts[1]))
  case "tokens": return tokens(f)
  default: return "null"
  }
}

// MARK: - WebAssembly exports

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
  let bytes = Array(call(input).utf8)
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
