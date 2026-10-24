// Unit tests of src/vm/cpio.js against GNU cpio (cpio -i / -t), the reference reader
// of the newc format the Linux kernel unpacks as an initramfs.
//
//   node test-cpio.mjs        (needs GNU cpio on PATH)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { concat, cpio, runArchive } from './src/vm/cpio.js';

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const extract = (bytes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpio-'));
    dirs.push(dir);
    execFileSync('cpio', ['-i', '-d', '--quiet', '--no-absolute-filenames'], { cwd: dir, input: bytes });
    return dir;
};
const list = (bytes) => execFileSync('cpio', ['-t', '--quiet'], { input: bytes }).toString().trim().split('\n');

test("a run's archive holds the program, its argv and nothing else", () => {
    const prog = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
    const a = runArchive(prog, ['main', 'two words', 'ünïcode', '']);
    assert.equal(a.length % 4, 0);
    assert.deepEqual(list(a), ['yk', 'yk/prog', 'yk/argv']);
    const dir = extract(a);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, 'yk/prog'))), prog);
    assert.equal(fs.statSync(path.join(dir, 'yk/prog')).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(path.join(dir, 'yk/argv'), 'utf8'), 'main\0two words\0ünïcode\0\0');
});

test('the environment and strace options are files of their own, and an empty strace list still means trace', () => {
    const a = runArchive(new Uint8Array(1), ['main'], ['PATH=/bin', 'A=b=c'], ['-f', '-e', 'trace=write']);
    assert.deepEqual(list(a), ['yk', 'yk/prog', 'yk/argv', 'yk/env', 'yk/strace']);
    const dir = extract(a);
    assert.equal(fs.readFileSync(path.join(dir, 'yk/env'), 'utf8'), 'PATH=/bin\0A=b=c\0');
    assert.equal(fs.readFileSync(path.join(dir, 'yk/strace'), 'utf8'), '-f\0-e\0trace=write\0');
    const empty = extract(runArchive(new Uint8Array(1), ['main'], null, []));
    assert.equal(fs.readFileSync(path.join(empty, 'yk/strace'), 'utf8'), '');
    assert.equal(fs.existsSync(path.join(empty, 'yk/env')), false);
});

test("a dynamically linked program's interpreter goes in with its directories, executable", () => {
    const loader = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 9]);
    const a = runArchive(new Uint8Array(1), ['main'], null, null, [{ path: 'lib/ld-musl-x86_64.so.1', data: loader }, { path: 'lib/sub/x', data: new Uint8Array(2) }]);
    assert.deepEqual(list(a), ['yk', 'yk/prog', 'yk/argv', 'lib', 'lib/ld-musl-x86_64.so.1', 'lib/sub', 'lib/sub/x']);
    const dir = extract(a);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, 'lib/ld-musl-x86_64.so.1'))), loader);
    assert.equal(fs.statSync(path.join(dir, 'lib/ld-musl-x86_64.so.1')).mode & 0o777, 0o755);
    assert.deepEqual(runArchive(new Uint8Array(1), ['main'], null, null, []), runArchive(new Uint8Array(1), ['main']));
});

test('the bytes are exactly what GNU cpio writes for the same tree (newc, root, mtime 0)', () => {
    // GNU cpio -o -H newc from a directory with the same files, owner and mtime;
    // only inode and device numbers differ (they come from the host file system),
    // so compare after zeroing c_ino, c_dev*, c_rdev* in both.
    const prog = new TextEncoder().encode('program bytes, 23 long!');
    const mine = runArchive(prog, ['main', 'x']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpio-src-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'yk'), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'yk/prog'), prog, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'yk/argv'), 'main\0x\0', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'yk'), 0o755);
    fs.chmodSync(path.join(dir, 'yk/prog'), 0o755);
    fs.chmodSync(path.join(dir, 'yk/argv'), 0o644);
    for (const f of ['yk/prog', 'yk/argv', 'yk']) fs.utimesSync(path.join(dir, f), 0, 0);
    const gnu = execFileSync('cpio', ['-o', '-H', 'newc', '--quiet', '--owner=0:0', '--reproducible'], { cwd: dir, input: 'yk\nyk/prog\nyk/argv\n' });
    const norm = (bytes) => {
        const b = Buffer.from(bytes);
        for (let at = 0; at + 110 <= b.length;) {
            assert.equal(b.toString('latin1', at, at + 6), '070701');
            const field = (i) => parseInt(b.toString('latin1', at + 6 + i * 8, at + 14 + i * 8), 16);
            const [size, nameLen] = [field(6), field(11)];
            for (const i of [0, 7, 8, 9, 10]) b.write('00000000', at + 6 + i * 8, 'latin1'); // ino, devmajor/minor, rdevmajor/minor
            const name = b.toString('latin1', at + 110, at + 110 + nameLen - 1);
            at = ((at + 110 + nameLen + 3) & ~3) + ((size + 3) & ~3);
            if (name === 'TRAILER!!!') return b.subarray(0, at);
        }
        throw new Error('no trailer');
    };
    // GNU cpio pads the whole archive to 512 bytes; the kernel does not need that.
    assert.deepEqual(norm(mine), norm(gnu));
});

test('every file size and name length pads correctly, so concatenated archives stay readable', () => {
    const parts = [];
    for (let n = 0; n < 9; n++)
        parts.push(cpio([{ name: 'd' + 'x'.repeat(n), mode: 0o040755 }, { name: `d${'x'.repeat(n)}/f`, mode: 0o100644, data: new Uint8Array(n).fill(65 + n) }]));
    // GNU cpio stops at the first trailer, so check each part alone and the kernel-style
    // concatenation by offsets.
    let at = 0;
    const all = concat(parts);
    for (const [n, p] of parts.entries()) {
        assert.equal(p.length % 4, 0);
        assert.deepEqual(all.subarray(at, at + p.length), p);
        const dir = extract(p);
        assert.equal(fs.readFileSync(path.join(dir, `d${'x'.repeat(n)}/f`), 'latin1'), String.fromCharCode(65 + n).repeat(n));
        at += p.length;
    }
});

test('device nodes carry their major and minor numbers', () => {
    const a = cpio([{ name: 'console', mode: 0o020600, rdev: [5, 1] }]);
    const out = execFileSync('cpio', ['-t', '-v', '--quiet'], { input: a }).toString();
    assert.match(out, /^crw-------.*5,\s+1.*console$/m);
});

test('bad names and arguments are refused rather than written', () => {
    assert.throws(() => cpio([{ name: '/abs', mode: 0o100644 }]), /bad name/);
    assert.throws(() => cpio([{ name: '', mode: 0o100644 }]), /bad name/);
    assert.throws(() => cpio([{ name: 'a\0b', mode: 0o100644 }]), /bad name/);
    assert.throws(() => runArchive(new Uint8Array(1), ['main', 'a\0b']), /NUL/);
    assert.throws(() => runArchive(new Uint8Array(1), ['main'], ['A=\0']), /NUL/);
    assert.throws(() => runArchive(new Uint8Array(1), []), /argv is empty/);
});
