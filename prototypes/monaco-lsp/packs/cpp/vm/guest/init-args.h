/* SPDX-License-Identifier: MIT */
/*
 * The parsing and formatting yk-init (init.c) does, as pure functions over
 * caller-owned buffers, so that test-init.c can check them natively with
 * AddressSanitizer and UndefinedBehaviorSanitizer.
 *
 * This header includes nothing: the includer provides size_t and strlen()
 * (init.c through the kernel's nolibc, test-init.c through <string.h>).
 */
#ifndef YK_INIT_ARGS_H
#define YK_INIT_ARGS_H

/** Errors of yk_split() and yk_child_argv(); every other result is >= 0. */
enum yk_error {
	YK_ERR_NO_NUL = -1,   /* the last string has no terminating NUL */
	YK_ERR_TOO_MANY = -2, /* more strings than the output array holds */
};

/*
 * Appends the NUL-terminated strings in buf[0..len) to out[at..cap), pointing
 * into buf (nothing is copied), and returns the new count. An empty buffer
 * adds nothing; "\0" is one empty string. Returns YK_ERR_NO_NUL if the last
 * string lacks its NUL, YK_ERR_TOO_MANY if they do not fit; out[at..cap) may
 * then be partly written. Requires 0 <= at <= cap.
 */
static inline int yk_split(char *buf, size_t len, char **out, int at, int cap)
{
	if (len > 0 && buf[len - 1] != '\0')
		return YK_ERR_NO_NUL;
	for (size_t i = 0; i < len;) {
		if (at >= cap)
			return YK_ERR_TOO_MANY;
		out[at++] = buf + i;
		i += strlen(buf + i) + 1;
	}
	return at;
}

/*
 * The argv init executes, in out[0..n) with out[n] = NULL; returns n, or
 * YK_ERR_TOO_MANY if n + 1 > cap. `prog_argv` (nargv >= 1) is the program's
 * argv as /yk/argv holds it; argv[0] need not name a file, the program is
 * always `prog_path`. With `strace_path` NULL that is the whole command, and
 * the caller executes prog_path with it. Otherwise the command is
 *   strace_path <strace_opts...> -o <trace_out> --argv0 <argv[0]> -- prog_path <argv[1..]>
 * and the caller executes strace_path: strace then runs the program with the
 * same argv[0] it would have had without tracing.
 */
static inline int yk_child_argv(char **out, int cap, char *const *prog_argv, int nargv, const char *prog_path,
				const char *strace_path, char *const *strace_opts, int nopts, const char *trace_out)
{
	int n = 0;
	int need = nargv + 1 + (strace_path ? nopts + 6 : 0);
	if (nargv < 1 || need > cap)
		return YK_ERR_TOO_MANY;
	if (strace_path) {
		out[n++] = (char *)strace_path;
		for (int i = 0; i < nopts; i++)
			out[n++] = strace_opts[i];
		out[n++] = (char *)"-o";
		out[n++] = (char *)trace_out;
		out[n++] = (char *)"--argv0";
		out[n++] = prog_argv[0];
		out[n++] = (char *)"--";
		out[n++] = (char *)prog_path;
	} else {
		out[n++] = prog_argv[0];
	}
	for (int i = 1; i < nargv; i++)
		out[n++] = prog_argv[i];
	out[n] = 0;
	return n;
}

/* Formats v in decimal into buf (12 bytes hold any int) and returns buf. */
static inline char *yk_decimal(int v, char buf[12])
{
	char tmp[12];
	unsigned int u = v < 0 ? 0U - (unsigned int)v : (unsigned int)v;
	int i = 0;
	int j = 0;
	do {
		tmp[i++] = (char)('0' + u % 10U);
		u /= 10U;
	} while (u != 0U);
	if (v < 0)
		buf[j++] = '-';
	while (i > 0)
		buf[j++] = tmp[--i];
	buf[j] = '\0';
	return buf;
}

/* Cuts s at its first space or newline: the first field of /proc/uptime. Returns s. */
static inline char *yk_first_field(char *s)
{
	for (char *c = s; *c != '\0'; c++) {
		if (*c == ' ' || *c == '\n') {
			*c = '\0';
			break;
		}
	}
	return s;
}

/*
 * The control line for a wait status, "exit N\n" or "signal N\n", into out
 * (24 bytes are enough); returns out. Decoded by hand from Linux's status
 * layout (low 7 bits: the terminating signal, 0 if the process exited; bits
 * 8-15: the exit status) and tested exited-first: Linux 6.12's nolibc defines
 * WIFSIGNALED(s) as ((s) - 1 < 0xff), which is true for status 0, so a program
 * that exited with 0 looked killed by "signal 0". Without WUNTRACED a status
 * is either exited or signalled, never stopped.
 */
static inline char *yk_status_line(int status, char out[24])
{
	char num[12];
	const char *kind;
	int value;
	if ((status & 0x7f) == 0) {
		kind = "exit ";
		value = (status >> 8) & 0xff;
	} else {
		kind = "signal ";
		value = status & 0x7f;
	}
	size_t k = strlen(kind);
	yk_decimal(value, num);
	size_t d = strlen(num);
	for (size_t i = 0; i < k; i++)
		out[i] = kind[i];
	for (size_t i = 0; i < d; i++)
		out[k + i] = num[i];
	out[k + d] = '\n';
	out[k + d + 1] = '\0';
	return out;
}

#endif
