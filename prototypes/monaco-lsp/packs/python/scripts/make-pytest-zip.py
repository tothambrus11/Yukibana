"""Merges the pytest wheels into one zip that the runner unpacks into Pyodide's
site-packages when the app asks for tests (runner.js, `type: 'test'`).

Usage: python3 -I make-pytest-zip.py <out.zip> <wheel>...

A wheel is a zip whose members are already laid out as they are installed
(`pytest/`, `_pytest/`, `pytest-9.0.2.dist-info/`), so installing a pure
Python wheel is unpacking it; the zip is the union of the wheels' members.
Not copied: each `.dist-info/RECORD` (hashes of an installation nobody
verifies here), and most of pygments: pytest imports pygments at module level
(`_pytest/_io/terminalwriter.py`) for the Python and diff lexers and the
terminal formatter, which is all it uses; the other ~580 lexers, formatters
and styles are 90 % of pygments' size. Everything kept is byte-for-byte what
PyPI published, including licences and the dist-info that `importlib.metadata`
reads (pytest looks up plugin entry points through it).

Members are stored, not deflated, so the .br/.gz siblings compress across
files (as python_stdlib.zip, see store-zip.py). Order and timestamps come from
the wheels, so the same wheels give the same bytes.
"""

import sys
import zipfile

# pygments: only these files in these directories; every other file of
# pygments (the package's own modules) is kept.
PYGMENTS_KEEP = {
    "pygments/lexers/": {"__init__.py", "_mapping.py", "python.py", "diff.py"},
    "pygments/formatters/": {"__init__.py", "_mapping.py", "terminal.py"},
    "pygments/styles/": {"__init__.py", "_mapping.py", "default.py"},
}


def kept(name: str) -> bool:
    if name.endswith(".dist-info/RECORD"):
        return False
    for prefix, files in PYGMENTS_KEEP.items():
        if name.startswith(prefix):
            return name[len(prefix):] in files
    return True


def main(out: str, wheels: list[str]) -> None:
    seen: set[str] = set()
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as dst:
        for wheel in wheels:
            with zipfile.ZipFile(wheel) as src:
                for info in src.infolist():
                    if info.is_dir() or not kept(info.filename):
                        continue
                    if info.filename in seen:
                        raise SystemExit(f"{wheel}: {info.filename} is also in an earlier wheel")
                    seen.add(info.filename)
                    data = src.read(info)
                    copy = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                    copy.external_attr = info.external_attr
                    copy.compress_type = zipfile.ZIP_STORED
                    dst.writestr(copy, data)
                    count += 1
    print(f"{out.rsplit('/', 1)[-1]}: {count} files from {len(wheels)} wheels")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
