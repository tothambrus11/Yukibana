// Opens the page in headless Chromium and uses it as a student would: wait
// for the toolchain, run samples, read the views. Saves a screenshot per
// step to test/screenshots/. Exits non-zero naming each failure.
//
//   node test/page.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
fs.mkdirSync(shots, { recursive: true });

const { url, server } = await serve(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

const failures = [];
const check = (what, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) { failures.push(what); if (detail) console.log(String(detail).replace(/^/gm, '     ')); }
};

const started = Date.now();
await page.goto(`${url}/web/`);
await page.waitForFunction(() => document.getElementById('status').textContent === 'Ready', null, { timeout: 180_000 });
check(`toolchain loads (${((Date.now() - started) / 1000).toFixed(1)} s)`, true);

async function runSample(name, arch = 'x86_64') {
    await page.selectOption('#sample', { label: name });
    await page.selectOption('#arch', arch);
    await page.click('#run');
    await page.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 60_000 });
    return {
        status: await page.textContent('#status'),
        out: await page.textContent('#out'),
        trace: await page.textContent('#trace'),
        dis: await page.textContent('#dis'),
        files: await page.textContent('#files'),
        timings: await page.textContent('#timings'),
    };
}

let r = await runSample('write(2) and exit');
check(`hello runs: ${r.timings}`, r.out.includes('hello from a Linux process') && r.out.includes('[exit 0]'), r.out);
check('its trace shows the write', /write\(1,/.test(r.trace), r.trace);
await page.screenshot({ path: path.join(shots, '1-output.png') });

await page.click('.tab[data-view="trace"]');
await page.screenshot({ path: path.join(shots, '2-trace.png') });

r = await runSample('files: open, write, lseek, read');
check('a file the program wrote is listed', r.files.includes('notes.txt') && r.files.includes('small integers'), r.files);

r = await runSample('signals: sigaction and kill');
check('a fatal signal is reported as such', r.out.includes('killed by signal 15'), r.out);

await page.selectOption('#libc', 'gnu');
r = await runSample('threads: pthread_create and a mutex');
check(`four threads share a mutex under glibc: ${r.timings}`, r.out.includes('counter = 40000') && r.out.includes('[exit 0]'), r.out);
check('thread ids show in the trace', /\[\d+\] /.test(r.trace), r.trace.slice(0, 2000));
r = await runSample('threads: a data race');
check(`a data race loses increments (${/lost -?\d+/.exec(r.out)?.[0]})`, r.out.includes('[exit 0]'), r.out);
await page.screenshot({ path: path.join(shots, '3-threads.png') });
await page.selectOption('#libc', 'musl');

r = await runSample('raw syscall, no libc', 'aarch64');
check('aarch64 compiles and shows svc in the disassembly', /svc\s+#0/.test(r.dis), r.dis);
await page.screenshot({ path: path.join(shots, '4-aarch64.png') });

await page.fill('#source', 'int main(void) { for (;;) ; }');
await page.selectOption('#arch', 'x86_64');
await page.click('#run');
await page.waitForFunction(() => document.getElementById('status').textContent === 'Running…', null, { timeout: 60_000 });
await page.click('#stop');
await page.waitForFunction(() => document.getElementById('status').textContent === 'Ready', null, { timeout: 120_000 });
check('Stop ends an endless loop and the page recovers', (await page.textContent('#out')).includes('[stopped]'));

await page.fill('#source', 'int main(void) { return undefined_name; }');
await page.click('#run');
await page.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 60_000 });
r = { out: await page.textContent('#out'), status: await page.textContent('#status') };
check('a compile error is shown with its line', r.status === 'Compile failed' && /main\.c:1:\d+: error/.test(r.out), r.out);
await page.screenshot({ path: path.join(shots, '5-error.png') });

check('no uncaught errors on the page', errors.length === 0, errors.join('\n'));

await browser.close();
server.close();
if (failures.length) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
}
console.log('\nall passed');
