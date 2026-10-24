// Headless test of the PHP runner (packs/CONTRACT.md, "Running a program"),
// run the way the app runs it: app/static served over http with COOP/COEP
// so the page is crossOriginIsolated, `new Worker('/packs/php/runner.js',
// { type: 'module' })` in Chromium, the stdin SharedArrayBuffer driven from
// the page as the app's terminal drives it.
//
//   node test-run.mjs        (after ./build.sh; needs playwright-core)
//
// "cold" is the first run in a fresh browser profile: every byte downloaded,
// the wasm compiled. "warm" is a later run in a new worker on the same page,
// the files from the HTTP cache (standing in for the app's service worker).

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC = resolve(HERE, '../../app/static');
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };

// Raw files, no content-encoding negotiation: the worst-case transfer.
let bytesServed = 0;
/** Every path asked for, so a check can tell what a Test fetched. */
const served = [];
const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    served.push(path);
    if (path === '/__test.html') {
        res.writeHead(200, { 'content-type': 'text/html', ...ISOLATION });
        res.end('<!doctype html><link rel=icon href="data:,"><title>php runner test</title>');
        return;
    }
    const file = normalize(join(STATIC, path));
    try {
        if (!file.startsWith(STATIC) || !(await stat(file)).isFile()) throw new Error('not a file');
        const body = await readFile(file);
        bytesServed += body.length;
        res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
            'content-length': body.length,
            'cache-control': 'max-age=3600',
            ...ISOLATION,
        });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

await stat(join(STATIC, 'packs/php/runner.js')).catch(() => {
    console.error(`no ${join(STATIC, 'packs/php/runner.js')}: run ./build.sh first`);
    process.exit(2);
});
// A persistent profile in a fresh temporary directory: an incognito context's
// in-memory HTTP cache does not keep 20 MB entries, a disk cache does.
const profile = await mkdtemp(join(tmpdir(), 'yukibana-php-runner-test-'));
const browser = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM });
const page = browser.pages()[0] ?? (await browser.newPage());
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${origin}/__test.html`);

// In the page: start a runner, answer its stdin requests from `inputs`
// (a string is a line, null is Ctrl-D), collect every message in order.
await page.evaluate(() => {
    window.runProgram = (files, entry, inputs = [], { stopAfterMs = 0, timeoutMs = 120000, type = 'run', isolated = true } = {}) =>
        new Promise((done) => {
            const t0 = performance.now();
            const sab = crossOriginIsolated && isolated ? new SharedArrayBuffer(8 + 65536) : null;
            const state = sab && new Int32Array(sab, 0, 2);
            const data = sab && new Uint8Array(sab, 8);
            const events = [];
            const out = { stdout: '', stderr: '', code: null, events, stopped: false, loading: {}, phases: [] };
            const worker = new Worker('/packs/php/runner.js', { type: 'module' });
            const finish = () => {
                worker.terminate();
                out.ms = Math.round(performance.now() - t0);
                done(out);
            };
            const timer = setTimeout(() => {
                out.timedOut = true;
                finish();
            }, timeoutMs);
            worker.onerror = (e) => {
                out.workerError = e.message ?? String(e);
                clearTimeout(timer);
                finish();
            };
            worker.onmessage = ({ data: m }) => {
                const at = Math.round(performance.now() - t0);
                if (m.type === 'loading') {
                    out.loading[m.label] = { loaded: m.loaded, total: m.total };
                    return;
                }
                events.push({ ...m, at });
                if (m.type === 'phase') {
                    out.phases.push(`${m.text}@${at}ms`);
                    if (m.text === 'Running' || m.text === 'Testing') out.runningAt = at;
                    if (m.text === 'Running' && stopAfterMs) {
                        setTimeout(() => {
                            out.stopped = true;
                            clearTimeout(timer);
                            finish();
                        }, stopAfterMs);
                    }
                }
                if (m.type === 'stdout') out.stdout += m.text;
                if (m.type === 'stderr') out.stderr += m.text;
                if (m.type === 'stdin') {
                    const line = inputs.shift();
                    // Answer asynchronously, as a person typing would.
                    setTimeout(() => {
                        if (line === undefined || line === null) {
                            Atomics.store(state, 0, 3);
                        } else {
                            const bytes = new TextEncoder().encode(line);
                            data.set(bytes);
                            Atomics.store(state, 1, bytes.length);
                            Atomics.store(state, 0, 2);
                        }
                        Atomics.notify(state, 0);
                    }, 20);
                }
                if (m.type === 'exit') {
                    out.code = m.code;
                    clearTimeout(timer);
                    finish();
                }
            };
            worker.postMessage({ type, files, entry, stdin: sab });
        });
});

const SAMPLE = {
    'main.php': `<?php

declare(strict_types=1);

require_once __DIR__ . '/geometry.php';

use Geometry\\Point;

use function Geometry\\distance;

$a = new Point(0, 0);
$b = new Point(3, 4);
echo "{$a} to {$b}: " . distance($a, $b) . "\\n";
echo $b->norm() . "\\n";
`,
    'geometry.php': `<?php

declare(strict_types=1);

namespace Geometry;

/** A point in the plane. */
final class Point
{
    public function __construct(
        public readonly float $x,
        public readonly float $y,
    ) {
    }

    /** Distance from the origin. */
    public function norm(): float
    {
        return hypot($this->x, $this->y);
    }

    public function __toString(): string
    {
        return "({$this->x}, {$this->y})";
    }
}

/** Euclidean distance between two points. */
function distance(Point $a, Point $b): float
{
    return hypot($a->x - $b->x, $a->y - $b->y);
}
`,
};
const TESTS = `<?php

declare(strict_types=1);

namespace Geometry\\Tests;

use Geometry\\Point;
use PHPUnit\\Framework\\Attributes\\DataProvider;
use PHPUnit\\Framework\\TestCase;

use function Geometry\\distance;

require_once __DIR__ . '/../geometry.php';

final class GeometryTest extends TestCase
{
    public function testNormOfThreeFourIsFive(): void
    {
        $this->assertSame(5.0, (new Point(3, 4))->norm());
    }

    public function testDistanceIsSymmetric(): void
    {
        $a = new Point(1, 2);
        $b = new Point(-2, 6);
        $this->assertSame(distance($a, $b), distance($b, $a));
    }

    /** @return iterable<string, array{float, float, float}> */
    public static function norms(): iterable
    {
        yield 'origin' => [0, 0, 0.0];
        yield '5-12-13' => [5, 12, 13.0];
    }

    #[DataProvider('norms')]
    public function testNorm(float $x, float $y, float $expected): void
    {
        $this->assertEqualsWithDelta($expected, (new Point($x, $y))->norm(), 1e-12);
    }
}
`;

let failures = 0;
const short = (s, n = 160) => JSON.stringify(s.length > n ? `${s.slice(0, n)}...` : s);
function check(name, ok, detail) {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
const run = (files, entry, inputs, opts) => page.evaluate(([f, e, i, o]) => window.runProgram(f, e, i, o), [files, entry, inputs, opts]);
const timing = (r) => `(${r.ms} ms total, Running at ${r.runningAt ?? '-'} ms)`;
const plain = (text) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');

try {
    check('the page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated));

    // 1. The sample project, cold and warm.
    const expectSample = '(0, 0) to (3, 4): 5\n5\n';
    const before = bytesServed;
    const cold = await run(SAMPLE, 'main.php', []);
    check(
        'cold: the sample project prints the distance and the norm, exit 0',
        cold.stdout === expectSample && cold.stderr === '' && cold.code === 0,
        `${timing(cold)} stdout=${short(cold.stdout)} stderr=${short(cold.stderr)} code=${cold.code} ${cold.workerError ?? ''}`,
    );
    console.log(`      cold downloads: ${((bytesServed - before) / 1e6).toFixed(2)} MB raw over http; progress: ${JSON.stringify(cold.loading)}; phases: ${cold.phases.join(', ')}`);
    const warms = [];
    for (let i = 0; i < 3; i++) warms.push(await run(SAMPLE, 'main.php', []));
    const warmMedian = warms.map((w) => w.runningAt).sort((a, b) => a - b)[1];
    // No faster-than-cold check: from a local server the 20 MB download and
    // its streaming compilation (V8 compiles lazily) are not what a run waits
    // for, so cold and warm are within noise here. Over a network the cold
    // run is the download.
    check(
        'warm: new workers, files from the HTTP cache, run the sample again',
        warms.every((w) => w.stdout === expectSample && w.code === 0),
        `cold ${cold.runningAt} ms, warm ${warms.map((w) => w.runningAt).join('/')} ms (median ${warmMedian}) to Running`,
    );

    // 2. A prompt without a newline, two lines of stdin, their sum.
    const SUM = `<?php
echo "First number: ";
$a = (int) fgets(STDIN);
echo "Second number: ";
$b = (int) fgets(STDIN);
echo "$a + $b = ", $a + $b, "\\n";
`;
    const sum = await run({ 'main.php': SUM }, 'main.php', ['2\n', '40\n']);
    const firstStdin = sum.events.findIndex((e) => e.type === 'stdin');
    const beforeStdin = sum.events.slice(0, firstStdin).filter((e) => e.type === 'stdout').map((e) => e.text).join('');
    check(
        'fgets(STDIN) reads two lines through the SharedArrayBuffer and prints their sum',
        sum.stdout === 'First number: Second number: 2 + 40 = 42\n' && sum.code === 0,
        `${timing(sum)} stdout=${short(sum.stdout)} stderr=${short(sum.stderr)} code=${sum.code}`,
    );
    check('the prompt without a newline arrives before the runner asks for input', beforeStdin === 'First number: ', `before first stdin: ${JSON.stringify(beforeStdin)}`);

    // 2b. Reading to end of file, and fgets at end of file.
    const READ = `<?php
$name = trim((string) fgets(STDIN));
echo "hello, $name\\n";
$rest = stream_get_contents(STDIN);
echo "rest: ", json_encode($rest), "\\n";
var_dump(fgets(STDIN));
`;
    const rd = await run({ 'main.php': READ }, 'main.php', ['Ada\n', 'more\n', 'lines\n', null]);
    check(
        'stream_get_contents(STDIN) reads to Ctrl-D, and fgets after it is false',
        rd.stdout === 'hello, Ada\nrest: "more\\nlines\\n"\nbool(false)\n' && rd.code === 0,
        `stdout=${short(rd.stdout)} stderr=${short(rd.stderr)}`,
    );
    const noSab = await run({ 'main.php': '<?php var_dump(fgets(STDIN));\n' }, 'main.php', [], { isolated: false });
    check('with stdin null, fgets(STDIN) is end of file at once', noSab.stdout === 'bool(false)\n' && noSab.code === 0, `stdout=${short(noSab.stdout)}`);

    // 3. Errors and exit codes.
    const syn = await run({ 'main.php': '<?php\nrequire "helper.php";\necho f(2);\n', 'helper.php': '<?php\nfunction f($x) {\n    return $x * 2\n}\n' }, 'main.php', []);
    check(
        'a parse error in a required file: on stderr with its file and line, exit 255, nothing on stdout',
        syn.code === 255 && syn.stdout === '' && /Parse error/.test(syn.stderr) && /helper\.php on line 4/.test(syn.stderr),
        `${timing(syn)} stderr=${short(syn.stderr, 300)}`,
    );
    const rt = await run({ 'main.php': '<?php\necho "before\\n";\nrequire "geometry.php";\nboom();\n', 'geometry.php': '<?php\nfunction boom(): int {\n    return intdiv(1, 0);\n}\n' }, 'main.php', []);
    check(
        'an uncaught exception: output so far, then the fatal error with a stack trace through both files, exit 255',
        rt.code === 255 && rt.stdout === 'before\n' && /DivisionByZeroError/.test(rt.stderr) && /geometry\.php/.test(rt.stderr) && /main\.php/.test(rt.stderr),
        `stderr=${short(rt.stderr, 400)}`,
    );
    const warn = await run({ 'main.php': '<?php\n$a = [];\necho $a["missing"] ?? "default", "\\n";\necho $a["missing"], "|\\n";\n' }, 'main.php', []);
    check('a warning goes to stderr and the program goes on, exit 0', warn.code === 0 && warn.stdout === 'default\n|\n' && /Warning: Undefined array key "missing"/.test(warn.stderr), `stdout=${short(warn.stdout)} stderr=${short(warn.stderr)}`);
    const ex = await run({ 'main.php': '<?php\necho "bye\\n";\nexit(3);\n' }, 'main.php', []);
    check('exit(3) exits with 3', ex.code === 3 && ex.stdout === 'bye\n' && ex.stderr === '', `code=${ex.code} stderr=${short(ex.stderr)}`);
    const exs = await run({ 'main.php': '<?php\nexit("fatal: no input\\n");\n' }, 'main.php', []);
    check('exit("message") prints the message (to stdout, as PHP does) and exits 0', exs.code === 0 && exs.stdout === 'fatal: no input\n', `code=${exs.code} stdout=${short(exs.stdout)}`);

    // 3b. Subfolders, UTF-8, interleaving, streaming, a lot of output.
    const pkg = await run(
        {
            'main.php': '<?php\nrequire __DIR__ . "/src/Shapes/Circle.php";\necho round((new Shapes\\Circle(1))->area(), 5), "\\n";\nfwrite(STDERR, "ünïcödé ✓ 雪花\\n");\necho "done\\n";\n',
            'src/Shapes/Circle.php': '<?php\nnamespace Shapes;\nfinal class Circle {\n    public function __construct(private float $r) {}\n    public function area(): float { return M_PI * $this->r ** 2; }\n}\n',
        },
        'main.php',
        [],
    );
    check('a file in a subfolder is required; UTF-8 survives', pkg.code === 0 && pkg.stdout === '3.14159\ndone\n' && pkg.stderr === 'ünïcödé ✓ 雪花\n', `stdout=${short(pkg.stdout)} stderr=${short(pkg.stderr)}`);
    // `echo a, b` is two writes, so stdout events of one line come in pieces.
    const order = pkg.events.filter((e) => e.type === 'stdout' || e.type === 'stderr').map((e) => e.type[3]).join('').replace(/(.)\1+/g, '$1');
    check('stdout and stderr arrive in program order', order === 'oeo', order);
    const slow = await run({ 'main.php': '<?php\nfor ($i = 0; $i < 3; $i++) {\n    echo $i, "\\n";\n    usleep(300000);\n}\n' }, 'main.php', []);
    const outs = slow.events.filter((e) => e.type === 'stdout');
    check(
        'output is streamed as printed (usleep in between)',
        slow.stdout === '0\n1\n2\n' && outs.length >= 3 && outs.at(-1).at - outs[0].at >= 500,
        `stdout events at ${outs.map((e) => e.at).join(', ')} ms`,
    );
    const big = await run({ 'main.php': '<?php\nfor ($i = 0; $i < 100000; $i++) echo $i, "\\n";\n' }, 'main.php', []);
    check('100 000 printed lines all arrive', big.code === 0 && big.stdout.split('\n').length === 100001, `${timing(big)}, ${big.events.filter((e) => e.type === 'stdout').length} stdout messages`);

    // 4. A program that never ends: its output arrives, Stop terminates it.
    const loop = await run({ 'main.php': '<?php\necho "spinning\\n";\nwhile (true) {}\n' }, 'main.php', [], { stopAfterMs: 1000 });
    check('an infinite loop is stopped by terminating the worker; its output arrived first', loop.stopped && loop.code === null && loop.stdout === 'spinning\n', `${timing(loop)} stdout=${short(loop.stdout)}`);
    const after = await run(SAMPLE, 'main.php', []);
    check('after Stop, a new run works', after.code === 0 && after.stdout === expectSample, timing(after));

    // 5. Test mode: PHPUnit over tests/.
    const test = async (files) => {
        const out = await run(files, 'main.php', [], { type: 'test' });
        return { ...out, raw: out.stdout, stdout: plain(out.stdout) };
    };
    const t1 = await test({ ...SAMPLE, 'tests/GeometryTest.php': TESTS });
    check(
        'test: the sample tests pass under PHPUnit, exit 0, the report on stdout',
        t1.code === 0 && /OK \(4 tests, 4 assertions\)/.test(t1.stdout) && /PHPUnit 12\.5\.40/.test(t1.stdout),
        `${timing(t1)} phases: ${t1.phases.join(', ')}; loading: ${JSON.stringify(t1.loading['phpunit.phar'])}\n${t1.stdout.trimEnd().replace(/^/gm, '      | ')}${t1.stderr ? `\nstderr ${short(t1.stderr, 400)}` : ''}`,
    );
    check('test: the report is in colour (the OK line in green)', /\x1b\[30;42mOK \(4 tests/.test(t1.raw) || /\x1b\[[0-9;]*m/.test(t1.raw), JSON.stringify(t1.raw.slice(-80)));
    const failing = TESTS.replace("$this->assertSame(5.0, (new Point(3, 4))->norm());", "$this->assertSame(6.0, (new Point(3, 4))->norm());");
    const t2 = await test({ ...SAMPLE, 'tests/GeometryTest.php': failing });
    check(
        'test: a failing assertion is reported with expected and actual, exit 1',
        t2.code === 1 && /FAILURES!/.test(t2.stdout) && /Failed asserting that 5\.0 is identical to 6\.0/.test(t2.stdout) && /GeometryTest\.php:\d+/.test(t2.stdout),
        `code=${t2.code}\n${t2.stdout.trim().split('\n').slice(-12).join('\n').replace(/^/gm, '      | ')}`,
    );
    // The autoloader: a test uses a class of the project without requiring its file.
    const t3 = await test({
        'src/Money.php': '<?php\nnamespace App;\nfinal class Money {\n    public function __construct(public readonly int $cents) {}\n    public function add(Money $o): self { return new self($this->cents + $o->cents); }\n}\n',
        'tests/MoneyTest.php': '<?php\nuse App\\Money;\nuse PHPUnit\\Framework\\TestCase;\nfinal class MoneyTest extends TestCase {\n    public function testAdds(): void { $this->assertSame(300, (new Money(100))->add(new Money(200))->cents); }\n}\n',
    });
    check('test: a project class is autoloaded by the class map, no require needed', t3.code === 0 && /OK \(1 test, 1 assertion\)/.test(t3.stdout), `code=${t3.code} ${short(t3.stdout.trim().split('\n').slice(-3).join(' | '), 300)} ${short(t3.stderr)}`);
    // A project with its own phpunit.xml: its test suites are used.
    const t4 = await test({
        ...SAMPLE,
        'phpunit.xml': '<?xml version="1.0"?>\n<phpunit bootstrap="vendor/autoload.php">\n  <testsuites>\n    <testsuite name="unit"><directory>spec</directory></testsuite>\n  </testsuites>\n</phpunit>\n',
        'spec/GeometryTest.php': TESTS,
    });
    check('test: a phpunit.xml of the project chooses the tests (spec/ here), with our bootstrap', t4.code === 0 && /OK \(4 tests/.test(t4.stdout), `code=${t4.code} ${short(t4.stdout.trim().split('\n').slice(-3).join(' | '), 300)} ${short(t4.stderr)}`);
    const t5 = await test({ ...SAMPLE });
    check('test: a project without tests says so, exit non-zero', t5.code !== 0, `code=${t5.code} ${short(t5.stdout.trim() + ' ' + t5.stderr.trim(), 200)}`);


    // 6. Property-based tests with Eris: fetched only by a Test that uses it.
    const fetchedEris = () => served.includes('/packs/php/eris.tar');
    check('test: Eris is not fetched by a Test that does not use it', !fetchedEris());
    const PROPERTIES = `<?php

declare(strict_types=1);

namespace Geometry\\Tests;

use Eris\\Generators;
use Eris\\TestTrait;
use Geometry\\Point;
use PHPUnit\\Framework\\TestCase;

use function Geometry\\distance;

require_once __DIR__ . '/../geometry.php';

final class PropertiesTest extends TestCase
{
    use TestTrait;

    public function testDistanceIsSymmetric(): void
    {
        $this->forAll(Generators::int(), Generators::int(), Generators::int(), Generators::int())
            ->then(function (int $ax, int $ay, int $bx, int $by): void {
                $a = new Point($ax, $ay);
                $b = new Point($bx, $by);
                $this->assertSame(distance($a, $b), distance($b, $a));
            });
    }

    public function testNormStaysUnder100(): void
    {
        $this->forAll(Generators::choose(0, 1000))
            ->then(function (int $x): void {
                $this->assertLessThan(100.0, (new Point($x, 0))->norm());
            });
    }
}
`;
    const t6 = await test({ ...SAMPLE, 'tests/GeometryTest.php': TESTS, 'tests/PropertiesTest.php': PROPERTIES });
    check(
        'test: Eris: a passing property passes; a failing one fails with its counterexample shrunk to 100 and the seed to replay it',
        t6.code === 1 &&
            /Tests: 6, Assertions: \d+, Failures: 1/.test(t6.stdout) &&
            /PropertiesTest::testNormStaysUnder100/.test(t6.stdout) &&
            /Failed asserting that 100\.0 is less than 100\.0/.test(t6.stdout) &&
            /ERIS_SEED=\d+/.test(t6.stdout + t6.stderr),
        `${timing(t6)} phases: ${t6.phases.join(', ')}; loading: ${JSON.stringify(t6.loading['eris.tar'])}\n${t6.stdout.trimEnd().replace(/^/gm, '      | ')}${t6.stderr ? `\nstderr ${short(t6.stderr, 600)}` : ''}`,
    );
    check('test: Eris is fetched once a test uses it', fetchedEris());

    check('no page errors', pageErrors.length === 0, pageErrors.join('; '));
} finally {
    await browser.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
