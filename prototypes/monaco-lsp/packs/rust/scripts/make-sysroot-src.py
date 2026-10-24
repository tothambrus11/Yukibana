"""Writes the standard library's sources rust-analyzer reads (core, alloc and
std from rust-src) as an uncompressed ustar archive, deterministically.

    python3 -I make-sysroot-src.py <rust-src library dir> <out.tar>

Left out: the libraries' own tests (rust-analyzer analyses the sysroot
without cfg(test)), and the platform layers of other operating systems,
which the Linux cfgs the server sets never reach.
"""
import io
import os
import sys
import tarfile

CRATES = ("core", "alloc", "std")
OTHER_OS = (
    "std/src/sys/pal/windows", "std/src/sys/pal/sgx", "std/src/sys/pal/hermit", "std/src/sys/pal/solid",
    "std/src/sys/pal/teeos", "std/src/sys/pal/uefi", "std/src/sys/pal/wasi", "std/src/sys/pal/wasm",
    "std/src/sys/pal/xous", "std/src/sys/pal/zkvm", "std/src/sys/pal/itron", "std/src/os/windows",
    "std/src/os/fortanix_sgx", "std/src/os/hermit", "std/src/os/solid", "std/src/os/uefi", "std/src/os/xous",
    "std/src/os/wasi", "std/src/os/horizon", "std/src/os/vita", "std/src/os/fuchsia", "std/src/os/illumos",
    "std/src/os/solaris", "std/src/os/haiku", "std/src/os/ios", "std/src/os/macos", "std/src/os/watchos",
    "std/src/os/visionos", "std/src/os/aix", "std/src/os/nto", "std/src/os/hurd", "std/src/os/l4re",
    "std/src/os/emscripten", "std/src/os/espidf", "std/src/os/redox", "std/src/os/vxworks",
    "std/src/os/dragonfly", "std/src/os/freebsd", "std/src/os/netbsd", "std/src/os/openbsd",
)


def wanted(rel):
    if not rel.endswith(".rs"):
        return False
    parts = rel.split("/")
    if parts[-1] in ("tests.rs", "benches.rs") or "tests" in parts[2:-1] or "benches" in parts[2:-1]:
        return False
    return not any(rel == p or rel.startswith(p + "/") for p in OTHER_OS)


def main(library, out):
    paths = []
    for crate in CRATES:
        for dirpath, dirnames, filenames in os.walk(os.path.join(library, crate, "src")):
            dirnames.sort()
            for name in sorted(filenames):
                rel = os.path.relpath(os.path.join(dirpath, name), library).replace(os.sep, "/")
                if wanted(rel):
                    paths.append(rel)
    with tarfile.open(out, "w", format=tarfile.USTAR_FORMAT) as tar:
        for rel in paths:
            with open(os.path.join(library, rel), "rb") as f:
                data = f.read()
            info = tarfile.TarInfo(rel)
            info.size = len(data)
            info.mtime = 0
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    print(f"{out}: {len(paths)} files")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
