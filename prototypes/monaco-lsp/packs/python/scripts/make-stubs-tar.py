"""Packs typeshed's stdlib stubs into a deterministic ustar archive, gzipped.

Usage: python3 -I make-stubs-tar.py <typeshed dir> <out.tar.gz>

Only `stdlib/` (with its VERSIONS file) and the licence go in: third-party
stubs (`stubs/`, ~27 MB) are for packages that cannot be installed in a
browser project anyway. USTAR_FORMAT makes tarfile refuse any name it cannot
store in a plain header, so the worker's reader never meets pax/GNU records.
Entries are sorted and mtime/uid/gid zeroed so the same input gives the same
bytes (and the service worker cache stays valid across rebuilds).
"""

import gzip
import io
import sys
import tarfile
from pathlib import Path


def main(src: Path, out: Path) -> None:
    files = sorted(p for p in (src / "stdlib").rglob("*") if p.is_file())
    files += [src / name for name in ("LICENSE", "commit.txt") if (src / name).is_file()]
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for path in files:
            data = path.read_bytes()
            info = tarfile.TarInfo(path.relative_to(src).as_posix())
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    out.write_bytes(gzip.compress(raw.getvalue(), compresslevel=9, mtime=0))
    print(f"{out.name}: {len(files)} files, {raw.tell()} bytes tar, {out.stat().st_size} bytes gzip")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
