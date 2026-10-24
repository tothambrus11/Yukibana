// The assertions. Every public declaration in this module is copied from
// swift-corelibs-xctest (Sources/XCTest/Public, tag swift-6.4.1-RELEASE,
// identical in swift-6.3.3-RELEASE) with its signature unchanged, defaults
// included (`#file`, not `#filePath`: corelibs still uses `#file`), so a test
// that compiles here compiles against the real XCTest. tools/xctest-subset.mjs
// checks that mechanically. Only the bodies are ours.
//
// The failure texts are corelibs' too, down to the " - " that follows the
// description even when there is no message: graders and students compare
// this output with the real one.

/// What an assertion evaluated to. `expected: false` is corelibs'
/// "unexpected" failure: the expression threw instead of failing.
private enum Outcome {
    case success
    case failure(String?)
    case threw(Error)
}

/// Runs one assertion and reports a failure to the running test case, as
/// corelibs' _XCTEvaluateAssertion does. `name` is nil for XCTFail, whose
/// description is just "failed".
private func evaluate(_ name: String?, _ message: () -> String, _ file: StaticString, _ line: UInt, _ body: () throws -> Outcome) {
    let outcome: Outcome
    do {
        outcome = try body()
    } catch {
        outcome = .threw(error)
    }
    let explanation: String
    switch outcome {
    case .success: return
    case .failure(let details?): explanation = "failed: \(details)"
    case .failure(nil): explanation = "failed"
    case .threw(let error): explanation = "threw error \"\(error)\""
    }
    let description = "\(name.map { "\($0) \(explanation)" } ?? explanation) - \(message())"
    // Outside a test the real XCTest drops the failure too.
    guard let test = _currentTestCase else { return }
    var isExpected = true
    if case .threw = outcome { isExpected = false }
    test.recordFailure(withDescription: description, inFile: String(describing: file), atLine: Int(line), expected: isExpected)
}

/// Equal within `accuracy`, as corelibs' areEqual: equality first so that
/// infinities equal themselves; NaN is never within any accuracy.
private func areEqual<T: Numeric>(_ a: T, _ b: T, accuracy: T) -> Bool {
    if a == b { return true }
    let difference = (a.magnitude > b.magnitude) ? a - b : b - a
    return difference.magnitude <= accuracy.magnitude
}

private func describe(_ object: AnyObject?) -> String {
    object == nil ? String(describing: object) : String(describing: object!)
}

public func XCTAssert(_ expression: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    XCTAssertTrue(try expression(), message(), file: file, line: line)
}

public func XCTAssertTrue(_ expression: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertTrue", message, file, line) { try expression() ? .success : .failure(nil) }
}

public func XCTAssertFalse(_ expression: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertFalse", message, file, line) { try expression() ? .failure(nil) : .success }
}

public func XCTAssertEqual<T: Equatable>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertEqual", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a == b ? .success : .failure("(\"\(a)\") is not equal to (\"\(b)\")")
    }
}

public func XCTAssertEqual<T: FloatingPoint>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, accuracy: T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    assertEqual(try expression1(), try expression2(), accuracy, message, file, line)
}

public func XCTAssertEqual<T: Numeric>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, accuracy: T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    assertEqual(try expression1(), try expression2(), accuracy, message, file, line)
}

private func assertEqual<T: Numeric>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ accuracy: T, _ message: () -> String, _ file: StaticString, _ line: UInt) {
    evaluate("XCTAssertEqual", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return areEqual(a, b, accuracy: accuracy) ? .success : .failure("(\"\(a)\") is not equal to (\"\(b)\") +/- (\"\(accuracy)\")")
    }
}

@available(*, deprecated, renamed: "XCTAssertEqual(_:_:accuracy:file:line:)")
public func XCTAssertEqualWithAccuracy<T: FloatingPoint>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, accuracy: T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    assertEqual(try expression1(), try expression2(), accuracy, message, file, line)
}

public func XCTAssertNotEqual<T: Equatable>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertNotEqual", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a != b ? .success : .failure("(\"\(a)\") is equal to (\"\(b)\")")
    }
}

public func XCTAssertNotEqual<T: FloatingPoint>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, accuracy: T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    assertNotEqual(try expression1(), try expression2(), accuracy, message, file, line)
}

public func XCTAssertNotEqual<T: Numeric>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, accuracy: T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    assertNotEqual(try expression1(), try expression2(), accuracy, message, file, line)
}

private func assertNotEqual<T: Numeric>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ accuracy: T, _ message: () -> String, _ file: StaticString, _ line: UInt) {
    evaluate("XCTAssertNotEqual", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return !areEqual(a, b, accuracy: accuracy) ? .success : .failure("(\"\(a)\") is equal to (\"\(b)\") +/- (\"\(accuracy)\")")
    }
}

// Unlike XCTAssertEqualWithAccuracy, corelibs declares `accuracy` here without a label.
@available(*, deprecated, renamed: "XCTAssertNotEqual(_:_:accuracy:file:line:)")
public func XCTAssertNotEqualWithAccuracy<T: FloatingPoint>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ accuracy: T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    assertNotEqual(try expression1(), try expression2(), accuracy, message, file, line)
}

/// Asserts that two values are identical.
public func XCTAssertIdentical(_ expression1: @autoclosure () throws -> AnyObject?, _ expression2: @autoclosure () throws -> AnyObject?, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertIdentical", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a === b ? .success : .failure("(\"\(describe(a))\") is not identical to (\"\(describe(b))\")")
    }
}

/// Asserts that two values aren't identical.
public func XCTAssertNotIdentical(_ expression1: @autoclosure () throws -> AnyObject?, _ expression2: @autoclosure () throws -> AnyObject?, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertNotIdentical", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a !== b ? .success : .failure("(\"\(describe(a))\") is identical to (\"\(describe(b))\")")
    }
}

public func XCTAssertGreaterThan<T: Comparable>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertGreaterThan", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a > b ? .success : .failure("(\"\(a)\") is not greater than (\"\(b)\")")
    }
}

public func XCTAssertGreaterThanOrEqual<T: Comparable>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertGreaterThanOrEqual", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a >= b ? .success : .failure("(\"\(a)\") is less than (\"\(b)\")")
    }
}

public func XCTAssertLessThan<T: Comparable>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertLessThan", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a < b ? .success : .failure("(\"\(a)\") is not less than (\"\(b)\")")
    }
}

public func XCTAssertLessThanOrEqual<T: Comparable>(_ expression1: @autoclosure () throws -> T, _ expression2: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertLessThanOrEqual", message, file, line) {
        let (a, b) = (try expression1(), try expression2())
        return a <= b ? .success : .failure("(\"\(a)\") is greater than (\"\(b)\")")
    }
}

public func XCTAssertNil(_ expression: @autoclosure () throws -> Any?, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertNil", message, file, line) {
        let value = try expression()
        return value == nil ? .success : .failure("\"\(value!)\"")
    }
}

public func XCTAssertNotNil(_ expression: @autoclosure () throws -> Any?, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertNotNil", message, file, line) { try expression() != nil ? .success : .failure(nil) }
}

/// Asserts that an expression is not `nil`, and returns its unwrapped value.
/// Throws if it is nil (after recording the failure), or rethrows what the
/// expression threw.
public func XCTUnwrap<T>(_ expression: @autoclosure () throws -> T?, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) throws -> T {
    var value: T?
    var thrown: Error?
    evaluate("XCTUnwrap", message, file, line) {
        do {
            value = try expression()
        } catch {
            thrown = error
            return .threw(error)
        }
        return value != nil ? .success : .failure("expected non-nil value of type \"\(T.self)\"")
    }
    if let value { return value }
    throw thrown ?? UnwrappedNil()
}

/// What XCTUnwrap throws for nil: the failure is already recorded, so the
/// test runner ends the test without recording it again (corelibs'
/// XCTestErrorWhileUnwrappingOptional).
struct UnwrappedNil: Error {}

public func XCTFail(_ message: String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate(nil, { message }, file, line) { .failure(nil) }
}

// Two overloads, as in corelibs: the rethrows one lets the error handler
// throw; the other keeps a non-throwing handler callable without `try`.
public func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line, _ errorHandler: (_ error: Swift.Error) -> Void = { _ in }) {
    let rethrowing: (() throws -> T, () -> String, StaticString, UInt, (Swift.Error) throws -> Void) throws -> Void = XCTAssertThrowsError
    try? rethrowing(expression, message, file, line, errorHandler)
}

public func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line, _ errorHandler: (_ error: Swift.Error) throws -> Void = { _ in }) rethrows {
    // As in corelibs, an error thrown by the handler is not rethrown: it is
    // recorded as an unexpected failure ("XCTAssertThrowsError threw error").
    evaluate("XCTAssertThrowsError", message, file, line) {
        do {
            _ = try expression()
        } catch {
            try errorHandler(error)
            return .success
        }
        return .failure("did not throw error")
    }
}

public func XCTAssertNoThrow<T>(_ expression: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) {
    evaluate("XCTAssertNoThrow", message, file, line) {
        do {
            _ = try expression()
            return .success
        } catch {
            return .failure("threw error \"\(error)\"")
        }
    }
}
