// Skipping, as corelibs' XCTSkip.swift. The real XCTSkip conforms only to
// Error on Linux too (no CustomNSError there), so this one is the same type.

/// An error which causes the current test to cease executing
/// and be marked as skipped when it is thrown.
public struct XCTSkip: Error {
    /// The user-supplied message related to this skip, if specified.
    public let message: String?

    /// "Test skipped", then ": explanation" and " - message" when present:
    /// the line the runner prints.
    let summary: String
    let file: String?
    let line: Int

    init(explanation: String?, message: String?, file: String?, line: Int) {
        self.message = message
        self.file = file
        self.line = line
        var summary = "Test skipped"
        if let explanation { summary += ": \(explanation)" }
        if let message, !message.isEmpty { summary += " - \(message)" }
        self.summary = summary
    }

    public init(_ message: @autoclosure () -> String? = nil, file: StaticString = #file, line: UInt = #line) {
        self.init(explanation: nil, message: message(), file: String(describing: file), line: Int(line))
    }
}

/// Evaluates a boolean expression and, if it is true, throws an error which
/// causes the current test to cease executing and be marked as skipped.
public func XCTSkipIf(
    _ expression: @autoclosure () throws -> Bool,
    _ message: @autoclosure () -> String? = nil,
    file: StaticString = #file, line: UInt = #line
) throws {
    try skipIf(expression, equalTo: true, message, file, line)
}

/// Evaluates a boolean expression and, if it is false, throws an error which
/// causes the current test to cease executing and be marked as skipped.
public func XCTSkipUnless(
    _ expression: @autoclosure () throws -> Bool,
    _ message: @autoclosure () -> String? = nil,
    file: StaticString = #file, line: UInt = #line
) throws {
    try skipIf(expression, equalTo: false, message, file, line)
}

private func skipIf(_ expression: () throws -> Bool, equalTo expected: Bool, _ message: () -> String?, _ file: StaticString, _ line: UInt) throws {
    let value: Bool
    do {
        value = try expression()
    } catch {
        throw XCTSkip(explanation: "threw error \"\(error)\"", message: message(), file: String(describing: file), line: Int(line))
    }
    if value == expected {
        // corelibs' wording, which reads backwards (XCTSkipIf(true) says
        // "required true value but got false"); kept so the output matches.
        let explanation = expected ? "required true value but got false" : "required false value but got true"
        throw XCTSkip(explanation: explanation, message: message(), file: String(describing: file), line: Int(line))
    }
}
