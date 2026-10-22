#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <gnu/libc-version.h>
#include <time.h>
enum { N = 4, ITERS = 2000000 };
static long plain;            /* deliberately racy */
static atomic_long atomic;
static long locked; static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static int cpus_seen[64];
static void *work(void *arg) {
  (void)arg;
  for (long i = 0; i < ITERS; i++) {
    plain++;
    atomic_fetch_add_explicit(&atomic, 1, memory_order_relaxed);
    if ((i & 1023) == 0) { pthread_mutex_lock(&mu); locked++; pthread_mutex_unlock(&mu); int c = sched_getcpu(); if (c >= 0 && c < 64) __atomic_store_n(&cpus_seen[c], 1, __ATOMIC_RELAXED); }
  }
  return NULL;
}
int main(void) {
  struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
  printf("glibc %s, online CPUs %ld\n", gnu_get_libc_version(), sysconf(_SC_NPROCESSORS_ONLN));
  pthread_t t[N];
  for (int i = 0; i < N; i++) pthread_create(&t[i], NULL, work, NULL);
  for (int i = 0; i < N; i++) pthread_join(t[i], NULL);
  clock_gettime(CLOCK_MONOTONIC, &b);
  printf("plain=%ld (lost %ld updates to the race) atomic=%ld mutex=%ld\n", plain, (long)N*ITERS - plain, (long)atomic_load(&atomic), locked);
  printf("threads ran on CPUs:"); for (int i = 0; i < 64; i++) if (cpus_seen[i]) printf(" %d", i);
  printf("\nwall %.2f s\n", (b.tv_sec - a.tv_sec) + (b.tv_nsec - a.tv_nsec) / 1e9);
  return 0;
}
