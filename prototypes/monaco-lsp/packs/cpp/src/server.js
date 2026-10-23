// The C/C++ pack's Worker: clangd (LLVM 21, Emscripten, with threads) behind
// the pack transport of ../../CONTRACT.md. One JSON-RPC object per
// postMessage in each direction; clangd itself speaks Content-Length framed
// JSON on stdin/stdout, and this file is the translation between the two,
// plus the file system clangd reads headers from.
//
// What clangd needs from its host, and where it gets it here:
//   * its wasm, and the headers <stdio.h> and <vector> come from: fetched
//     next to this file, with yukibana/loading progress;
//   * threads: Web Workers sharing the module's memory, so the page must be
//     cross-origin isolated. clangd's main runs on one of them, which leaves
//     this Worker free to receive messages;
//   * its input: each message is handed to clangd with clangd_input
//     (patches/clangd-browser.patch), and clangd's main thread waits for
//     the next one;
//   * the project's files on disk, for #include "x.h", compile_flags.txt and
//     .clangd: every didOpen/didChange/didClose is mirrored into the module's
//     in-memory file system when it arrives, before clangd reads the message;
//   * only C-family documents as documents: the app opens every project file,
//     and clangd would compile compile_flags.txt or README.md as a
//     translation unit and publish an error on it. Those files are mirrored
//     but not forwarded;
//   * a reparse when the build configuration changes: clangd rereads
//     compile_flags.txt and .clangd on every parse (patched; upstream caches
//     them for 5 to 30 s), but only reparses open files when told to, so a
//     change to one of them is followed by a didSave, which reparses every
//     open file whose command changed.

/* global CLANGD_WASM_SIZE, SYSROOT_SIZE */
// Replaced by build.sh with the byte sizes it shipped: a host that serves the
// .br sibling sends a compressed Content-Length, but progress counts bytes
// after decoding.
const WASM_TOTAL = typeof CLANGD_WASM_SIZE === 'number' ? CLANGD_WASM_SIZE : 0;
const SYSROOT_TOTAL = typeof SYSROOT_SIZE === 'number' ? SYSROOT_SIZE : 0;

/** clangd's command line. --use-dirty-headers: an edited, unsaved header is
 * seen by the files including it. The resource dir is where sysroot.tar.gz
 * puts clang's own headers. */
const ARGS = [
    '--background-index=false',
    '--use-dirty-headers',
    '--pch-storage=memory',
    '--resource-dir=/usr/lib/clang/21',
    '--log=error',
];

/** Configuration for the whole file system, below the project's own
 * .clangd (clangd reads every ancestor's, the nearest winning): headers are
 * C++. With compile_flags.txt every file gets the same flags, and the driver
 * takes a .h for a C header, so `-std=c++20` there is "not allowed with 'C'"
 * and the header's C++ is reported as errors. A C project overrides it in its
 * own .clangd. */
const HEADERS_ARE_CXX = `If:
  PathMatch: .*\\.(h|hh|hpp|hxx|inc)
CompileFlags:
  Add: [-xc++-header]
`;

const post = (msg) => self.postMessage(msg);
/** LSP MessageType: 1 error, 2 warning, 3 info, 4 log. */
const logMessage = (type, message) => post({ jsonrpc: '2.0', method: 'window/logMessage', params: { type, message } });
const progress = (label, loaded, total) =>
    post({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label, loaded, total } });

// ---- stdin: each message framed and handed to clangd's input queue.

/** @type {any} the Emscripten module, once loaded */
let clangd = null;

function writeStdin(message) {
    const body = JSON.stringify(message);
    const framed = `Content-Length: ${clangd.lengthBytesUTF8(body)}\r\n\r\n${body}`;
    const size = clangd.lengthBytesUTF8(framed);
    const ptr = clangd._malloc(size + 1);
    clangd.stringToUTF8(framed, ptr, size + 1);
    clangd._clangd_input(ptr, size); // copies
    clangd._free(ptr);
}

// ---- stdout: Content-Length framed JSON, one object per postMessage.

const decoder = new TextDecoder();
let outBuf = new Uint8Array(1 << 16);
let outLen = 0;
let bodyLength = -1; // -1 while reading headers

function writeStdoutByte(byte) {
    if (outLen === outBuf.length) {
        const bigger = new Uint8Array(outBuf.length * 2);
        bigger.set(outBuf);
        outBuf = bigger;
    }
    outBuf[outLen++] = byte & 0xff;
    if (bodyLength < 0) {
        // Headers end at the first empty line.
        if (byte !== 10 || outLen < 4 || outBuf[outLen - 2] !== 13 || outBuf[outLen - 3] !== 10) return;
        const headers = decoder.decode(outBuf.subarray(0, outLen));
        const match = /^content-length:\s*(\d+)/im.exec(headers);
        outLen = 0;
        bodyLength = match ? Number(match[1]) : -1;
        if (!match) logMessage(1, `clangd wrote a message without Content-Length: ${headers.trim()}`);
        return;
    }
    if (outLen < bodyLength) return;
    const text = decoder.decode(outBuf.subarray(0, outLen));
    outLen = 0;
    bodyLength = -1;
    post(JSON.parse(text));
}

// ---- stderr: clangd's log, one line per window/logMessage.

let errLine = [];
function writeStderrByte(byte) {
    if (byte !== 10) {
        errLine.push(byte & 0xff);
        return;
    }
    const line = decoder.decode(new Uint8Array(errLine));
    errLine = [];
    // clangd prefixes its lines with E[, I[ or V[ and a time.
    const type = line.startsWith('E[') ? 1 : line.startsWith('I[') ? 3 : 4;
    logMessage(type, line);
}

// ---- the project's files, mirrored into the module's file system.

/** @type {Map<string, string>} uri -> text, as the client last sent it */
const documents = new Map();
/** @type {Set<string>} the uris forwarded to clangd as documents */
const forwarded = new Set();

const C_FAMILY_LANGUAGES = new Set(['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda-cpp']);
const C_FAMILY_EXTENSION = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inc|inl|ipp|tcc|ixx|cppm|m|mm|cu|cuh)$/i;
/** Files that change how clangd compiles the project. */
const BUILD_CONFIG = /\/(compile_flags\.txt|compile_commands\.json|\.clangd)$/;

/** Whether clangd should see a didOpen as a document: a C-family language
 * or a C-family file name (a header Monaco calls plaintext). */
const isCFamily = ({ uri, languageId }) => C_FAMILY_LANGUAGES.has(languageId) || C_FAMILY_EXTENSION.test(new URL(uri).pathname);
let FS = null;

function pathOf(uri) {
    const url = new URL(uri);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : null;
}

function writeFile(uri, text) {
    const path = pathOf(uri);
    if (!path) return;
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
    FS.writeFile(path, text);
}

/** Applies LSP content changes (full or ranged, UTF-16 positions, which are
 * JavaScript string indices) to a document's text. */
function applyChanges(text, changes) {
    for (const change of changes) {
        if (!change.range) {
            text = change.text;
            continue;
        }
        const offset = ({ line, character }) => {
            let at = 0;
            for (let l = 0; l < line; l++) {
                const nl = text.indexOf('\n', at);
                if (nl < 0) return text.length;
                at = nl + 1;
            }
            const end = text.indexOf('\n', at);
            return Math.min(at + character, end < 0 ? text.length : end);
        };
        text = text.slice(0, offset(change.range.start)) + change.text + text.slice(offset(change.range.end));
    }
    return text;
}

function mirror(message) {
    const params = message.params;
    try {
        switch (message.method) {
            case 'textDocument/didOpen':
                documents.set(params.textDocument.uri, params.textDocument.text);
                writeFile(params.textDocument.uri, params.textDocument.text);
                break;
            case 'textDocument/didChange': {
                const uri = params.textDocument.uri;
                const text = applyChanges(documents.get(uri) ?? '', params.contentChanges);
                documents.set(uri, text);
                writeFile(uri, text);
                break;
            }
            case 'textDocument/didClose': {
                // The app closes a document only when its file is deleted.
                documents.delete(params.textDocument.uri);
                const path = pathOf(params.textDocument.uri);
                if (path && FS.analyzePath(path).exists) FS.unlink(path);
                break;
            }
        }
    } catch (error) {
        logMessage(1, `could not mirror ${message.method}: ${error}`);
    }
}

// ---- messages from the client.

/** @type {unknown[] | null} messages that arrive while loading */
let early = [];
let failure = null;

function receive(message) {
    if (failure) {
        if (message.id !== undefined && message.method)
            post({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: failure } });
        return;
    }
    if (early) {
        early.push(message);
        return;
    }
    mirror(message);
    const uri = message.params?.textDocument?.uri;
    switch (message.method) {
        case 'textDocument/didOpen':
            if (!isCFamily(message.params.textDocument)) return reconfigure(uri);
            forwarded.add(uri);
            return writeStdin(message);
        case 'textDocument/didChange':
            if (!forwarded.has(uri)) return reconfigure(uri);
            return writeStdin(message);
        case 'textDocument/didClose':
            if (!forwarded.delete(uri)) return reconfigure(uri);
            return writeStdin(message);
        default:
            writeStdin(message);
    }
}

/** After a file that is not a document changed on disk: when it is a build
 * configuration file, ask clangd to reparse the open files. didSave does that for every
 * open file (ClangdLSPServer::onDocumentDidSave); a file whose compile
 * command came out the same is not rebuilt. */
function reconfigure(uri) {
    if (!BUILD_CONFIG.test(new URL(uri).pathname)) return;
    writeStdin({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri } } });
}
self.onmessage = ({ data }) => receive(data);

// ---- loading.

/** Fetches a file next to this script as a stream, reporting progress. */
async function download(name, total) {
    const response = await fetch(new URL(name, import.meta.url));
    if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
    let loaded = 0;
    progress(name, 0, total);
    return response.body.pipeThrough(
        new TransformStream({
            transform(chunk, out) {
                loaded += chunk.length;
                progress(name, loaded, Math.max(total, loaded));
                out.enqueue(chunk);
            },
        })
    );
}

/** Unpacks a ustar archive (sysroot.tar.gz, gzip or already decoded by the
 * host) into the module's file system. */
async function unpackSysroot(bytes) {
    const tar =
        bytes[0] === 0x1f && bytes[1] === 0x8b
            ? new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
            : bytes;
    const field = (at, length) => {
        const end = tar.indexOf(0, at);
        return decoder.decode(tar.subarray(at, end < 0 || end > at + length ? at + length : end));
    };
    let files = 0;
    for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
        const name = field(at, 100);
        const prefix = field(at + 345, 155);
        const size = parseInt(field(at + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(tar[at + 156] || 48);
        const path = '/' + (prefix ? `${prefix}/${name}` : name).replace(/\/$/, '');
        at += 512;
        if (type === '5') FS.mkdirTree(path);
        else if (type === '0') {
            FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
            FS.writeFile(path, tar.subarray(at, at + size));
            files++;
        }
        at += Math.ceil(size / 512) * 512;
    }
    return files;
}

async function start() {
    if (!crossOriginIsolated)
        throw new Error('the page is not cross-origin isolated, and clangd needs SharedArrayBuffer for its threads');
    const started = performance.now();
    const [{ default: createClangd }, wasm, sysroot] = await Promise.all([
        import('./clangd.js'),
        download('clangd.wasm', WASM_TOTAL),
        download('sysroot.tar.gz', SYSROOT_TOTAL),
    ]);
    // Both downloads run to the end at once: compiling the wasm as it streams
    // in, and buffering the headers until the file system exists.
    const compiled = WebAssembly.compileStreaming(new Response(wasm, { headers: { 'content-type': 'application/wasm' } }));
    const sysrootBytes = new Response(sysroot).arrayBuffer();

    clangd = await createClangd({
        thisProgram: '/usr/bin/clangd',
        instantiateWasm(imports, done) {
            compiled
                .then((module) => WebAssembly.instantiate(module, imports).then((instance) => done(instance, module)))
                .catch((error) => fail(`clangd.wasm: ${error}`));
            return {};
        },
        stdout: writeStdoutByte,
        stderr: writeStderrByte,
        onExit(code) {
            logMessage(code === 0 ? 3 : 1, `clangd exited with status ${code}`);
            self.close();
        },
        onAbort(reason) {
            fail(`clangd aborted: ${reason}`);
        },
    });
    FS = clangd.FS;
    const headers = await unpackSysroot(new Uint8Array(await sysrootBytes));
    FS.mkdirTree('/workspace');
    FS.writeFile('/.clangd', HEADERS_ARE_CXX);
    logMessage(3, `clangd loaded in ${Math.round(performance.now() - started)} ms, ${headers} headers`);

    const queued = early;
    early = null;
    for (const message of queued) receive(message);
    clangd.callMain(ARGS);
}

function fail(reason) {
    if (failure) return;
    failure = reason;
    logMessage(1, reason);
    const queued = early ?? [];
    early = null;
    for (const message of queued) receive(message);
}

start().catch((error) => fail(`could not start clangd: ${error?.message ?? error}`));
