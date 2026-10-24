// SPDX-License-Identifier: MIT
/*
 * yk-init: PID 1 of the C/C++ pack's Linux VM (src/vm/system.js). It runs one
 * program, reports how it ended, and reboots, which QEMU (-no-reboot) would turn
 * into its own exit; the host does not wait for that (see system.js).
 *
 * The VM's channels, all virtio consoles, so the program never shares a stream
 * with the kernel's log (that goes to the serial port, ttyS0 / ttyAMA0):
 *   /dev/hvc0  the program's stdin and stdout (a tty, so isatty(0/1) is true)
 *   /dev/hvc1  the program's stderr (a tty too)
 *   /dev/hvc2  strace's output, when tracing
 *   /dev/hvc3  control, init to host only: "exec <uptime>\n" right before the
 *              program starts (the first field of /proc/uptime: how long the
 *              kernel took to get here), then exactly one of "exit <n>\n" or
 *              "signal <n>\n", after the program's output has drained.
 *              Nothing the program writes can reach this channel.
 *
 * What it runs comes from files in the initramfs, which the host appends as a
 * cpio archive of its own (no kernel command line quoting; src/vm/cpio.js):
 *   /yk/prog    the program, always executed by this path
 *   /yk/argv    its argv, each argument NUL-terminated, argv[0] first
 *   /yk/env     optional: its environment, "NAME=value" NUL-terminated;
 *               without it, DEFAULT_ENV below
 *   /yk/strace  optional: if present, strace's own options, NUL-terminated,
 *               and the program runs under /bin/strace -o /dev/hvc2
 *
 * If init cannot do its job it says why on the kernel console and reboots
 * without a control message, which the host reports as a VM failure.
 *
 * Built with the kernel's nolibc (tools/include/nolibc, build-init.sh), so it is
 * a few KB and needs no C library in the initramfs. The parsing is in
 * init-args.h, which test-init.c tests natively.
 */
#include <asm/termbits.h>
#include <linux/reboot.h>

#include "init-args.h"

enum { MAX_ARGS = 4096, MAX_ARGV_BYTES = 128 * 1024, MAX_ENV = 1024, MAX_ENV_BYTES = 64 * 1024, MAX_OPTS = 64 };

static char argv_bytes[MAX_ARGV_BYTES];
static char env_bytes[MAX_ENV_BYTES];
static char strace_bytes[4096];
static char *prog_argv[MAX_ARGS];
static char *child_argv[MAX_ARGS + MAX_OPTS + 8];
static char *child_env[MAX_ENV + 1];
static char *strace_opts[MAX_OPTS];

/* The environment without /yk/env; src/vm/run-linux.js's DEFAULT_ENV, which always sends one. */
static char *const DEFAULT_ENV[] = {"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/", "TERM=xterm-256color", "LANG=C.UTF-8", 0};

/* Writes a NUL-terminated string to fd, ignoring errors (there is nowhere to report them). */
static void put(int fd, const char *s)
{
	size_t n = strlen(s);
	while (n > 0) {
		ssize_t w = write(fd, s, n);
		if (w <= 0)
			return;
		s += w;
		n -= (size_t)w;
	}
}

/* Says why on the kernel console and ends the VM with no control message. */
static void fail(const char *what, const char *path)
{
	char num[12];
	put(2, "yk-init: ");
	put(2, what);
	put(2, " ");
	put(2, path);
	put(2, ": errno ");
	put(2, yk_decimal(errno, num));
	put(2, "\n");
	reboot(LINUX_REBOOT_CMD_RESTART);
	exit(1); /* only if reboot failed: init exiting panics, and panic=-1 reboots */
}

/*
 * Reads all of path into buf (capacity cap) and returns its length, or -1 if it
 * does not exist. A file that does not fit is an error, not a truncation.
 */
static ssize_t slurp(const char *path, char *buf, size_t cap)
{
	int fd = open(path, O_RDONLY, 0);
	if (fd < 0) {
		if (errno == ENOENT)
			return -1;
		fail("cannot open", path);
	}
	size_t len = 0;
	for (;;) {
		if (len == cap)
			fail("too large:", path);
		ssize_t r = read(fd, buf + len, cap - len);
		if (r < 0)
			fail("cannot read", path);
		if (r == 0)
			break;
		len += (size_t)r;
	}
	close(fd);
	return (ssize_t)len;
}

/* yk_split() into out[0..cap), or fail() naming path. */
static int split_or_fail(char *buf, ssize_t len, char **out, int cap, const char *path)
{
	int n = yk_split(buf, len > 0 ? (size_t)len : 0, out, 0, cap);
	if (n == YK_ERR_NO_NUL)
		fail("a string without its NUL in", path);
	if (n < 0)
		fail("too many strings in", path);
	return n;
}

/*
 * Opens a virtio console and makes it a byte pipe: no echo (the host shows what
 * the user typed itself) and no output processing ("\n" stays "\n"). Input stays
 * canonical, so the host sends whole lines and ^D (VEOF) is end of file.
 */
static int open_channel(const char *path, int flags)
{
	int fd = open(path, flags | O_NOCTTY, 0);
	if (fd < 0)
		fail("cannot open", path);
	struct termios t;
	if (ioctl(fd, TCGETS, &t) < 0)
		fail("not a tty:", path);
	t.c_lflag &= ~(tcflag_t)(ECHO | ECHOE | ECHOK | ECHONL | ECHOCTL | ECHOKE);
	t.c_oflag &= ~(tcflag_t)OPOST;
	if (ioctl(fd, TCSETS, &t) < 0)
		fail("cannot set termios on", path);
	return fd;
}

/* Waits until everything written to fd has left the guest (tcdrain). */
static void drain(int fd)
{
	(void)ioctl(fd, TCSBRK, (void *)1); /* a non-zero argument means drain, not break */
}

static void mount_or_fail(const char *src, const char *dir, const char *type)
{
	(void)mkdir(dir, 0755);
	if (mount(src, dir, type, 0, "") < 0 && errno != EBUSY)
		fail("cannot mount", dir);
}

/* The child: the program's session, its channels as fds 0-2, then exec. Never returns. */
static void start(int io, int err, int ctl, const char *path, char **env)
{
	(void)setsid();
	(void)ioctl(io, TIOCSCTTY, 0);
	(void)dup2(io, 0);
	(void)dup2(io, 1);
	(void)dup2(err, 2);
	if (io > 2)
		(void)close(io);
	if (err > 2)
		(void)close(err);
	(void)close(ctl);
	(void)chdir("/");
	(void)execve(path, child_argv, env);
	char num[12];
	put(2, "cannot run ");
	put(2, path);
	put(2, ": errno ");
	put(2, yk_decimal(errno, num));
	put(2, "\n");
	exit(127);
}

int main(void)
{
	mount_or_fail("devtmpfs", "/dev", "devtmpfs");
	mount_or_fail("proc", "/proc", "proc");
	mount_or_fail("sysfs", "/sys", "sysfs");
	mount_or_fail("tmpfs", "/tmp", "tmpfs");
	mount_or_fail("tmpfs", "/dev/shm", "tmpfs");

	int ctl = open_channel("/dev/hvc3", O_WRONLY);
	int io = open_channel("/dev/hvc0", O_RDWR);
	int err = open_channel("/dev/hvc1", O_WRONLY);

	int nargv = split_or_fail(argv_bytes, slurp("/yk/argv", argv_bytes, sizeof argv_bytes), prog_argv, MAX_ARGS, "/yk/argv");
	if (nargv < 1)
		fail("no program in", "/yk/argv");
	char **env = (char **)DEFAULT_ENV;
	ssize_t elen = slurp("/yk/env", env_bytes, sizeof env_bytes);
	if (elen >= 0) {
		int n = split_or_fail(env_bytes, elen, child_env, MAX_ENV, "/yk/env");
		child_env[n] = 0;
		env = child_env;
	}
	ssize_t slen = slurp("/yk/strace", strace_bytes, sizeof strace_bytes);
	int nopts = slen >= 0 ? split_or_fail(strace_bytes, slen, strace_opts, MAX_OPTS, "/yk/strace") : 0;
	const char *strace = slen >= 0 ? "/bin/strace" : 0;
	if (yk_child_argv(child_argv, (int)(sizeof child_argv / sizeof *child_argv), prog_argv, nargv, "/yk/prog", strace,
			  strace_opts, nopts, "/dev/hvc2") < 0)
		fail("too many arguments in", "/yk/argv");
	const char *path = strace ? strace : "/yk/prog";

	pid_t pid = fork();
	if (pid < 0)
		fail("cannot fork for", path);
	if (pid == 0)
		start(io, err, ctl, path, env);

	char up[32];
	ssize_t ulen = slurp("/proc/uptime", up, sizeof up - 1);
	up[ulen > 0 ? ulen : 0] = '\0';
	put(ctl, "exec ");
	put(ctl, yk_first_field(up));
	put(ctl, "\n");

	int status = 0;
	for (;;) {
		pid_t w = waitpid(-1, &status, 0);
		if (w == pid)
			break;
		if (w < 0 && errno != EINTR)
			fail("lost the program", path);
	}
	/* Whatever the program left behind (a daemon, a stopped child) ends with it. */
	(void)kill(-1, SIGKILL);
	while (waitpid(-1, 0, 0) > 0 || errno == EINTR)
		;
	drain(io);
	drain(err);

	char line[24];
	put(ctl, yk_status_line(status, line));
	drain(ctl);
	reboot(LINUX_REBOOT_CMD_RESTART);
	return 0;
}
