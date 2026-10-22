// The page: an editor, a Run button, and four views of what happened. All
// the work is in worker.js; this file only sends a request and draws the
// answer.
import { SAMPLES } from './samples.js';

const $ = id => document.getElementById(id);
const ui = {
    status: $('status'), sample: $('sample'), arch: $('arch'), libc: $('libc'), opt: $('opt'), strace: $('strace'),
    intel: $('intel'), args: $('args'), run: $('run'), stop: $('stop'), source: $('source'), stdin: $('stdin'),
    out: $('out'), trace: $('trace'), dis: $('dis'), files: $('files'), nTrace: $('n-trace'), nFiles: $('n-files'),
    timings: $('timings'), download: $('download'),
};

const store = {
    get(k) { try { return localStorage.getItem(`yukibana-syscalls:${k}`); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`yukibana-syscalls:${k}`, v); } catch { /* private mode */ } },
};

for (const [i, s] of SAMPLES.entries()) ui.sample.add(new Option(s.name, String(i)));
function loadSample(i) {
    const s = SAMPLES[i];
    ui.source.value = s.source;
    ui.stdin.value = s.stdin ?? '';
}
const saved = store.get('source');
if (saved) { ui.source.value = saved; ui.stdin.value = store.get('stdin') ?? ''; } else loadSample(0);
ui.sample.onchange = () => loadSample(Number(ui.sample.value));
ui.source.oninput = () => store.set('source', ui.source.value);
ui.stdin.oninput = () => store.set('stdin', ui.stdin.value);

ui.source.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        ui.source.setRangeText('    ', ui.source.selectionStart, ui.source.selectionEnd, 'end');
        store.set('source', ui.source.value);
    }
});
document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !ui.run.disabled) { e.preventDefault(); run(); }
});

for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => show(tab.dataset.view);
function show(view) {
    for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    for (const v of ['out', 'trace', 'dis', 'files']) ui[v].hidden = v !== view;
}

function status(text, error = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle('err', error);
}

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};

let worker;
let busy = false;
let hasThreads = false;
const sizes = {};
function start() {
    worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => handlers[data.type]?.(data);
    worker.onerror = e => status(`Worker failed: ${e.message}`, true);
}
const handlers = {
    progress({ name, done, total }) {
        sizes[name] = { done, total };
        const all = Object.values(sizes);
        const mb = n => (n / 1048576).toFixed(0);
        const d = all.reduce((a, s) => a + s.done, 0), t = all.reduce((a, s) => a + (s.total || s.done), 0);
        status(`Downloading the toolchain… ${mb(d)} of ${mb(t)} MB`);
    },
    ready({ threads }) {
        hasThreads = threads;
        status(threads ? 'Ready' : 'Ready (no threads: page is not cross-origin isolated)');
        ui.run.disabled = false;
    },
    stage({ stage }) { status(stage === 'compiling' ? 'Compiling…' : 'Running…'); },
    error({ message }) { status('Error', true); ui.out.textContent = message; finish(); },
    result(r) { draw(r); finish(); },
};

function finish() {
    busy = false;
    ui.run.disabled = false;
    ui.stop.disabled = true;
}

function run() {
    if (busy) return;
    busy = true;
    ui.run.disabled = true;
    ui.stop.disabled = false;
    const arch = ui.arch.value;
    worker.postMessage({
        source: ui.source.value, arch, libc: ui.libc.value, flags: [ui.opt.value],
        stdin: ui.stdin.value, args: ui.args.value.split(/\s+/).filter(Boolean),
        strace: ui.strace.checked, intel: ui.intel.checked,
    });
}
ui.run.onclick = run;
ui.stop.onclick = () => {
    // A program in an endless loop never returns to the worker's event
    // loop, so the only stop is to end the worker and load a fresh one.
    worker.terminate();
    finish();
    ui.run.disabled = true;
    ui.out.append(el('span', 'fd2', '\n[stopped]\n'));
    status('Stopped; reloading…');
    start();
};

function draw(r) {
    const { compiled } = r;
    ui.out.replaceChildren();
    ui.trace.replaceChildren();
    ui.files.replaceChildren();
    ui.nTrace.textContent = '';
    ui.nFiles.textContent = '';
    ui.download.hidden = true;
    const times = compiled.steps.map(s => `${s.tool} ${s.ms} ms`);

    if (!compiled.ok) {
        ui.out.append(el('span', 'fd2', compiled.log || 'compilation failed'));
        ui.dis.textContent = '';
        ui.timings.textContent = times.join(' · ');
        status('Compile failed', true);
        show('out');
        return;
    }
    if (compiled.log) ui.out.append(el('span', 'meta', compiled.log + '\n'));
    ui.dis.textContent = r.disassembly;
    ui.download.href = URL.createObjectURL(new Blob([r.elf], { type: 'application/octet-stream' }));
    ui.download.hidden = false;
    times.push(`a.out ${(r.elfSize / 1024).toFixed(1)} KB`);

    if (!r.run) {
        ui.out.append(el('span', 'meta',
            `Compiled and linked for aarch64 against ${ui.libc.value === 'gnu' ? 'glibc' : 'musl'}.`
            + ' There is no AArch64 emulator here yet, so it does not run;\n'
            + 'see the Disassembly tab, or download a.out and run it on an arm64 Linux machine.\n'));
        ui.timings.textContent = times.join(' · ');
        status('Compiled');
        show('dis');
        return;
    }

    const run = r.run;
    for (const c of run.chunks) ui.out.append(c.fd === 2 ? el('span', 'fd2', c.text) : document.createTextNode(c.text));
    const sig = run.exit > 128 ? ` (killed by signal ${run.exit - 128})` : '';
    ui.out.append(el('span', 'meta', `${run.chunks.length && !run.chunks.at(-1).text.endsWith('\n') ? '\n' : ''}[exit ${run.exit}${sig}]\n`));
    for (const p of run.problems) ui.out.append(el('span', 'fd2', `blink: ${p}\n`));
    if (!hasThreads && run.trace.some(l => l.startsWith('clone('))) {
        ui.out.append(el('span', 'meta', 'This page is not cross-origin isolated, so threads are off and clone() fails.\n'
            + 'Serve it with COOP/COEP headers (test/serve.mjs does) to run threaded programs.\n'));
    }

    let n = 0;
    for (const line of run.trace) {
        const row = el('span', 'trace-line');
        const loader = line.startsWith('LoadProgram') || line.startsWith('PT_LOAD');
        if (loader) row.classList.add('loader');
        if (line.includes('-ENOSYS')) row.classList.add('enosys');
        row.append(el('span', 'n', loader ? '' : String(++n)));
        const m = /^(\[\d+\] )?([a-z_0-9]+)(\(.*)$/s.exec(line);
        if (m && !loader) row.append(document.createTextNode(m[1] ?? ''), el('span', 'call', m[2]), document.createTextNode(m[3]));
        else row.append(document.createTextNode(line));
        ui.trace.append(row, '\n');
    }
    if (!run.trace.length) ui.trace.append(el('span', 'hint', ui.strace.checked ? 'No system calls.' : 'Turn on "Trace syscalls" and run again.'));
    ui.nTrace.textContent = n ? String(n) : '';

    for (const f of run.home) {
        const box = el('div', 'file');
        box.append(el('div', 'file-name', `${f.name}  ·  ${f.size} bytes`));
        if (f.data) {
            const text = new TextDecoder('utf-8', { fatal: false }).decode(f.data.slice(0, 64 * 1024));
            box.append(el('pre', '', text));
        }
        ui.files.append(box);
    }
    if (!run.home.length) ui.files.append(el('span', 'hint', 'Files the program creates in its working directory show up here.'));
    ui.nFiles.textContent = run.home.length ? String(run.home.length) : '';

    times.push(`run ${run.ms} ms`);
    ui.timings.textContent = times.join(' · ');
    status(`Exited with ${run.exit}${sig}`);
    show('out');
}

start();
