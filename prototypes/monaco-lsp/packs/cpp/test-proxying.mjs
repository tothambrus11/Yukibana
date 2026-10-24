// Tests that the Emscripten clangd is linked with (the emsdk build.sh caches)
// finishes a synchronous proxied call safely: the caller's context, on its
// stack, is signalled before the caller can see the call done and return.
// The 4.0.22 release unlocked first and signalled after
// (patches/emscripten-proxying-signal-before-unlock.patch), and clangd then
// trapped on server.js with "operation does not support unaligned accesses"
// about one C++ e2e run in four, when the stack had been reused.
//
// The race is a few instructions wide, so this widens it: it copies the
// emsdk's system/lib/pthread/proxying.c, makes the calling thread wait 10 ms
// before it takes the context's mutex (so the call is finished first), and
// makes emscripten_proxy_finish wait 50 ms between its two last steps and
// then check that the context still says DONE. tests/proxying-race/race.c,
// built with that copy, proxies calls and reuses its stack after each.
//
//   1. the emsdk's proxying.c, as build.sh leaves it: every call completes;
//   2. the same with unlock and signal in the old order: the check fails or
//      Wasm traps, which shows that (1) would have caught the bug.
//
// Needs the emsdk build.sh fetches ($PACK_CACHE/cpp/emsdk) and node.
//
//   node test-proxying.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMSDK = join(process.env.PACK_CACHE ?? join(homedir(), '.cache/yukibana-packs'), 'cpp/emsdk');
const EM = join(EMSDK, 'upstream/emscripten');
const CALLS = 8;

const UNLOCK = '    pthread_mutex_unlock(&ctx->sync.mutex);\n';
const SIGNAL = '    pthread_cond_signal(&ctx->sync.cond);\n';
const STALE = 'yukibana: a finished call was signalled after its caller returned';

/** The body of `name` in `source`: from its definition to the next line that is "}". */
function body(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`proxying.c has no ${signature.trim()}`);
    const end = source.indexOf('\n}\n', start);
    return [start, end + 3];
}

/**
 * proxying.c with the delays and the check; `order` 'as-is' keeps the
 * emsdk's order of unlock and signal in emscripten_proxy_finish, 'old'
 * makes it unlock, then signal.
 */
function instrument(source, order) {
    const [fs, fe] = body(source, '\nvoid emscripten_proxy_finish(em_proxying_ctx* ctx) {');
    let finish = source.slice(fs, fe);
    const u = finish.indexOf(UNLOCK), s = finish.indexOf(SIGNAL);
    if (u < 0 || s < 0) throw new Error('emscripten_proxy_finish neither unlocks nor signals as expected');
    finish = finish.replace(UNLOCK, '').replace(SIGNAL, '');
    // Both were removed: put them back where the first was, in the chosen order.
    const at = Math.min(u, s);
    const first = order === 'old' ? UNLOCK : u < s ? UNLOCK : SIGNAL;
    const second = first === UNLOCK ? SIGNAL : UNLOCK;
    const check = `    yk_wait_ms(50);\n    if (ctx->sync.state != DONE) { emscripten_err("${STALE}"); abort(); }\n`;
    finish = finish.slice(0, at) + first + check + second + finish.slice(at);
    let out = source.slice(0, fs) + finish + source.slice(fe);

    const [ss, se] = body(out, '\nint emscripten_proxy_sync_with_ctx(');
    const sync = out.slice(ss, se);
    const lock = '  pthread_mutex_lock(&ctx.sync.mutex);\n';
    if (!sync.includes(lock)) throw new Error('emscripten_proxy_sync_with_ctx does not lock the context as expected');
    out = out.slice(0, ss) + sync.replace(lock, `  yk_wait_ms(10);\n${lock}`) + out.slice(se);
    return `#include <emscripten/console.h>
#include <emscripten/emscripten.h>
#include <stdlib.h>
static void yk_wait_ms(double ms) {
  double until = emscripten_get_now() + ms;
  while (emscripten_get_now() < until) {}
}
${out}`;
}

const source = readFileSync(join(EM, 'system/lib/pthread/proxying.c'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'yk-proxying-'));
const failures = [];
try {
    for (const order of ['as-is', 'old']) {
        const c = join(dir, `proxying-${order}.c`);
        writeFileSync(c, instrument(source, order));
        const js = join(dir, `race-${order}.js`);
        execFileSync('bash', ['-c', `source "${EMSDK}/emsdk_env.sh" >/dev/null 2>&1 && emcc -O2 -pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME \
            -I"${EM}/system/lib/pthread" -I"${EM}/system/lib/libc/musl/src/internal" -I"${EM}/system/lib/libc/musl/src/include" \
            -I"${EM}/system/lib/libc" -I"${EM}/system/lib/libc/musl/arch/emscripten" -Wno-macro-redefined \
            "${join(HERE, 'tests/proxying-race/race.c')}" "${c}" -o "${js}"`], { stdio: ['ignore', 'ignore', 'inherit'] });
        const r = spawnSync(process.execPath, [js, String(CALLS)], { encoding: 'utf8', timeout: 60_000 });
        const out = `${r.stdout}${r.stderr}`;
        const done = r.status === 0 && out.includes(`${CALLS} calls done`);
        const caught = out.includes(STALE) || out.includes('unaligned accesses');
        const ok = order === 'as-is' ? done && !caught : caught;
        const what = order === 'as-is'
            ? `the emsdk's proxying.c finishes ${CALLS} synchronous calls with each caller's stack reused at once`
            : 'with unlock before signal, as Emscripten 4.0.22 shipped, a finished call is signalled after its caller returned';
        const seen = out.split('\n').find((l) => l.includes(STALE) || l.includes('RuntimeError') || l.includes('calls done')) ?? `exit ${r.status}`;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${what} (${seen.trim()})`);
        if (!ok) failures.push(what);
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}
if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
}
