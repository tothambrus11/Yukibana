/**
 * Starter programs for the page, one per kind of system call an OS course
 * opens with. `expect` is what test/smoke.mjs checks after running the
 * x86-64 build: the exit status, strings the output contains, and system
 * calls (by name and opening parenthesis) the trace contains. `threads`
 * marks a sample that only runs where guest threads can (THREADS in
 * toolchain.js).
 */
export const SAMPLES = [
    {
        name: 'write(2) and exit',
        source: `#include <string.h>
#include <unistd.h>

int main(void) {
    const char *msg = "hello from a Linux process in your browser\\n";
    /* No stdio: this is one write system call, file descriptor 1. */
    ssize_t n = write(STDOUT_FILENO, msg, strlen(msg));
    return n < 0 ? 1 : 0;
}
`,
        expect: { exit: 0, output: ['hello from a Linux process'], trace: ['write(1,', 'exit_group(0)'] },
    },
    {
        name: 'raw syscall, no libc',
        source: `/* The system call ABI by hand: number in a register, arguments in
 * registers, one trap instruction. Compare with the disassembly. */
#include <stddef.h>

static long sys3(long nr, long a, long b, long c) {
    long ret;
#if defined(__x86_64__)
    __asm__ volatile ("syscall"
                      : "=a"(ret)
                      : "a"(nr), "D"(a), "S"(b), "d"(c)
                      : "rcx", "r11", "memory");
#elif defined(__aarch64__)
    register long x8 __asm__("x8") = nr;
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    __asm__ volatile ("svc #0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2) : "memory");
    ret = x0;
#endif
    return ret;
}

#if defined(__x86_64__)
enum { SYS_write = 1, SYS_getpid = 39 };
#else
enum { SYS_write = 64, SYS_getpid = 172 };
#endif

int main(void) {
    static const char msg[] = "written by a hand-made syscall\\n";
    sys3(SYS_write, 1, (long)msg, sizeof msg - 1);
    long pid = sys3(SYS_getpid, 0, 0, 0);
    return pid > 0 ? 0 : 1;
}
`,
        expect: { exit: 0, output: ['hand-made syscall'], trace: ['write(1,', 'getpid()'] },
    },
    {
        name: 'files: open, write, lseek, read',
        source: `#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    int fd = open("notes.txt", O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }

    const char *text = "file descriptors are just small integers\\n";
    write(fd, text, strlen(text));

    lseek(fd, 0, SEEK_SET);
    char buf[128] = {0};
    ssize_t n = read(fd, buf, sizeof buf - 1);
    printf("fd %d, read back %zd bytes: %s", fd, n, buf);
    close(fd);
    return 0;
}
`,
        expect: { exit: 0, output: ['read back 41 bytes'], trace: ['open(', 'lseek(', 'read('] },
    },
    {
        name: 'memory: brk and mmap',
        source: `#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void) {
    /* The program break: where the heap ends. */
    char *start = (char *)syscall(SYS_brk, 0);
    char *end = (char *)syscall(SYS_brk, start + 4096);
    printf("brk moved from %p to %p\\n", (void *)start, (void *)end);

    /* An anonymous mapping: memory straight from the kernel. */
    char *p = mmap(NULL, 1 << 16, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) { perror("mmap"); return 1; }
    strcpy(p, "hello, page");
    printf("mmap gave %p: %s\\n", (void *)p, p);
    munmap(p, 1 << 16);
    return 0;
}
`,
        expect: { exit: 0, output: ['brk moved', 'hello, page'], trace: ['brk(', 'mmap(', 'munmap('] },
    },
    {
        name: 'errors and errno',
        source: `#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    if (open("/does/not/exist", O_RDONLY) < 0)
        printf("open: errno %d (%s)\\n", errno, strerror(errno));
    if (write(42, "x", 1) < 0)
        printf("write: errno %d (%s)\\n", errno, strerror(errno));
    if (close(-1) < 0)
        perror("close");
    return 0;
}
`,
        expect: { exit: 0, output: ['No such file', 'Bad file descriptor'] },
    },
    {
        name: 'read(2) from stdin',
        stdin: 'the quick brown fox\njumps over the lazy dog\n',
        source: `#include <stdio.h>
#include <unistd.h>

int main(void) {
    char buf[256];
    long bytes = 0, lines = 0;
    ssize_t n;
    while ((n = read(STDIN_FILENO, buf, sizeof buf)) > 0) {
        bytes += n;
        for (ssize_t i = 0; i < n; i++) lines += buf[i] == '\\n';
    }
    printf("%ld bytes, %ld lines\\n", bytes, lines);
    return 0;
}
`,
        expect: { exit: 0, output: ['44 bytes, 2 lines'], trace: ['read(0,'] },
    },
    {
        name: 'process: ids, uname, time',
        source: `#include <stdio.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

int main(void) {
    struct utsname u;
    uname(&u);
    printf("%s %s on %s\\n", u.sysname, u.release, u.machine);
    printf("pid %d, parent %d, uid %d\\n", getpid(), getppid(), getuid());

    struct timespec t0, t1, nap = { 0, 20 * 1000 * 1000 };
    clock_gettime(CLOCK_MONOTONIC, &t0);
    nanosleep(&nap, NULL);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    long ms = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000;
    printf("slept about %ld ms\\n", ms);
    return 0;
}
`,
        expect: { exit: 0, output: ['Linux', 'pid '], trace: ['uname(', 'getppid()', 'nanosleep('] },
    },
    {
        name: 'pipe(2): a process talking to itself',
        source: `#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    int fds[2];
    if (pipe(fds) < 0) { perror("pipe"); return 1; }
    printf("read end %d, write end %d\\n", fds[0], fds[1]);

    const char *msg = "through the kernel and back";
    write(fds[1], msg, strlen(msg));
    close(fds[1]);

    char buf[64] = {0};
    ssize_t n = read(fds[0], buf, sizeof buf - 1);
    printf("got %zd bytes: %s\\n", n, buf);
    /* With the write end closed, the next read is end of file. */
    printf("then read returns %zd\\n", read(fds[0], buf, sizeof buf));
    return 0;
}
`,
        expect: { exit: 0, output: ['got 27 bytes', 'then read returns 0'], trace: ['pipe(', 'close('] },
    },
    {
        name: 'signals: sigaction and kill',
        source: `#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t got;

static void on_signal(int sig) { got = sig; }

int main(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGUSR1, &sa, NULL);

    kill(getpid(), SIGUSR1);
    printf("handler saw signal %d (%s)\\n", got, strsignal(got));
    /* A signal that kills the process skips stdio's buffers: flush now. */
    fflush(stdout);

    /* Nobody handles this one: the default action ends the process. */
    raise(SIGTERM);
    printf("not reached\\n");
    return 0;
}
`,
        expect: { exit: 128 + 15, output: ['handler saw signal 10'], trace: ['rt_sigaction(', 'kill('] },
    },
    {
        name: 'threads: pthread_create and a mutex',
        threads: true,
        source: `#include <pthread.h>
#include <stdio.h>

enum { THREADS = 4, ROUNDS = 10000 };
static long counter;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void *work(void *arg) {
    for (int i = 0; i < ROUNDS; i++) {
        pthread_mutex_lock(&lock);
        counter++;
        pthread_mutex_unlock(&lock);
    }
    return arg;
}

int main(void) {
    pthread_t t[THREADS];
    for (int i = 0; i < THREADS; i++) pthread_create(&t[i], NULL, work, NULL);
    for (int i = 0; i < THREADS; i++) pthread_join(t[i], NULL);
    printf("counter = %ld (expected %d)\\n", counter, THREADS * ROUNDS);
    return counter == THREADS * ROUNDS ? 0 : 1;
}
`,
        expect: { exit: 0, output: ['counter = 40000'], trace: ['clone('] },
    },
    {
        name: 'threads: a data race',
        threads: true,
        source: `/* The same counter without the mutex. The threads really run at the
 * same time, so increments get lost: run it a few times. */
#include <pthread.h>
#include <stdio.h>

enum { THREADS = 4, ROUNDS = 1000000 };
static volatile long counter;

static void *work(void *arg) {
    for (int i = 0; i < ROUNDS; i++) counter++;
    return arg;
}

int main(void) {
    pthread_t t[THREADS];
    for (int i = 0; i < THREADS; i++) pthread_create(&t[i], NULL, work, NULL);
    for (int i = 0; i < THREADS; i++) pthread_join(t[i], NULL);
    printf("counter = %ld, expected %d, lost %ld\\n",
           counter, THREADS * ROUNDS, THREADS * ROUNDS - counter);
    return 0;
}
`,
        expect: { exit: 0, output: ['expected 4000000'] },
    },
    {
        name: 'fork(2): not in the browser',
        source: `/* The browser gives one process and one thread, so fork() fails
 * here. Look for it in the system call trace. */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    pid_t pid = fork();
    if (pid < 0) {
        printf("fork failed: %s\\n", strerror(errno));
        return 0;
    }
    printf(pid == 0 ? "child\\n" : "parent\\n");
    return 0;
}
`,
        expect: { exit: 0, output: ['fork failed'], trace: ['fork() -> -ENOSYS'] },
    },
];
