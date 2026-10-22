/* Differential ALU test: prints one checksum per category. Run natively (or under
 * qemu-user) and under the emulator under test; any difference is a translation bug.
 * Loops many times so every block is hot enough to be JIT-compiled. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static uint64_t st = 0x9e3779b97f4a7c15ull;
static inline uint64_t rnd(void) { st ^= st << 13; st ^= st >> 7; st ^= st << 17; return st; }
static uint64_t sum[16];
static inline void mix(int k, uint64_t v) { sum[k] = (sum[k] ^ v) * 0x100000001b3ull + (v >> 29); }
struct bf { uint32_t a:3, b:7, c:13, d:9; };
struct bfs { int32_t a:5, b:11, c:16; };
__attribute__((noinline)) static void step(uint64_t x, uint64_t y) {
  uint32_t a = x, b = y; int32_t sa = a, sb = b;
  uint32_t r32; uint64_t r64; int32_t s32; int64_t s64;
  /* 0: 32-bit carry/borrow/overflow */
  mix(0, __builtin_add_overflow(a, b, &r32)); mix(0, r32);
  mix(0, __builtin_sub_overflow(a, b, &r32)); mix(0, r32);
  mix(0, __builtin_add_overflow(sa, sb, &s32)); mix(0, (uint32_t)s32);
  mix(0, __builtin_sub_overflow(sa, sb, &s32)); mix(0, (uint32_t)s32);
  mix(0, a + b < a); mix(0, a - b > a); mix(0, (uint32_t)(a - 0x3a) + 10u < 10u);
  /* 1: 64-bit carry/borrow/overflow */
  mix(1, __builtin_add_overflow(x, y, &r64)); mix(1, r64);
  mix(1, __builtin_sub_overflow(x, y, &r64)); mix(1, r64);
  mix(1, __builtin_add_overflow((int64_t)x, (int64_t)y, &s64)); mix(1, (uint64_t)s64);
  mix(1, __builtin_sub_overflow((int64_t)x, (int64_t)y, &s64)); mix(1, (uint64_t)s64);
  /* 2: 128-bit arithmetic (add/sub with carry chains, mul high) */
  unsigned __int128 p = (unsigned __int128)x * y; mix(2, (uint64_t)(p >> 64)); mix(2, (uint64_t)p);
  __int128 q = (__int128)(int64_t)x * (int64_t)y; mix(2, (uint64_t)(q >> 64));
  unsigned __int128 u = ((unsigned __int128)x << 64 | y) + ((unsigned __int128)y << 64 | x); mix(2, (uint64_t)(u >> 64)); mix(2, (uint64_t)u);
  unsigned __int128 v = ((unsigned __int128)x << 64 | y) - ((unsigned __int128)y << 64 | x); mix(2, (uint64_t)(v >> 64)); mix(2, (uint64_t)v);
  mix(2, (uint64_t)a * b); mix(2, (uint64_t)((int64_t)sa * sb));
  mix(2, __builtin_mul_overflow(a, b, &r32)); mix(2, r32); mix(2, __builtin_mul_overflow(sa, sb, &s32)); mix(2, (uint32_t)s32);
  /* 3: bit counts */
  mix(3, a ? __builtin_clz(a) : 99); mix(3, a ? __builtin_ctz(a) : 99); mix(3, x ? __builtin_clzll(x) : 99); mix(3, x ? __builtin_ctzll(x) : 99);
  mix(3, __builtin_popcount(a)); mix(3, __builtin_popcountll(x)); mix(3, __builtin_clrsb(sa)); mix(3, __builtin_clrsbll((int64_t)x));
  /* 4: bitfields (extract/sextract/deposit) */
  struct bf f; memcpy(&f, &a, 4); mix(4, f.a); mix(4, f.b); mix(4, f.c); mix(4, f.d);
  f.b = b; f.d = b >> 3; memcpy(&r32, &f, 4); mix(4, r32);
  struct bfs g; memcpy(&g, &b, 4); mix(4, (uint32_t)g.a); mix(4, (uint32_t)g.b); mix(4, (uint32_t)g.c);
  _Float16 h = (_Float16)(float)sa; uint16_t hb; memcpy(&hb, &h, 2); mix(4, hb); /* FCVT reads FPCR.AHP with extract_i32 */
  mix(4, (x >> 13) & 0x7ff); mix(4, (uint64_t)((int64_t)(x << 7) >> 40)); mix(4, (a >> 5) & 0x3f); mix(4, (uint32_t)((sa << 3) >> 20));
  /* 5: shifts and rotates */
  unsigned n = b & 31, m = y & 63;
  mix(5, a << n); mix(5, a >> n); mix(5, (uint32_t)(sa >> n)); mix(5, (a << n) | (a >> ((32 - n) & 31)));
  mix(5, x << m); mix(5, x >> m); mix(5, (uint64_t)((int64_t)x >> m)); mix(5, (x >> m) | (x << ((64 - m) & 63)));
  /* 6: division */
  if (b) { mix(6, a / b); mix(6, a % b); } if (sb && !(sa == INT32_MIN && sb == -1)) { mix(6, (uint32_t)(sa / sb)); mix(6, (uint32_t)(sa % sb)); }
  if (y) { mix(6, x / y); mix(6, x % y); } if (y && !((int64_t)x == INT64_MIN && (int64_t)y == -1)) { mix(6, (uint64_t)((int64_t)x / (int64_t)y)); }
  /* 7: compares and selects, signed/unsigned, 32/64 */
  mix(7, a < b); mix(7, sa < sb); mix(7, a <= b); mix(7, sa >= sb); mix(7, x < y); mix(7, (int64_t)x < (int64_t)y);
  mix(7, sa > sb ? a : b); mix(7, (int64_t)x > (int64_t)y ? x : y); mix(7, (a & 4) ? x : y); mix(7, a == b); mix(7, (x & 0xff) == 0x31);
  mix(7, (unsigned)(a & 0xff) - '0' < 10u);
  /* 8: byte swaps, extensions, logic */
  mix(8, __builtin_bswap16((uint16_t)a)); mix(8, __builtin_bswap32(a)); mix(8, __builtin_bswap64(x));
  mix(8, (uint64_t)(int8_t)a); mix(8, (uint64_t)(int16_t)a); mix(8, (uint64_t)(int32_t)x); mix(8, (uint64_t)(uint32_t)x);
  mix(8, a & ~b); mix(8, a | ~b); mix(8, ~(a ^ b)); mix(8, ~(a & b)); mix(8, ~(a | b)); mix(8, x & ~y); mix(8, -x); mix(8, (uint32_t)-sa);
}
int main(int argc, char **argv) {
  long iters = argc > 1 ? atol(argv[1]) : 20000;
#ifdef __aarch64__
  /* FPSR.NZCV shares the FPSCR word with FPCR.AHP: a sloppy extract of AHP sees them */
  __asm__ volatile("msr fpsr, %0" :: "r"(0xf0000000ull));
#endif
  /* edge values first, then random */
  static const uint64_t e[] = {0, 1, 2, 9, 10, 0x30, 0x31, 0x39, 0x3a, 0x7f, 0x80, 0xff, 0x7fffffff, 0x80000000, 0xfffffff7, 0xffffffff,
    0x100000000ull, 0x7fffffffffffffffull, 0x8000000000000000ull, 0xffffffffffffffffull, 0xffffffff00000000ull, 0x00000000fffffff6ull};
  for (int rep = 0; rep < 50; rep++) for (unsigned i = 0; i < sizeof e / 8; i++) for (unsigned j = 0; j < sizeof e / 8; j++) step(e[i], e[j]);
  for (long i = 0; i < iters; i++) { uint64_t x = rnd(), y = rnd(); if (i & 1) y &= 0xffffffff; if (i & 2) x |= 0xffffffff00000000ull; step(x, y); }
  for (int k = 0; k < 9; k++) printf("cat%d %016llx\n", k, (unsigned long long)sum[k]);
  return 0;
}
