// test-proxying.mjs: a thread (main, under -sPROXY_TO_PTHREAD) proxies calls
// synchronously to the main runtime thread, as clangd's threads proxy every
// file system call to server.js, and reuses its stack right after each one
// returns, as any caller does. The test builds this against Emscripten's
// proxying.c with delays where the race is; argv[1] is the number of calls.
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static void bump(void *arg) { ++*(volatile int *)arg; }

// Fills the stack the proxied call's context was on with words that are
// alternately 0 and odd, and keeps it so while the other thread may still be
// finishing the call: what a stale context then holds is not a pointer.
__attribute__((noinline)) static void reuse_stack(void) {
  volatile uint32_t words[1024];
  for (int i = 0; i < 1024; i++) words[i] = (i & 1) ? 0x1001 : 0;
  double until = emscripten_get_now() + 60;
  while (emscripten_get_now() < until) {}
}

int main(int argc, char **argv) {
  long calls = argc > 1 ? atol(argv[1]) : 10;
  em_proxying_queue *q = emscripten_proxy_get_system_queue();
  pthread_t target = emscripten_main_runtime_thread_id();
  volatile int n = 0;
  for (long i = 0; i < calls; i++) {
    if (!emscripten_proxy_sync(q, target, bump, (void *)&n)) return 2;
    reuse_stack();
  }
  printf("%d calls done\n", n);
  return n == calls ? 0 : 1;
}
