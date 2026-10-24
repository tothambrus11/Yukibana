// demangle.wasm: LLVM's own Itanium demangler (llvm::itaniumDemangle, from
// LLVMDemangle in the pack's LLVM 21.1.8 tree) behind one C function, for
// the compiler output views (explorer.js; README, "Compiler output views").
// It is the code llvm::demangle, and so llvm-cxxfilt, runs for an Itanium
// name, chosen by the same test; the Microsoft, Rust and D demanglers are
// left out, as the views' targets (Linux and WASI) only produce Itanium
// names: 38% less to download. Anything else comes back as it was.
//
// Built by build-demangle.sh with Emscripten; checked natively, with
// AddressSanitizer and UndefinedBehaviorSanitizer, by test-native.cpp.

#include "demangle.h"

#include "llvm/Demangle/Demangle.h"

#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>

namespace yk {

namespace {

/// llvm::demangle's test for an Itanium name (Demangle.cpp,
/// isItaniumEncoding): one to four underscores, then 'Z'.
bool isItaniumEncoding(std::string_view name) {
  const std::size_t pos = name.find_first_not_of('_');
  return pos != std::string_view::npos && pos > 0 && pos <= 4 && name[pos] == 'Z';
}

/// What llvm::demangle returns for an Itanium name; any other name as it is.
std::string demangleOne(std::string_view name) {
  if (!isItaniumEncoding(name)) {
    return std::string(name);
  }
  // itaniumDemangle hands back a malloc'd string, or null when the name
  // does not parse (llvm::demangle then returns the name).
  // NOLINTNEXTLINE(cppcoreguidelines-owning-memory)
  char *demangled = llvm::itaniumDemangle(name);
  if (demangled == nullptr) {
    return std::string(name);
  }
  std::string result(demangled);
  // NOLINTNEXTLINE(cppcoreguidelines-owning-memory,cppcoreguidelines-no-malloc)
  std::free(demangled);
  return result;
}

} // namespace

std::string demangleLines(std::string_view input) {
  std::string out;
  out.reserve(input.size() * 2);
  for (;;) {
    const std::size_t end = input.find('\n');
    const std::string_view line = input.substr(0, end);
    std::string plain = demangleOne(line);
    // A newline in a demangled name would break the line correspondence;
    // the Itanium grammar cannot produce one, but the promise is kept here
    // rather than assumed.
    if (plain.find('\n') != std::string::npos) {
      plain.assign(line);
    }
    out += plain;
    if (end == std::string_view::npos) {
      break;
    }
    out += '\n';
    input.remove_prefix(end + 1);
  }
  return out;
}

} // namespace yk

extern "C" char *yk_demangle_lines(const char *input) {
  if (input == nullptr) {
    return nullptr;
  }
  const std::string out = yk::demangleLines(input);
  // The C interface hands JavaScript a malloc'd string it frees with free():
  // manual memory is the contract here, not an oversight.
  // NOLINTNEXTLINE(cppcoreguidelines-owning-memory,cppcoreguidelines-no-malloc)
  auto *copy = static_cast<char *>(std::malloc(out.size() + 1));
  if (copy == nullptr) {
    return nullptr;
  }
  std::memcpy(copy, out.c_str(), out.size() + 1);
  return copy;
}
