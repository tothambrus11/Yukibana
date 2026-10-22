/**
 * Reads a ustar archive into a list of files. Only regular files and
 * directories are returned; the sysroot tarballs hold nothing else.
 *
 * @param {Uint8Array} bytes the whole archive
 * @returns {{ path: string, dir: boolean, data: Uint8Array }[]}
 */
export function untar(bytes) {
    const files = [];
    const text = (at, len) => {
        let end = at;
        while (end < at + len && bytes[end] !== 0) end++;
        return new TextDecoder().decode(bytes.subarray(at, end));
    };
    let at = 0;
    while (at + 512 <= bytes.length && bytes[at] !== 0) {
        const name = text(at, 100);
        const prefix = text(at + 345, 155);
        const size = parseInt(text(at + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(bytes[at + 156] || 48);
        const path = prefix ? `${prefix}/${name}` : name;
        at += 512;
        if (type === '0' || type === '\0') {
            files.push({ path, dir: false, data: bytes.slice(at, at + size) });
        } else if (type === '5') {
            files.push({ path, dir: true, data: new Uint8Array() });
        }
        at += Math.ceil(size / 512) * 512;
    }
    return files;
}
