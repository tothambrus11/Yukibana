// SPDX-License-Identifier: MIT
/*
 * Unit tests of init-args.h, built natively (build-init.sh):
 *   clang-18 -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Wpedantic -Werror \
 *     -fsanitize=address,undefined test-init.c
 * Exit status 0 when every check passed; each failure prints its line.
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "init-args.h"

static int failures;

/* Counts and reports one failed check; a function, so each CHECK adds no branches. */
static void check(int ok, int line, const char *what)
{
	if (!ok) {
		fprintf(stderr, "%s:%d: CHECK(%s)\n", __FILE__, line, what);
		failures++;
	}
}

#define CHECK(cond) check((cond) ? 1 : 0, __LINE__, #cond)

/* A string check that also fails, instead of crashing, on a NULL that should be a string. */
static void check_str(const char *got, const char *want, int line)
{
	check(got != NULL && strcmp(got, want) == 0, line, want);
}

#define CHECK_STR(a, b) check_str((a), (b), __LINE__)

/* The status a real child leaves: forks, lets the child call `how`, and waits. */
static int status_of(void (*how)(void))
{
	pid_t pid = fork();
	if (pid == 0) {
		how();
		_exit(99);
	}
	int status = -1;
	if (waitpid(pid, &status, 0) != pid)
		return -1;
	return status;
}

static void exit_0(void) { _exit(0); }
static void exit_3(void) { _exit(3); }
static void exit_255(void) { _exit(255); }
static void segv(void)
{
	signal(SIGSEGV, SIG_DFL);
	raise(SIGSEGV);
}
static void abrt(void)
{
	signal(SIGABRT, SIG_DFL);
	raise(SIGABRT);
}

static void test_split(void)
{
	char *out[4] = {0};
	char a[] = "main\0two words\0\0";
	CHECK(yk_split(a, sizeof a - 1, out, 0, 4) == 3);
	CHECK_STR(out[0], "main");
	CHECK_STR(out[1], "two words");
	CHECK_STR(out[2], "");

	char *none[1] = {0};
	CHECK(yk_split(a, 0, none, 0, 1) == 0); /* an empty file is no strings */
	CHECK(none[0] == 0);

	char b[] = "x\0y";
	CHECK(yk_split(b, sizeof b - 1, out, 0, 4) == YK_ERR_NO_NUL); /* "y" lacks its NUL */

	char c[] = "1\0002\0003\0004\0005\0";
	CHECK(yk_split(c, sizeof c - 1, out, 0, 4) == YK_ERR_TOO_MANY);
	CHECK(yk_split(c, sizeof c - 1, out, 1, 4) == YK_ERR_TOO_MANY); /* counted from at */

	char d[] = "z\0";
	out[0] = (char *)"kept";
	CHECK(yk_split(d, sizeof d - 1, out, 1, 4) == 2);
	CHECK_STR(out[0], "kept");
	CHECK_STR(out[1], "z");
}

static void test_child_argv(void)
{
	char *argv[] = {(char *)"main", (char *)"a b", (char *)""};
	char *out[16] = {0};
	CHECK(yk_child_argv(out, 16, argv, 3, "/yk/prog", 0, 0, 0, "/dev/hvc2") == 3);
	CHECK_STR(out[0], "main");
	CHECK_STR(out[1], "a b");
	CHECK_STR(out[2], "");
	CHECK(out[3] == 0);

	char *opts[] = {(char *)"-f"};
	int n = yk_child_argv(out, 16, argv, 3, "/yk/prog", "/bin/strace", opts, 1, "/dev/hvc2");
	const char *want[] = {"/bin/strace", "-f", "-o", "/dev/hvc2", "--argv0", "main", "--", "/yk/prog", "a b", ""};
	CHECK(n == 10);
	for (int i = 0; i < 10 && i < n; i++)
		CHECK_STR(out[i], want[i]);
	CHECK(out[n] == 0);

	/* exactly full (n + 1 == cap) fits; one less does not */
	CHECK(yk_child_argv(out, 4, argv, 3, "/yk/prog", 0, 0, 0, "") == 3);
	CHECK(yk_child_argv(out, 3, argv, 3, "/yk/prog", 0, 0, 0, "") == YK_ERR_TOO_MANY);
	CHECK(yk_child_argv(out, 11, argv, 3, "/yk/prog", "/bin/strace", opts, 1, "") == 10);
	CHECK(yk_child_argv(out, 10, argv, 3, "/yk/prog", "/bin/strace", opts, 1, "") == YK_ERR_TOO_MANY);
	CHECK(yk_child_argv(out, 16, argv, 0, "/yk/prog", 0, 0, 0, "") == YK_ERR_TOO_MANY); /* no argv[0] */
}

static void test_decimal(void)
{
	char buf[12];
	CHECK_STR(yk_decimal(0, buf), "0");
	CHECK_STR(yk_decimal(7, buf), "7");
	CHECK_STR(yk_decimal(139, buf), "139");
	CHECK_STR(yk_decimal(-2, buf), "-2");
	CHECK_STR(yk_decimal(2147483647, buf), "2147483647");
	CHECK_STR(yk_decimal(-2147483647 - 1, buf), "-2147483648");
}

static void test_first_field(void)
{
	char a[] = "2.53 1.10\n";
	CHECK_STR(yk_first_field(a), "2.53");
	char b[] = "12.00\n";
	CHECK_STR(yk_first_field(b), "12.00");
	char c[] = "";
	CHECK_STR(yk_first_field(c), "");
}

static void test_status_line(void)
{
	char line[24];
	/* Real statuses from real children, not hand-made numbers. */
	CHECK_STR(yk_status_line(status_of(exit_0), line), "exit 0\n");
	CHECK_STR(yk_status_line(status_of(exit_3), line), "exit 3\n");
	CHECK_STR(yk_status_line(status_of(exit_255), line), "exit 255\n");
	CHECK_STR(yk_status_line(status_of(segv), line), "signal 11\n");
	CHECK_STR(yk_status_line(status_of(abrt), line), "signal 6\n");
	/* The bug the exited-first order avoids: 0 is an exit, not "signal 0". */
	CHECK_STR(yk_status_line(0, line), "exit 0\n");
	/* A core-dump flag (0x80) does not change the signal. */
	CHECK_STR(yk_status_line(0x80 | 11, line), "signal 11\n");
}

int main(void)
{
	test_split();
	test_child_argv();
	test_decimal();
	test_first_field();
	test_status_line();
	if (failures)
		fprintf(stderr, "%d check(s) failed\n", failures);
	else
		printf("init-args.h: all checks passed\n");
	return failures ? 1 : 0;
}
