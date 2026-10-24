// XCTest and XCTestCase: the public declarations of corelibs'
// XCAbstractTest.swift and XCTestCase.swift that need no Foundation, with
// their signatures unchanged. Left out, because their types are Foundation's
// or exist to observe a run (XCTestRun's dates, XCTestSuite, observers):
// testRun, testRunClass, perform(_:), run(), invokeTest(), the expectation
// and waiter API (TimeInterval), measure (XCTPerformanceMetric).
//
// One behaviour differs from corelibs on Linux and matches corelibs on WASI:
// tests run inside a Task (see XCTMain), so `setUp() async throws`,
// `tearDown() async throws`, async teardown blocks and `asyncTest` work on a
// single thread without XCTWaiter.

/// An abstract base class for testing. `XCTestCase` extends it.
open class XCTest {
    /// Test's name. Must be overridden by subclasses.
    open var name: String {
        fatalError("Must be overridden by subclasses.")
    }

    /// Number of test cases. Must be overridden by subclasses.
    open var testCaseCount: Int {
        fatalError("Must be overridden by subclasses.")
    }

    /// Async setup method called before the invocation of `setUpWithError` for each test method in the class.
    @available(macOS 12.0, *)
    open func setUp() async throws {}
    /// Setup method called before the invocation of `setUp` and the test method
    /// for each test method in the class.
    open func setUpWithError() throws {}

    /// Setup method called before the invocation of each test method in the
    /// class.
    open func setUp() {}

    /// Teardown method called after the invocation of each test method in the
    /// class.
    open func tearDown() {}

    /// Teardown method called after the invocation of the test method and `tearDown`
    /// for each test method in the class.
    open func tearDownWithError() throws {}

    /// Async teardown method which is called after the invocation of `tearDownWithError`
    /// for each test method in the class.
    @available(macOS 12.0, *)
    open func tearDown() async throws {}

    public init() {}
}

/// A block with the test code to be invoked when the test runs.
public typealias XCTestCaseClosure = (XCTestCase) throws -> Void

/// A test case class and its tests, as `testCase(_:)` makes it for `XCTMain`.
public typealias XCTestCaseEntry = (testCaseClass: XCTestCase.Type, allTests: [(String, XCTestCaseClosure)])

/// The test being run, which assertions report to. One at a time: the
/// browser runs tests on one thread, and so does corelibs.
nonisolated(unsafe) var _currentTestCase: XCTestCase?

/// An instance of this class represents an individual test case which can be
/// run by the framework. This class is normally subclassed and extended with
/// methods containing the tests to run.
open class XCTestCase: XCTest {
    private final let testClosure: XCTestCaseClosure
    private final var _name: String

    // What the runner reads after the test (XCTestMain.swift). `final`
    // keeps these internal members out of the vtable: a subclass in the
    // student's module would otherwise reference their (unexported) accessors.
    final var failureCount = 0
    final var unexpectedFailureCount = 0
    final var skip: XCTSkip?
    /// Set by an `asyncTest` closure: the test's body, awaited by the runner.
    final var asyncBody: Task<Void, Error>?
    private final var teardownBlocks: [() async throws -> Void] = []

    /// The name of the test case, consisting of its class name and the method
    /// name it will run.
    open override var name: String {
        return _name
    }

    open override var testCaseCount: Int {
        return 1
    }

    /// The designated initializer; `XCTMain` calls it once per test method.
    public required init(name: String, testClosure: @escaping XCTestCaseClosure) {
        _name = "\(type(of: self)).\(name)"
        self.testClosure = testClosure
    }

    /// Records a failure in the execution of the test and is used by all test
    /// assertions. `expected` is false for an error thrown where an assertion
    /// expected a value (counted as "unexpected" in the summary).
    open func recordFailure(withDescription description: String, inFile filePath: String, atLine lineNumber: Int, expected: Bool) {
        if expected { failureCount += 1 } else { unexpectedFailureCount += 1 }
        _output("\(filePath):\(lineNumber): error: \(name) : \(description)")
    }

    /// Setup method called before the invocation of any test method in the
    /// class.
    open class func setUp() {}

    /// Teardown method called after the invocation of every test method in the
    /// class.
    open class func tearDown() {}

    /// Registers a block of teardown code to be run after the current test
    /// method ends.
    open func addTeardownBlock(_ block: @escaping () -> Void) {
        teardownBlocks.append(block)
    }

    /// Registers a block of teardown code to be run after the current test
    /// method ends.
    @available(macOS 12.0, *)
    public func addTeardownBlock(_ block: @Sendable @escaping () async throws -> Void) {
        teardownBlocks.append(block)
    }

    /// Always true, and setting it does nothing: corelibs' behaviour, because
    /// Swift cannot stop a test at a failed assertion without crashing.
    open var continueAfterFailure: Bool {
        get {
            return true
        }
        set {}
    }

    /// One test, in corelibs' order: async setUp, setUpWithError, setUp, the
    /// test (unless setUp skipped it), teardown blocks last-in first-out,
    /// tearDown, tearDownWithError, async tearDown.
    final func runTest() async {
        _currentTestCase = self
        defer { _currentTestCase = nil }
        do { try await setUp() } catch { setUpFailed(error) }
        syncSetUp()
        if skip == nil {
            do {
                try testClosure(self)
                if let body = asyncBody { try await body.value }
            } catch let error as XCTSkip {
                skip = error
            } catch is UnwrappedNil {
                // XCTUnwrap has recorded it
            } catch {
                recordThrown(error)
            }
        }
        if let skip {
            _output("\(skip.file ?? "<unknown>"):\(skip.line): \(name) : \(skip.summary)")
        }
        for block in teardownBlocks.reversed() {
            do { try await block() } catch { recordThrown(error) }
        }
        teardownBlocks = []
        syncTearDown()
        do { try await tearDown() } catch { recordThrown(error) }
    }

    // In an async function a bare `setUp()` would pick the async overload;
    // these synchronous wrappers call the synchronous ones (as corelibs does).
    private final func syncSetUp() {
        do { try setUpWithError() } catch { setUpFailed(error) }
        setUp()
    }

    private final func syncTearDown() {
        tearDown()
        do { try tearDownWithError() } catch { recordThrown(error) }
    }

    /// corelibs: an error from a setUp records a failure (unless it is a
    /// skip) and skips the test, with "threw error" as the skip's reason.
    private final func setUpFailed(_ error: Error) {
        if let skip = error as? XCTSkip {
            self.skip = self.skip ?? skip
            return
        }
        recordThrown(error)
        skip = skip ?? XCTSkip(explanation: "threw error \"\(error)\"", message: nil, file: nil, line: 0)
    }

    /// An error escaping the test: corelibs records it at "<EXPR>:0".
    private final func recordThrown(_ error: Error) {
        recordFailure(withDescription: "threw error \"\(error)\"", inFile: "<EXPR>", atLine: 0, expected: false)
    }
}

/// Wrapper function allowing an array of static test case methods to fit
/// the signature required by `XCTMain`
/// - seealso: `XCTMain`
public func testCase<T: XCTestCase>(_ allTests: [(String, (T) -> () throws -> Void)]) -> XCTestCaseEntry {
    return (T.self, allTests.map { ($0.0, closure($0.1)) })
}

/// Wrapper function for the non-throwing variant of tests.
/// - seealso: `XCTMain`
public func testCase<T: XCTestCase>(_ allTests: [(String, (T) -> () -> Void)]) -> XCTestCaseEntry {
    return (T.self, allTests.map { ($0.0, closure($0.1)) })
}

private func closure<T: XCTestCase>(_ method: @escaping (T) -> () throws -> Void) -> XCTestCaseClosure {
    return { test in
        guard let test = test as? T else {
            fatalError("Attempt to invoke test on class \(T.self) with incompatible instance type \(type(of: test))")
        }
        try method(test)()
    }
}

/// Makes an async test method fit `testCase(_:)`: `("testX", asyncTest(testX))`.
/// The returned closure starts the test in a Task, which the runner awaits.
@available(macOS 12.0, *)
public func asyncTest<T: XCTestCase>(
    _ testClosureGenerator: @escaping (T) -> () async throws -> Void
) -> (T) -> () throws -> Void {
    return { (test: T) in
        let body = testClosureGenerator(test)
        return {
            precondition(test.asyncBody == nil, "Async test case \(test) cannot be run more than once")
            test.asyncBody = Task { try await body() }
        }
    }
}
