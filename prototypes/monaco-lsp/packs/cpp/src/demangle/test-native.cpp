// Native unit test of demangle.cpp (test-demangle.mjs builds it with clang
// and AddressSanitizer + UndefinedBehaviorSanitizer, and runs it):
//
//   test-native <cases.tsv>
//
// Each line of the cases file is "mangled<TAB>expected". Every case is
// checked alone, then all of them in one batch (the way explorer.js calls
// the wasm build), then the edge cases of the line protocol. Prints one line
// per check and exits 1 when any failed.

#include "demangle.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {

int failures = 0;

void check(bool ok, const std::string &what, const std::string &got) {
  std::cout << (ok ? "PASS  " : "FAIL  ") << what << "  " << got << '\n';
  if (!ok) {
    ++failures;
  }
}

std::vector<std::pair<std::string, std::string>> readCases(const char *path) {
  std::vector<std::pair<std::string, std::string>> cases;
  std::ifstream in(path);
  std::string line;
  while (std::getline(in, line)) {
    const std::size_t tab = line.find('\t');
    if (line.empty() || line.front() == '#' || tab == std::string::npos) {
      continue;
    }
    cases.emplace_back(line.substr(0, tab), line.substr(tab + 1));
  }
  return cases;
}

} // namespace

int main(int argc, char **argv) {
  const std::vector<std::string> args(argv, std::next(argv, argc));
  if (args.size() != 2) {
    std::cerr << "usage: test-native <cases.tsv>\n";
    return 2;
  }
  const auto cases = readCases(args[1].c_str());
  check(!cases.empty(), "the cases file has cases", std::to_string(cases.size()));

  std::string batch;
  std::string expected;
  for (const auto &[mangled, plain] : cases) {
    const std::string got = yk::demangleLines(mangled);
    check(got == plain, mangled, got);
    batch += mangled + '\n';
    expected += plain + '\n';
  }
  batch.pop_back();
  expected.pop_back();
  check(yk::demangleLines(batch) == expected, "all cases in one batch keep their order and line count",
        std::to_string(cases.size()) + " lines");

  check(yk::demangleLines("").empty(), "an empty input gives an empty output", "");
  check(yk::demangleLines("_Znwm\n") == "operator new(unsigned long)\n",
        "a trailing newline is kept (an empty last line)", yk::demangleLines("_Znwm\n"));
  check(yk::demangleLines("\n\n") == "\n\n", "empty lines stay empty lines", "");
  check(yk::demangleLines("_Z") == "_Z", "a truncated name comes back unchanged", yk::demangleLines("_Z"));
  check(yk::demangleLines("_ZZZZ\x01\xff") == "_ZZZZ\x01\xff", "bytes that are no name come back unchanged", "");

  check(yk_demangle_lines(nullptr) == nullptr, "the C function returns null for null", "");
  char *out = yk_demangle_lines("_Z8distanceRK5PointS1_\nmain");
  const std::string c = out != nullptr ? out : "(null)";
  // The C interface's contract: its result is freed with free().
  // NOLINTNEXTLINE(cppcoreguidelines-owning-memory,cppcoreguidelines-no-malloc)
  std::free(out);
  check(c == "distance(Point const&, Point const&)\nmain", "the C function demangles and frees cleanly", c);

  std::cout << (failures == 0 ? "all passed" : std::to_string(failures) + " failed") << '\n';
  return failures == 0 ? 0 : 1;
}
