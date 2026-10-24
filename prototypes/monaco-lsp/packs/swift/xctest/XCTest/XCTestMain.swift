// XCTMain: runs the tests and prints corelibs' report (PrintObserver), then
// exits with 0 if nothing failed and 1 otherwise.
//
// The two overloads kept are corelibs' Linux ones, synchronous and `-> Never`.
// Left out: `XCTMain(_:arguments:observers:)` in both forms, because
// XCTestObservation's methods take Foundation's Bundle. The WASI build of
// corelibs declares the same three functions `async`; this module follows
// Linux, where students' tests are graded.
//
// Timestamps are UTC: WASI has no time zone (the real XCTest on WASI prints
// UTC as well); durations come from the monotonic clock.
//
// No libc module is imported, on purpose: `import WASILibc` here would make
// every `import XCTest` load WASILibc and parse wasi-libc's headers, which
// measured 0.7 s of each compile in the browser. The three C functions used
// are declared directly instead (`@_extern(c)`, the Extern feature that
// swift-corelibs-xctest enables too).

@_extern(c, "exit") private func cExit(_ status: Int32) // `Never` cannot be written in a C declaration
@_extern(c, "fflush") private func cFlush(_ stream: OpaquePointer?) -> Int32
/// `struct timeval` is two 64-bit integers on wasm32-wasi and on 64-bit Linux.
@_extern(c, "gettimeofday") private func cTimeOfDay(_ tv: UnsafeMutablePointer<Int64>, _ tz: UnsafeMutableRawPointer?) -> Int32

/// The concurrency runtime's loop that an `async` main runs on. Calling it
/// from the synchronous XCTMain lets the tests run in a Task (for async
/// setUp, tearDown and tests) on the program's only thread; it never
/// returns, the Task ends the process with exit().
@_silgen_name("swift_task_asyncMainDrainQueue")
private func drainMainQueue() -> Never

/// Prints one line of the report and flushes it (fflush(NULL): every C
/// stream), so the browser shows a test as started before it finishes.
func _output(_ line: String) {
    print(line)
    _ = cFlush(nil)
}

// @available(*, deprecated, message: "Call the overload of XCTMain() that returns an exit code instead.")
public func XCTMain(_ testCases: [XCTestCaseEntry]) -> Never {
    XCTMain(testCases, arguments: CommandLine.arguments)
}

/// `arguments[1]`, if present, selects tests as corelibs does: `Class` or
/// `Class/testMethod` (a `Module.` prefix is accepted and ignored).
public func XCTMain(_ testCases: [XCTestCaseEntry], arguments: [String]) -> Never {
    var selected = testCases
    var root = "All tests"
    if arguments.count > 1 {
        let parts = arguments[1].split(separator: "/", maxSplits: 1).map(String.init)
        let className = parts[0].split(separator: ".").last.map(String.init) ?? parts[0]
        selected = testCases.compactMap { entry in
            guard String(describing: entry.testCaseClass) == className else { return nil }
            guard parts.count == 2 else { return entry }
            return (entry.testCaseClass, entry.allTests.filter { $0.0 == parts[1] })
        }
        root = "Selected tests"
    }
    let program = arguments.first.flatMap { $0.split(separator: "/").last }.map(String.init) ?? "main"
    let tests = selected
    Task {
        var all = Tally()
        if root == "Selected tests" {
            all = await runSuite(root) { await runClasses(tests) }
        } else {
            all = await runSuite(root) {
                await runSuite("\(program).xctest") { await runClasses(tests) }
            }
        }
        cExit(all.failures + all.unexpected == 0 ? 0 : 1)
        fatalError("exit returned")
    }
    drainMainQueue()
}

/// What a suite reports in its summary line.
private struct Tally {
    var executed = 0, skipped = 0, failures = 0, unexpected = 0
    var testSeconds = 0.0

    static func += (a: inout Tally, b: Tally) {
        a.executed += b.executed
        a.skipped += b.skipped
        a.failures += b.failures
        a.unexpected += b.unexpected
        a.testSeconds += b.testSeconds
    }
}

private func runClasses(_ entries: [XCTestCaseEntry]) async -> Tally {
    var tally = Tally()
    for entry in entries {
        tally += await runSuite(String(describing: entry.testCaseClass)) {
            entry.testCaseClass.setUp()
            var tally = Tally()
            for (name, closure) in entry.allTests {
                tally += await runCase(entry.testCaseClass.init(name: name, testClosure: closure))
            }
            entry.testCaseClass.tearDown()
            return tally
        }
    }
    return tally
}

private func runSuite(_ name: String, _ body: () async -> Tally) async -> Tally {
    let start = ContinuousClock.now
    _output("Test Suite '\(name)' started at \(timestamp())")
    let tally = await body()
    let total = seconds(ContinuousClock.now - start)
    let failed = tally.failures + tally.unexpected
    _output("Test Suite '\(name)' \(failed == 0 ? "passed" : "failed") at \(timestamp())")
    let tests = tally.executed == 1 ? "test" : "tests"
    let skipped = tally.skipped > 0 ? "\(tally.skipped) test\(tally.skipped != 1 ? "s" : "") skipped and " : ""
    let failures = failed == 1 ? "failure" : "failures"
    _output("\t Executed \(tally.executed) \(tests), with \(skipped)\(failed) \(failures) (\(tally.unexpected) unexpected) in \(format(tally.testSeconds)) (\(format(total))) seconds")
    return tally
}

private func runCase(_ test: XCTestCase) async -> Tally {
    _output("Test Case '\(test.name)' started at \(timestamp())")
    let start = ContinuousClock.now
    await test.runTest()
    let duration = seconds(ContinuousClock.now - start)
    let failed = test.failureCount + test.unexpectedFailureCount > 0
    let verb = failed ? "failed" : test.skip != nil ? "skipped" : "passed"
    _output("Test Case '\(test.name)' \(verb) (\(format(duration)) seconds)")
    return Tally(executed: 1, skipped: test.skip != nil ? 1 : 0, failures: test.failureCount,
                 unexpected: test.unexpectedFailureCount, testSeconds: duration)
}

private func seconds(_ d: Duration) -> Double {
    Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18
}

/// corelibs' formatTimeInterval: milliseconds, printed as a Double ("0.001", "0.0").
private func format(_ seconds: Double) -> String {
    String((seconds * 1000).rounded() / 1000)
}

/// "yyyy-MM-dd HH:mm:ss.SSS", as corelibs' date formatter, in UTC.
private func timestamp() -> String {
    var tv: (Int64, Int64) = (0, 0)
    _ = withUnsafeMutableBytes(of: &tv) { cTimeOfDay($0.baseAddress!.assumingMemoryBound(to: Int64.self), nil) }
    let (seconds, micros) = tv
    // Days since 1970-01-01 to a civil date (Howard Hinnant's days_from_civil, inverted).
    let days = seconds >= 0 ? seconds / 86400 : (seconds - 86399) / 86400
    let secondOfDay = seconds - days * 86400
    let z = days + 719468
    let era = (z >= 0 ? z : z - 146096) / 146097
    let dayOfEra = z - era * 146097
    let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365
    let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    let mp = (5 * dayOfYear + 2) / 153
    let day = dayOfYear - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
    func pad(_ n: Int64, _ width: Int) -> String {
        let s = String(n)
        return String(repeating: "0", count: max(0, width - s.count)) + s
    }
    return "\(pad(year, 4))-\(pad(month, 2))-\(pad(day, 2)) "
        + "\(pad(secondOfDay / 3600, 2)):\(pad(secondOfDay / 60 % 60, 2)):\(pad(secondOfDay % 60, 2)).\(pad(micros / 1000, 3))"
}
