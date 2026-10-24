// test-vm.mjs: a prompt without a newline, then every line of stdin until end of
// file, then a line on stderr; exits 3.
#include <stdio.h>

int main(void) {
  printf("name? ");
  fflush(stdout);
  char line[256];
  int n = 0;
  while (fgets(line, sizeof line, stdin)) {
    printf("got: %s", line);
    fflush(stdout);
    n++;
  }
  printf("eof after %d lines\n", n);
  fprintf(stderr, "this is stderr\n");
  return 3;
}
