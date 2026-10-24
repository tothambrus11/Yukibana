// The conformance corpus: every public declaration of the browser's XCTest,
// used with its full type spelled out (a function reference annotated with
// its exact type, @autoclosure, throws/rethrows, generic constraints and
// labels included) and called with every argument and with only the
// required ones (so the defaults must exist). tools/xctest-subset.mjs
// type-checks it against the browser's XCTest (native 6.4.1 and the pack's
// swift-frontend.wasm 6.3.3) and against the real swift-corelibs-xctest of the
// Swift 6.4.1 Linux toolchain; it has to compile against all three.
//
// When a declaration is added to xctest/XCTest, it is added here too:
// tools/xctest-subset.mjs fails if a public name of the module does not
// appear in this file.

import XCTest

struct Failure: Error {}
final class Object {}

final class Corpus: XCTestCase {
    // XCTest's open members, overridden with their exact signatures.
    override func setUp() async throws { try await super.setUp() }
    override func setUpWithError() throws { try super.setUpWithError() }
    override func setUp() { super.setUp() }
    override func tearDown() { super.tearDown() }
    override func tearDownWithError() throws { try super.tearDownWithError() }
    override func tearDown() async throws { try await super.tearDown() }
    override class func setUp() { super.setUp() }
    override class func tearDown() { super.tearDown() }
    override var name: String { super.name }
    override var testCaseCount: Int { super.testCaseCount }
    override var continueAfterFailure: Bool {
        get { super.continueAfterFailure }
        set { super.continueAfterFailure = newValue }
    }
    override func recordFailure(withDescription description: String, inFile filePath: String, atLine lineNumber: Int, expected: Bool) {
        super.recordFailure(withDescription: description, inFile: filePath, atLine: lineNumber, expected: expected)
    }
    override func addTeardownBlock(_ block: @escaping () -> Void) { super.addTeardownBlock(block) }

    func testMembers() {
        let _: (String, @escaping XCTestCaseClosure) -> Corpus = Corpus.init(name:testClosure:)
        let _: (String, @escaping (XCTestCase) throws -> Void) -> XCTestCase = XCTestCase.init(name:testClosure:)
        let _: () -> XCTest = XCTest.init
        let _: (@escaping () -> Void) -> Void = addTeardownBlock
        let _: (@Sendable @escaping () async throws -> Void) -> Void = addTeardownBlock
        addTeardownBlock {}
        addTeardownBlock { @Sendable () async throws in }
        let base: XCTest = self
        let _: String = base.name
        let _: Int = base.testCaseCount
        let _: XCTestCase.Type = Corpus.self
    }

    func testTypes() {
        let closure: XCTestCaseClosure = { (_: XCTestCase) throws -> Void in }
        let entry: XCTestCaseEntry = (testCaseClass: Corpus.self, allTests: [("testTypes", closure)])
        let _: XCTestCase.Type = entry.testCaseClass
        let _: [(String, XCTestCaseClosure)] = entry.allTests
        let _: (XCTestCase.Type, [(String, (XCTestCase) throws -> Void)]) = entry
    }

    func testEntryPoints() {
        let _: ([(String, (Corpus) -> () throws -> Void)]) -> XCTestCaseEntry = testCase
        let _: ([(String, (Corpus) -> () -> Void)]) -> XCTestCaseEntry = testCase
        let _: (@escaping (Corpus) -> () async throws -> Void) -> (Corpus) -> () throws -> Void = asyncTest
        let _: ([XCTestCaseEntry]) -> Never = XCTMain
        let _: ([XCTestCaseEntry], [String]) -> Never = XCTMain
        _ = testCase([("testTypes", Corpus.testTypes)])
        _ = testCase([("testThrowing", Corpus.testThrowing), ("testAsync", asyncTest(Corpus.testAsync))])
    }

    func testThrowing() throws {}
    func testAsync() async throws {}

    func testBooleans() {
        let _: (@autoclosure () throws -> Bool, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssert
        let _: (@autoclosure () throws -> Bool, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertTrue
        let _: (@autoclosure () throws -> Bool, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertFalse
        XCTAssert(true)
        XCTAssert(true, "message", file: #file, line: #line)
        XCTAssertTrue(true)
        XCTAssertTrue(true, "message", file: #file, line: #line)
        XCTAssertFalse(false)
        XCTAssertFalse(false, "message", file: #file, line: #line)
    }

    func testEquality() {
        let _: (@autoclosure () throws -> String, @autoclosure () throws -> String, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertEqual
        let _: (@autoclosure () throws -> String, @autoclosure () throws -> String, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNotEqual
        let _: (@autoclosure () throws -> Double, @autoclosure () throws -> Double, Double, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertEqual
        let _: (@autoclosure () throws -> Double, @autoclosure () throws -> Double, Double, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNotEqual
        let _: (@autoclosure () throws -> Int, @autoclosure () throws -> Int, Int, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertEqual
        let _: (@autoclosure () throws -> Int, @autoclosure () throws -> Int, Int, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNotEqual
        XCTAssertEqual("a", "a")
        XCTAssertEqual("a", "a", "message", file: #file, line: #line)
        XCTAssertNotEqual(1, 2)
        XCTAssertNotEqual(1, 2, "message", file: #file, line: #line)
        XCTAssertEqual(0.1 + 0.2, 0.3, accuracy: 1e-9)
        XCTAssertEqual(Float(1), 1.0001, accuracy: 0.001, "message", file: #file, line: #line)
        XCTAssertEqual(10, 12, accuracy: 2)
        XCTAssertNotEqual(1.0, 2.0, accuracy: 0.5)
        XCTAssertNotEqual(10, 20, accuracy: 2, "message", file: #file, line: #line)
    }

    @available(*, deprecated)
    func testDeprecated() {
        let _: (@autoclosure () throws -> Double, @autoclosure () throws -> Double, Double, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertEqualWithAccuracy
        let _: (@autoclosure () throws -> Double, @autoclosure () throws -> Double, Double, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNotEqualWithAccuracy
        XCTAssertEqualWithAccuracy(1.0, 1.0, accuracy: 0.1)
        XCTAssertNotEqualWithAccuracy(1.0, 2.0, 0.1, "message", file: #file, line: #line)
    }

    func testOrdering() {
        let _: (@autoclosure () throws -> Int, @autoclosure () throws -> Int, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertGreaterThan
        let _: (@autoclosure () throws -> Int, @autoclosure () throws -> Int, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertGreaterThanOrEqual
        let _: (@autoclosure () throws -> Int, @autoclosure () throws -> Int, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertLessThan
        let _: (@autoclosure () throws -> Int, @autoclosure () throws -> Int, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertLessThanOrEqual
        XCTAssertGreaterThan(2, 1)
        XCTAssertGreaterThan(2, 1, "message", file: #file, line: #line)
        XCTAssertGreaterThanOrEqual("b", "a")
        XCTAssertGreaterThanOrEqual(1, 1, "message", file: #file, line: #line)
        XCTAssertLessThan(1, 2)
        XCTAssertLessThan(1.0, 2.0, "message", file: #file, line: #line)
        XCTAssertLessThanOrEqual(1, 1)
        XCTAssertLessThanOrEqual(1, 1, "message", file: #file, line: #line)
    }

    func testOptionalsAndIdentity() throws {
        let _: (@autoclosure () throws -> Any?, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNil
        let _: (@autoclosure () throws -> Any?, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNotNil
        let _: (@autoclosure () throws -> Int?, @autoclosure () -> String, StaticString, UInt) throws -> Int = XCTUnwrap
        let _: (@autoclosure () throws -> AnyObject?, @autoclosure () throws -> AnyObject?, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertIdentical
        let _: (@autoclosure () throws -> AnyObject?, @autoclosure () throws -> AnyObject?, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNotIdentical
        let none: Int? = nil
        XCTAssertNil(none)
        XCTAssertNil(none, "message", file: #file, line: #line)
        XCTAssertNotNil(Optional(1))
        XCTAssertNotNil(1, "message", file: #file, line: #line)
        let one: Int = try XCTUnwrap(Optional(1))
        let two: String = try XCTUnwrap("2" as String?, "message", file: #file, line: #line)
        _ = (one, two)
        let object = Object()
        XCTAssertIdentical(object, object)
        XCTAssertIdentical(object, object, "message", file: #file, line: #line)
        XCTAssertNotIdentical(object, Object())
        XCTAssertNotIdentical(object, nil, "message", file: #file, line: #line)
    }

    func testErrors() throws {
        let _: (@autoclosure () throws -> Int, @autoclosure () -> String, StaticString, UInt, (Error) -> Void) -> Void = XCTAssertThrowsError
        let _: (@autoclosure () throws -> Int, @autoclosure () -> String, StaticString, UInt, (Error) throws -> Void) throws -> Void = XCTAssertThrowsError
        let _: (@autoclosure () throws -> Int, @autoclosure () -> String, StaticString, UInt) -> Void = XCTAssertNoThrow
        let _: (String, StaticString, UInt) -> Void = XCTFail
        func fails() throws -> Int { throw Failure() }
        XCTAssertThrowsError(try fails())
        XCTAssertThrowsError(try fails(), "message", file: #file, line: #line) { error in _ = error }
        XCTAssertThrowsError(try fails()) { (error: Error) in XCTAssertTrue(error is Failure) }
        try XCTAssertThrowsError(try fails(), "message") { (error: Error) throws in throw error }
        XCTAssertNoThrow(1)
        XCTAssertNoThrow(try fails(), "message", file: #file, line: #line)
        XCTFail()
        XCTFail("message", file: #file, line: #line)
    }

    func testSkips() throws {
        let _: (@autoclosure () -> String?, StaticString, UInt) -> XCTSkip = XCTSkip.init
        let _: (@autoclosure () throws -> Bool, @autoclosure () -> String?, StaticString, UInt) throws -> Void = XCTSkipIf
        let _: (@autoclosure () throws -> Bool, @autoclosure () -> String?, StaticString, UInt) throws -> Void = XCTSkipUnless
        let skip: Error = XCTSkip()
        let message: String? = XCTSkip("message", file: #file, line: #line).message
        _ = (skip, message)
        try XCTSkipIf(false)
        try XCTSkipIf(false, "message", file: #file, line: #line)
        try XCTSkipUnless(true)
        try XCTSkipUnless(true, "message", file: #file, line: #line)
        throw XCTSkip("message")
    }
}

// Subclassing as students do, and a list of their own, as on Linux.
class Base: XCTestCase {
    var value = 0
    func testInherited() {}
}

final class Derived: Base {
    static var allTests = [("testInherited", testInherited)]
}

func entries() -> [XCTestCaseEntry] {
    [testCase(Derived.allTests)]
}
