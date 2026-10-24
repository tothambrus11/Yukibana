// RapidCheck properties of the app's C++ sample (geometry.h), as a project
// would write them in tests/properties_test.cpp (README, "Properties"):
// packs/cpp/test-run.mjs runs them in the browser, app/tests/export.mjs with
// CMake and the machine's own compiler.
//
// `PROPERTIES[framework](failing)` is the file for GoogleTest, doctest or
// Catch2: two properties that hold (distance is symmetric; a point's
// distance to itself is zero) or, with `failing`, the second replaced by one
// that does not (a point's norm is a whole number), which RapidCheck shrinks
// to (1, 1), the smallest coordinates whose norm is not.

/** A property's body at the given indentation. */
const body = {
    symmetric: (pad) => `${pad}const Point a{double(x1), double(y1)}, b{double(x2), double(y2)};\n${pad}RC_ASSERT(distance(a, b) == distance(b, a));`,
    zero: (pad) => `${pad}const Point a{double(x), double(y)};\n${pad}RC_ASSERT(distance(a, a) == 0.0);`,
    whole: (pad) => `${pad}const Point p{double(x), double(y)};\n${pad}RC_ASSERT(p.norm() == std::floor(p.norm()));`,
};
const second = (failing) => (failing ? { name: 'norm is a whole number', body: body.whole } : { name: 'distance to itself is zero', body: body.zero });

export const PROPERTIES = {
    gtest: (failing) => `#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

#include <cmath>

#include "geometry.h"

RC_GTEST_PROP(GeometryProperties, DistanceIsSymmetric, (int x1, int y1, int x2, int y2)) {
${body.symmetric('    ')}
}

RC_GTEST_PROP(GeometryProperties, ${failing ? 'NormIsAWholeNumber' : 'DistanceToItselfIsZero'}, (int x, int y)) {
${second(failing).body('    ')}
}
`,
    // RapidCheck's own doctest integration (rapidcheck/doctest.h) does not
    // compile (README, "Properties"): the test CHECKs what rc::check returns.
    doctest: (failing) => `#include <doctest/doctest.h>
#include <rapidcheck.h>

#include <cmath>

#include "geometry.h"

TEST_CASE("distance is symmetric") {
    const bool holds = rc::check("distance is symmetric", [](int x1, int y1, int x2, int y2) {
${body.symmetric('        ')}
    });
    CHECK(holds);
}

TEST_CASE("${second(failing).name}") {
    const bool holds = rc::check("${second(failing).name}", [](int x, int y) {
${second(failing).body('        ')}
    });
    CHECK(holds);
}
`,
    catch2: (failing) => `#include <catch2/catch_test_macros.hpp>
#include <rapidcheck/catch.h>

#include <cmath>

#include "geometry.h"

TEST_CASE("distance is symmetric") {
    rc::prop("distance is symmetric", [](int x1, int y1, int x2, int y2) {
${body.symmetric('        ')}
    });
}

TEST_CASE("${second(failing).name}") {
    rc::prop("${second(failing).name}", [](int x, int y) {
${second(failing).body('        ')}
    });
}
`,
};

/** rc::check from a main of the program's own, no framework: one property that holds, one that does not; exit 1 when one failed. */
export const OWN_MAIN_PROPERTIES = `#include <rapidcheck.h>

#include <cmath>

#include "geometry.h"

int main() {
    bool ok = rc::check("distance is symmetric", [](int x1, int y1, int x2, int y2) {
${body.symmetric('        ')}
    });
    ok = rc::check("norm is a whole number", [](int x, int y) {
${body.whole('        ')}
    }) && ok;
    return ok ? 0 : 1;
}
`;
