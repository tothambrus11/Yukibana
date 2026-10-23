// Headless test of the Swift runner (../CONTRACT.md, "Running a program"),
// run the way the app runs it: app/static served over http WITH
// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy, so the page is
// crossOriginIsolated; `new Worker('/packs/swift/runner.js', { type: 'module' })`
// in Chromium; one { type: 'run' } message; stdin through the
// SharedArrayBuffer protocol, driven from the page as the app's terminal does.
//
//   node test-run.mjs        (after ./build.sh; needs playwright-core)
//
// Cases: the app's sample project (languages.ts, main.swift + Geometry.swift)
// cold (empty caches) and warm (the downloads in Cache Storage, through a
// service worker that does for /packs/ what the app's does), a prompt without newline and
// two lines read with readLine(), end of input, a type error (on stderr,
// non-zero exit, nothing run), a runtime trap, and a program that never
// ends, which the page stops by terminating the worker.
//
// Adapted from ../cpp/test-run.mjs.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';

const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.tar': 'application/x-tar', '.html': 'text/html' };
const ISOLATION = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
};

// Static files with the isolation headers, serving the .br sibling when the
// browser accepts brotli, as the app's host does; cacheable, so the second
// run measures a warm cache.
let bytesSent = 0;
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION });
        res.end('<!doctype html><link rel=icon href="data:,"><title>swift runner test</title>');
        return;
    }
    if (path === '/__sw.js') {
        // What the app's service worker does for /packs/** (app/src/service-worker):
        // cache-first in Cache Storage, filled on the first download.
        res.writeHead(200, { 'content-type': 'text/javascript', ...ISOLATION });
        res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
    if (!new URL(e.request.url).pathname.startsWith('/packs/')) return;
    e.respondWith((async () => {
        const cache = await caches.open('packs');
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const response = await fetch(e.request);
        if (response.ok) e.waitUntil(cache.put(e.request, response.clone()));
        return response;
    })());
});`);
        return;
    }
    const file = normalize(join(STATIC, path));
    try {
        if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
        const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600', ...ISOLATION };
        let body;
        if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '') && !file.endsWith('.gz')) {
            try {
                body = await readFile(file + '.br');
                headers['content-encoding'] = 'br';
            } catch {}
        }
        body ??= await readFile(file);
        headers['content-length'] = body.length;
        bytesSent += body.length;
        res.writeHead(200, headers).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

// The sample project of app/src/lib/languages.ts, read from there so the test
// runs exactly what a new project contains.
const languages = await readFile(resolve(HERE, '../../app/src/lib/languages.ts'), 'utf8');
const SAMPLE = sampleOf(languages, 'swift');

const STDIN = {
    'main.swift': `print("first number: ", terminator: "")
let a = Int(readLine()!)!
print("second number: ", terminator: "")
let b = Int(readLine()!)!
print("sum: \\(a + b)")
`,
};
const EOF = {
    'main.swift': `var lines = 0
while let line = readLine() {
    lines += 1
    print("got \\(line)")
}
print("end of input after \\(lines) lines")
`,
};
const TYPE_ERROR = { 'main.swift': 'let x: Int = "no"\nprint(x)\n' };
const TRAP = { 'main.swift': 'let empty: [Int] = []\nprint("before")\nprint(empty[1])\n' };
const FOREVER = { 'main.swift': 'print("looping")\nvar i = 0\nwhile true { i &+= 1 }\n' };

const browser = await chromium.launch({ executablePath: CHROMIUM });
let failed = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (m) => process.env.VERBOSE && console.log('[page]', m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/__test.html`);
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/__sw.js');
        await navigator.serviceWorker.ready;
    });
    await page.reload();
    check('the page is crossOriginIsolated and controlled by a service worker that caches /packs/',
        await page.evaluate(() => crossOriginIsolated && !!navigator.serviceWorker.controller));

    // In the page: start the runner, answer stdin requests from `inputs` (one
    // line each, then end of file), optionally terminate it after the program
    // printed `stopAfter`. Resolves with what came back and when.
    await page.evaluate(() => {
        window.runProject = (files, { inputs = [], stopAfter = null, entry = 'main.swift', type = 'run' } = {}) =>
            new Promise((done) => {
                const t0 = performance.now();
                const result = { stdout: '', stderr: '', code: null, phases: [], loading: {}, stdinRequests: 0, stdoutBeforeInput: [], terminated: false };
                const sab = new SharedArrayBuffer(8 + 65536);
                const state = new Int32Array(sab, 0, 2);
                const data = new Uint8Array(sab, 8);
                const worker = new Worker('/packs/swift/runner.js', { type: 'module' });
                const finish = () => {
                    result.ms = Math.round(performance.now() - t0);
                    done(result);
                };
                worker.onerror = (e) => {
                    result.stderr += `worker error: ${e.message}\n`;
                    finish();
                };
                worker.onmessage = ({ data: m }) => {
                    const at = Math.round(performance.now() - t0);
                    if (m.type === 'stdout') result.stdout += m.text;
                    else if (m.type === 'stderr') result.stderr += m.text;
                    else if (m.type === 'phase') result.phases.push([m.text, at]);
                    else if (m.type === 'loading') result.loading[m.label] = [m.loaded, m.total];
                    else if (m.type === 'stdin') {
                        // What the terminal shows when the program asks.
                        result.stdinRequests++;
                        result.stdoutBeforeInput.push(result.stdout);
                        const line = inputs.shift();
                        if (Atomics.load(state, 0) !== 1) result.stderr += 'stdin requested with state != 1\n';
                        if (line === undefined) Atomics.store(state, 0, 3);
                        else {
                            const bytes = new TextEncoder().encode(line + '\n');
                            data.set(bytes);
                            Atomics.store(state, 1, bytes.length);
                            Atomics.store(state, 0, 2);
                        }
                        Atomics.notify(state, 0);
                    } else if (m.type === 'exit') {
                        result.code = m.code;
                        worker.terminate();
                        finish();
                    }
                    if (stopAfter && m.type === 'stdout' && result.stdout.includes(stopAfter)) {
                        // Let it spin a moment, then Stop as the app does.
                        setTimeout(() => {
                            worker.terminate();
                            result.terminated = true;
                            finish();
                        }, 1000);
                    }
                };
                worker.postMessage({ type, files, entry, stdin: sab });
            });
    });

    const run = (files, opts) => page.evaluate(([f, o]) => window.runProject(f, o), [files, opts ?? {}]);
    const timeline = (r) => r.phases.map(([t, ms]) => `${t}@${ms}`).join(', ');

    // 1. The sample, cold then warm.
    const EXPECTED = '(0.0, 0.0) to (3.0, 4.0): 5.0\n5.0\n';
    bytesSent = 0;
    const cold = await run(SAMPLE);
    const coldBytes = bytesSent;
    check(
        'sample project (cold): main.swift + Geometry.swift print the distance and the norm, exit 0',
        cold.code === 0 && cold.stdout === EXPECTED,
        `${JSON.stringify(cold.stdout)} code=${cold.code} in ${cold.ms} ms, ${(coldBytes / 1e6).toFixed(1)} MB transferred; ${timeline(cold)}`
    );
    if (cold.stderr) console.log(cold.stderr);
    const loads = Object.entries(cold.loading).map(([k, [l, t]]) => `${k} ${l}/${t}`);
    check('loading messages for each download', loads.length === 3 && Object.values(cold.loading).every(([l, t]) => l === t && l > 0), loads.join(', '));
    for (let i = 1; i <= 2; i++) {
        bytesSent = 0;
        const warm = await run(SAMPLE);
        check(
            `sample project (warm #${i}): same output from the browser cache`,
            warm.code === 0 && warm.stdout === EXPECTED,
            `code=${warm.code} in ${warm.ms} ms, ${bytesSent} bytes transferred; ${timeline(warm)}`
        );
    }

    // 2. stdin: the prompt must be visible before the program waits.
    const r = await run(STDIN, { inputs: ['19', '23'] });
    check(
        'readLine(): prompt without newline, two lines of stdin, their sum',
        r.code === 0 &&
            r.stdout === 'first number: second number: sum: 42\n' &&
            r.stdinRequests === 2 &&
            r.stdoutBeforeInput[0] === 'first number: ' &&
            r.stdoutBeforeInput[1] === 'first number: second number: ',
        `${JSON.stringify(r.stdout)} requests=${r.stdinRequests} seen-before-input=${JSON.stringify(r.stdoutBeforeInput)} code=${r.code} ${r.ms} ms; ${timeline(r)}`
    );
    if (r.stderr) console.log(r.stderr);
    const eof = await run(EOF, { inputs: ['one', 'two'] });
    check('end of input (Ctrl-D) makes readLine() return nil', eof.code === 0 && eof.stdout === 'got one\ngot two\nend of input after 2 lines\n' && eof.stdinRequests === 3,
        `code=${eof.code} ${JSON.stringify(eof.stdout)} requests=${eof.stdinRequests}`);

    // 3. A type error: on stderr, non-zero exit, nothing run.
    const broken = await run(TYPE_ERROR);
    check(
        'type error: swift-frontend diagnostics on stderr, non-zero exit, not run',
        broken.code !== 0 && /^main\.swift:1:14: error: cannot convert value of type 'String' to specified type 'Int'/m.test(broken.stderr) && broken.stdout === '' && !broken.phases.some(([t]) => t === 'Running'),
        `code=${broken.code} ${broken.ms} ms\n${broken.stderr.trimEnd()}`
    );

    // 4. A runtime error: Swift's message, then the trap.
    const trap = await run(TRAP);
    check('runtime error: index out of range is reported and exits non-zero',
        trap.code !== 0 && trap.stdout === 'before\n' && /Fatal error: Index out of range/.test(trap.stderr),
        `code=${trap.code} ${JSON.stringify(trap.stdout)}\n${trap.stderr.trimEnd()}`);

    // 5. A program that never ends: the page terminates the worker.
    const t = Date.now();
    const forever = await run(FOREVER, { stopAfter: 'looping' });
    const alive = await page.evaluate(() => 1 + 1);
    check(
        'endless loop: terminated by the page, which stays responsive',
        forever.terminated && forever.code === null && forever.stdout === 'looping\n' && alive === 2,
        `stopped after ${Date.now() - t} ms; ${timeline(forever)}`
    );

    // 6. XCTest: { type: 'test' } runs the project's tests with the browser's XCTest.
    // a. The behaviour corpus: the report must be the real XCTest's, line for
    //    line (xctest/conformance/Behaviour.expected, from swift-corelibs-xctest
    //    by tools/xctest-subset.mjs), with dates, times and the bundle blanked.
    const normal = (text) => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/g, 'DATE').replace(/\(\d+(\.\d+)? seconds\)/g, '(T seconds)')
        .replace(/in \d+(\.\d+)? \(\d+(\.\d+)?\) seconds/g, 'in T (T) seconds').replace(/^Test Suite '[^']*\.xctest'/gm, "Test Suite 'BUNDLE.xctest'");
    const golden = await readFile(resolve(HERE, 'xctest/conformance/Behaviour.expected'), 'utf8');
    bytesSent = 0;
    const behaviour = await run({ 'Behaviour.swift': await readFile(resolve(HERE, 'xctest/conformance/Behaviour.swift'), 'utf8') }, { type: 'test' });
    const got = normal(behaviour.stdout).split('\n');
    const want = golden.split('\n');
    const firstDiff = want.findIndex((line, i) => got[i] !== line);
    check(
        'XCTest: the behaviour corpus prints exactly what swift-corelibs-xctest prints (assertion texts, skips, setUp/tearDown order, async, summaries) and exits 1',
        behaviour.code === 1 && firstDiff === -1 && got.length === want.length && behaviour.stderr === '',
        `${want.length - 1} lines, code=${behaviour.code} in ${behaviour.ms} ms, swift-xctest.tar ${JSON.stringify(behaviour.loading['swift-xctest.tar'])}; ${timeline(behaviour)}` +
            (firstDiff >= 0 ? `\n  first difference at line ${firstDiff + 1}:\n  want ${want[firstDiff]}\n  got  ${got[firstDiff]}` : '') +
            (behaviour.stderr ? `\n${behaviour.stderr}` : ''),
    );
    console.log(behaviour.stdout.split('\n').filter((l) => / error: |skipped|Executed|^\[|^class/.test(l)).slice(0, 8).map((l) => `      ${l}`).join('\n'));

    // b. A student project as SwiftPM lays it out: code, a main.swift, and
    //    tests that `@testable import Calc`. Discovery, setUp/tearDown, a
    //    throwing test, XCTUnwrap, accuracy, XCTAssertThrowsError, async.
    const CALC = {
        'main.swift': 'print(Calculator().add(2, 3))\n',
        'Calculator.swift': `enum CalcError: Error { case divisionByZero }
struct Calculator {
    func add(_ a: Int, _ b: Int) -> Int { a + b }
    func divide(_ a: Double, _ b: Double) throws -> Double {
        guard b != 0 else { throw CalcError.divisionByZero }
        return a / b
    }
    func slowAdd(_ a: Int, _ b: Int) async -> Int { await Task.yield(); return a + b }
}
`,
        'Tests/CalculatorTests.swift': `import XCTest
@testable import Calc

final class CalculatorTests: XCTestCase {
    var calculator: Calculator!
    var events: [String] = []

    override func setUp() { calculator = Calculator(); events.append("setUp") }
    override func tearDown() { events.append("tearDown"); print("\\(name): \\(events)") }

    func testAdd() { events.append("test"); XCTAssertEqual(calculator.add(2, 3), 5) }
    func testDivide() throws { XCTAssertEqual(try calculator.divide(1, 3), 0.333, accuracy: 0.001) }
    func testDivideByZero() {
        XCTAssertThrowsError(try calculator.divide(1, 0)) { XCTAssertEqual($0 as? CalcError, .divisionByZero) }
    }
    func testUnwrap() throws { XCTAssertEqual(try XCTUnwrap(Int("42")), 42) }
    func testAsync() async throws { let sum = await calculator.slowAdd(1, 2); XCTAssertEqual(sum, 3) }
}
`,
    };
    const calc = await run(CALC, { type: 'test' });
    check(
        'XCTest: discovered tests pass (`@testable import Calc` names the module), setUp/tearDown around each, exit 0, nothing on stderr',
        calc.code === 0 && /Executed 5 tests, with 0 failures \(0 unexpected\)/.test(calc.stdout) && calc.stderr === '' &&
            calc.stdout.includes('CalculatorTests.testAdd: ["setUp", "test", "tearDown"]') &&
            ['testAdd', 'testDivide', 'testDivideByZero', 'testUnwrap', 'testAsync'].every((t) => calc.stdout.includes(`Test Case 'CalculatorTests.${t}' passed`)),
        `code=${calc.code} in ${calc.ms} ms; ${timeline(calc)}\n${calc.stderr}${calc.stdout.split('\n').filter((l) => /Executed|testAdd:/.test(l)).slice(0, 2).map((l) => `      ${l}`).join('\n')}`,
    );
    const calcRun = await run(CALC);
    check("XCTest: 'run' of the same project runs the program, without its tests", calcRun.code === 0 && calcRun.stdout === '5\n' && calcRun.stderr === '' && !('swift-xctest.tar' in calcRun.loading),
        `${JSON.stringify(calcRun.stdout)} code=${calcRun.code}`);

    const failing = await run({
        ...CALC,
        'Tests/CalculatorTests.swift': `import XCTest
@testable import Calc

final class CalculatorTests: XCTestCase {
    func testAdd() { XCTAssertEqual(Calculator().add(2, 2), 5, "two and two") }
    func testDivide() throws { XCTAssertEqual(try Calculator().divide(1, 3), 0.3, accuracy: 0.001) }
    func testThrows() throws { _ = try Calculator().divide(1, 0) }
    func testUnwrap() throws { _ = try XCTUnwrap(Int("forty-two")); XCTFail("not reached") }
    func testPasses() {}
}
`,
    }, { type: 'test' });
    const expectLines = [
        `Tests/CalculatorTests.swift:5: error: CalculatorTests.testAdd : XCTAssertEqual failed: ("4") is not equal to ("5") - two and two`,
        `Tests/CalculatorTests.swift:6: error: CalculatorTests.testDivide : XCTAssertEqual failed: ("0.3333333333333333") is not equal to ("0.3") +/- ("0.001") - `,
        `<EXPR>:0: error: CalculatorTests.testThrows : threw error "divisionByZero"`,
        `Tests/CalculatorTests.swift:8: error: CalculatorTests.testUnwrap : XCTUnwrap failed: expected non-nil value of type "Int" - `,
        `Test Case 'CalculatorTests.testPasses' passed`,
        `\t Executed 5 tests, with 4 failures (1 unexpected) in`,
    ];
    check('XCTest: failures as file:line: error: Class.test : message, project-relative; a thrown error is unexpected; exit 1',
        failing.code === 1 && expectLines.every((l) => failing.stdout.includes(l)),
        `code=${failing.code}\n${failing.stdout.split('\n').filter((l) => / error: |Executed/.test(l)).slice(0, 6).map((l) => `      ${l}`).join('\n')}`);

    // c. Discovery: comments, strings, inheritance, extensions, nesting, and
    //    what must not be taken for a test.
    const discovery = await run({
        'main.swift': 'print("not run by a test run")\n',
        'Discovery.swift': `import XCTest

/* class Fake: XCTestCase { func testInComment() {} } /* nested */ func testAlsoComment() {} */
// final class Commented: XCTestCase { func testInLineComment() {} }
let decoy = "class Decoy: XCTestCase { func testInString() {} }"
let raw = #"func testInRaw() { "\\(x)" } \\#(decoy.count) "#
let multi = """
    final class InMultiline: XCTestCase { func testInMultiline() {} }
    \\(decoy.filter { $0 == "}" }.count)
    """

class BaseTests: XCTestCase {
    func testFromBase() {}
    func helper() { XCTFail("helper is not a test") }
    func testWithArgument(_ x: Int) { XCTFail("has an argument") }
    static func testStatic() {}
    private func testPrivate() { XCTFail("private") }
    func testReturning() -> Int { XCTFail("returns a value"); return 1 }
}

final class DerivedTests: BaseTests {
    func testOwn() { XCTAssertTrue(true) }
    func \`testBackticked\`() {}
}

extension DerivedTests {
    func testInExtension() async throws {}
}

enum Outer {
    final class NestedTests: XCTestCase {
        func testNested() { XCTAssertEqual(name, "NestedTests.testNested") }
    }
}

final class GenericTests<T>: XCTestCase { func testGeneric() {} }
`,
    }, { type: 'test' });
    const ran = [...discovery.stdout.matchAll(/^Test Case '([^']+)' (passed|failed)/gm)].map((m) => `${m[1]} ${m[2]}`);
    const wantRan = ['BaseTests.testFromBase passed', 'DerivedTests.testOwn passed', 'DerivedTests.testBackticked passed',
        'DerivedTests.testInExtension passed', 'DerivedTests.testFromBase passed', 'NestedTests.testNested passed'];
    check('XCTest discovery: own, inherited, extension, backticked, nested and async tests; nothing from comments, strings, helpers, arguments, static, private, generic',
        discovery.code === 0 && JSON.stringify(ran) === JSON.stringify(wantRan) && !discovery.stdout.includes('not run'),
        `code=${discovery.code} ${JSON.stringify(ran)}\n${discovery.stderr}`);

    // d. A student file with its own allTests, as the real XCTest on Linux
    //    wants it: the list is used as written, not rediscovered.
    const LISTED = `import XCTest

final class ListedTests: XCTestCase {
    static var allTests = [
        ("testListed", testListed),
    ]
    func testListed() { XCTAssertEqual(1 + 1, 2) }
    func testNotListed() { XCTFail("not in allTests") }
}
`;
    const listed = await run({ 'Tests/ListedTests.swift': LISTED, 'main.swift': 'print("program")\n' }, { type: 'test' });
    check('XCTest: a class with its own allTests runs exactly that list',
        listed.code === 0 && listed.stdout.includes("Test Case 'ListedTests.testListed' passed") && !listed.stdout.includes('testNotListed') && /Executed 1 test, with 0 failures/.test(listed.stdout),
        `code=${listed.code}\n${listed.stderr}`);
    const ownMain = await run({
        'Tests/ListedTests.swift': LISTED,
        'main.swift': 'import XCTest\n\nprint("hand-written main")\nXCTMain([testCase(ListedTests.allTests)])\n',
    }, { type: 'test' });
    check('XCTest: a main.swift that calls XCTMain itself (LinuxMain style) is used instead of a generated one',
        ownMain.code === 0 && ownMain.stdout.startsWith('hand-written main\n') && ownMain.stdout.includes("Test Case 'ListedTests.testListed' passed"),
        `code=${ownMain.code} ${JSON.stringify(ownMain.stdout.slice(0, 60))}\n${ownMain.stderr}`);

    const ownMainRun = await run({
        'Tests/ListedTests.swift': LISTED,
        'main.swift': 'import XCTest\n\nprint("hand-written main")\nXCTMain([testCase(ListedTests.allTests)])\n',
    });
    check("XCTest: 'run' of that project runs its main.swift with the tests it names",
        ownMainRun.code === 0 && ownMainRun.stdout.startsWith('hand-written main\n') && ownMainRun.stdout.includes("Test Case 'ListedTests.testListed' passed"),
        `code=${ownMainRun.code}\n${ownMainRun.stderr}`);

    // e. A test that does not compile: diagnostics, non-zero exit, nothing run.
    const brokenTest = await run({ 'Tests/BrokenTests.swift': 'import XCTest\nfinal class BrokenTests: XCTestCase {\n    func testX() { XCTAssertEqual(1, "one") }\n}\n' }, { type: 'test' });
    check('XCTest: a type error in a test is reported like any other, and nothing runs',
        brokenTest.code !== 0 && /^Tests\/BrokenTests\.swift:3:\d+: error: /m.test(brokenTest.stderr) && brokenTest.stdout === '',
        `code=${brokenTest.code}\n${brokenTest.stderr.split('\n')[0]}`);
} finally {
    await browser.close();
    server.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

/** The `sample` object literal of one language in languages.ts, evaluated:
 * template literals of plain text keyed by file name. */
function sampleOf(source, id) {
    const at = source.indexOf(`id: '${id}'`);
    const start = source.indexOf('sample: {', at) + 'sample: '.length;
    let depth = 0;
    let i = start;
    let inTemplate = false;
    for (; i < source.length; i++) {
        const c = source[i];
        if (inTemplate) {
            if (c === '\\') i++;
            else if (c === '`') inTemplate = false;
        } else if (c === '`') inTemplate = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
    }
    return new Function(`return (${source.slice(start, i + 1)});`)();
}
