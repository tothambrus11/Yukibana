/* Emscripten's <emscripten/stack.h>, the part compiler-rt's port uses. */
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
uintptr_t emscripten_stack_get_base(void);
uintptr_t emscripten_stack_get_end(void);
#ifdef __cplusplus
}
#endif
