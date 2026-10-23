// The Rust pack's language server worker (../../CONTRACT.md): rust-analyzer's
// IDE crates, compiled to wasm32-wasip1 with a small LSP layer of ours
// (../server/src/lib.rs), run in this worker on one thread.
//
//   rust-analyzer.wasm  the server (ra_ap_ide 0.0.358 and our LSP layer)
//   std-src.tar         core, alloc and std from rust-src 1.98.0: what
//                       rust-analyzer reads for the standard library
//                       (completion, hover docs, types). Newer than the
//                       runner's Miri (1.78), because this rust-analyzer
//                       only understands a recent std's format_args!
//
// The wasm module is a library with no main loop: this file hands it each
// JSON-RPC message (yk_message) and, once the client has been quiet for a
// moment, asks it to publish diagnostics (yk_idle). Both return the
// messages to send. A panic in rust-analyzer aborts the module (wasm has no
// unwinding here); the worker then starts a fresh instance, gives it the
// standard library and the open documents again, and answers the request
// that failed with an error, so one bad request does not end the session.

/* global SERVER_WASM_SIZE, STD_SRC_SIZE */
const SIZES = {
    'rust-analyzer.wasm': typeof SERVER_WASM_SIZE === 'number' ? SERVER_WASM_SIZE : 0,
    'std-src.tar': typeof STD_SRC_SIZE === 'number' ? STD_SRC_SIZE : 0,
};
/** How long the client must be quiet before diagnostics are computed. */
const IDLE_MS = 250;

const post = (message) => self.postMessage(message);
const log = (type, message) => post({ jsonrpc: '2.0', method: 'window/logMessage', params: { type, message } });
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function download(name) {
    const response = await fetch(new URL(name, import.meta.url));
    if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
    const total = SIZES[name] ?? 0;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    post({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label: name, loaded, total } });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        post({ jsonrpc: '2.0', method: 'yukibana/loading', params: { label: name, loaded, total: Math.max(total, loaded) } });
    }
    const bytes = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
    }
    return bytes;
}

/** Regular files of a ustar archive, as [path, bytes]. */
function untar(tar) {
    const field = (at, length) => {
        const end = tar.indexOf(0, at);
        return decoder.decode(tar.subarray(at, end < 0 || end > at + length ? at + length : end));
    };
    const files = [];
    for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
        const name = field(at, 100);
        const prefix = field(at + 345, 155);
        const size = parseInt(field(at + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(tar[at + 156] || 48);
        at += 512;
        if (type === '0') files.push([prefix ? `${prefix}/${name}` : name, tar.subarray(at, at + size)]);
        at += Math.ceil(size / 512) * 512;
    }
    return files;
}

/** Thrown by proc_exit. */
class Exit extends Error {}

/** The few WASI calls the Rust standard library makes in a library with no
 * files: the clock, randomness (hash maps), the environment (empty) and
 * stderr, which carries rust-analyzer's panic messages to the log. */
function wasi(memory) {
    const view = () => new DataView(memory().buffer);
    let stderr = '';
    return {
        clock_time_get(clock, _precision, out) {
            const ns = clock === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
            view().setBigUint64(out, ns, true);
            return 0;
        },
        random_get(buf, len) {
            for (let at = 0; at < len; at += 65536) crypto.getRandomValues(new Uint8Array(memory().buffer, buf + at, Math.min(65536, len - at)));
            return 0;
        },
        environ_sizes_get(count, size) {
            view().setUint32(count, 0, true);
            view().setUint32(size, 0, true);
            return 0;
        },
        environ_get: () => 0,
        fd_write(fd, iovs, count, written) {
            const dv = view();
            let total = 0;
            for (let i = 0; i < count; i++) {
                const ptr = dv.getUint32(iovs + i * 8, true);
                const len = dv.getUint32(iovs + i * 8 + 4, true);
                stderr += decoder.decode(new Uint8Array(memory().buffer, ptr, len));
                total += len;
            }
            for (let nl; (nl = stderr.indexOf('\n')) >= 0; ) {
                log(fd === 2 ? 1 : 3, stderr.slice(0, nl));
                stderr = stderr.slice(nl + 1);
            }
            dv.setUint32(written, total, true);
            return 0;
        },
        poll_oneoff: () => 52,
        sched_yield: () => 0,
        proc_exit(code) {
            throw new Exit(`exit ${code}`);
        },
    };
}

let module = null;
let sysroot = null;
let instance = null;
/** The client's documents (uri -> text) and its initialize message, to
 * bring a fresh instance up to date after a crash. */
const documents = new Map();
let initializeMessage = null;

function start() {
    let exports = null;
    const imports = { wasi_snapshot_preview1: wasi(() => exports.memory) };
    exports = new WebAssembly.Instance(module, imports).exports;
    const pass = (text) => {
        const bytes = encoder.encode(text);
        const ptr = exports.yk_alloc(bytes.length);
        new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
        return [ptr, bytes.length];
    };
    const output = () => JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, exports.yk_output_ptr(), exports.yk_output_len())));
    for (const [path, bytes] of sysroot) exports.yk_sysroot_file(...pass(path), ...pass(decoder.decode(bytes)));
    instance = {
        message(message) {
            exports.yk_message(...pass(JSON.stringify(message)));
            return output();
        },
        idle() {
            exports.yk_idle();
            return output();
        },
    };
}

/** Calls the instance; after a crash, starts a new one and replays the
 * session into it. Returns the messages to send, or null after a crash. */
function call(f) {
    try {
        return f(instance);
    } catch (e) {
        log(1, `rust-analyzer stopped (${e instanceof Error ? e.message : String(e)}); restarting it`);
        try {
            start();
            if (initializeMessage) instance.message(initializeMessage);
            instance.message({ jsonrpc: '2.0', method: 'initialized', params: {} });
            for (const [uri, text] of documents)
                instance.message({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'rust', version: 0, text } } });
        } catch (again) {
            log(1, `rust-analyzer could not be restarted: ${again instanceof Error ? again.message : String(again)}`);
        }
        return null;
    }
}

let idleTimer = 0;
function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        for (const m of call((i) => i.idle()) ?? []) post(m);
    }, IDLE_MS);
}

function track(message) {
    const doc = message.params?.textDocument;
    if (message.method === 'textDocument/didOpen') documents.set(doc.uri, doc.text);
    else if (message.method === 'textDocument/didChange') {
        const last = message.params.contentChanges?.at(-1);
        if (last && last.range === undefined) documents.set(doc.uri, last.text);
    } else if (message.method === 'textDocument/didClose') documents.delete(doc.uri);
    else if (message.method === 'initialize') initializeMessage = message;
}

function handle(message) {
    track(message);
    const out = call((i) => i.message(message));
    if (out === null && message.id !== undefined && message.method)
        post({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'rust-analyzer crashed on this request (see the log); it was restarted' } });
    for (const m of out ?? []) post(m);
    if (message.method === 'exit') self.close();
    else if (!message.method || !message.method.startsWith('$/')) scheduleIdle();
}

const queue = [];
let ready = false;
self.onmessage = ({ data }) => {
    if (ready) handle(data);
    else queue.push(data);
};

(async () => {
    try {
        const [wasm, tar] = await Promise.all([download('rust-analyzer.wasm'), download('std-src.tar')]);
        module = await WebAssembly.compile(wasm);
        sysroot = untar(tar);
        start();
        ready = true;
        for (const m of queue.splice(0)) handle(m);
    } catch (e) {
        log(1, `rust-analyzer failed to start: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    }
})();
