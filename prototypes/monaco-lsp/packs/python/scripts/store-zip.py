"""Rewrites a zip archive with every member stored (uncompressed).

Pyodide's python_stdlib.zip is deflated member by member, so brotli and gzip
over the whole file gain almost nothing (2.55 MB -> 2.49 MB). Stored, the
archive is 9.7 MB raw but 1.6 MB brotli / 2.2 MB gzip, because the
compressor sees all of the stdlib's text at once. zipimport reads stored
members without inflating them. Order, names, timestamps and attributes are
kept, so the output is a deterministic function of the input.

    python3 -I store-zip.py IN.zip OUT.zip
"""

import sys
import zipfile

src_path, dst_path = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src_path) as src, zipfile.ZipFile(dst_path, "w", zipfile.ZIP_STORED) as dst:
    for info in src.infolist():
        out = zipfile.ZipInfo(info.filename, info.date_time)
        out.external_attr = info.external_attr
        out.create_system = info.create_system
        dst.writestr(out, src.read(info), zipfile.ZIP_STORED)
