/* What Emscripten's JavaScript runtime gives compiler-rt's Emscripten port,
 * here defined by wasi_emscripten.c (over the host's imports) and by
 * wasi_asan.c or wasi_heap.c (the allocator under the runtime's own). */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
void *emscripten_builtin_mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset);
int emscripten_builtin_munmap(void *addr, size_t length);
uintptr_t emscripten_stack_snapshot(void);
uint32_t emscripten_stack_unwind_buffer(uintptr_t pc, uintptr_t *buffer, uint32_t depth);
void _emscripten_get_progname(char *buffer, int size);
char *_emscripten_sanitizer_get_option(const char *name);
bool _emscripten_sanitizer_use_colors(void);
#ifdef __cplusplus
}
#endif
