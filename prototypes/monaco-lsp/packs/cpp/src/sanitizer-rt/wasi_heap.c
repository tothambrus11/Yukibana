// The runtime's own allocations under UndefinedBehaviorSanitizer alone
// (build-sanitizers.sh, libclang_rt.ubsan_standalone.a): the C library's
// malloc, which UBSan does not replace, under the names Emscripten's
// runtime gives its allocator (emscripten_builtin_*).
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

void *emscripten_builtin_malloc(size_t n) { return malloc(n); }
void *emscripten_builtin_calloc(size_t n, size_t m) { return calloc(n, m); }
void *emscripten_builtin_realloc(void *p, size_t n) { return realloc(p, n); }
void *emscripten_builtin_memalign(size_t a, size_t n) {
  void *p = 0;
  return posix_memalign(&p, a, n) ? 0 : p;
}
void emscripten_builtin_free(void *p) { free(p); }
// Anonymous mappings only, zeroed, as Emscripten's mmap gives them.
void *emscripten_builtin_mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset) {
  void *p = emscripten_builtin_memalign(65536, length);
  if (!p) return (void *)-1;
  memset(p, 0, length);
  return p;
}
int emscripten_builtin_munmap(void *addr, size_t length) {
  free(addr);
  return 0;
}
