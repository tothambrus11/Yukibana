// The WASI preview1 imports a Kotlin/Wasm program for WASI uses (fd_write, fd_read,
// poll_oneoff, random_get), over a fixed stdin. A pack's runner would block in fd_read on a
// SharedArrayBuffer instead, as the other packs' terminals do.
//
// wasiImports(stdin: Uint8Array, write: (fd, text) => void) returns { imports, bind }: pass
// imports as the module's wasi_snapshot_preview1, then bind(instance) before calling _start.
export function wasiImports(stdin, write) {
    let mem, pos = 0;
    const dv = () => new DataView(mem.buffer);
    const decoder = new TextDecoder();
    const iov = (iovs, i) => [dv().getUint32(iovs + 8 * i, true), dv().getUint32(iovs + 8 * i + 4, true)];
    const imports = {
        fd_write(fd, iovs, n, nwritten) {
            let total = 0;
            for (let i = 0; i < n; i++) {
                const [p, l] = iov(iovs, i);
                write(fd, decoder.decode(new Uint8Array(mem.buffer, p, l)));
                total += l;
            }
            dv().setUint32(nwritten, total, true);
            return 0;
        },
        fd_read(fd, iovs, n, nread) {
            let total = 0;
            for (let i = 0; i < n && pos < stdin.length; i++) {
                const [p, l] = iov(iovs, i);
                const c = Math.min(l, stdin.length - pos);
                new Uint8Array(mem.buffer, p, c).set(stdin.subarray(pos, pos + c));
                pos += c;
                total += c;
            }
            dv().setUint32(nread, total, true);
            return 0;
        },
        // Every subscription is ready at once: a clock has expired, stdin has what is left.
        poll_oneoff(inp, out, n, nevents) {
            for (let i = 0; i < n; i++) {
                const sub = inp + 48 * i, ev = out + 32 * i, type = dv().getUint8(sub + 8);
                dv().setBigUint64(ev, dv().getBigUint64(sub, true), true);
                dv().setUint16(ev + 8, 0, true);
                dv().setUint8(ev + 10, type);
                dv().setBigUint64(ev + 16, BigInt(type === 1 ? stdin.length - pos : 0), true);
                dv().setUint16(ev + 24, 0, true);
            }
            dv().setUint32(nevents, n, true);
            return 0;
        },
        random_get(p, l) {
            crypto.getRandomValues(new Uint8Array(mem.buffer, p, l));
            return 0;
        },
    };
    return { imports, bind(instance) { mem = instance.exports.memory; } };
}
