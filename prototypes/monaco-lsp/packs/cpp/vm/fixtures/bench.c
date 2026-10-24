// CPU-bound: N iterations of an LCG-and-xor loop (default 1e8), split over T threads.
// Prints the result and the in-guest wall time (CLOCK_MONOTONIC).
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static uint64_t per_thread;
static void *work(void *arg) {
  uint64_t x = (uint64_t)(uintptr_t)arg + 1, acc = 0;
  for (uint64_t i = 0; i < per_thread; i++) {
    x = x * 6364136223846793005ull + 1442695040888963407ull;
    acc ^= x >> 33;
  }
  return (void *)(uintptr_t)acc;
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
  uint64_t n = argc > 1 ? strtoull(argv[1], 0, 10) : 100000000ull;
  int threads = argc > 2 ? atoi(argv[2]) : 1;
  if (threads < 1 || threads > 64) return 2;
  per_thread = n / (uint64_t)threads;
  pthread_t tid[64];
  double t0 = now();
  uint64_t acc = 0;
  for (int i = 0; i < threads; i++) pthread_create(&tid[i], 0, work, (void *)(uintptr_t)i);
  for (int i = 0; i < threads; i++) {
    void *r;
    pthread_join(tid[i], &r);
    acc ^= (uint64_t)(uintptr_t)r;
  }
  double dt = now() - t0;
  printf("bench n=%llu threads=%d acc=%016llx guest_s=%.3f Miter/s=%.1f\n", (unsigned long long)n, threads,
         (unsigned long long)acc, dt, (double)n / dt / 1e6);
  return 0;
}
