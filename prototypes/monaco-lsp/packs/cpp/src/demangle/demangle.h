// The demangler's interface (demangle.cpp): what demangle.wasm exports and
// what test-native.cpp checks.
#ifndef YK_DEMANGLE_H
#define YK_DEMANGLE_H

#ifdef __cplusplus
#include <string>
#include <string_view>

namespace yk {
/// Demangles each line of `input` (lines separated by '\n') on its own with
/// llvm::itaniumDemangle, as llvm::demangle would an Itanium (_Z...) name,
/// and returns them joined by '\n': as many lines as the
/// input has (an empty input gives an empty output), each one the demangled
/// name, or the line unchanged when it is not a mangled name.
std::string demangleLines(std::string_view input);
} // namespace yk

extern "C" {
#endif

/// The same over C strings, for JavaScript: `input` is UTF-8, NUL
/// terminated, newline-separated names. Returns a new NUL-terminated string
/// from malloc, which the caller frees with free(); null when `input` is
/// null or memory runs out.
char *yk_demangle_lines(const char *input);

#ifdef __cplusplus
}
#endif

#endif
