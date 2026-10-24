// SPDX-License-Identifier: MIT
// The app's standard input protocol (packs/CONTRACT.md, "Standard input"),
// read without ever blocking the calling thread.
//
// runLinux runs on the runner's worker, which is emscripten's main runtime
// thread for QEMU: every file system call QEMU's threads make is proxied to
// it and served from its event loop. An Atomics.wait there would stop all of
// them, so this waits with Atomics.waitAsync, or polls every 10 ms where the
// browser has no waitAsync (Firefox before 145).

/** How often the fallback polls the state word, in milliseconds. */
export const POLL_MS = 10;

/**
 * Asks the app for input for as long as the run lasts, and hands each piece to
 * the guest:
 * 1. stores 1 in `state` and posts `{ type: 'stdin', streaming: true }`
 *    (the contract's streaming request: the app hands over each line as it
 *    is typed and does not show the program as blocked on input);
 * 2. waits, without blocking, until the app stores 2 or 3;
 * 3. on 2 copies `length` bytes, stores 0 and calls `onData(bytes)`; on 3
 *    stores 0 and calls `onEof()`;
 * 4. asks again: the guest's reads cannot be seen from here, so input is
 *    requested continuously and the guest's line discipline (system mode) or
 *    stdin buffer (user mode) holds it until the program reads.
 * With `sab` null (a page that is not cross-origin isolated) it calls
 * `onEof()` once and never posts `stdin`.
 * `onData` receives a fresh copy it may keep. Never throws.
 * @param {SharedArrayBuffer | null} sab the contract's stdin buffer
 * @param {(msg: object) => void} post sends a message to the app
 * @param {(bytes: Uint8Array) => void} onData
 * @param {() => void} onEof
 * @param {{ waitAsync?: boolean }} [opts] `waitAsync: false` forces the
 *   polling fallback (for tests); by default it is used only when missing
 * @returns {() => void} stops asking; a pending wait is abandoned, and the
 *   state word is left as it is (the app ends the run with 'exit')
 */
export function pumpStdin(sab, post, onData, onEof, opts = {}) {
    if (!sab) {
        onEof();
        return () => {};
    }
    const state = new Int32Array(sab, 0, 2);
    const useWaitAsync = opts.waitAsync ?? typeof Atomics.waitAsync === 'function';
    let stopped = false;
    let timer = null;

    /** Consumes a ready state (2 or 3); false if the app has not answered. */
    const take = () => {
        const s = Atomics.load(state, 0);
        if (s === 2) {
            const n = Math.min(Math.max(Atomics.load(state, 1), 0), sab.byteLength - 8);
            const bytes = new Uint8Array(sab, 8, n).slice();
            Atomics.store(state, 0, 0);
            onData(bytes);
            return true;
        }
        if (s === 3) {
            Atomics.store(state, 0, 0);
            onEof();
            return true;
        }
        return false;
    };
    const ask = () => {
        if (stopped) return;
        Atomics.store(state, 0, 1);
        post({ type: 'stdin', streaming: true });
        wait();
    };
    /** After a wake-up: deliver and ask again, keep waiting, or re-ask if the word was reset. */
    const woke = () => {
        if (stopped) return;
        if (take()) ask();
        else if (Atomics.load(state, 0) === 1) wait();
        else ask();
    };
    const wait = () => {
        if (stopped) return;
        if (useWaitAsync) {
            const w = Atomics.waitAsync(state, 0, 1);
            if (w.async) w.value.then(woke);
            else queueMicrotask(woke); // 'not-equal': the app answered already
        } else {
            timer = setTimeout(woke, POLL_MS);
        }
    };
    ask();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
