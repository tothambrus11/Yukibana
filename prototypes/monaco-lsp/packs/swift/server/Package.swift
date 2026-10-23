// swift-tools-version:6.0
// The Swift half of the swift pack: a WebAssembly reactor module built on
// swift-syntax (parser, parser diagnostics, classifier, lexical lookup,
// basic formatter). It is NOT SourceKit-LSP; see ../README.md for why.
import PackageDescription

let package = Package(
  name: "YKSwift",
  dependencies: [
    .package(url: "https://github.com/swiftlang/swift-syntax.git", exact: "604.0.0")
  ],
  targets: [
    .executableTarget(
      name: "YKSwift",
      dependencies: [
        .product(name: "SwiftSyntax", package: "swift-syntax"),
        .product(name: "SwiftParser", package: "swift-syntax"),
        .product(name: "SwiftParserDiagnostics", package: "swift-syntax"),
        .product(name: "SwiftDiagnostics", package: "swift-syntax"),
        .product(name: "SwiftIDEUtils", package: "swift-syntax"),
        .product(name: "SwiftBasicFormat", package: "swift-syntax"),
        .product(name: "SwiftLexicalLookup", package: "swift-syntax"),
      ],
      swiftSettings: [.swiftLanguageMode(.v5)],
      // A reactor: no main loop, the worker calls the exported functions.
      // The shadow stack goes first in memory (--stack-first), so running off
      // its end is a clean out-of-bounds trap at address 0 instead of writing
      // over static data and Swift metadata above it, which is what the
      // default layout (a ~640 KB stack sitting just above the data) did on
      // deeply nested code: corruption first, an odd trap later. It is 8 MB:
      // swift-syntax's parser and visitors recurse once per nesting level.
      linkerSettings: [.unsafeFlags([
        "-Xclang-linker", "-mexec-model=reactor",
        "-Xlinker", "--stack-first",
        "-Xlinker", "-z", "-Xlinker", "stack-size=8388608",
        // The Wasm SDK puts data at 4096; with the stack first it must start
        // after the stack.
        "-Xlinker", "--global-base=8388608",
      ])]
    )
  ]
)
