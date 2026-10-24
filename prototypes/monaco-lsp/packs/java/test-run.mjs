// Headless test of the Java runner (runner.js), run the way the app runs
// it: app/static served over http with COOP/COEP (so the page is
// crossOriginIsolated and has SharedArrayBuffer), `new Worker(
// '/packs/java/runner.js', { type: 'module' })` in Chromium, the CONTRACT.md
// messages, and stdin driven from the page through the SharedArrayBuffer.
//
// Runs the sample project of app/src/lib/languages.ts as it is there (cold,
// then warm), its tests (Test), a failing test, Scanner and BufferedReader
// on stdin, end of file, compile errors, an uncaught exception,
// System.exit, a compact source file (JEP 512), a program that loops
// forever, a flood of output, and the Java a course uses.
//
//   node test-run.mjs        (after ./build.sh; needs playwright-core)

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const LANGUAGES = resolve(HERE, '../../app/src/lib/languages.ts');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };

let bytesServed = 0;
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION }).end('<!doctype html><link rel=icon href="data:,"><title>java runner test</title>');
        return;
    }
    const file = normalize(join(STATIC, path));
    try {
        if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
        const body = await readFile(file);
        bytesServed += body.length;
        // Raw files (worst-case transfer); cacheable, as the app's service
        // worker makes /packs/** after the first download.
        res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length,
            'cache-control': 'max-age=3600', 'cross-origin-resource-policy': 'same-origin', ...ISOLATION,
        });
        res.end(body);
    } catch {
        res.writeHead(404, ISOLATION).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

await stat(join(STATIC, 'packs/java/runner.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/java/runner.js')}: run ./build.sh first`);
    process.exit(2);
});

/** The Java sample project exactly as languages.ts has it (template literals unescaped). */
async function sampleProject() {
    const src = await readFile(LANGUAGES, 'utf8');
    const block = src.slice(src.indexOf("id: 'java'"));
    const files = {};
    for (const m of block.slice(0, block.indexOf('\n\t},')).matchAll(/'([\w./]+\.java)': `((?:[^`\\]|\\.)*)`/g)) files[m[1]] = m[2].replace(/\\(.)/g, '$1');
    const entry = /entry: '([^']+)'/.exec(block)[1];
    return { files, entry };
}

// A persistent profile, so that the warm run reads the HTTP disk cache.
const profile = await mkdtemp(join(tmpdir(), 'java-runner-test-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
};

try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => console.log('[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'debug') console.log(`  [runner] ${m.text()}`); });
    await page.goto(`${origin}/__test.html`);
    check('the page is cross-origin isolated (SharedArrayBuffer available)', await page.evaluate(() => crossOriginIsolated));

    /** Runs a project in a fresh runner worker. `input` lines are given one per
     *  `stdin` request ("" = end of file); `stopAfterOutputMs` terminates the
     *  worker that long after its first output. Resolves with what the app
     *  would have seen, and when. */
    const runProgramRaw = (files, entry, opts = {}) => page.evaluate(({ files, entry, opts }) => new Promise((done) => {
        const t0 = performance.now();
        const at = () => Math.round(performance.now() - t0);
        const stdin = new SharedArrayBuffer(8 + 64 * 1024);
        const state = new Int32Array(stdin, 0, 2);
        const input = [...(opts.input ?? [])];
        const r = { stdout: '', stderr: '', exit: null, phases: [], loading: {}, prompts: [], terminated: false, ms: 0, messages: 0 };
        const worker = new Worker('/packs/java/runner.js', { type: 'module' });
        let stopTimer = 0;
        const finish = () => { clearTimeout(guard); r.ms = at(); done(r); };
        const guard = setTimeout(() => { worker.terminate(); r.terminated = true; r.stderr += '[test: no exit after 120 s]'; finish(); }, 120000);
        worker.onerror = (e) => { r.stderr += `[worker error] ${e.message}`; worker.terminate(); finish(); };
        worker.onmessage = ({ data: m }) => {
            r.messages++;
            if (m.type === 'loading') r.loading[m.label] = { loaded: m.loaded, total: m.total, at: at() };
            else if (m.type === 'phase') r.phases.push([m.text, at()]);
            else if (m.type === 'stdout' || m.type === 'stderr') {
                r[m.type] += m.text;
                if (opts.stopAfterOutputMs !== undefined && !stopTimer) {
                    stopTimer = setTimeout(() => { worker.terminate(); r.terminated = true; finish(); }, opts.stopAfterOutputMs);
                }
            } else if (m.type === 'stdin') {
                // What the user sees when the input line appears.
                r.prompts.push(r.stdout);
                const line = input.shift();
                setTimeout(() => {
                    if (line === undefined || line === '') Atomics.store(state, 0, 3);
                    else {
                        const bytes = new TextEncoder().encode(line);
                        new Uint8Array(stdin, 8, bytes.length).set(bytes);
                        Atomics.store(state, 1, bytes.length);
                        Atomics.store(state, 0, 2);
                    }
                    Atomics.notify(state, 0);
                }, 50);
            } else if (m.type === 'exit') {
                r.exit = m.code;
                r.phases.push(['exit', at()]);
                worker.terminate();
                finish();
            }
        };
        worker.postMessage({ type: opts.test ? 'test' : 'run', files, entry, stdin: opts.noStdin ? null : stdin });
    }), { files, entry, opts });

    // The test report is coloured as JUnit's console launcher colours it;
    // the checks read the text without the escape sequences.
    const runProgram = async (...args) => {
        const r = await runProgramRaw(...args);
        r.coloured = r.stdout;
        r.stdout = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
        return r;
    };
    const phases = (r) => r.phases.map(([p, t]) => `${p}@${t}ms`).join(' ');
    const sample = await sampleProject();
    const main = (body, imports = '') => ({ 'Main.java': `${imports}public class Main {\n    public static void main(String[] args) throws Exception {\n${body}\n    }\n}\n` });

    // The sample project, cold.
    bytesServed = 0;
    const cold = await runProgram(sample.files, sample.entry);
    const coldBytes = bytesServed;
    check('the sample project runs as-is and prints its two lines (cold)', cold.exit === 0 && cold.stdout === 'Point[x=0.0, y=0.0] to Point[x=3.0, y=4.0]: 5.0\n5.0\n',
        `(${cold.ms} ms, ${(coldBytes / 1e6).toFixed(1)} MB fetched: ${phases(cold)}) stdout=${JSON.stringify(cold.stdout)} stderr=${JSON.stringify(cold.stderr)}`);
    check('progress was reported for every download', ['compiler.wasm', 'classlib-javac.bin', 'classlib-teavm.bin', 'junit.jar'].every((f) => cold.loading[f] && cold.loading[f].loaded === cold.loading[f].total && cold.loading[f].total > 0),
        JSON.stringify(Object.fromEntries(Object.entries(cold.loading).map(([k, v]) => [k, v.loaded]))));

    // Its tests.
    const tests = await runProgram(sample.files, sample.entry, { test: true });
    check('Test runs the sample\'s three JUnit tests, reported as JUnit\'s console launcher does, exit 0', tests.exit === 0 &&
        /\[ +3 tests successful +\]/.test(tests.stdout) && /\[ +0 tests failed +\]/.test(tests.stdout) && /GeometryTest ✔/.test(tests.stdout) && /normOfThreeFourIsFive\(\) ✔/.test(tests.stdout),
        `(${tests.ms} ms: ${phases(tests)}) stdout=${JSON.stringify(tests.stdout)} stderr=${JSON.stringify(tests.stderr)}`);
    check('the test report is coloured as JUnit\'s console launcher colours it (green \u2714)', tests.coloured.includes('\x1b[32m\u2714\x1b[0m'), JSON.stringify(tests.coloured.slice(0, 80)));
    const failing = await runProgram({
        ...sample.files,
        'src/test/java/geometry/MoreTest.java': `package geometry;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.*;

@DisplayName("More")
class MoreTest {
    private Point p;

    @BeforeEach
    void setUp() {
        p = new Point(6, 8);
    }

    @Test
    @DisplayName("norm of (6, 8)")
    void norm() {
        assertEquals(11.0, p.norm(), "the norm");
    }

    @Test
    void throwsOnPurpose() {
        assertThrows(ArithmeticException.class, () -> System.out.println(1 / 0));
    }

    @Test
    @Disabled("not yet")
    void later() {
        fail();
    }

    @Test
    void nullIsNull() {
        assertNull(null);
        assertTrue(p.x() > 0);
        assertAll(() -> assertEquals(6.0, p.x()), () -> assertEquals(8.0, p.y()));
    }
}
`,
    }, sample.entry, { test: true });
    check('a failing assertion fails its test with JUnit\'s message, @Disabled is skipped, @BeforeEach and assertThrows work, exit 1', failing.exit === 1 &&
        /norm of \(6, 8\) ✘ the norm ==> expected: <11\.0> but was: <10\.0>/.test(failing.stdout) && /later\(\) ↷ @Disabled/.test(failing.stdout) &&
        /throwsOnPurpose\(\) ✔/.test(failing.stdout) && /nullIsNull\(\) ✔/.test(failing.stdout) &&
        /\[ +5 tests successful +\]/.test(failing.stdout) && /\[ +1 tests failed +\]/.test(failing.stdout) && /\[ +1 tests skipped +\]/.test(failing.stdout),
        `stdout=${JSON.stringify(failing.stdout)} stderr=${JSON.stringify(failing.stderr)}`);
    // Test classes declared without a package, alone and next to packaged
    // ones: the generated main class must reach both (it is in the unnamed
    // package, since a named package cannot refer to the unnamed one).
    const DEFAULT_PACKAGE_TEST = `import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    @Test
    void addsInTheDefaultPackage() {
        assertEquals(4, Main.twice(2));
    }
}
`;
    const unnamed = await runProgram({ 'Main.java': 'public class Main {\n    static int twice(int n) {\n        return 2 * n;\n    }\n\n    public static void main(String[] args) {\n        System.out.println(twice(21));\n    }\n}\n', 'src/test/java/CalculatorTest.java': DEFAULT_PACKAGE_TEST }, 'Main.java', { test: true });
    check('Test runs test classes in the unnamed package (no package declaration), calling a class of the unnamed package, exit 0', unnamed.exit === 0 &&
        /CalculatorTest ✔/.test(unnamed.stdout) && /addsInTheDefaultPackage\(\) ✔/.test(unnamed.stdout) && /\[ +1 tests successful +\]/.test(unnamed.stdout),
        `stdout=${JSON.stringify(unnamed.stdout)} stderr=${JSON.stringify(unnamed.stderr)}`);
    const mixed = await runProgram({ ...sample.files, 'src/test/java/CalculatorTest.java': DEFAULT_PACKAGE_TEST.replace('Main.twice(2)', '2 + 2') }, sample.entry, { test: true });
    check('Test runs unnamed-package and packaged test classes together', mixed.exit === 0 &&
        /CalculatorTest ✔/.test(mixed.stdout) && /GeometryTest ✔/.test(mixed.stdout) && /\[ +4 tests successful +\]/.test(mixed.stdout),
        `stdout=${JSON.stringify(mixed.stdout)} stderr=${JSON.stringify(mixed.stderr)}`);
    const none = await runProgram(main('System.out.println(1);'), 'Main.java', { test: true });
    check('Test with no @Test methods says so', none.exit === 0 && /No tests found/.test(none.stdout), `stdout=${JSON.stringify(none.stdout)} stderr=${JSON.stringify(none.stderr)}`);

    // Standard input.
    const sum = await runProgram(main(`        var in = new java.util.Scanner(System.in);
        System.out.print("First number: ");
        int a = in.nextInt();
        System.out.print("Second number: ");
        int b = in.nextInt();
        System.out.println("Sum: " + (a + b));`), 'Main.java', { input: ['40\n', '2\n'] });
    check('a prompt printed without a newline is visible when the program waits for input', sum.prompts[0] === 'First number: ' && sum.prompts[1] === 'First number: Second number: ', JSON.stringify(sum.prompts));
    check('two numbers read with Scanner through the SharedArrayBuffer are summed', sum.exit === 0 && sum.stdout === 'First number: Second number: Sum: 42\n',
        `(${sum.ms} ms: ${phases(sum)}) stdout=${JSON.stringify(sum.stdout)} stderr=${JSON.stringify(sum.stderr)}`);
    const lines = await runProgram(main(`        var in = new BufferedReader(new InputStreamReader(System.in));
        String line;
        int n = 0;
        while ((line = in.readLine()) != null) {
            n++;
            System.out.println(n + ": " + line.toUpperCase());
        }
        System.out.println(n + " lines");`, 'import java.io.*;\n\n'), 'Main.java', { input: ['héllo wörld\n', 'two\n', ''] });
    check('BufferedReader reads UTF-8 lines until end of input (Ctrl-D)', lines.exit === 0 && lines.stdout === '1: HÉLLO WÖRLD\n2: TWO\n2 lines\n',
        `stdout=${JSON.stringify(lines.stdout)} stderr=${JSON.stringify(lines.stderr)}`);
    const SCAN_EOF = `        var in = new java.util.Scanner(System.in);
        System.out.println(in.hasNextLine() ? in.nextLine() : "end of file");`;
    const noStdin = await runProgram(main(SCAN_EOF), 'Main.java', { noStdin: true });
    check('without a SharedArrayBuffer (stdin: null) System.in is at end of file', noStdin.exit === 0 && noStdin.stdout === 'end of file\n', `stdout=${JSON.stringify(noStdin.stdout)} stderr=${JSON.stringify(noStdin.stderr)}`);
    const mismatch = await runProgram(main('        System.out.println(new java.util.Scanner(System.in).nextInt());'), 'Main.java', { input: ['seven\n'] });
    check('Scanner.nextInt on a word throws InputMismatchException: stderr, exit 1', mismatch.exit === 1 && /^Exception in thread "main" java\.util\.InputMismatchException/.test(mismatch.stderr),
        `stderr=${JSON.stringify(mismatch.stderr.split('\n').slice(0, 2).join('\n'))}`);

    // Errors and exits.
    const broken = await runProgram(main('        int n = "five";\n        System.out.println(n);'), 'Main.java');
    check('a type error is reported on stderr as javac does (path:line: error:, the line, a caret), exit 1', broken.exit === 1 && broken.stdout === '' &&
        broken.stderr.startsWith('Main.java:3: error: incompatible types: String cannot be converted to int\n        int n = "five";\n                ^\n') && /\n1 error\n$/.test(broken.stderr),
        `(${broken.ms} ms: ${phases(broken)}) stderr=${JSON.stringify(broken.stderr)}`);
    const syntax = await runProgram({ 'Main.java': 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("unclosed);\n    }\n}\n' }, 'Main.java');
    check('a syntax error is reported on stderr, exit 1', syntax.exit === 1 && /Main\.java:3: error: unclosed string literal/.test(syntax.stderr), `stderr=${JSON.stringify(syntax.stderr)}`);
    const boom = await runProgram({ 'Main.java': 'public class Main {\n    static void fail(int depth) {\n        if (depth == 0) throw new IllegalStateException("boom");\n        fail(depth - 1);\n    }\n\n    public static void main(String[] args) {\n        System.out.println("before");\n        fail(2);\n    }\n}\n' }, 'Main.java');
    // TeaVM cannot name the frames (README, "Exceptions"): the trace is the exception alone.
    check('an uncaught exception prints "Exception in thread "main"" and the exception on stderr, exit 1', boom.exit === 1 && boom.stdout === 'before\n' &&
        boom.stderr === 'Exception in thread "main" java.lang.IllegalStateException: boom\n',
        `stderr=${JSON.stringify(boom.stderr)}`);
    const npe = await runProgram(main('        String s = args.length > 5 ? "x" : null;\n        System.out.println(s.length());'), 'Main.java');
    check('a NullPointerException is a Java exception (stderr, exit 1)', npe.exit === 1 && /^Exception in thread "main" java\.lang\.NullPointerException/.test(npe.stderr),
        `stderr=${JSON.stringify(npe.stderr.split('\n').slice(0, 2).join('\n'))}`);
    const bounds = await runProgram(main('        int[] xs = {1, 2, 3};\n        System.out.println(xs[3]);'), 'Main.java');
    check('an array index out of bounds is an ArrayIndexOutOfBoundsException (stderr, exit 1)', bounds.exit === 1 && /^Exception in thread "main" java\.lang\.ArrayIndexOutOfBoundsException/.test(bounds.stderr),
        `stderr=${JSON.stringify(bounds.stderr.split('\n').slice(0, 2).join('\n'))}`);
    const deep = await runProgram({ 'Main.java': 'public class Main {\n    static int down(int n) { return down(n + 1) + 1; }\n\n    public static void main(String[] args) {\n        System.out.println(down(0));\n    }\n}\n' }, 'Main.java');
    check('unbounded recursion ends the run with StackOverflowError, exit 1', deep.exit === 1 && /StackOverflowError/.test(deep.stderr), `stderr=${JSON.stringify(deep.stderr.split('\n').slice(0, 2).join('\n'))}`);
    const exited = await runProgram(main('        System.out.println("bye");\n        System.exit(3);\n        System.out.println("not printed");'), 'Main.java');
    check('System.exit(3) ends the run with exit code 3', exited.exit === 3 && exited.stdout === 'bye\n' && exited.stderr === '', `exit=${exited.exit} stdout=${JSON.stringify(exited.stdout)} stderr=${JSON.stringify(exited.stderr)}`);
    const nomain = await runProgram({ 'Main.java': 'public class Main {\n}\n' }, 'Main.java');
    check('a project without a main says so, exit 1', nomain.exit === 1 && /No main method/.test(nomain.stderr), `stderr=${JSON.stringify(nomain.stderr)}`);

    // Java 25: a compact source file with an instance main (JEP 512) and IO.
    const compact = await runProgram({ 'Main.java': 'void main() {\n    String name = IO.readln("Name: ");\n    IO.println("Hello, " + name + "!");\n}\n' }, 'Main.java', { input: ['Ada\n'] });
    check('a compact source file (void main, IO.readln, IO.println) runs', compact.exit === 0 && compact.stdout === 'Name: Hello, Ada!\n', `stdout=${JSON.stringify(compact.stdout)} stderr=${JSON.stringify(compact.stderr)}`);

    // A program that never ends: the page terminates the worker.
    const spin = await runProgram(main('        System.out.println("spinning");\n        long i = 0;\n        while (true) i++;'), 'Main.java', { stopAfterOutputMs: 1000 });
    check('a program that loops forever runs until the worker is terminated, and the test goes on', spin.terminated && spin.exit === null && spin.stdout === 'spinning\n',
        `(${spin.ms} ms) stdout=${JSON.stringify(spin.stdout)}`);
    const busy = await runProgram(main('        System.out.println("start");\n        System.out.print("working...");\n        System.out.flush();\n        long i = 0;\n        while (true) i++;'), 'Main.java', { stopAfterOutputMs: 1500 });
    check('output printed before a long computation shows during it, a flushed partial line included', busy.terminated && busy.stdout === 'start\nworking...',
        `stdout=${JSON.stringify(busy.stdout)}`);
    const flood = await runProgram(main('        for (int i = 1; i <= 100000; i++) System.out.println(i);'), 'Main.java');
    const floodLines = flood.stdout.split('\n');
    check('100000 printed lines arrive complete and in order, in few messages', flood.exit === 0 && floodLines.length === 100001 &&
        floodLines.every((l, i) => i === 100000 ? l === '' : l === String(i + 1)) && flood.messages < 3000,
        `(${flood.ms} ms) ${flood.messages} messages for ${flood.stdout.length} characters`);

    // The Java a course uses.
    const features = await runProgram({
        'src/main/java/shapes/Main.java': `package shapes;

import java.math.BigInteger;
import java.util.*;
import java.util.stream.*;

public class Main {
    sealed interface Shape permits Circle, Rect {}
    record Circle(double r) implements Shape {}
    record Rect(double w, double h) implements Shape {}

    enum Day { MON, TUE, WED }

    static double area(Shape s) {
        return switch (s) {
            case Circle c -> Math.PI * c.r() * c.r();
            case Rect(double w, double h) -> w * h;
        };
    }

    interface Stack<T> extends Iterable<T> {
        void push(T t);
    }

    public static void main(String[] args) {
        List<Shape> shapes = List.of(new Circle(1), new Rect(2, 3));
        System.out.println(shapes);
        System.out.println(String.format("%.3f %.1f", area(shapes.get(0)), area(shapes.get(1))));
        var counts = new TreeMap<Character, Integer>();
        for (char c : "hello world".toCharArray()) if (c != ' ') counts.merge(c, 1, Integer::sum);
        System.out.println(counts);
        System.out.println(IntStream.rangeClosed(1, 5).map(i -> i * i).boxed().collect(Collectors.toList()));
        System.out.println(Stream.of("b", "a", "c").sorted(Comparator.reverseOrder()).collect(Collectors.joining(",", "[", "]")));
        System.out.println(Arrays.toString(Day.values()) + " " + Day.valueOf("TUE").ordinal());
        long big = 1;
        for (int i = 1; i <= 20; i++) big *= i;
        System.out.println(big + " " + BigInteger.TWO.pow(100));
        var sb = new StringBuilder("abc").reverse();
        System.out.println(sb + " " + "a,b,,c".split(",").length + " " + "Mississippi".replaceAll("ss", "SS"));
        Optional<String> first = Stream.of("x", "yy").filter(s -> s.length() > 1).findFirst();
        System.out.println(first.orElse("none") + " " + Objects.hash(1, 2) + " " + Integer.toBinaryString(10));
        int[] xs = {5, 3, 9, 1};
        Arrays.sort(xs);
        System.out.println(Arrays.toString(xs) + " " + Arrays.stream(xs).sum() + " " + Math.max(2.5, 1) + " " + (char) ('a' + 2));
        Object o = 42;
        if (o instanceof Integer n && n > 40) System.out.println("pattern " + n);
        var text = """
            text block
              indented""";
        System.out.println(text);
        System.out.println("Unicode: \\u00e9t\\u00e9 \\u2713 " + "\\u00e9t\\u00e9".length());
        System.out.printf("%5d|%-5s|%08.3f|%x%n", 42, "ab", Math.E, 255);
        System.out.printf("%d%% %.3e|%E|%10.2e%n", 5, 12345.678, 0.000123, -1.0);
        try {
            System.out.println(xs.length / (xs[0] - 1));
        } catch (ArithmeticException e) {
            System.out.println("caught " + e.getMessage());
        }
    }
}
`,
    }, 'src/main/java/shapes/Main.java');
    check('a program using sealed interfaces, records, pattern switches, collections, streams, BigInteger, text blocks, printf (%n, %e) and a caught ArithmeticException runs',
        features.exit === 0 && features.stdout === [
            '[Circle[r=1.0], Rect[w=2.0, h=3.0]]', '3.142 6.0', '{d=1, e=1, h=1, l=3, o=2, r=1, w=1}', '[1, 4, 9, 16, 25]', '[c,b,a]', '[MON, TUE, WED] 1',
            '2432902008176640000 1267650600228229401496703205376', 'cba 4 MiSSiSSippi', 'yy 994 1010', '[1, 3, 5, 9] 18 2.5 c', 'pattern 42',
            'text block\n  indented', 'Unicode: été ✓ 3', '   42|ab   |0002.718|ff', '5% 1.235e+04|1.230000E-04| -1.00e+00', 'caught / by zero', ''].join('\n'),
        `stdout=${JSON.stringify(features.stdout)} stderr=${JSON.stringify(features.stderr)}`);

    // The sample, warm: files from the HTTP cache.
    bytesServed = 0;
    const warm = await runProgram(sample.files, sample.entry);
    check('the sample project runs again (warm: no download)', warm.exit === 0 && warm.stdout === cold.stdout,
        `(${warm.ms} ms, ${(bytesServed / 1e6).toFixed(1)} MB fetched: ${phases(warm)})`);
} finally {
    await context.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
