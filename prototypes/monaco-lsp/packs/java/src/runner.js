// Yukibana Java pack: the runner worker (CONTRACT.md, "Running a program").
//
// Run: javac (in compiler.wasm, the file the language server loads) compiles
// the project's sources, outside its test folders, to class files; TeaVM, in
// the same module, compiles those class files with its Java class library to
// a WebAssembly GC module, as `teavm` would ahead of time; the worker
// instantiates it and calls its main. System.out and System.err come here
// through TeaVM's console imports; System.in, Scanner and IO.readln read the
// terminal through the "yukibana" imports (classlib/ in the pack). See
// ../README.md, "Running".
//
// Test: the same, with the test sources and JUnit Jupiter's API on the class
// path; the tests are found in the class files (@Test methods) and called
// from generated code, reported the way JUnit's console launcher does.

import { load } from './teavm-runtime.js';

const BASE = new URL('./', import.meta.url);
const post = (m) => postMessage(m);

/** Fetches a pack file, reporting `loading` as bytes arrive (totals from manifest.json). */
async function fetchBytes(name, total) {
    const res = await fetch(new URL(name, BASE));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    let last = 0;
    post({ type: 'loading', label: name, loaded: 0, total });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (loaded - last > 256 * 1024) {
            last = loaded;
            post({ type: 'loading', label: name, loaded, total: Math.max(total, loaded) });
        }
    }
    post({ type: 'loading', label: name, loaded, total: loaded });
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

// ---- Output
//
// Text is posted as it is written, partial lines included, except in bursts:
// after 32 messages within 50 ms, further writes collect and go out with the
// first write after that window, at 8 KB, before a read, or at the end (the
// Scala pack's policy, which the app's terminal is tuned for).

const WINDOW_MS = 50;
const POSTS_PER_WINDOW = 32;
const MAX_PENDING = 8192;
const pending = { 1: '', 2: '' };
let timer = 0;
let windowStart = 0;
let postsInWindow = 0;
let exited = false;

function flush(fd) {
    if (!pending[fd]) return;
    post({ type: fd === 2 ? 'stderr' : 'stdout', text: pending[fd] });
    pending[fd] = '';
    postsInWindow++;
}
function flushAll() {
    clearTimeout(timer);
    timer = 0;
    flush(1);
    flush(2);
}
function write(fd, text) {
    if (!text || exited) return;
    if (pending[3 - fd]) flush(3 - fd); // keep stdout and stderr in order
    pending[fd] += text;
    const now = performance.now();
    if (now - windowStart >= WINDOW_MS) {
        windowStart = now;
        postsInWindow = 0;
    }
    if (postsInWindow < POSTS_PER_WINDOW || pending[fd].length >= MAX_PENDING) flush(fd);
    else if (!timer) timer = setTimeout(flushAll, 0); // in case the program yields
}

/** Ends the run: the last message. Anything the program does after it is dropped. */
function exit(code) {
    if (exited) return;
    flushAll();
    exited = true;
    post({ type: 'exit', code });
}

/** What the "yukibana" import's exit throws, to unwind the program; never reported. */
class ExitSignal extends Error {}
self.addEventListener('error', (e) => {
    if (e.error instanceof ExitSignal || exited) e.preventDefault();
});
self.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof ExitSignal || exited) e.preventDefault();
});

/**
 * The imports a program built here needs: TeaVM's console (UTF-16 code
 * units; one character at a time), and ours for System.in and System.exit
 * (classlib/: TConsoleInputStream, TRuntime).
 */
function imports(stdin) {
    let input = new Uint8Array(0);
    let position = 0;
    /** Waits for a line from the app (CONTRACT.md, "Standard input"); false at end of file. */
    function readLine() {
        flushAll(); // a prompt printed without a newline must show first
        if (!stdin) return false;
        const state = new Int32Array(stdin, 0, 2);
        Atomics.store(state, 0, 1);
        post({ type: 'stdin' });
        Atomics.wait(state, 0, 1);
        if (Atomics.load(state, 0) === 3) {
            Atomics.store(state, 0, 0);
            return false;
        }
        const length = Atomics.load(state, 1);
        input = new Uint8Array(stdin, 8, length).slice();
        position = 0;
        Atomics.store(state, 0, 0);
        return true;
    }
    return (imports) => {
        // TeaVM's own console writes a line at a time to console.log; here
        // a character at a time to a buffer, posted at each newline, at each
        // print (System.out's flush import, as the JVM's autoflushing
        // System.out shows a prompt at once), before input, and at the end.
        //
        // A stack trace's frames are all `java.lang.Throwable$FakeClass.
        // fakeMethod(Throwable.java:<code offset>)` here: TeaVM names frames
        // with its deobfuscator (teavm-wasm-gc-deobfuscator), which found no
        // frame in the programs compiler.wasm builds (README, "Exceptions").
        // Such lines say nothing, so they are left out wherever they are
        // printed; a partial line that may become one waits for its end.
        const buffer = { 1: '', 2: '' };
        const held = { 1: '', 2: '' };
        const emit = (fd, final) => {
            const text = held[fd] + buffer[fd];
            buffer[fd] = '';
            held[fd] = '';
            let shown = '';
            let start = 0;
            for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
                const l = text.slice(start, nl + 1);
                if (!FAKE_FRAME.test(l)) shown += l;
                start = nl + 1;
            }
            const tail = text.slice(start);
            const trimmed = tail.replace(/^\s+/, '');
            if (tail && !final && (FAKE_HEAD.startsWith(trimmed) || trimmed.startsWith(FAKE_HEAD))) held[fd] = tail;
            else shown += tail;
            write(fd, shown);
        };
        imports.teavmConsole.putcharStdout = (c) => {
            buffer[1] += String.fromCharCode(c);
            if (c === 10 || buffer[1].length >= 1024) emit(1, false);
        };
        imports.teavmConsole.putcharStderr = (c) => {
            buffer[2] += String.fromCharCode(c);
            if (c === 10 || buffer[2].length >= 1024) emit(2, false);
        };
        const drain = () => {
            emit(1, true);
            emit(2, true);
        };
        imports.yukibana = {
            stdinRead: () => {
                if (position >= input.length) {
                    drain();
                    if (!readLine()) return -1;
                }
                return input[position++];
            },
            stdinAvailable: () => input.length - position,
            flush: (fd) => emit(fd === 2 ? 2 : 1, false),
            exit: (code) => {
                drain();
                exit(code);
                throw new ExitSignal(`exit ${code}`);
            },
        };
        drainOutput = drain;
    };
}
let drainOutput = () => {};
const FAKE_HEAD = 'at java.lang.Throwable$FakeClass.fakeMethod(';
const FAKE_FRAME = /^\s*at java\.lang\.Throwable\$FakeClass\.fakeMethod\(Throwable\.java:\d+\)\r?\n$/;

// ---- Compiling

const TEST_DIRS = /^(src\/test\/|tests?\/)/;

/** The runtime support every program is compiled with. */
const LAUNCHER = `package yukibana;

/** Starts a program (from YukibanaEntry, which runner.js makes) and ends the run with its status. */
public final class Launcher {
    public interface Main {
        void run(String[] args) throws Throwable;
    }

    public static void start(String[] args, Main main) {
        int status = 0;
        try {
            main.run(args);
        } catch (Throwable t) {
            System.out.flush();
            System.err.print("Exception in thread \\"main\\" ");
            t.printStackTrace();
            status = 1;
        }
        System.out.flush();
        System.err.flush();
        System.exit(status);
    }
}
`;

/** The test report, in the format of JUnit's console launcher (tree details, summary). */
const REPORT = `package yukibana.junit;

import java.util.ArrayList;
import java.util.List;

public final class Report {
    public interface Body {
        void run() throws Throwable;
    }

    private static final class Test {
        String display;
        String status;
        Throwable failure;
        String reason;
    }

    private static final class Container {
        String name;
        String display;
        Throwable failure;
        String skipped;
        final List<Test> tests = new ArrayList<>();
    }

    private final List<Container> containers = new ArrayList<>();
    private Container current;
    private final long start = System.currentTimeMillis();

    public void beginClass(String name, String display) {
        current = new Container();
        current.name = name;
        current.display = display;
        containers.add(current);
    }

    public void skipClass(String reason) {
        current.skipped = reason;
    }

    public boolean lifecycle(Body body) {
        try {
            body.run();
            return true;
        } catch (Throwable t) {
            if (current.failure == null) {
                current.failure = t;
            }
            return false;
        }
    }

    public void test(String display, Body body) {
        var test = new Test();
        test.display = display;
        current.tests.add(test);
        try {
            body.run();
            test.status = "successful";
        } catch (org.opentest4j.TestAbortedException e) {
            test.status = "aborted";
            test.failure = e;
        } catch (Throwable e) {
            test.status = "failed";
            test.failure = e;
        }
    }

    public void skipped(String display, String reason) {
        var test = new Test();
        test.display = display;
        test.status = "skipped";
        test.reason = reason;
        current.tests.add(test);
    }

    // The console launcher's colours (its default ColorPalette).
    private static final int SUCCESSFUL = 32;
    private static final int ABORTED = 33;
    private static final int FAILED = 31;
    private static final int SKIPPED = 35;

    private static String paint(int colour, String text) {
        return colour == 0 ? text : "\\u001b[" + colour + "m" + text + "\\u001b[0m";
    }

    private static String line(Test t) {
        return switch (t.status) {
            case "successful" -> t.display + " " + paint(SUCCESSFUL, "\\u2714");
            case "skipped" -> t.display + " " + paint(SKIPPED, "\\u21b7 " + t.reason);
            case "aborted" -> t.display + " " + paint(ABORTED, "\\u25a0 " + t.failure.getMessage());
            default -> t.display + " " + paint(FAILED, "\\u2718 " + t.failure.getMessage());
        };
    }

    private static String count(int n, String what) {
        var number = String.valueOf(n);
        var sb = new StringBuilder("[");
        for (int i = number.length(); i < 10; i++) {
            sb.append(' ');
        }
        sb.append(number).append(' ').append(what);
        while (sb.length() < 34) {
            sb.append(' ');
        }
        return sb.append(']').toString();
    }

    private static void printFailure(Throwable t) {
        System.out.println("    => " + t);
        var frames = t.getStackTrace();
        int shown = 0;
        for (var frame : frames == null ? new StackTraceElement[0] : frames) {
            var s = String.valueOf(frame);
            if (s.startsWith("org.junit.") || s.startsWith("yukibana.") || s.startsWith("java.") || s.startsWith("org.teavm.")) {
                continue;
            }
            System.out.println("       " + s);
            if (++shown == 5) {
                break;
            }
        }
    }

    /** Prints the report; the exit status: 1 when a test or a class failed. */
    public int finish() {
        System.out.flush();
        int found = 0;
        int skipped = 0;
        int aborted = 0;
        int successful = 0;
        int failed = 0;
        int containersFailed = 0;
        int containersSkipped = 0;
        for (var c : containers) {
            if (c.failure != null) {
                containersFailed++;
            }
            if (c.skipped != null) {
                containersSkipped++;
            }
            for (var t : c.tests) {
                found++;
                switch (t.status) {
                    case "successful" -> successful++;
                    case "skipped" -> skipped++;
                    case "aborted" -> aborted++;
                    default -> failed++;
                }
            }
        }
        var out = System.out;
        out.println("\\u2577");
        out.println("\\u2514\\u2500 JUnit Jupiter " + (failed + containersFailed > 0 ? paint(FAILED, "\\u2718") : paint(SUCCESSFUL, "\\u2714")));
        for (int i = 0; i < containers.size(); i++) {
            var c = containers.get(i);
            boolean lastContainer = i == containers.size() - 1;
            var mark = c.skipped != null ? paint(SKIPPED, "\\u21b7 " + c.skipped) : c.failure != null ? paint(FAILED, "\\u2718 " + c.failure.getMessage())
                    : c.tests.stream().anyMatch(t -> t.status.equals("failed")) ? paint(FAILED, "\\u2718") : paint(SUCCESSFUL, "\\u2714");
            out.println("   " + (lastContainer ? "\\u2514\\u2500 " : "\\u251c\\u2500 ") + c.display + " " + mark);
            for (int j = 0; j < c.tests.size(); j++) {
                var t = c.tests.get(j);
                out.println("   " + (lastContainer ? "   " : "\\u2502  ") + (j == c.tests.size() - 1 ? "\\u2514\\u2500 " : "\\u251c\\u2500 ") + line(t));
            }
        }
        out.println();
        if (failed + containersFailed > 0) {
            out.println("Failures (" + (failed + containersFailed) + "):");
            for (var c : containers) {
                if (c.failure != null) {
                    out.println("  JUnit Jupiter:" + c.display);
                    out.println("    ClassSource [className = '" + c.name + "']");
                    printFailure(c.failure);
                }
                for (var t : c.tests) {
                    if (t.status.equals("failed")) {
                        out.println("  JUnit Jupiter:" + c.display + ":" + t.display);
                        printFailure(t.failure);
                    }
                }
            }
            out.println();
        }
        out.println("Test run finished after " + (System.currentTimeMillis() - start) + " ms");
        int containersFound = containers.size() + 1;
        out.println(count(containersFound, "containers found"));
        out.println(count(containersSkipped, "containers skipped"));
        out.println(count(containersFound - containersSkipped, "containers started"));
        out.println(count(0, "containers aborted"));
        out.println(count(containersFound - containersSkipped - containersFailed, "containers successful"));
        out.println(count(containersFailed, "containers failed"));
        out.println(count(found, "tests found"));
        out.println(paint(skipped > 0 ? SKIPPED : 0, count(skipped, "tests skipped")));
        out.println(count(found - skipped, "tests started"));
        out.println(paint(aborted > 0 ? ABORTED : 0, count(aborted, "tests aborted")));
        out.println(paint(successful > 0 ? SUCCESSFUL : 0, count(successful, "tests successful")));
        out.println(paint(failed > 0 ? FAILED : 0, count(failed, "tests failed")));
        out.println();
        return failed + containersFailed > 0 ? 1 : 0;
    }
}
`;

/** A Java string literal. */
const quote = (s) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * The code that runs a package's test classes: one class per package, so
 * that package-private test classes and methods (JUnit's usual style) can
 * be called. JUnit's order within a class is deterministic but unspecified;
 * here it is the class file's (declaration) order.
 */
function testSuite(pkg, classes) {
    const lines = [];
    if (pkg) lines.push(`package ${pkg};`, '');
    lines.push('public final class YukibanaTests {', '    public static void run(yukibana.junit.Report r) {');
    for (const c of classes) {
        const source = c.cls.replace(/\$/g, '.');
        const simple = c.cls.slice(c.cls.lastIndexOf('.') + 1).replace(/^.*\$/, '');
        lines.push(`        r.beginClass(${quote(c.cls)}, ${quote(c.display ?? simple)});`);
        if (c.disabled) {
            lines.push(`        r.skipClass("class ${simple} is @Disabled");`);
            continue;
        }
        if (!c.instantiable) {
            lines.push(`        r.lifecycle(() -> { throw new IllegalStateException("cannot instantiate ${simple}: a test class needs a no-argument constructor and must not be abstract or an inner class"); });`);
            continue;
        }
        const all = (names) => names.map((n) => `${source}.${n}();`).join(' ');
        lines.push(`        if (r.lifecycle(() -> { ${all(c.beforeAll)} })) {`);
        for (const t of c.tests) {
            const display = t.display ?? `${t.name}()`;
            if (t.disabled) {
                lines.push(`            r.skipped(${quote(display)}, "@Disabled");`);
            } else if (t.unsupported) {
                lines.push(`            r.skipped(${quote(display)}, ${quote(`not run: ${t.unsupported} is not supported here`)});`);
            } else {
                const before = c.beforeEach.map((n) => `t.${n}(); `).join('');
                const after = c.afterEach.map((n) => `try { t.${n}(); } catch (Throwable e) { if (failure == null) failure = e; else failure.addSuppressed(e); } `).join('');
                lines.push(`            r.test(${quote(display)}, () -> { var t = new ${source}(); Throwable failure = null; try { ${before}t.${t.name}(); } catch (Throwable e) { failure = e; } ${after}if (failure != null) throw failure; });`);
            }
        }
        lines.push('        }', `        r.lifecycle(() -> { ${all(c.afterAll)} });`);
    }
    lines.push('    }', '}', '');
    return lines.join('\n');
}

/**
 * The test program's main class, which calls each package's YukibanaTests.
 * It is in the unnamed package: a class in a named package cannot refer to
 * one in the unnamed package (JLS 7.5: there is no way to import it), so a
 * main class in `yukibana.junit`, as this was, could not call the suite of
 * test classes declared without a package, and the generated runner did not
 * compile. From the unnamed package both are in reach.
 */
const TEST_MAIN = 'YukibanaTestMain';

function testMain(packages) {
    const calls = packages.map((p) => `        ${p ? p + '.' : ''}YukibanaTests.run(r);`).join('\n');
    return `public final class ${TEST_MAIN} {
    public static void main(String[] args) {
        var r = new yukibana.junit.Report();
${calls}
        System.exit(r.finish());
    }
}
`;
}

/**
 * A javac message with types by their simple names (`String`, `List<Point>`),
 * as javac prints them on the command line (its RichDiagnosticFormatter);
 * the compiler API's messages, which these are, qualify every type.
 */
const simpleNames = (message) => message.replace(/\b(?:[a-z_$][\w$]*\.)+(?=[A-Z][\w$]*)/g, '');

/** A diagnostic as javac prints it: `path:line: error: message`, the line, a caret. */
function formatDiagnostic(d, files) {
    const kind = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'note';
    if (d.type !== 'javac' || !d.fileName) return `${kind}: ${d.message}\n`;
    const path = d.fileName;
    let text = `${path}:${d.lineNumber}: ${kind}: ${simpleNames(d.message)}\n`;
    const source = files[path];
    if (source !== undefined && d.lineNumber > 0) {
        const lineText = source.split('\n')[d.lineNumber - 1] ?? '';
        text += `${lineText.replace(/\r$/, '')}\n${' '.repeat(Math.max(0, d.columnNumber - 1))}^\n`;
    }
    return text;
}

/** The package a Java source declares ('' for none). */
function packageOf(text) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1] ?? '';
}

async function run({ type, files, entry, stdin }) {
    const testing = type === 'test';
    const manifest = await (await fetch(new URL('manifest.json', BASE))).json();
    const [compilerBytes, javacLib, teavmLib, junit] = await Promise.all([
        fetchBytes(manifest.compiler.file, manifest.compiler.size),
        fetchBytes(manifest.classlibJavac.file, manifest.classlibJavac.size),
        fetchBytes(manifest.classlibTeaVM.file, manifest.classlibTeaVM.size),
        fetchBytes(manifest.junit.file, manifest.junit.size),
    ]);

    post({ type: 'phase', text: 'Compiling' });
    const lib = (await load(compilerBytes)).exports;
    const compiler = lib.createCompiler();
    const diagnostics = [];
    compiler.onDiagnostic((d) => diagnostics.push({
        type: d.type, severity: d.severity, fileName: d.fileName, lineNumber: d.lineNumber, message: d.message,
        columnNumber: d.type === 'javac' ? d.columnNumber : 0,
    }));
    compiler.setSdk(new Int8Array(javacLib.buffer));
    compiler.setTeaVMClasslib(new Int8Array(teavmLib.buffer));
    compiler.addJarFile(new Int8Array(junit.buffer));

    const sources = Object.keys(files).filter((p) => p.endsWith('.java') && (testing || !TEST_DIRS.test(p))).sort();
    if (!sources.length) {
        write(2, testing ? 'No .java files to test.\n' : `No .java files to run outside ${'src/test/'} and tests/.\n`);
        return exit(1);
    }
    for (const p of sources) compiler.addSourceFile(p, files[p]);
    compiler.addSourceFile('yukibana/Launcher.java', LAUNCHER);

    /** Prints what javac (or TeaVM) said; true when it was an error. */
    const report = () => {
        let errors = 0;
        let warnings = 0;
        for (const d of diagnostics.splice(0)) {
            if (d.severity === 'error') errors++;
            else if (d.severity === 'warning') warnings++;
            else if (d.type === 'javac' && /^Note: /.test(d.message)) continue;
            write(2, formatDiagnostic(d, files));
        }
        if (errors) write(2, `${errors} error${errors > 1 ? 's' : ''}\n`);
        else if (warnings) write(2, `${warnings} warning${warnings > 1 ? 's' : ''}\n`);
        return errors > 0;
    };
    const t0 = performance.now();
    const compiled = compiler.compile();
    if (report() || !compiled) return exit(1);
    const found = JSON.parse(lib.findEntryPoints(compiler.getOutputJar()));

    let mainClass;
    if (testing) {
        const tests = found.tests.filter((c) => !c.cls.startsWith('yukibana.'));
        if (!tests.length) {
            write(1, 'No tests found: a test is a method annotated with @Test (org.junit.jupiter.api.Test), in src/test/java/ or tests/.\n');
            return exit(0);
        }
        const byPackage = new Map();
        for (const c of tests) {
            const dot = c.cls.lastIndexOf('.');
            const pkg = dot < 0 ? '' : c.cls.slice(0, dot);
            if (!byPackage.has(pkg)) byPackage.set(pkg, []);
            byPackage.get(pkg).push(c);
        }
        for (const [pkg, classes] of byPackage) compiler.addSourceFile(`${pkg.replace(/\./g, '/')}/YukibanaTests.java`.replace(/^\//, ''), testSuite(pkg, classes));
        compiler.addSourceFile('yukibana/junit/Report.java', REPORT);
        compiler.addSourceFile(`${TEST_MAIN}.java`, testMain([...byPackage.keys()]));
        compiler.clearOutputFiles();
        if (report() || !compiler.compile() || report()) {
            write(2, 'The generated test runner did not compile (above). A test class or method may not be accessible from its package.\n');
            return exit(1);
        }
        mainClass = TEST_MAIN;
    } else {
        const mains = found.mains.filter((m) => !m.cls.startsWith('yukibana.'));
        const entryPackage = files[entry] !== undefined ? packageOf(files[entry]) : '';
        const entryName = entry.replace(/^.*\//, '').replace(/\.java$/, '');
        const entryClass = entryPackage ? `${entryPackage}.${entryName}` : entryName;
        // The launcher's preference (JEP 512): main(String[]) over main(), static over instance.
        const rank = (m) => (m.args ? 0 : 1) + (m.static ? 0 : 2);
        const candidates = mains.filter((m) => m.cls === entryClass).sort((a, b) => rank(a) - rank(b));
        const others = [...new Set(mains.map((m) => m.cls))];
        const main = candidates[0] ?? (others.length === 1 ? mains.filter((m) => m.cls === others[0]).sort((a, b) => rank(a) - rank(b))[0] : null);
        if (!main) {
            write(2, others.length
                ? `${entry} has no main method, and the project has several (${others.join(', ')}): put the one to run in ${entry}.\n`
                : `No main method to run: ${entry} needs \`public static void main(String[] args)\` (or, as in Java 25, \`void main()\`).\n`);
            return exit(1);
        }
        const name = (main.cls.includes('.') ? main.cls.slice(0, main.cls.lastIndexOf('.') + 1) : '') + 'YukibanaEntry';
        compiler.addOutputClassFile(`${name.replace(/\./g, '/')}.class`, lib.makeEntry(main.cls, main.static, main.args));
        mainClass = name;
    }
    const javacMs = performance.now() - t0;

    post({ type: 'phase', text: 'Linking' });
    const t1 = performance.now();
    const built = compiler.generateWebAssembly({ outputName: 'app', mainClass });
    if (report() || !built) {
        write(2, 'TeaVM could not compile the program to WebAssembly (above): it uses a part of the Java class library that TeaVM does not have.\n');
        return exit(1);
    }
    const wasm = compiler.getWebAssemblyOutputFile('app.wasm');
    post({ type: 'phase', text: testing ? 'Testing' : 'Running' });
    const t2 = performance.now();
    const app = await load(wasm, { installImports: imports(stdin) });
    console.debug(`javac ${Math.round(javacMs)} ms, TeaVM ${Math.round(t2 - t1)} ms, ${wasm.length} bytes of WebAssembly`);
    try {
        app.exports.main([]);
    } catch (e) {
        if (e instanceof ExitSignal) return;
        drainOutput();
        // Not a Java exception (Launcher catches those): the WebAssembly
        // machine itself stopped.
        write(2, `Exception in thread "main" ${describe(e)}\n`);
        return exit(1);
    }
    // main returned without System.exit: the program waits (Thread.sleep, a
    // timer); Launcher calls System.exit when it is done.
}

/** A JavaScript-level failure of the program, said as the JVM would where there is a JVM name for it. */
function describe(e) {
    const message = String(e?.message ?? e);
    if (e instanceof RangeError && /call stack/i.test(message)) return 'java.lang.StackOverflowError';
    if (/out of memory|allocation failed|array length/i.test(message)) return `java.lang.OutOfMemoryError: ${message}`;
    // What TeaVM leaves to the WebAssembly machine instead of throwing the
    // Java exception (so a catch in the program does not see it).
    const TRAPS = [
        [/array element access out of bounds|index out of bounds/i, 'java.lang.ArrayIndexOutOfBoundsException'],
        [/null/i, 'java.lang.NullPointerException'],
        [/illegal cast|cast failure/i, 'java.lang.ClassCastException'],
        [/divide by zero/i, 'java.lang.ArithmeticException: / by zero'],
    ];
    const trap = e instanceof WebAssembly.RuntimeError ? TRAPS.find(([re]) => re.test(message)) : undefined;
    if (trap) return `${trap[1]} (WebAssembly trap: ${message}; not catchable in Java here, see the Java pack's README)`;
    const frames = typeof e?.stack === 'string'
        ? e.stack.split('\n').filter((l) => /^\s+at /.test(l) && !/teavm-runtime|runner\.js|^\s+at (Fiber|org\.teavm)/.test(l)).slice(0, 8).map((l) => l.replace(/ \(wasm:\/\/[^)]*\)$/, ''))
        : [];
    return [`java.lang.Error: ${message} (inside TeaVM's WebAssembly: a TeaVM limitation, not a Java exception)`, ...frames].join('\n');
}

let started = false;
self.onmessage = ({ data }) => {
    if ((data?.type !== 'run' && data?.type !== 'test') || started) return;
    started = true;
    run(data).catch((e) => {
        if (e instanceof ExitSignal) return;
        drainOutput();
        write(2, `runner failed: ${e?.stack ?? e}\n`);
        exit(1);
    });
};
