"""Packs typeshed's stdlib stubs into a deterministic ustar archive, gzipped.

Usage: python3 -I make-stubs-tar.py <typeshed dir> <out.tar.gz> [<extra stubs dir>...]

Only `stdlib/` (with its VERSIONS file) and the licence go in: third-party
stubs (`stubs/`, ~27 MB) are for packages that cannot be installed in a
browser project anyway. USTAR_FORMAT makes tarfile refuse any name it cannot
store in a plain header, so the worker's reader never meets pax/GNU records.
Entries are sorted and mtime/uid/gid zeroed so the same input gives the same
bytes (and the service worker cache stays valid across rebuilds).

The extra directories (build.sh: stubgen's stubs of pytest and of
Hypothesis) go in under `stdlib/` too, each of their top-level packages added
to stdlib/VERSIONS, so pyright treats them as part of the interpreter. That
is what they are for this pack: the runner installs pytest in test mode and
Hypothesis for a project that imports it, and as a third-party stub
(typeshed's `stubs/`) every `import pytest` would carry a
reportMissingModuleSource warning for a module the browser does run.
"""

import gzip
import io
import sys
import tarfile
from pathlib import Path


def main(src: Path, out: Path, extras: list[Path]) -> None:
    entries: dict[str, Path] = {}
    for p in sorted((src / "stdlib").rglob("*")):
        if p.is_file():
            entries[p.relative_to(src).as_posix()] = p
    for name in ("LICENSE", "commit.txt"):
        if (src / name).is_file():
            entries[name] = src / name
    versions = (src / "stdlib" / "VERSIONS").read_text()
    for extra in extras:
        tops = sorted({p.relative_to(extra).parts[0] for p in extra.rglob("*.pyi")})
        for top in tops:
            if f"stdlib/{top}" in entries or f"stdlib/{top}.pyi" in entries:
                raise SystemExit(f"{top} is already in typeshed's stdlib")
            versions += f"{top}: 3.10-\n"
        for p in sorted(extra.rglob("*.pyi")):
            entries[f"stdlib/{p.relative_to(extra).as_posix()}"] = p
    names = sorted(entries)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in names:
            path = entries[name]
            data = versions.encode() if name == "stdlib/VERSIONS" else path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    out.write_bytes(gzip.compress(raw.getvalue(), compresslevel=9, mtime=0))
    print(f"{out.name}: {len(names)} files, {raw.tell()} bytes tar, {out.stat().st_size} bytes gzip")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), [Path(a) for a in sys.argv[3:]])
