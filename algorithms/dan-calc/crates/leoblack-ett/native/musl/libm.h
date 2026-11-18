// dan-calc: the parts of musl's src/internal/libm.h these files use, for any
// compiler. The files are compiled as C++ in namespace `musl` (see build.rs).
#pragma once

#include <cstdint>
#include <cstring>
#include <cmath>
#include <math.h>

#include "features.h"

// as in the wasm builds, which have neither
#undef __FP_FAST_FMA
#define TOINT_INTRINSICS 0

#define WANT_ROUNDING 1
#define issignalingf_inline(x) 0
#define issignaling_inline(x) 0

#if defined(__GNUC__) || defined(__clang__)
#define predict_true(x) __builtin_expect(!!(x), 1)
#define predict_false(x) __builtin_expect(x, 0)
#else
#define predict_true(x) (x)
#define predict_false(x) (x)
#endif

static inline float eval_as_float(float x) { float y = x; return y; }
static inline double eval_as_double(double x) { double y = x; return y; }
static inline float fp_barrierf(float x) { volatile float y = x; return y; }
static inline double fp_barrier(double x) { volatile double y = x; return y; }
static inline void fp_force_evalf(float x) { volatile float y; y = x; (void)y; }
static inline void fp_force_eval(double x) { volatile double y; y = x; (void)y; }

static inline std::uint32_t asuint(float f) { std::uint32_t i; std::memcpy(&i, &f, 4); return i; }
static inline float asfloat(std::uint32_t i) { float f; std::memcpy(&f, &i, 4); return f; }
static inline std::uint64_t asuint64(double f) { std::uint64_t i; std::memcpy(&i, &f, 8); return i; }
static inline double asdouble(std::uint64_t i) { double f; std::memcpy(&f, &i, 8); return f; }

#define EXTRACT_WORDS(hi, lo, d) do { std::uint64_t __u = asuint64(d); (hi) = __u >> 32; (lo) = (std::uint32_t)__u; } while (0)
#define GET_HIGH_WORD(hi, d) do { (hi) = asuint64(d) >> 32; } while (0)
#define GET_LOW_WORD(lo, d) do { (lo) = (std::uint32_t)asuint64(d); } while (0)
#define INSERT_WORDS(d, hi, lo) do { (d) = asdouble(((std::uint64_t)(hi) << 32) | (std::uint32_t)(lo)); } while (0)
#define SET_HIGH_WORD(d, hi) INSERT_WORDS(d, hi, (std::uint32_t)asuint64(d))
#define SET_LOW_WORD(d, lo) INSERT_WORDS(d, asuint64(d) >> 32, lo)
#define GET_FLOAT_WORD(w, d) do { (w) = asuint(d); } while (0)
#define SET_FLOAT_WORD(d, w) do { (d) = asfloat(w); } while (0)

float __math_oflowf(std::uint32_t);
float __math_uflowf(std::uint32_t);
float __math_xflowf(std::uint32_t, float);
float __math_invalidf(float);
float __math_divzerof(std::uint32_t);
double __math_oflow(std::uint32_t);
double __math_uflow(std::uint32_t);
double __math_xflow(std::uint32_t, double);
double __math_invalid(double);
double __math_divzero(std::uint32_t);

double exp(double);
float expf(float);
