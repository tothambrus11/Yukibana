// The whole pipeline, with no DOM: compile C to a static Linux ELF with
// clang and lld running as WebAssembly, then run it under Blink. The page
// runs this in a worker; test/smoke.mjs runs it in Node.
import { untar } from './tar.js';

/**
 * What each architecture can do here. Both compile and link; only x86_64
 * has an emulator, because Blink is x86-64 only and nothing comparable for
 * AArch64 builds for the web today (see README.md).
 */
export const TARGETS = {
    x86_64: { runnable: true },
    aarch64: { runnable: false },
};

/**
 * The two C libraries, each a sysroot per architecture. Both link
 * statically. glibc's static link needs gcc's crtbeginT.o, crtend.o and
 * libgcc (from Debian's libgcc-14-dev); musl's needs only compiler-rt.
 */
export const LIBCS = {
    musl: {
        triple: arch => `${arch}-linux-musl`,
        link: [['/sys/lib/crt1.o', '/sys/lib/crti.o'],
            ['/sys/lib/libc.a', '/sys/lib/libclang_rt.builtins.a'],
            ['/sys/lib/crtn.o']],
    },
    gnu: {
        triple: arch => `${arch}-linux-gnu`,
        link: [['/sys/lib/crt1.o', '/sys/lib/crti.o', '/sys/lib/crtbeginT.o'],
            ['/sys/lib/libc.a', '/sys/lib/libm.a', '/sys/lib/libmvec.a', '/sys/lib/libgcc.a', '/sys/lib/libgcc_eh.a'],
            ['/sys/lib/crtend.o', '/sys/lib/crtn.o']],
    },
};

/**
 * Whether guest threads can run: the threaded Blink needs shared memory,
 * which a browser gives only to a cross-origin isolated page. Node has it
 * and no `crossOriginIsolated` at all.
 */
export const THREADS = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated !== false;

/**
 * x86-64 numbers of the calls this Blink build answers with ENOSYS, so the
 * trace can name them. Each needs a second process or thread, which the
 * browser does not give; see README.md.
 */
const UNEMULATED = {
    41: 'socket', 42: 'connect', 43: 'accept', 49: 'bind', 50: 'listen',
    56: 'clone', 57: 'fork', 58: 'vfork', 59: 'execve', 61: 'wait4', 202: 'futex', 334: 'rseq', 435: 'clone3',
};

/** Where the student's program lives, inside the compiler and the emulator alike. */
const HOME = '/home/student';

/**
 * Loads the two WebAssembly modules once, and makes a fresh instance of one
 * for every tool run: neither LLVM nor Blink can run main() twice in the
 * same instance, and a fresh instance is a fresh filesystem too.
 */
export class Toolchain {
    /**
     * @param {(name: string) => Promise<Uint8Array>} fetchBytes reads a file from dist/
     * @param {(name: string) => Promise<Function>} importFactory imports an Emscripten module factory from dist/
     */
    static async load(fetchBytes, importFactory) {
        const blinkName = THREADS ? 'blink-mt' : 'blink';
        const [llvm, blink, createLLVM, createBlink] = await Promise.all([
            fetchBytes('llvm.wasm').then(b => WebAssembly.compile(b)),
            fetchBytes(`${blinkName}.wasm`).then(b => WebAssembly.compile(b)),
            importFactory('llvm.mjs'),
            importFactory(`${blinkName}.mjs`),
        ]);
        return new Toolchain({ llvm, blink, createLLVM, createBlink, fetchBytes, threads: THREADS });
    }

    constructor(parts) {
        this.parts = parts;
        /** @type {Map<string, Promise<{ path: string, dir: boolean, data: Uint8Array }[]>>} */
        this.sysroots = new Map();
    }

    /** Whether `run` can start threads (see THREADS). */
    get threads() { return this.parts.threads; }

    /** One sysroot, fetched and unpacked the first time it is asked for. */
    sysroot(arch, libc) {
        const key = `${arch}-${libc}`;
        if (!this.sysroots.has(key)) {
            this.sysroots.set(key, this.parts.fetchBytes(`sysroot-${key}.tar.gz`).then(async gz => {
                const tar = new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')));
                return untar(new Uint8Array(await tar.arrayBuffer()));
            }));
        }
        return this.sysroots.get(key);
    }

    /**
     * Compiles one C file and links it statically against musl or glibc.
     *
     * `ok` is false when either step exited non-zero; `log` then holds what
     * clang or lld said. `elf` is the linked program and `object` the
     * compiler's output for main.c alone, which is what disassembly shows:
     * the student's code without libc around it.
     *
     * @param {{ source: string, arch: keyof TARGETS, libc?: keyof LIBCS, flags?: string[] }} request
     */
    async compile({ source, arch, libc = 'musl', flags = [] }) {
        const triple = LIBCS[libc].triple(arch);
        const [before, libs, after] = LIBCS[libc].link;
        const sys = await this.sysroot(arch, libc);
        const files = [...sys.map(f => ({ ...f, path: `/sys/${f.path}` })),
            { path: `${HOME}/main.c`, dir: false, data: new TextEncoder().encode(source) }];

        const cc = await this.tool('llvm', files, [
            'clang', `--target=${triple}`, '-resource-dir=/sys/res', '-nostdlibinc',
            '-isystem', '/sys/include', '-fno-color-diagnostics', '-pthread', ...flags,
            '-c', `${HOME}/main.c`, '-o', `${HOME}/main.o`,
        ], [`${HOME}/main.o`]);
        if (cc.exit !== 0) return { ok: false, log: cc.output, steps: [cc] };

        const object = cc.files[`${HOME}/main.o`];
        const ld = await this.tool('llvm', [...files, { path: `${HOME}/main.o`, dir: false, data: object }], [
            'ld.lld', '-static', '-o', `${HOME}/a.out`,
            ...before, `${HOME}/main.o`, '--start-group', ...libs, '--end-group', ...after,
        ], [`${HOME}/a.out`]);
        if (ld.exit !== 0) return { ok: false, log: cc.output + ld.output, steps: [cc, ld] };

        return { ok: true, log: cc.output + ld.output, steps: [cc, ld], object, elf: ld.files[`${HOME}/a.out`] };
    }

    /**
     * Disassembles an object file with llvm-objdump, relocations inline so
     * a call to printf reads as one.
     *
     * @param {Uint8Array} object
     * @param {boolean} intel Intel syntax rather than AT&T (x86 only)
     */
    async disassemble(object, intel = false) {
        const r = await this.tool('llvm', [{ path: `${HOME}/main.o`, dir: false, data: object }], [
            'objdump', '-d', '-r', '--no-show-raw-insn', ...(intel ? ['-M', 'intel'] : []), `${HOME}/main.o`,
        ]);
        return r.output;
    }

    /**
     * Runs a static x86-64 Linux program under Blink. Guest threads run
     * as real threads (Web Workers) when `threads` is true; otherwise
     * clone() fails with ENOSYS.
     *
     * `output` is the program's stdout and stderr interleaved as written,
     * each chunk tagged with its descriptor. `trace` is one line per system
     * call when `strace` was asked for, prefixed `[tid] ` when a thread other
     * than the main one made it. `files` is every file the program
     * left in its working directory, so a program that writes a file can be
     * looked at afterwards.
     *
     * @param {{ elf: Uint8Array, args?: string[], stdin?: string, strace?: boolean }} request
     */
    async run({ elf, args = [], stdin = '', strace = true }) {
        const r = await this.tool('blink', [{ path: `${HOME}/a.out`, dir: false, data: elf, mode: 0o755 }], [
            '-L', '/tmp/blink.log', ...(strace ? ['-s'] : []), '-0', './a.out', `${HOME}/a.out`, ...args,
        ], ['/tmp/blink.log'], { stdin, listHome: true });
        const log = r.files['/tmp/blink.log'] ? new TextDecoder().decode(r.files['/tmp/blink.log']) : '';
        // Blink prefixes each line with level, time and source position;
        // a student wants the call, so keep what follows "(sys) ".
        // A call Blink does not emulate is logged apart from the others, so
        // it is put back in sequence, readably: a student who calls fork()
        // should see that it was refused and why.
        const trace = log.split('\n').flatMap(l => {
            const call = /:(\d+) \(sys\) (.*)$/.exec(l);
            // The number before "(sys)" is the calling thread; the main
            // thread is the process (Blink's pid is always 42), and only
            // the others are worth a prefix.
            if (call) return [call[1] === '42' ? call[2] : `[${call[1]}] ${call[2]}`];
            const missing = /missing syscall 0x([0-9a-f]+)/.exec(l);
            if (!missing) return [];
            const nr = parseInt(missing[1], 16);
            return [`${UNEMULATED[nr] ?? `syscall ${nr}`}() -> -ENOSYS (not emulated in the browser)`];
        });
        const problems = log.split('\n').filter(l => /^[EF]\d/.test(l));
        return { exit: r.exit, chunks: r.chunks, output: r.output, trace, problems, home: r.home, ms: r.ms };
    }

    /**
     * One run of one tool in a fresh instance.
     *
     * @param {'llvm' | 'blink'} which
     * @param {{ path: string, dir: boolean, data: Uint8Array, mode?: number }[]} files written before main()
     * @param {string[]} args argv after argv[0]
     * @param {string[]} collect paths read back after main() returns, if they exist
     */
    async tool(which, files, args, collect = [], { stdin = '', listHome = false } = {}) {
        const module = this.parts[which];
        const factory = which === 'llvm' ? this.parts.createLLVM : this.parts.createBlink;
        const chunks = [];
        const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
        const emit = fd => byte => {
            if (byte === null) return;
            const text = decoders[fd].decode(new Uint8Array([byte & 0xff]), { stream: true });
            if (!text) return;
            const last = chunks[chunks.length - 1];
            if (last && last.fd === fd) last.text += text; else chunks.push({ fd, text });
        };
        const input = new TextEncoder().encode(stdin);
        let at = 0;
        const m = await factory({
            noInitialRun: true,
            // LLVM's multicall binary picks the tool from argv[1] when
            // argv[0] is "llvm".
            thisProgram: which === 'llvm' ? 'llvm' : 'blink',
            instantiateWasm(imports, done) {
                WebAssembly.instantiate(module, imports).then(i => done(i, module));
                return {};
            },
            preRun: [mod => mod.FS.init(() => (at < input.length ? input[at++] : null), emit(1), emit(2))],
            print: () => {}, printErr: () => {},
        });
        const FS = m.FS;
        for (const f of files) {
            const parent = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
            FS.mkdirTree(f.dir ? f.path : parent);
            if (!f.dir) {
                FS.writeFile(f.path, f.data);
                if (f.mode) FS.chmod(f.path, f.mode);
            }
        }
        FS.mkdirTree(HOME);
        FS.mkdirTree('/tmp');
        FS.chdir(HOME);

        const start = performance.now();
        let exit;
        try {
            // callMain puts argv[0] in front of the array it is given.
            exit = m.callMain([...args]);
        } catch (e) {
            if (e && typeof e.status === 'number') exit = e.status;
            else { chunks.push({ fd: 2, text: `\n[${which} crashed: ${e && e.message || e}]\n` }); exit = -1; }
        }
        const ms = Math.round(performance.now() - start);

        const out = {};
        for (const p of collect) {
            try { out[p] = FS.readFile(p); } catch { /* not produced */ }
        }
        let home = [];
        if (listHome) {
            home = FS.readdir(HOME).filter(n => n !== '.' && n !== '..' && n !== 'a.out').map(n => {
                const st = FS.stat(`${HOME}/${n}`);
                return { name: n, size: st.size, dir: FS.isDir(st.mode), data: FS.isDir(st.mode) ? null : FS.readFile(`${HOME}/${n}`) };
            });
        }
        return { tool: args[0], exit, chunks, output: chunks.map(c => c.text).join(''), files: out, home, ms };
    }
}
