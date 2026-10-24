// What compiler-rt's Emscripten port takes from Emscripten's JavaScript
// runtime, for a wasm32-wasip1 program (build-sanitizers.sh; README,
// "Sanitizers"): the C half here, the JavaScript half (stack traces from
// the engine's Error().stack, functions and lines from the module's own
// name section and DWARF) imported from the runner, module
// "yukibana:sanitizer" (src/sanitizer.js, which documents each import).
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define IMPORT(name) __attribute__((import_module("yukibana:sanitizer"), import_name(#name)))

IMPORT(return_address) uintptr_t js_return_address(int level);
IMPORT(stack_snapshot) uintptr_t js_stack_snapshot(void);
IMPORT(stack_unwind) uint32_t js_stack_unwind(uintptr_t pc, uintptr_t *buffer, uint32_t depth);
IMPORT(pc_frames) int js_pc_frames(uintptr_t pc);
IMPORT(pc_function) uint32_t js_pc_function(uintptr_t pc, int frame, char *buffer, uint32_t size);
IMPORT(pc_file) uint32_t js_pc_file(uintptr_t pc, int frame, char *buffer, uint32_t size);
IMPORT(pc_line) int js_pc_line(uintptr_t pc, int frame);
IMPORT(pc_column) int js_pc_column(uintptr_t pc, int frame);

// wasm-ld's bounds of the stack: it grows down from __stack_high.
extern unsigned char __stack_low;
extern unsigned char __stack_high;

uintptr_t emscripten_stack_get_base(void) { return (uintptr_t)&__stack_high; }
uintptr_t emscripten_stack_get_end(void) { return (uintptr_t)&__stack_low; }
size_t emscripten_get_heap_size(void) { return __builtin_wasm_memory_size(0) * 65536; }

void *emscripten_return_address(int level) { return (void *)js_return_address(level); }
uintptr_t emscripten_stack_snapshot(void) { return js_stack_snapshot(); }
uint32_t emscripten_stack_unwind_buffer(uintptr_t pc, uintptr_t *buffer, uint32_t depth) {
  return js_stack_unwind(pc, buffer, depth);
}

// The symbolizer's questions (the patched sanitizer_symbolizer_emscripten.cpp):
// frame 0 is the innermost function at pc, the last the one that holds the
// code; the strings stay valid until the next call.
static char function_name[1024];
static char file_name[1024];

// libc++abi's demangler, in a C++ program (a C program has no mangled
// names): with -g, DWARF names an inlined function by its linkage name,
// which llvm-symbolizer prints demangled. The name section's names are
// demangled already (wasm-ld writes them so).
char *__cxa_demangle(const char *name, char *buffer, size_t *length, int *status) __attribute__((weak));

int _wasi_pc_frames(uintptr_t pc) { return js_pc_frames(pc); }
const char *_wasi_pc_function(uintptr_t pc, int frame) {
  if (!js_pc_function(pc, frame, function_name, sizeof function_name)) return NULL;
  if (__cxa_demangle && strncmp(function_name, "_Z", 2) == 0) {
    char *plain = __cxa_demangle(function_name, NULL, NULL, NULL);
    if (plain) {
      strncpy(function_name, plain, sizeof function_name - 1);
      function_name[sizeof function_name - 1] = 0;
      free(plain);
    }
  }
  return function_name;
}
const char *_wasi_pc_file(uintptr_t pc, int frame) {
  return js_pc_file(pc, frame, file_name, sizeof file_name) ? file_name : NULL;
}
int _wasi_pc_line(uintptr_t pc, int frame) { return js_pc_line(pc, frame); }
int _wasi_pc_column(uintptr_t pc, int frame) { return js_pc_column(pc, frame); }

// What a frame without a line names as its module: the runner's file name
// for the linked program.
void _emscripten_get_progname(char *buffer, int size) {
  strncpy(buffer, "program.wasm", size);
  if (size > 0) buffer[size - 1] = 0;
}

// ASAN_OPTIONS, UBSAN_OPTIONS, LSAN_OPTIONS: from the environment, as on
// Linux (Emscripten reads them from Module).
char *_emscripten_sanitizer_get_option(const char *name) {
  const char *value = getenv(name);
  return strdup(value ? value : "");
}

bool _emscripten_sanitizer_use_colors(void) { return isatty(2); }

// One thread: nothing ever waits on a futex.
int emscripten_futex_wait(volatile void *addr, uint32_t val, double ms) { return 0; }
int emscripten_futex_wake(volatile void *addr, int count) { return 0; }

// The code a function pointer points to: on WebAssembly a function's
// address is its index in the indirect function table (the patched
// asan_descriptions.cpp, which names a stack variable's frame by it).
IMPORT(function_pc) uintptr_t js_function_pc(uintptr_t pointer);
uintptr_t _wasi_function_pc(uintptr_t pointer) { return js_function_pc(pointer); }
