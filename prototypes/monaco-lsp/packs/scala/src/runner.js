// Yukibana Scala pack: runs a Scala 3 project in a module Web Worker, as
// CONTRACT.md ("Running a program") says. Nothing is interpreted or faked:
//
//   1. Compiling: the real Scala 3.7.4 compiler (scalac.js, the same file the
//      language server loads) runs its full pipeline with the Scala.js back
//      end (`-scalajs`, GenSJSIR) over every .scala file of the project, to
//      Scala.js IR in memory. Diagnostics go to stderr; errors exit 1.
//   2. Linking: the Scala.js 1.19.0 linker (sjslinker.js, the linker compiled
//      with Scala.js) links that IR with the Scala.js standard library IR
//      (sjsir.bin) into one ES module, the way `sbt fastLinkJS` does.
//   3. Running: the module is imported in this worker. Its first module
//      initializer (yukibana.runtime.Std, compiled at build time) replaces
//      System.out/err/in with streams that call `globalThis.__yukibana` below,
//      so output arrives as it is written and `scala.io.StdIn.readLine()`
//      blocks on the SharedArrayBuffer with Atomics.wait. Then the program's
//      main runs.
//
// A program that never ends blocks this worker; the app terminates it.

const BASE = new URL('./', import.meta.url);
const post = (m) => postMessage(m);

/** Fetches a pack file, reporting `loading` as bytes arrive. Totals come from
 *  manifest.json (uncompressed sizes): a host serving .br/.gz siblings reports
 *  the compressed length, if any. */
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

/** Imports an ES module from bytes (so that its download could report progress). */
async function importBytes(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    try { return await import(url); } finally { URL.revokeObjectURL(url); }
}

/** The entries of a bundle (classpath.bin's format): [path, Int8Array view]. */
function entries(bundle) {
    const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
    const headerLength = view.getUint32(0);
    const header = JSON.parse(new TextDecoder().decode(bundle.subarray(4, 4 + headerLength)));
    const start = bundle.byteOffset + 4 + headerLength;
    return header.map(([path, off, len]) => [path, new Int8Array(bundle.buffer, start + off, len)]);
}

// ---- standard streams of the program (see compiler-js/runtime) ----

// Output is posted as it is written, so a line (or a prompt without a
// newline) shows even when the program then computes for a long time
// without yielding: nothing can flush a buffer while main runs, so text that
// is held may stay held. Only a burst is coalesced: after POSTS_PER_WINDOW
// posts within WINDOW_MS, further writes are appended to `pending` and go
// out with the first write after the window, at 8 KB, before a read of
// stdin, at exit, or when the program yields. So `for i <- 1 to 100000 do
// println(i)` takes a few hundred messages, not 100000. What remains: the
// tail of such a burst, if the program then goes silent without yielding,
// shows only at its next write or its end.
const WINDOW_MS = 50;
const POSTS_PER_WINDOW = 32;
const MAX_PENDING = 8192;
const pending = { 1: '', 2: '' };
const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
let timer = 0;
let windowStart = 0;
let postsInWindow = 0;

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
    if (!text) return;
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

function installHost(stdin) {
    globalThis.__yukibana = {
        write: (fd, s) => write(fd, s),
        writeBytes: (fd, bytes) => write(fd, decoders[fd].decode(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), { stream: true })),
        flush: (fd) => flush(fd),
        /** One line of input as UTF-8 bytes (an Int8Array), or null at end of
         *  file. Blocks the worker until the app answers (CONTRACT.md). */
        readStdin: () => {
            flushAll(); // a prompt printed without a newline must show first
            if (!stdin) return null;
            const state = new Int32Array(stdin, 0, 2);
            Atomics.store(state, 0, 1);
            post({ type: 'stdin' });
            Atomics.wait(state, 0, 1);
            if (Atomics.load(state, 0) === 3) {
                Atomics.store(state, 0, 0);
                return null;
            }
            const length = Atomics.load(state, 1);
            const bytes = new Int8Array(new Uint8Array(stdin, 8, length).slice().buffer);
            Atomics.store(state, 0, 0);
            return bytes;
        },
    };
}

// ---- compile, link, run ----

function formatDiagnostic(d) {
    const where = d.path ? `${d.path}:${d.line}:${d.column}: ` : '';
    let text = `${where}${d.severity}: ${d.message}\n`;
    if (d.lineText && d.column > 0) text += `${d.lineText}\n${' '.repeat(d.column - 1)}^\n`;
    return text;
}

async function run({ files, entry, stdin }) {
    const res = await fetch(new URL('manifest.json', BASE));
    if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
    const manifest = await res.json();
    const r = manifest.runner;
    // All five downloads start now; compiling waits only for its three. The
    // library IR and the linker (18 MB of the 30) arrive while it compiles,
    // and are not waited for at all when the program does not compile.
    const linkFiles = Promise.all([fetchBytes(r.library.file, r.library.size), fetchBytes(r.linker.file, r.linker.size)]);
    linkFiles.catch(() => {}); // reported when awaited, before linking
    const [compilerJs, classpath, classpathSjs] = await Promise.all([
        fetchBytes(manifest.compiler.file, manifest.compiler.size),
        fetchBytes(manifest.classpath.file, manifest.classpath.size),
        fetchBytes(r.classpath.file, r.classpath.size),
    ]);

    post({ type: 'phase', text: 'Compiling' });
    const { ScalaJSCompiler } = await importBytes(compilerJs);
    const compiler = new ScalaJSCompiler([new Int8Array(classpath.buffer), new Int8Array(classpathSjs.buffer)]);
    const result = compiler.compile(files, entry);
    let errors = 0;
    let warnings = 0;
    for (const d of result.diagnostics) {
        if (d.severity === 'error') errors++;
        else if (d.severity === 'warning') warnings++;
        write(2, formatDiagnostic(d));
    }
    if (errors) {
        write(2, `${errors} error${errors > 1 ? 's' : ''} found\n`);
        flushAll();
        post({ type: 'exit', code: 1 });
        return;
    }
    if (warnings) write(2, `${warnings} warning${warnings > 1 ? 's' : ''} found\n`);
    const main = result.mains[0];
    if (!main) {
        write(2, `No main method to run: ${entry} needs an \`@main def\` or an \`object Main { def main(args: Array[String]): Unit }\`.\n`);
        flushAll();
        post({ type: 'exit', code: 1 });
        return;
    }

    const [library, linkerJs] = await linkFiles;
    post({ type: 'phase', text: 'Linking' });
    const { link } = await importBytes(linkerJs);
    const ir = [...result.ir, ...entries(library)];
    let linked;
    try {
        linked = await link(ir, [['yukibana.runtime.Std', 'init', 'noargs'], [main, 'main', 'args']], false, (level, message) => {
            if (level !== 'trace') write(2, `${level === 'error' ? 'link error' : 'link warning'}: ${message}\n`);
        });
    } catch (e) {
        write(2, `Linking failed${e?.message ? `: ${e.message}` : ''}. Scala.js has no implementation of some JDK API the program uses (a link error above names it).\n`);
        flushAll();
        post({ type: 'exit', code: 1 });
        return;
    }
    post({ type: 'phase', text: 'Running' });
    installHost(stdin);
    try {
        await importBytes(linked);
    } catch (e) {
        flushAll();
        write(2, `Exception in thread "main" ${describe(e)}\n`);
        flushAll();
        post({ type: 'exit', code: 1 });
        return;
    }
    flushAll();
    post({ type: 'exit', code: 0 });
}

/** A thrown value as the JVM would print it: a Scala.js Throwable's
 *  toString is the Scala one ("java.lang.RuntimeException: boom"). */
function describe(e) {
    let text;
    try { text = String(e); } catch { text = Object.prototype.toString.call(e); }
    // Frames name the linked (unminified) Scala.js functions, e.g.
    // `$c_LMain$package$.sum__V`; the blob URL of the module says nothing.
    const stack = typeof e?.stack === 'string'
        ? e.stack.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 8).map((l) => l.replace(/ \(?blob:[^)]*\)?$/, ''))
            .filter((l) => !/^\s+at\s*$/.test(l)).join('\n')
        : '';
    return stack ? `${text}\n${stack}` : text;
}

let started = false;
self.onmessage = ({ data }) => {
    if (data?.type !== 'run' || started) return;
    started = true;
    run(data).catch((e) => {
        flushAll();
        post({ type: 'stderr', text: `The Scala runner failed: ${e?.stack ?? e}\n` });
        post({ type: 'exit', code: 1 });
    });
};
