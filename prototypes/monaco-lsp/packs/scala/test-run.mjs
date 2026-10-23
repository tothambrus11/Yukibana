// Headless test of the Scala runner (runner.js), run the way the app runs
// it: app/static served over http with COOP/COEP (so the page is
// crossOriginIsolated and has SharedArrayBuffer), `new Worker(
// '/packs/scala/runner.js', { type: 'module' })` in Chromium, the CONTRACT.md
// messages, and stdin driven from the page through the SharedArrayBuffer.
//
// Runs: (1) the sample project of app/src/lib/languages.ts, as it is there;
// (2) a prompt without a newline, two lines of stdin, their sum; (3) a type
// error: on stderr, exit 1; (4) a program that loops forever: the page
// terminates the worker; plus output that streams while the program never
// yields, a flood of lines coalesced into few messages, end of file on stdin
// (Ctrl-D, and no SharedArrayBuffer at all), an uncaught exception, an
// `object Main { def main }` entry, and a project of four files. The sample runs first in a fresh
// browser (cold: every file downloaded) and again at the end (warm: HTTP
// cache, as the service worker gives the app).
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
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };

let bytesServed = 0;
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION }).end('<!doctype html><link rel=icon href="data:,"><title>scala runner test</title>');
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

await stat(join(STATIC, 'packs/scala/runner.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/scala/runner.js')}: run ./build.sh first`);
    process.exit(2);
});

/** The Scala sample project exactly as languages.ts has it (template literals unescaped). */
async function sampleProject() {
    const src = await readFile(LANGUAGES, 'utf8');
    const block = src.slice(src.indexOf("id: 'scala'"));
    const files = {};
    for (const m of block.matchAll(/'([\w.]+\.scala)': `((?:[^`\\]|\\.)*)`/g)) files[m[1]] = m[2].replace(/\\(.)/g, '$1');
    const entry = /entry: '([^']+)'/.exec(block)[1];
    return { files, entry };
}

// A persistent profile, so that the warm run reads the HTTP disk cache (an
// incognito context's memory cache does not keep the 16 MB sjsir.bin).
const profile = await mkdtemp(join(tmpdir(), 'scala-runner-test-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
};

try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => console.log('[page error]', e.message));
    await page.goto(`${origin}/__test.html`);
    check('the page is cross-origin isolated (SharedArrayBuffer available)', await page.evaluate(() => crossOriginIsolated));

    /** Runs a project in a fresh runner worker. `input` lines are given one per
     *  `stdin` request ("" = end of file); `stopAfterOutputMs` terminates the
     *  worker that long after its first output. Resolves with what the app
     *  would have seen, and when. */
    const runProgram = (files, entry, opts = {}) => page.evaluate(({ files, entry, opts }) => new Promise((done) => {
        const t0 = performance.now();
        const at = () => Math.round(performance.now() - t0);
        const stdin = new SharedArrayBuffer(8 + 64 * 1024);
        const state = new Int32Array(stdin, 0, 2);
        const input = [...(opts.input ?? [])];
        const r = { stdout: '', stderr: '', exit: null, phases: [], loading: {}, prompts: [], terminated: false, ms: 0, messages: 0 };
        const worker = new Worker('/packs/scala/runner.js', { type: 'module' });
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
        worker.postMessage({ type: 'run', files, entry, stdin: opts.noStdin ? null : stdin });
    }), { files, entry, opts });

    const phases = (r) => r.phases.map(([p, t]) => `${p}@${t}ms`).join(' ');
    const sample = await sampleProject();

    // (1) The sample project, cold.
    bytesServed = 0;
    const cold = await runProgram(sample.files, sample.entry);
    const coldBytes = bytesServed;
    // Scala.js prints a Double with an integral value without ".0" (as
    // JavaScript does): the JVM would print Point(0.0,0.0) and 5.0.
    check('the sample project runs as-is and prints its two lines (cold)', cold.exit === 0 && cold.stdout === 'Point(0,0) to Point(3,4): 5\n5\n',
        `(${cold.ms} ms, ${(coldBytes / 1e6).toFixed(1)} MB fetched: ${phases(cold)}) stdout=${JSON.stringify(cold.stdout)} stderr=${JSON.stringify(cold.stderr)}`);
    check('progress was reported for every download', ['scalac.js', 'classpath.bin', 'classpath-sjs.bin', 'sjsir.bin', 'sjslinker.js'].every((f) => cold.loading[f] && cold.loading[f].loaded === cold.loading[f].total && cold.loading[f].total > 0),
        JSON.stringify(Object.fromEntries(Object.entries(cold.loading).map(([k, v]) => [k, v.loaded]))));

    // (2) A prompt without a newline, two lines of stdin, their sum.
    const SUM = `import scala.io.StdIn

@main def sum(): Unit =
  print("First number: ")
  val a = StdIn.readLine().trim.toInt
  print("Second number: ")
  val b = StdIn.readLine().trim.toInt
  println(s"Sum: \${a + b}")
`;
    const sum = await runProgram({ 'Main.scala': SUM }, 'Main.scala', { input: ['40\n', '2\n'] });
    check('a prompt printed without a newline is visible when the program waits for input', sum.prompts[0] === 'First number: ' && sum.prompts[1] === 'First number: Second number: ', JSON.stringify(sum.prompts));
    check('two lines read from stdin through the SharedArrayBuffer are summed', sum.exit === 0 && sum.stdout === 'First number: Second number: Sum: 42\n',
        `(${sum.ms} ms: ${phases(sum)}) stdout=${JSON.stringify(sum.stdout)} stderr=${JSON.stringify(sum.stderr)}`);

    // (3) A compile error.
    const BROKEN = `@main def broken(): Unit =\n  val n: Int = "five"\n  println(n)\n`;
    const broken = await runProgram({ 'Main.scala': BROKEN }, 'Main.scala');
    check('a type error is reported on stderr with its position, and the exit code is non-zero', broken.exit === 1 && broken.stdout === '' &&
        /Main\.scala:2:16: error: Found: +\("five" : String\)\nRequired: Int/.test(broken.stderr) && /1 error found/.test(broken.stderr),
        `(${broken.ms} ms: ${phases(broken)}) exit=${broken.exit} stderr=${JSON.stringify(broken.stderr)}`);
    const SYNTAX = `@main def oops(): Unit =\n  println("unclosed\n`;
    const syntax = await runProgram({ 'Main.scala': SYNTAX }, 'Main.scala');
    check('a syntax error is reported on stderr, and the exit code is non-zero', syntax.exit === 1 && /error/.test(syntax.stderr), `stderr=${JSON.stringify(syntax.stderr)}`);

    // (4) A program that never ends: the page terminates the worker.
    const SPIN = `@main def spin(): Unit =\n  println("spinning")\n  var i = 0L\n  while true do i += 1\n`;
    const spin = await runProgram({ 'Main.scala': SPIN }, 'Main.scala', { stopAfterOutputMs: 1000 });
    check('a program that loops forever runs until the worker is terminated, and the test goes on', spin.terminated && spin.exit === null && spin.stdout === 'spinning\n',
        `(${spin.ms} ms, terminated 1 s after its first output) stdout=${JSON.stringify(spin.stdout)}`);

    // Output is streamed while the program runs without yielding: a partial
    // line shows although nothing flushes it and main never returns.
    const BUSY = `@main def busy(): Unit =\n  println("start")\n  print("working...")\n  var i = 0L\n  while true do i += 1\n`;
    const busy = await runProgram({ 'Main.scala': BUSY }, 'Main.scala', { stopAfterOutputMs: 1500 });
    check('output printed before a long computation shows during it, a partial line included', busy.terminated && busy.stdout === 'start\nworking...',
        `stdout=${JSON.stringify(busy.stdout)}`);
    const FLOOD = `@main def flood(): Unit =\n  for i <- 1 to 100000 do println(i)\n`;
    const flood = await runProgram({ 'Main.scala': FLOOD }, 'Main.scala');
    const floodLines = flood.stdout.split('\n');
    check('100000 printed lines arrive complete and in order, in few messages', flood.exit === 0 && floodLines.length === 100001 &&
        floodLines[0] === '1' && floodLines[99999] === '100000' && floodLines.every((l, i) => i === 100000 ? l === '' : l === String(i + 1)) && flood.messages < 2000,
        `(${flood.ms} ms) ${flood.messages} messages for ${flood.stdout.length} characters`);

    // A project of four files in folders; another file has a main too, and
    // the entry's main is the one that runs.
    const multi = await runProgram({
        'src/Main.scala': `import util.{Greeter, Name}\n\n@main def run(): Unit =\n  println(Greeter.greet(Name("x")) + " " + Answer.value)\n`,
        'src/Answer.scala': `object Answer:\n  val value = 42\n`,
        'src/util/Name.scala': `package util\n\ncase class Name(text: String)\n`,
        'src/util/Greeter.scala': `package util\n\nobject Greeter:\n  def greet(n: Name): String = s"hello \${n.text}"\n\n@main def other(): Unit = println("wrong main")\n`,
    }, 'src/Main.scala');
    check('a project of four files in folders runs, and the entry file\'s main is the one that runs', multi.exit === 0 && multi.stdout === 'hello x 42\n',
        `stdout=${JSON.stringify(multi.stdout)} stderr=${JSON.stringify(multi.stderr)}`);

    // More: end of file, an uncaught exception, an object with main.
    const EOF = `@main def eof(): Unit =\n  val l = scala.io.StdIn.readLine()\n  println(if l == null then "end of file" else l)\n`;
    const eof = await runProgram({ 'Main.scala': EOF }, 'Main.scala', { input: [''] });
    check('end of input (Ctrl-D) makes readLine return null', eof.exit === 0 && eof.stdout === 'end of file\n', `stdout=${JSON.stringify(eof.stdout)} stderr=${JSON.stringify(eof.stderr)}`);
    const noStdin = await runProgram({ 'Main.scala': EOF }, 'Main.scala', { noStdin: true });
    check('without a SharedArrayBuffer (stdin: null) readLine returns null', noStdin.exit === 0 && noStdin.stdout === 'end of file\n', `stdout=${JSON.stringify(noStdin.stdout)} stderr=${JSON.stringify(noStdin.stderr)}`);
    const BOOM = `@main def boom(): Unit =\n  throw new IllegalStateException("boom")\n`;
    const boom = await runProgram({ 'Main.scala': BOOM }, 'Main.scala');
    check('an exception\'s stack trace names Scala.js frames and has no empty frame line', boom.exit === 1 &&
        boom.stderr.startsWith('Exception in thread "main" java.lang.IllegalStateException: boom\n    at ') && !/^\s+at\s*$/m.test(boom.stderr),
        `stderr=${JSON.stringify(boom.stderr)}`);
    const THROW = `object Main:\n  def main(args: Array[String]): Unit =\n    println("before")\n    val xs = Array(1, 2, 3)\n    println(xs(3))\n`;
    const thrown = await runProgram({ 'Main.scala': THROW }, 'Main.scala');
    check('`object Main { def main }` runs, and an uncaught exception goes to stderr with exit 1', thrown.exit === 1 && thrown.stdout === 'before\n' &&
        /ArrayIndexOutOfBoundsException/.test(thrown.stderr), `stderr=${JSON.stringify(thrown.stderr.split('\n').slice(0, 2).join('\n'))}`);
    const UNLINKABLE = `@main def threads(): Unit =\n  val t = new Thread(() => println("in a thread"))\n  t.start()\n  t.join()\n`;
    const unlinkable = await runProgram({ 'Main.scala': UNLINKABLE }, 'Main.scala');
    check('JDK API that Scala.js does not have (threads) is a link error on stderr, exit 1', unlinkable.exit === 1 && /link error/.test(unlinkable.stderr),
        `stderr=${JSON.stringify(unlinkable.stderr.split('\n').slice(0, 2).join('\n'))}`);

    // A program with the Scala 3 a course uses: enums, pattern matching,
    // givens and extension methods, collections, string formatting, Long
    // arithmetic, lazy vals, a mutable map, Option, a for comprehension.
    const FEATURES = `import scala.collection.mutable

enum Shape:
  case Circle(r: Double)
  case Rect(w: Double, h: Double)

def area(s: Shape): Double = s match
  case Shape.Circle(r) => math.Pi * r * r
  case Shape.Rect(w, h) => w * h

trait Show[A]:
  extension (a: A) def show: String

given Show[Int] with
  extension (a: Int) def show: String = s"#\${a}"

lazy val big: Long = (1L to 20L).product

@main def features(): Unit =
  println(List(Shape.Circle(1), Shape.Rect(2, 3)).mkString(", "))
  println(f"\${area(Shape.Circle(1))}%.3f \${area(Shape.Rect(2, 3))}%.1f")
  println(42.show)
  println(big)
  val counts = mutable.Map.empty[Char, Int]
  for c <- "hello world" if c != ' ' do counts(c) = counts.getOrElse(c, 0) + 1
  println(counts.toSeq.sortBy((c, n) => (-n, c)).take(3).mkString(" "))
  println(for x <- Some(3); y <- Option(4) yield x * y)
  println(List(3, 1, 2).sorted.reverse.zipWithIndex)
  println("Unicode: \u00e9t\u00e9 \u2713")
`;
    const features = await runProgram({ 'Main.scala': FEATURES }, 'Main.scala');
    // As in the sample, a Double with an integral value prints as on
    // JavaScript: Circle(1), where the JVM prints Circle(1.0).
    check('a program using enums, givens, extension methods, collections, f-strings and Longs runs',
        features.exit === 0 && features.stdout === 'Circle(1), Rect(2,3)\n3.142 6.0\n#42\n2432902008176640000\n(l,3) (o,2) (d,1)\nSome(12)\nList((3,0), (2,1), (1,2))\nUnicode: \u00e9t\u00e9 \u2713\n',
        `stdout=${JSON.stringify(features.stdout)} stderr=${JSON.stringify(features.stderr)}`);
    const EXIT = `@main def quit(): Unit =\n  println("bye")\n  sys.exit(3)\n`;
    const exited = await runProgram({ 'Main.scala': EXIT }, 'Main.scala');
    check('sys.exit is not available (Scala.js has no System.exit): a link error, exit 1', exited.exit === 1 && /System\.exit/.test(exited.stderr),
        `stderr=${JSON.stringify(exited.stderr.split('\n').slice(0, 2).join('\n'))}`);

    // (1 again) The sample, warm: files from the HTTP cache.
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
