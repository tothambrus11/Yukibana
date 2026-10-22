// Runs the toolchain off the page's thread, so a compile or a program that
// loops forever never freezes the page: the page stops it by terminating
// this worker and starting another.
import { Toolchain } from './toolchain.js';

const base = new URL('../dist/', import.meta.url);
let toolchain;

/** Fetches a dist/ file, reporting its progress as it arrives. */
async function fetchBytes(name) {
    const res = await fetch(new URL(name, base));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const parts = [];
    let done = 0;
    for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        parts.push(value);
        done += value.length;
        postMessage({ type: 'progress', name, done, total });
    }
    const bytes = new Uint8Array(done);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    return bytes;
}

const ready = Toolchain.load(fetchBytes, async name => (await import(new URL(name, base).href)).default)
    .then(tc => { toolchain = tc; postMessage({ type: 'ready', threads: tc.threads }); })
    .catch(e => postMessage({ type: 'error', message: String(e && e.message || e) }));

onmessage = async ({ data }) => {
    await ready;
    if (!toolchain) return;
    const { source, arch, libc, flags, stdin, args, strace, intel } = data;
    try {
        postMessage({ type: 'stage', stage: 'compiling' });
        const compiled = await toolchain.compile({ source, arch, libc, flags });
        const result = { type: 'result', compiled: { ok: compiled.ok, log: compiled.log, steps: compiled.steps.map(s => ({ tool: s.tool, ms: s.ms, exit: s.exit })) } };
        if (compiled.ok) {
            result.disassembly = await toolchain.disassemble(compiled.object, intel && arch === 'x86_64');
            result.elfSize = compiled.elf.length;
            if (arch === 'x86_64') {
                postMessage({ type: 'stage', stage: 'running' });
                const r = await toolchain.run({ elf: compiled.elf, stdin, args, strace });
                result.run = { exit: r.exit, chunks: r.chunks, trace: r.trace, problems: r.problems, home: r.home, ms: r.ms };
            }
            result.elf = compiled.elf;
        }
        postMessage(result);
    } catch (e) {
        postMessage({ type: 'error', message: String(e && e.stack || e) });
    }
};
