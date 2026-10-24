/* Emscripten's <emscripten/heap.h>, the part compiler-rt's port uses. */
#pragma once
#include <stddef.h>
#define WASM_PAGE_SIZE 65536
#define EMSCRIPTEN_PAGE_SIZE WASM_PAGE_SIZE
#ifdef __cplusplus
extern "C" {
#endif
size_t emscripten_get_heap_size(void);
void *emscripten_builtin_memalign(size_t alignment, size_t size);
void *emscripten_builtin_malloc(size_t size);
void *emscripten_builtin_calloc(size_t nmemb, size_t size);
void *emscripten_builtin_realloc(void *ptr, size_t size);
void emscripten_builtin_free(void *ptr);
#ifdef __cplusplus
}
#endif
