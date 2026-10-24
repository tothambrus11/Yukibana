/* Emscripten's <emscripten/threading.h>, the part compiler-rt's port uses:
 * one thread on WASI, so a futex never waits. */
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
int emscripten_futex_wait(volatile void *addr, uint32_t val, double maxWaitMilliseconds);
int emscripten_futex_wake(volatile void *addr, int count);
#ifdef __cplusplus
}
#endif
