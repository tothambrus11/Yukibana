/* The few Emscripten declarations compiler-rt's Emscripten port includes,
 * for building that port for wasm32-wasip1 (build-sanitizers.sh; README,
 * "Sanitizers"). wasi_emscripten.c and wasi_asan.c / wasi_heap.c define
 * them. */
#pragma once
#include <emscripten/heap.h>
#include <emscripten/stack.h>
