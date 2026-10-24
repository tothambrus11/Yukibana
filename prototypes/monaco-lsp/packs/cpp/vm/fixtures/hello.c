// test-vm.mjs: says where it runs and what it was given, then exits 0.
#include <stdio.h>
#include <stdlib.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(int argc, char **argv) {
  struct utsname u;
  if (uname(&u) != 0) return 1;
  const char *home = getenv("HOME");
  printf("hello from %s %s, argv[0]=%s, isatty(0)=%d isatty(1)=%d isatty(2)=%d, HOME=%s, argc=%d", u.machine,
         u.release, argv[0], isatty(0), isatty(1), isatty(2), home ? home : "(none)", argc);
  for (int i = 1; i < argc; i++) printf(" [%s]", argv[i]);
  printf("\n");
  return 0;
}
