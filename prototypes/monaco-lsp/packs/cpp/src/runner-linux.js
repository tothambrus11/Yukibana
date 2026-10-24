// The Linux half of the C/C++ pack's runner (runner.js imports it only for
// a Linux target, so the default target's runner.js stays as small as it
// was): links the compiled objects into a static ELF with ld.lld, the way
// clang's own driver would (toolchain.js linkLinux), and runs it with
// vm.js's runLinux, QEMU-Wasm in system or user mode (the emulator's
// bundle; P/vm/README.md, ../../CONTRACT.md "Running a program").

import { linkLinux } from './toolchain.js';

/**
 * Links `objects` (`.yukibana/obj/<source>.o` to bytes, compiled by the
 * runner for `target`, a Linux row of src/targets.js) with `libs` (`-l`
 * flags, a test framework's and RapidCheck's, found in the files of the
 * `archives` named: targets/<arch>/gtest.tar, rapidcheck.tar) and runs the program,
 * resolving to its exit status (the runner posts 'exit').
 *
 * Posts `mark` 'compiled' and 'linked' (ms since `started`, the runner's
 * performance.now() when the request arrived), the 'Linking' phase, and the
 * linker's messages on stderr through `post`. Then frees the compiler
 * (`toolchain.release()`) and imports ./vm.js: when that fails (the
 * emulator is not built), prints "Running on <label> is not installed
 * (packs/cpp/vm.js)" and resolves to 1. Otherwise calls `runLinux` with
 * the program, `args` (argv[1..]) and `env` (a test framework's colour
 * switches; empty for a plain program), the app's `stdin`
 * buffer, and `options` over the defaults `{ emulation: 'system', cpus: 1,
 * strace: false }`, and `t0: started` so that vm.js's marks count from the
 * same moment as 'compiled' and 'linked'; vm.js posts everything else.
 */
export async function runOnLinux({ toolchain, target, objects, cxx, libs = [], archives = [], args = [], env = {}, stdin, options, post, started }) {
    const mark = (name) => post({ type: 'mark', name, ms: Math.round(performance.now() - started) });
    mark('compiled');
    post({ type: 'phase', text: 'Linking' });
    const { code, program } = await linkLinux(toolchain, objects, target, { cxx, libs, archives });
    if (code !== 0 || !program) return code || 1;
    mark('linked');
    // The compiled cc-cross module and the unpacked headers and libraries
    // (well over 100 MB) are not needed while the guest runs.
    toolchain.release();
    let runLinux;
    try {
        ({ runLinux } = await import('./vm.js'));
    } catch {
        post({ type: 'stderr', text: `Running on ${target.label} is not installed (packs/cpp/vm.js)\n` });
        return 1;
    }
    return runLinux({
        arch: target.arch,
        program,
        args,
        env,
        stdin,
        options: { emulation: 'system', cpus: 1, strace: false, ...options },
        post,
        base: new URL('./', import.meta.url),
        // vm.js's marks ('vm-loaded', 'exec', ...) count from the same
        // moment as 'compiled' and 'linked' above.
        t0: started,
    });
}
