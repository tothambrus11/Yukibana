// Copies GHC's dyld.mjs (its wasm dynamic linker, from GHC's libdir) into
// the pack with four changes, each checked to apply exactly once:
//
// * browser_wasi_shim comes from the pack (./wasi.js), not from esm.sh: a
//   pack loads nothing from a third party at run time (CONTRACT.md).
// * The WASI fds of the linked program (stdin, stdout, stderr) can be given
//   by the host as `wasiFds`: the runner's stdout is posted as it is
//   written and its stdin waits for the terminal, where dyld.mjs would
//   print whole lines to the console and read nothing.
// * With the host's fds, closing fd 0, 1 or 2 leaves them open. The runner
//   runs program after program in one GHC (runner.js), and GHC closes
//   stdin when a program has read it to its end (getContents) and at other
//   times of its choosing; the shim would then drop fd 0, and the next
//   program's stdin (Yuki.hs's freshStdio opens fd 0 again) would be a bad
//   file descriptor. A terminal outlives the programs it runs.
// * The browser host resolves `.` and `..` in a path before looking it up in
//   the in-memory file system, as Node's does: GHC loads a package's library
//   from its registered directory, `${pkgroot}/../lib/...` for a boot
//   package, and the lookup otherwise fails with "Cannot read properties of
//   null (reading 'data')" the first time a program imports text or mtl.
//
// Usage: node patch-dyld.mjs <GHC's dyld.mjs> <out>
import { readFileSync, writeFileSync } from 'node:fs';

const [from, to] = process.argv.slice(2);
let s = readFileSync(from, 'utf8');
const replace = (what, by) => {
    const n = s.split(what).length - 1;
    if (n !== 1) throw new Error(`${from}: expected one ${JSON.stringify(what.slice(0, 60))}, found ${n}`);
    s = s.replace(what, by);
};
replace('await import("https://esm.sh/gh/haskell-wasm/browser_wasi_shim")', 'await import("./wasi.js")');
replace(
    `      this.#wasi = new wasi.WASI(
        args,
        [],
        [`,
    `      this.#wasi = new wasi.WASI(
        args,
        [],
        this.#rpc.wasiFds ? [...this.#rpc.wasiFds, this.#rpc.rootfs] : [`,
);
replace(
    `        wasi_snapshot_preview1: this.#wasi.wasiImport,`,
    `        wasi_snapshot_preview1: this.#rpc.wasiFds ? { ...this.#wasi.wasiImport, fd_close: (fd) => (fd <= 2 ? 0 : this.#wasi.wasiImport.fd_close(fd)) } : this.#wasi.wasiImport,`,
);
replace(
    `      parts: p.split("/").filter((tok) => tok !== ""),
      is_dir: false,`,
    `      parts: p.split("/").filter((tok) => tok !== "" && tok !== ".").reduce((a, tok) => (tok === ".." ? a.slice(0, -1) : [...a, tok]), []),
      is_dir: false,`,
);
writeFileSync(to, s);
