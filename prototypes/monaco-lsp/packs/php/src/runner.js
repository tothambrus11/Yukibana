// PHP runner for the Yukibana IDE (packs/CONTRACT.md, "Running a program"):
// `php main.php` in the project folder, with PHP 8.4's own CLI SAPI compiled
// to WebAssembly (the same php.wasm the language server runs), and Test as
// `phpunit tests` with PHPUnit's own phar.
//
// Protocol (one object per postMessage):
//   in:  { type: 'run' | 'test', files, entry, stdin: SharedArrayBuffer | null }
//   out: loading / phase / stdout / stderr / stdin / exit (exit is last)
//
// stdin: PHP's reads of fd 0 come here one byte at a time (php.js). With no
// input left, the runner asks the app for a line and blocks on the
// SharedArrayBuffer, which is allowed in a worker and leaves PHP waiting in
// its read() as on a terminal. PHP's CLI writes stdout unbuffered, so a
// prompt printed before the read has already been posted.

import { download, runCli, startPhp, writeFile } from './php.js';

const ROOT = '/workspace';
const post = (msg) => self.postMessage(msg);
const report = (p) => post({ type: 'loading', ...p });

// Starts loading at once, so the download overlaps the app sending `run`.
let input = () => null;
const ready = startPhp({
    report,
    stdin: () => input(),
    stdout: writer('stdout'),
    stderr: writer('stderr'),
    env: { TERM: 'xterm-256color', COLUMNS: '100' },
});
ready.catch(() => {});

/** Posts a stream's bytes as text, a UTF-8 sequence split between writes kept whole. */
function writer(type) {
    const decoder = new TextDecoder();
    return (bytes) => {
        const text = decoder.decode(bytes, { stream: true });
        if (text) post({ type, text });
    };
}

/**
 * The byte source for fd 0 over the contract's SharedArrayBuffer (null:
 * always end of file). A read of fd 0 calls this up to its buffer's length
 * (php.js): after a line is handed out it returns `undefined` once, which
 * ends that read with the line, so the next read is the one that waits.
 */
function terminal(sab) {
    if (!sab) return () => null;
    const state = new Int32Array(sab, 0, 2);
    const data = new Uint8Array(sab, 8);
    let line = new Uint8Array(0);
    let at = 0;
    let endOfRead = false;
    return () => {
        if (at < line.length) {
            const byte = line[at++];
            if (at === line.length) endOfRead = true;
            return byte;
        }
        if (endOfRead) {
            endOfRead = false;
            return undefined;
        }
        Atomics.store(state, 0, 1);
        post({ type: 'stdin' });
        while (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1);
        const s = Atomics.load(state, 0);
        line = s === 2 ? data.slice(0, Math.min(Atomics.load(state, 1), data.length)) : new Uint8Array(0);
        at = 0;
        // Back to idle; after Ctrl-D (3) a later read asks again, as a terminal does.
        Atomics.store(state, 0, 0);
        if (line.length === 0) return null;
        const byte = line[at++];
        if (at === line.length) endOfRead = true;
        return byte;
    };
}

/** The project's files at their paths under ROOT; a path that leaves it is refused. */
function writeProject(php, files) {
    php.FS.mkdirTree(ROOT);
    for (const [rel, text] of Object.entries(files)) {
        const parts = rel.split('/').filter((p) => p && p !== '.');
        if (parts.length === 0 || parts.includes('..')) throw new Error(`bad project path: ${rel}`);
        writeFile(php, `${ROOT}/${parts.join('/')}`, text);
    }
}

/**
 * PHPUnit's arguments for the project: its own phpunit.xml(.dist) when it
 * has one, else the tests in tests/ (every *Test.php, PHPUnit's default
 * suffix); the bootstrap is always ours (autoload.php), because a
 * configuration's own bootstrap is normally Composer's vendor/autoload.php,
 * which the browser does not have.
 */
function phpunitArgs(files) {
    const configured = ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'].some((f) => f in files);
    return ['--bootstrap', '/opt/yukibana/autoload.php', '--colors=always', '--do-not-cache-result', ...(configured ? [] : ['tests'])];
}

let started = false;
self.onmessage = async ({ data: msg }) => {
    if ((msg?.type !== 'run' && msg?.type !== 'test') || started) return;
    started = true;
    const testing = msg.type === 'test';
    let code = 1;
    try {
        post({ type: 'phase', text: testing ? 'Loading PHP and PHPUnit' : 'Loading PHP' });
        const [php, phpunit, autoload] = await Promise.all([
            ready,
            testing ? download('phpunit.phar', report) : null,
            testing ? download('autoload.php', () => {}) : null,
        ]);
        input = terminal(msg.stdin ?? null);
        writeProject(php, msg.files ?? {});
        php.FS.chdir(ROOT);
        // Errors and warnings to stderr, so the terminal shows them as errors.
        const ini = ['-d', 'display_errors=stderr', '-d', 'html_errors=0'];
        if (testing) {
            writeFile(php, '/opt/phpunit.phar', phpunit);
            writeFile(php, '/opt/yukibana/autoload.php', autoload);
            post({ type: 'phase', text: 'Testing' });
            code = await runCli(php, ['php', ...ini, '/opt/phpunit.phar', ...phpunitArgs(msg.files ?? {})]);
        } else {
            post({ type: 'phase', text: 'Running' });
            code = await runCli(php, ['php', ...ini, msg.entry ?? 'main.php']);
        }
    } catch (err) {
        post({ type: 'stderr', text: `php runner: ${err?.stack ?? err}\n` });
        code = 1;
    }
    post({ type: 'exit', code });
};
