# extract.py <tarball> <out dir> <member>[=<name>]...: writes each member's
# file into <out dir> under <name>, or its base name. Reads the tarball as
# data: nothing in it runs.
import os
import sys
import tarfile

tarball, out, *members = sys.argv[1:]
with tarfile.open(tarball, "r:gz") as tar:
    for arg in members:
        name, _, target = arg.partition("=")
        data = tar.extractfile(tar.getmember(name)).read()
        with open(os.path.join(out, target or os.path.basename(name)), "wb") as f:
            f.write(data)
