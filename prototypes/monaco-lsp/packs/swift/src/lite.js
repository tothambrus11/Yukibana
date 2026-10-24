// sourcekit-lsp-lite, the language server, running in this worker: the
// `lsp_*` exports of swift-frontend-lsp.wasm (swift-toolchain-wasm), a C++
// LSP server over an in-process, single-threaded sourcekitd 6.3.3. It is the
// same sourcekitd SourceKit-LSP drives, answering through its C API; what the
// server maps and what it leaves out is swift-toolchain-wasm's
// docs/status.md, "sourcekit-lsp-lite".
//
// The module is a WASI reactor: instantiated once, then called per JSON-RPC
// message (no framing), synchronously. Its file system is the worker's
// in-memory one (toolchain.js): the sysroot at /sysroot, the project
// mirrored at /workspace, scratch space in /tmp.

import { File, OpenFile, PreopenDirectory, WASI, WASIProcExit, sink } from './toolchain.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Whether an exception thrown out of the module means the instance is dead:
 * a trap (WebAssembly.RuntimeError: sourcekitd's `abort`, an assertion, an
 * out-of-bounds access), the browser's native stack running out inside wasm
 * frames (RangeError; deeply nested code recurses in the type checker), or
 * the module calling `exit`. Its memory may be inconsistent after any of
 * them, so the caller starts a new instance.
 */
export const isFatal = (e) => e instanceof WebAssembly.RuntimeError || e instanceof RangeError || e instanceof WASIProcExit;

export class Lite {
    /**
     * `module` is the compiled swift-frontend-lsp.wasm, `root` the file
     * system (a browser_wasi_shim Directory) it sees as `/`, `onStderr(text)`
     * receives what it prints (sourcekitd's own warnings).
     */
    constructor(module, root, onStderr) {
        this.module = module;
        this.root = root;
        this.onStderr = onStderr;
        this.exports = null;
    }

    /** A fresh instance with its constructors run. Synchronous: a worker may instantiate a large module without awaiting. */
    start() {
        const stderr = sink((bytes) => this.onStderr(decoder.decode(bytes)));
        const fds = [new OpenFile(new File(new Uint8Array())), stderr, stderr, new PreopenDirectory('/', this.root.contents)];
        const wasi = new WASI(['sourcekit-lsp-lite'], ['TMPDIR=/tmp', 'HOME=/tmp'], fds, { debug: false });
        const instance = new WebAssembly.Instance(this.module, { wasi_snapshot_preview1: wasi.wasiImport });
        wasi.initialize(instance);
        this.exports = instance.exports;
    }

    /** Hands one message to the server; returns the messages it sent back (replies and notifications), in order. */
    handle(message) {
        const x = this.exports;
        const bytes = encoder.encode(JSON.stringify(message));
        const pointer = x.lsp_alloc(bytes.length);
        new Uint8Array(x.memory.buffer, pointer, bytes.length).set(bytes);
        const length = x.lsp_handle(pointer, bytes.length); // a throw leaves the instance dead: nothing to free
        x.lsp_free(pointer);
        return this.output(length);
    }

    /** One unit of deferred work (diagnosing one open file); returns what it published. */
    idle() {
        return this.output(this.exports.lsp_idle());
    }

    hasIdleWork() {
        return this.exports.lsp_has_idle_work() !== 0;
    }

    output(length) {
        const x = this.exports;
        const text = decoder.decode(new Uint8Array(x.memory.buffer, x.lsp_output(), length));
        return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    }
}
