// MinaCalc's math calls, resolved as emscripten's libc++ resolves them for
// the site's wasm builds and computed by the same musl code, so the results
// don't depend on the C++ library or the platform's libm. The sources call
// these as mcm::pow and so on (the `dan-calc` changes listed in README.md).
#pragma once

#include <cmath>
#include <cstdlib>
#include <type_traits>

#include "musl/musl.h"

namespace mcm {

template <class T>
concept integral = std::is_integral_v<T>;
template <class T>
concept arithmetic = std::is_arithmetic_v<T>;

inline float pow(float x, float y) { return musl::powf(x, y); }
inline double pow(double x, double y) { return musl::pow(x, y); }
// any other mix is computed in double, as libc++ promotes it
template <arithmetic A, arithmetic B>
	requires(!(std::is_same_v<A, float> && std::is_same_v<B, float>))
inline double pow(A x, B y) { return musl::pow(static_cast<double>(x), static_cast<double>(y)); }
inline float powf(float x, float y) { return musl::powf(x, y); }

inline float log(float x) { return musl::logf(x); }
inline double log(double x) { return musl::log(x); }
template <integral T> inline double log(T x) { return musl::log(static_cast<double>(x)); }

// no float versions: MinaCalc only calls these with integers or doubles
float log2(float) = delete;
inline double log2(double x) { return musl::log2(x); }
template <integral T> inline double log2(T x) { return musl::log2(static_cast<double>(x)); }
float exp2(float) = delete;
inline double exp2(double x) { return musl::exp2(x); }
template <integral T> inline double exp2(T x) { return musl::exp2(static_cast<double>(x)); }

inline float erf(float x) { return musl::erff(x); }
inline double erf(double x) { return musl::erf(x); }
inline float erfc(float x) { return musl::erfcf(x); }
inline double erfc(double x) { return musl::erfc(x); }

// libc++'s abs(float) is fabsf, where libstdc++'s can be the int abs
inline float abs(float x) { return std::fabs(x); }
inline double abs(double x) { return std::fabs(x); }
inline int abs(int x) { return std::abs(x); }

}
