// Drives web/toolchain.js in Node over every sample, the way the page's
// worker does: compile for both architectures, run the x86-64 build under
// Blink, and check what came out. Exits non-zero naming each failure.
//
//   node test/smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Toolchain } from '../web/toolchain.js';
import { SAMPLES } from '../web/samples.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const tc = await Toolchain.load(
    async name => new Uint8Array(fs.readFileSync(path.join(dist, name))),
    async name => (await import(pathToFileURL(path.join(dist, name)).href)).default,
);

const failures = [];
const check = (what, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) { failures.push(what); if (detail) console.log(detail.replace(/^/gm, '     ')); }
};

console.log(`guest threads: ${tc.threads ? 'yes' : 'no'}`);
for (const sample of SAMPLES) {
    for (const libc of ['musl', 'gnu']) {
        for (const arch of ['x86_64', 'aarch64']) {
            const what = `${sample.name} [${arch}, ${libc}]`;
            const c = await tc.compile({ source: sample.source, arch, libc, flags: ['-O1'] });
            check(`${what}: compiles (${c.steps.map(s => `${s.tool} ${s.ms} ms`).join(', ')})`, c.ok, c.log);
            if (!c.ok || arch !== 'x86_64' || (sample.threads && !tc.threads)) continue;
            const r = await tc.run({ elf: c.elf, stdin: sample.stdin ?? '', strace: true });
            check(`${what}: exits ${sample.expect.exit} (${r.ms} ms, ${r.trace.length} syscalls)`,
                r.exit === sample.expect.exit, `exit ${r.exit}\n${r.output}\n${r.problems.join('\n')}`);
            for (const s of sample.expect.output ?? []) {
                check(`${what}: prints ${JSON.stringify(s)}`, r.output.includes(s), r.output);
            }
            for (const s of sample.expect.trace ?? []) {
                // glibc calls openat where musl calls open,
                // pipe2 where musl uses pipe, and clone where musl uses fork.
                const alt = { 'open(': 'openat(', 'pipe(': 'pipe2(', 'nanosleep(': 'clock_nanosleep(', 'fork() -> -ENOSYS': 'clone(' }[s] ?? s;
                check(`${what}: traces ${s}`, r.trace.some(l => [s, alt].some(c => l.replace(/^\[\d+\] /, '').startsWith(c))), r.trace.join('\n'));
            }
        }
    }
}

const broken = await tc.compile({ source: 'int main(void) { return x; }', arch: 'x86_64' });
check('a compile error is reported with its position', !broken.ok && /main\.c:1:\d+: error/.test(broken.log), broken.log);

const hello = await tc.compile({ source: SAMPLES[0].source, arch: 'x86_64' });
const dis = await tc.disassemble(hello.object);
check('disassembly shows main', /<main>:/.test(dis), dis);

if (failures.length) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
}
console.log('\nall passed');
// The threaded Blink's worker pool would keep Node alive.
process.exit(0);
