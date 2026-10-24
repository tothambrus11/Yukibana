# zipdir.py <dir> <out.zip> <prefix>: a zip of a directory's files under <prefix>/, without .git.
import os
import sys
import zipfile

src, out, prefix = sys.argv[1:]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as z:
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d != '.git')
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, prefix + '/' + os.path.relpath(p, src))
