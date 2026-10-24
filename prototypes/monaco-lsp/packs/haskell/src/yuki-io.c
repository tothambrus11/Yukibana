/* Linked into yuki.wasm (build.sh). MicroHs writes stdout through C's stdio,
 * and with Emscripten's file system behind it (not a terminal) that is fully
 * buffered: a program's lines would reach the terminal in 1 KB lumps, or at
 * its end. Line buffering is what a terminal gives: each line as it is
 * printed. A prompt without a newline is flushed by the runner, which calls
 * fflush before it waits for input (runner.js). */
#include <stdio.h>

__attribute__((constructor)) static void yuki_line_buffered(void) {
    setvbuf(stdout, NULL, _IOLBF, BUFSIZ);
}
