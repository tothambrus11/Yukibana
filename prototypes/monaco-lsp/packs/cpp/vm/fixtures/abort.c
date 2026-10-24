// test-vm.mjs: prints, then calls abort() (SIGABRT).
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  puts("about to abort");
  fflush(stdout);
  abort();
}
