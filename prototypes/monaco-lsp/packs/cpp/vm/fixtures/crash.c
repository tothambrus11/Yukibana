// test-vm.mjs: prints, then dereferences a null pointer (SIGSEGV under a kernel).
#include <stdio.h>

int main(void) {
  puts("about to crash");
  fflush(stdout);
  volatile int *p = 0;
  return *p;
}
