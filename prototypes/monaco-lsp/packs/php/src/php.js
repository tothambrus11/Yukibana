// What the PHP pack's two workers share: starting PHP 8.4 (the WordPress
// Playground build, php.wasm with its Emscripten loader php.mjs) with our own
// stdin, stdout and stderr, running its CLI SAPI with argv, and unpacking a
// tar archive into its in-memory file system.
//
// The loader is used directly, without @php-wasm/universal: that package is
// a web server around PHP (requests, php.ini, a process manager), and both
// workers only ever run `php <args>` once per runtime, as a terminal would.

import { init } from './php.mjs';

const BASE = new URL('./', import.meta.url).href;

/**
 * Downloads `name` (relative to this pack) and reports progress with
 * `report({ label, loaded, total })`. With Content-Encoding the length header
 * is of the compressed body while the stream yields decompressed bytes, so
 * the total is unknown (0) until the end.
 */
export async function download(name, report) {
    const res = await fetch(BASE + name);
    if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
    return new Uint8Array(await new Response(counted(res, name, report)).arrayBuffer());
}

/** The response's body as a stream that reports its bytes as they pass. */
function counted(res, label, report) {
    const total = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length') ?? 0);
    let loaded = 0;
    let last = 0;
    report({ label, loaded, total });
    return res.body.pipeThrough(
        new TransformStream({
            transform(chunk, controller) {
                loaded += chunk.byteLength;
                const now = performance.now();
                if (now - last > 50) {
                    last = now;
                    report({ label, loaded, total });
                }
                controller.enqueue(chunk);
            },
            flush() {
                report({ label, loaded, total: total || loaded });
            },
        }),
    );
}

/**
 * Compiles php.wasm once per worker. instantiateStreaming on the original
 * Response, so the browser can cache the compiled module by URL (a 20 MB
 * module recompiled from bytes on every Run costs seconds); the bytes are
 * counted on a clone.
 */
async function compile(report) {
    const res = await fetch(BASE + 'php.wasm');
    if (!res.ok || !res.body) throw new Error(`php.wasm: HTTP ${res.status}`);
    const counting = new Response(counted(res.clone(), 'php.wasm', report)).arrayBuffer();
    try {
        const module = await WebAssembly.compileStreaming(res);
        counting.catch(() => {});
        return module;
    } catch {
        // A host that does not send application/wasm: compile from the bytes.
        return WebAssembly.compile(await counting);
    }
}

/**
 * A started PHP runtime: its Emscripten module, after the runtime has
 * initialised and before any PHP code ran.
 *
 * - `stdin()` is called for each byte PHP reads from fd 0: a number is the
 *   byte, `undefined` means "nothing now" (a read that got bytes returns
 *   them, one that got none fails with EAGAIN, which a non-blocking reader
 *   such as amphp's event loop expects), `null` is end of file.
 * - `stdout(bytes)` and `stderr(bytes)` get PHP's output as it is written.
 */
export async function startPhp({ report, stdin, stdout, stderr, env = {} }) {
    const module = await compile(report);
    return new Promise((resolve, reject) => {
        const php = init('WORKER', {
            ENV: { HOME: '/home', TMPDIR: '/tmp', ...env },
            noInitialRun: true,
            locateFile: (path) => path,
            instantiateWasm(imports, done) {
                WebAssembly.instantiate(module, imports).then((instance) => done(instance, module), reject);
                return {};
            },
            stdin,
            onStdout: stdout,
            onStderr: stderr,
            onAbort: (what) => reject(new Error(`PHP aborted: ${what}`)),
            onRuntimeInitialized: () => resolve(php),
        });
    });
}

/**
 * Runs PHP's CLI SAPI with `argv` (argv[0] is the program name, "php") and
 * resolves with its exit code: `exit(n)` in PHP ends the runtime with an
 * exception that carries the status, which is caught here. A runtime runs
 * the CLI once.
 */
export async function runCli(php, argv) {
    for (const arg of argv) php.ccall('wasm_add_cli_arg', null, ['string'], [arg]);
    try {
        return await php.ccall('run_cli', 'number', [], [], { async: true });
    } catch (e) {
        if (e && typeof e === 'object' && 'status' in e) return e.status;
        throw e;
    }
}

/** Writes `text` at `path` (absolute), creating its folders. */
export function writeFile(php, path, text) {
    php.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
    php.FS.writeFile(path, text);
}

/**
 * Unpacks a tar archive (ustar, with GNU long names and pax `path` records,
 * as GNU tar writes them) under `dest`, with the files' modification times.
 * Regular files and directories only.
 */
export function untar(php, tar, dest) {
    const text = new TextDecoder();
    const field = (at, len) => {
        const bytes = tar.subarray(at, at + len);
        const end = bytes.indexOf(0);
        return text.decode(end < 0 ? bytes : bytes.subarray(0, end));
    };
    let longName = null;
    for (let at = 0; at + 512 <= tar.length; ) {
        if (tar[at] === 0) break;
        const size = parseInt(field(at + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(tar[at + 156] || 48);
        const body = tar.subarray(at + 512, at + 512 + size);
        const prefix = field(at + 257, 6) === 'ustar' ? field(at + 345, 155) : '';
        let name = longName ?? (prefix ? `${prefix}/${field(at, 100)}` : field(at, 100));
        longName = null;
        if (type === 'L') longName = text.decode(body).replace(/\0+$/, '');
        else if (type === 'x') {
            const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text.decode(body));
            if (path) longName = path[1];
        } else if (type === '5' || type === '0' || type === '7') {
            name = name.replace(/^\.\//, '').replace(/\/$/, '');
            if (name && name !== '.') {
                const path = `${dest}/${name}`;
                if (type === '5') php.FS.mkdirTree(path);
                else {
                    writeFile(php, path, body);
                    // The archive's time, not now, as change time too:
                    // Phpactor's index (built with these times) re-reads
                    // a file whose ctime is newer than itself.
                    const time = parseInt(field(at + 136, 12).trim() || '0', 8) * 1000;
                    const node = php.FS.lookupPath(path).node;
                    node.atime = node.mtime = node.ctime = time;
                }
            }
        }
        at += 512 + Math.ceil(size / 512) * 512;
    }
}
