#!/bin/bash
# Builds QEMU-Wasm's dependencies (zlib, libffi, glib, pixman) with emscripten 6.0.13,
# natively, mirroring the stages of ktock/qemu-wasm's Dockerfile.
# Needs: emsdk 6.0.13 (any 5.0.5 or later) activated (source emsdk_env.sh), meson 1.5, ninja, autoconf,
# automake, libtool, libltdl-dev, pkg-config, python3, curl, git, npm.
set -euxo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HERE/work}
export TARGET=$WORK/target
mkdir -p "$TARGET/lib" "$WORK/src"
export CFLAGS="-O2 -matomics -mbulk-memory -DNDEBUG -sWASM_BIGINT -DWASM_BIGINT -pthread -sMALLOC=mimalloc -sASYNCIFY=1"
export CXXFLAGS="$CFLAGS" LDFLAGS="-L$TARGET/lib -O2" CPATH="$TARGET/include"
# The host's .pc files must not leak in (a host libelf breaks glib's gresource tool).
export PKG_CONFIG_LIBDIR="$TARGET/lib/pkgconfig" PKG_CONFIG_PATH="$TARGET/lib/pkgconfig" EM_PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export CHOST=wasm32-unknown-linux MAKEFLAGS="-j$(nproc)"
cd "$WORK/src"

[ -d zlib ] || { mkdir zlib && curl -Ls https://zlib.net/fossils/zlib-1.3.1.tar.gz | tar xzC zlib --strip-components=1; }
(cd zlib && emconfigure ./configure --prefix="$TARGET" --static && make install)

[ -d libffi ] || git clone -q https://github.com/libffi/libffi libffi
(cd libffi && git checkout -q adbcf2b247696dde2667ab552cb93e0c79455c84 && autoreconf -fi \
  && LDFLAGS="$LDFLAGS -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0" emconfigure ./configure --host=$CHOST --prefix="$TARGET" \
     --enable-static --disable-shared --disable-dependency-tracking --disable-builddir --disable-multi-os-directory \
     --disable-raw-api --disable-structs --disable-docs \
  && emmake make install SUBDIRS=include)

printf '#include <netdb.h>\nint res_query(const char *n, int c, int t, unsigned char *d, int l) { h_errno = HOST_NOT_FOUND; return -1; }\n' > res_query.c
emcc $CFLAGS -c res_query.c -fPIC -o libresolv.o && emar rcs "$TARGET/lib/libresolv.a" libresolv.o

[ -d glib ] || { mkdir glib && curl -Lks https://download.gnome.org/sources/glib/2.75/glib-2.75.0.tar.xz | tar xJC glib --strip-components=1; }
cat > emcc-meson-wrap.sh <<'EOT'
#!/bin/bash
# emcc warns about -s flags at compile time; meson's checks must not turn that into an error.
set -euo pipefail
cmd="$1"; shift; args=()
for a in "$@"; do args+=("${a//-Werror=unused-command-line-argument/-Wno-error=unused-command-line-argument}"); done
"$cmd" "${args[@]}"
EOT
cat > cross.meson <<EOT
[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
[binaries]
c = ['bash', '$WORK/src/emcc-meson-wrap.sh', 'emcc']
cpp = ['bash', '$WORK/src/emcc-meson-wrap.sh', 'em++']
ar = 'emar'
ranlib = 'emranlib'
pkgconfig = ['pkg-config', '--static']
EOT
(cd glib && rm -rf _build \
  && CFLAGS="-Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types -O2 -matomics -mbulk-memory -DNDEBUG -pthread -sWASM_BIGINT -sMALLOC=mimalloc -sASYNCIFY=1" \
     meson setup _build --prefix="$TARGET" --cross-file="$WORK/src/cross.meson" --default-library=static --buildtype=release \
     --force-fallback-for=pcre2,gvdb -Dselinux=disabled -Dxattr=false -Dlibmount=disabled -Dnls=disabled -Dtests=false \
     -Dglib_assert=false -Dglib_checks=false -Dlibelf=disabled \
  && for d in HAVE_CLOSE_RANGE HAVE_EPOLL_CREATE HAVE_KQUEUE HAVE_POSIX_SPAWN HAVE_FALLOCATE; do sed -i -E "/#define $d 1/d" _build/config.h; done \
  && meson install -C _build)

[ -d pixman ] || git clone -q https://gitlab.freedesktop.org/pixman/pixman pixman
(cd pixman && git checkout -q pixman-0.42.2 && NOCONFIGURE=y ./autogen.sh && emconfigure ./configure --host=$CHOST --prefix="$TARGET" \
  && emmake make -C pixman install && rm -f "$TARGET"/lib/libpixman-1.so*)

(cd "$WORK" && npm i --no-save xterm-pty@0.10.1 >/dev/null)
echo "deps ready in $TARGET"
