// The behaviour corpus: tests whose report must be the same, line for line,
// from the browser's XCTest and from the real swift-corelibs-xctest.
// tools/xctest-subset.mjs builds this file natively against both, runs the
// two programs and compares their output with times, dates and the bundle
// name blanked. (Natively, because the real XCTest needs Foundation, which
// the browser does not have; the same source is compiled for the browser by
// test-run.mjs.)

import XCTest

struct Oops: Error, CustomStringConvertible {
    var description: String { "oops" }
}

final class Box {}

final class Assertions: XCTestCase {
    func testPassing() {
        XCTAssert(true)
        XCTAssertEqual([1, 2], [1, 2])
        XCTAssertEqual(0.1 + 0.2, 0.3, accuracy: 1e-9)
        XCTAssertNotEqual(1.0, 1.5, accuracy: 0.1)
        XCTAssertGreaterThanOrEqual(2, 2)
        XCTAssertNil(nil as Int?)
    }

    func testFailing() {
        XCTAssert(false)
        XCTAssertTrue(false, "true")
        XCTAssertFalse(true)
        XCTAssertEqual(2, 3, "two and three")
        XCTAssertEqual("a", "b")
        XCTAssertNotEqual(1, 1)
        XCTAssertEqual(1.0, 1.5, accuracy: 0.1)
        XCTAssertNotEqual(1.0, 1.05, accuracy: 0.1)
        XCTAssertEqual(10, 13, accuracy: 2)
        XCTAssertGreaterThan(1, 2)
        XCTAssertGreaterThanOrEqual(1, 2)
        XCTAssertLessThan(2, 1)
        XCTAssertLessThanOrEqual(2, 1)
        XCTAssertNil(Optional(5))
        XCTAssertNotNil(nil as Int?)
        XCTAssertIdentical(Box(), nil)
        let box = Box()
        XCTAssertNotIdentical(box, box)
        XCTFail()
        XCTFail("by hand")
    }

    func testThrowingExpressions() throws {
        func boom() throws -> Int { throw Oops() }
        XCTAssertEqual(try boom(), 1)
        XCTAssertNoThrow(try boom())
        XCTAssertThrowsError(1)
        XCTAssertThrowsError(try boom()) { error in XCTAssertTrue(error is Oops) }
        try XCTAssertThrowsError(try boom(), "handler throws") { (error: Error) throws in throw error }
    }

    func testUnwrap() throws {
        XCTAssertEqual(try XCTUnwrap(Optional(3)), 3)
        _ = try XCTUnwrap(nil as String?, "nothing there")
        XCTFail("not reached")
    }

    func testThrows() throws {
        throw Oops()
    }
}

final class Lifecycle: XCTestCase {
    nonisolated(unsafe) static var log: [String] = []

    override class func setUp() { log.append("class setUp") }
    override class func tearDown() {
        log.append("class tearDown")
        print(log.joined(separator: ", "))
    }
    override func setUp() async throws { Self.log.append("setUp async") }
    override func setUpWithError() throws { Self.log.append("setUpWithError") }
    override func setUp() { Self.log.append("setUp") }
    override func tearDown() { Self.log.append("tearDown") }
    override func tearDownWithError() throws { Self.log.append("tearDownWithError") }
    override func tearDown() async throws { Self.log.append("tearDown async") }

    func testOrder() {
        Self.log.append("test \(name)")
        addTeardownBlock { Self.log.append("teardown block 1") }
        addTeardownBlock { Self.log.append("teardown block 2") }
    }

    func testAsync() async throws {
        Self.log.append("async test")
        XCTAssertEqual(name, "Lifecycle.testAsync")
    }

    func testSkipped() throws {
        try XCTSkipIf(true, "not today")
        XCTFail("not reached")
    }

    func testSkippedUnless() throws {
        try XCTSkipUnless(false)
    }

    func testSkip() throws {
        throw XCTSkip("thrown")
    }
}

final class FailingSetUp: XCTestCase {
    override func setUpWithError() throws { throw Oops() }
    func testNeverRuns() { XCTFail("not reached") }
}

final class SkippingSetUp: XCTestCase {
    override func setUpWithError() throws { throw XCTSkip("whole class") }
    func testNeverRuns() { XCTFail("not reached") }
}

let behaviourTests = [
    testCase([
        ("testPassing", Assertions.testPassing),
        ("testFailing", Assertions.testFailing),
        ("testThrowingExpressions", Assertions.testThrowingExpressions),
        ("testUnwrap", Assertions.testUnwrap),
        ("testThrows", Assertions.testThrows),
    ] as [(String, (Assertions) -> () throws -> Void)]),
    testCase([
        ("testOrder", Lifecycle.testOrder),
        ("testAsync", asyncTest(Lifecycle.testAsync)),
        ("testSkipped", Lifecycle.testSkipped),
        ("testSkippedUnless", Lifecycle.testSkippedUnless),
        ("testSkip", Lifecycle.testSkip),
    ] as [(String, (Lifecycle) -> () throws -> Void)]),
    testCase([("testNeverRuns", FailingSetUp.testNeverRuns)]),
    testCase([("testNeverRuns", SkippingSetUp.testNeverRuns)]),
]
