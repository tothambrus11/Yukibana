// The memory under AddressSanitizer's own allocator, which replaces malloc
// (build-sanitizers.sh, libclang_rt.asan.a): a private dlmalloc on
// wasi-libc's sbrk, Emscripten's own copy of Doug Lea's allocator (the one
// wasi-libc's malloc is too; build-sanitizers.sh puts emsdk's system/lib on
// the include path), under the names Emscripten's runtime gives it
// (emscripten_builtin_*).
#define USE_DL_PREFIX 1
#define DLMALLOC_EXPORT static
#define HAVE_MMAP 0
#define MORECORE_CANNOT_TRIM 1
#define ABORT __builtin_trap()
#define NO_MALLOC_STATS 1
#define NO_MALLINFO 1
#define LACKS_TIME_H 1
#define MALLOC_ALIGNMENT 16
#include "dlmalloc.c"

void *emscripten_builtin_malloc(size_t n) { return dlmalloc(n); }
void *emscripten_builtin_calloc(size_t n, size_t m) { return dlcalloc(n, m); }
void *emscripten_builtin_realloc(void *p, size_t n) { return dlrealloc(p, n); }
void *emscripten_builtin_memalign(size_t a, size_t n) { return dlmemalign(a, n); }
void emscripten_builtin_free(void *p) { dlfree(p); }
// Anonymous mappings only, zeroed, as Emscripten's mmap gives them.
void *emscripten_builtin_mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset) {
  void *p = dlmemalign(65536, length);
  if (!p) return (void *)-1;
  memset(p, 0, length);
  return p;
}
int emscripten_builtin_munmap(void *addr, size_t length) { dlfree(addr); return 0; }
// The C library's internal allocations (atexit's table, locales) go to the
// same private heap, outside what AddressSanitizer checks or LeakSanitizer
// counts, as Emscripten's __libc_malloc does.
void *__libc_malloc(size_t n) { return dlmalloc(n); }
void *__libc_calloc(size_t n, size_t m) { return dlcalloc(n, m); }
void *__libc_realloc(void *p, size_t n) { return dlrealloc(p, n); }
void __libc_free(void *p) { dlfree(p); }

// REAL(memcpy) and REAL(memset): AddressSanitizer's memcpy and memset check
// their arguments, and replace the C library's; these are the unchecked
// ones, the bulk memory instructions, as Emscripten's are.
__attribute__((no_sanitize("address"))) void *emscripten_builtin_memcpy(void *d, const void *s, size_t n) {
  __builtin_memcpy(d, s, n);
  return d;
}
__attribute__((no_sanitize("address"))) void *emscripten_builtin_memmove(void *d, const void *s, size_t n) {
  __builtin_memmove(d, s, n);
  return d;
}
__attribute__((no_sanitize("address"))) void *emscripten_builtin_memset(void *d, int c, size_t n) {
  __builtin_memset(d, c, n);
  return d;
}

// One thread: pthread_create fails, as wasi-libc's does without threads.
#include <errno.h>
int emscripten_builtin_pthread_create(void *thread, const void *attr, void *(*start)(void *), void *arg) { return EAGAIN; }

// main's argv, as wasi-libc's __main_void makes it, but kept in globals:
// wasi-libc keeps the two allocations only in WebAssembly locals, which
// LeakSanitizer cannot scan (natively argv is on the stack it scans), so
// every program would report them as leaked. Weak, as wasi-libc's is: a
// `main(void)` is itself compiled as __main_void, and needs no argv. This
// archive comes before the C library, so its definition is the one linked.
#include <wasi/api.h>
#include <sysexits.h>
int __main_argc_argv(int argc, char **argv);
static char *argv_buf;
static char **argv;
__attribute__((weak)) int __main_void(void) {
  size_t argc, argv_buf_size;
  if (__wasi_args_sizes_get(&argc, &argv_buf_size) != __WASI_ERRNO_SUCCESS) _Exit(EX_OSERR);
  argv_buf = malloc(argv_buf_size);
  argv = calloc(argc + 1, sizeof(char *));
  if (!argv_buf || !argv) _Exit(EX_SOFTWARE);
  if (__wasi_args_get((uint8_t **)argv, (uint8_t *)argv_buf) != __WASI_ERRNO_SUCCESS) _Exit(EX_OSERR);
  return __main_argc_argv(argc, argv);
}
