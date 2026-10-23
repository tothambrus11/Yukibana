/**
 * C++ test frameworks: which one a project's tests use, and the sample tests
 * written for each, so a project can be switched from one to another.
 *
 * The framework is what the test files include, as a real build would need
 * it: `<gtest/gtest.h>`, `<doctest/doctest.h>` or `<catch2/...>`. Nothing
 * else records it, so the browser's runner (packs/cpp/src/runner.js, which
 * has the same rules), the generated CMakeLists.txt (export.ts) and the
 * header's framework choice all read the same files the same way.
 *
 * Imports only types, so `node` can load this file directly (tests/export.mjs).
 */
import type { Files } from './languages';

export type TestFramework = 'gtest' | 'doctest' | 'catch2';

export interface TestFrameworkInfo {
	id: TestFramework;
	/** Its name, as the header's choice shows it. */
	label: string;
	/** The header its tests include, for messages. */
	header: string;
}

export const TEST_FRAMEWORKS: readonly TestFrameworkInfo[] = [
	{ id: 'gtest', label: 'GoogleTest', header: '<gtest/gtest.h>' },
	{ id: 'doctest', label: 'doctest', header: '<doctest/doctest.h>' },
	{ id: 'catch2', label: 'Catch2', header: '<catch2/catch_test_macros.hpp>' },
];

/** Where a C++ project keeps its tests (the runner's and CMake's rule). */
export const TESTS_DIR = 'tests/';

const INCLUDES: Record<TestFramework, RegExp> = {
	gtest: /^[ \t]*#[ \t]*include[ \t]*[<"]gtest\//m,
	doctest: /^[ \t]*#[ \t]*include[ \t]*[<"]doctest\//m,
	catch2: /^[ \t]*#[ \t]*include[ \t]*[<"]catch2\//m,
};

/** C and C++ files, sources and headers. */
const C_FAMILY = /\.(c|cc|cpp|cxx|c\+\+|C|h|hh|hpp|hxx|h\+\+|inl|ipp)$/;

function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The frameworks a file includes, in TEST_FRAMEWORKS' order. */
export function frameworksIncluded(text: string): TestFramework[] {
	const code = withoutComments(text);
	return TEST_FRAMEWORKS.map((f) => f.id).filter((id) => INCLUDES[id].test(code));
}

/**
 * What the C/C++ files under tests/ include: one framework, none (`null`),
 * or several (`mixed`, with a file for each), which no test program links.
 */
export type Detected = { framework: TestFramework | null; mixed: false } | { framework: null; mixed: true; files: Partial<Record<TestFramework, string>> };

export function detectTestFramework(files: Files): Detected {
	const found: Partial<Record<TestFramework, string>> = {};
	for (const path of Object.keys(files).sort()) {
		if (!path.startsWith(TESTS_DIR) || !C_FAMILY.test(path)) continue;
		for (const id of frameworksIncluded(files[path] ?? '')) found[id] ??= path;
	}
	const ids = Object.keys(found) as TestFramework[];
	if (ids.length > 1) return { framework: null, mixed: true, files: found };
	return { framework: ids[0] ?? null, mixed: false };
}

export function frameworkInfo(id: TestFramework): TestFrameworkInfo {
	return TEST_FRAMEWORKS.find((f) => f.id === id)!;
}

// ---- Sample tests, one set per framework

/** The sample's tests of geometry.h, by framework; GoogleTest's are the sample's own (`sample`). */
const GEOMETRY_TESTS: Record<TestFramework, (sample: Files) => string> = {
	gtest: (sample) => sample['tests/geometry_test.cpp'] ?? '',
	doctest: () => `#include <doctest/doctest.h>

#include "geometry.h"

TEST_CASE("the norm of (3, 4) is 5") {
    Point p{3, 4};
    CHECK(p.norm() == doctest::Approx(5.0));
}

TEST_CASE("distance is symmetric") {
    Point a{1, 2};
    Point b{-2, 6};
    CHECK(distance(a, b) == doctest::Approx(distance(b, a)));
    CHECK(distance(a, b) == doctest::Approx(5.0));
}

TEST_CASE("the distance to itself is zero") {
    Point a{1.5, -2.5};
    CHECK(distance(a, a) == 0.0);
}
`,
	catch2: () => `#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "geometry.h"

using Catch::Matchers::WithinULP;

TEST_CASE("the norm of (3, 4) is 5", "[geometry]") {
    Point p{3, 4};
    REQUIRE_THAT(p.norm(), WithinULP(5.0, 4));
}

TEST_CASE("distance is symmetric", "[geometry]") {
    Point a{1, 2};
    Point b{-2, 6};
    REQUIRE_THAT(distance(a, b), WithinULP(distance(b, a), 4));
    REQUIRE_THAT(distance(a, b), WithinULP(5.0, 4));
}

TEST_CASE("the distance to itself is zero", "[geometry]") {
    Point a{1.5, -2.5};
    REQUIRE(distance(a, a) == 0.0);
}
`,
};

/** A test that needs nothing of the project, for a project that is not the sample. */
const EXAMPLE_TESTS: Record<TestFramework, string> = {
	gtest: `#include <gtest/gtest.h>

#include <string>

TEST(Example, StringsConcatenate) {
    std::string greeting = "Hello, ";
    EXPECT_EQ(greeting + "world", "Hello, world");
}
`,
	doctest: `#include <doctest/doctest.h>

#include <string>

TEST_CASE("strings concatenate") {
    std::string greeting = "Hello, ";
    CHECK(greeting + "world" == "Hello, world");
}
`,
	catch2: `#include <catch2/catch_test_macros.hpp>

#include <string>

TEST_CASE("strings concatenate", "[example]") {
    std::string greeting = "Hello, ";
    REQUIRE(greeting + "world" == "Hello, world");
}
`,
};

/** What choosing a framework changes: files to write (new or replaced), the one to show, and what to say. */
export interface FrameworkChange {
	write: Files;
	show: string | null;
	message: string;
	/** Whether the tests now mix frameworks (existing tests of another one were left as they are). */
	mixed: boolean;
}

/**
 * The tests for `target`: every tests/ file that is a sample test as the app
 * wrote it (of any framework) is rewritten for `target`; tests someone wrote
 * or changed are left alone. When there is no sample test to convert and the
 * tests do not use `target` already, a sample test file is added: the
 * geometry tests while the project still has the sample's geometry.h, else
 * a test that needs nothing of the project. `sample` is the C++ sample
 * project (languages.ts), whose GoogleTest tests are the ones converted.
 */
export function chooseTestFramework(files: Files, target: TestFramework, sample: Files): FrameworkChange {
	const label = frameworkInfo(target).label;
	const ids = TEST_FRAMEWORKS.map((f) => f.id);
	const write: Files = {};
	for (const [path, text] of Object.entries(files)) {
		if (!path.startsWith(TESTS_DIR)) continue;
		if (ids.some((id) => text === GEOMETRY_TESTS[id](sample))) write[path] = GEOMETRY_TESTS[target](sample);
		else if (ids.some((id) => text === EXAMPLE_TESTS[id])) write[path] = EXAMPLE_TESTS[target];
	}
	for (const [path, text] of Object.entries(write)) if (files[path] === text) delete write[path];
	const after = detectTestFramework({ ...files, ...write });
	const converted = Object.keys(write).sort();
	if (converted.length) {
		return { write, show: converted[0]!, message: `Converted ${converted.join(', ')} to ${label}.${after.mixed ? mixedNote(target) : ''}`, mixed: after.mixed };
	}
	if (after.framework === target) return { write: {}, show: null, message: `The tests already use ${label}.`, mixed: false };
	const geometry = files['geometry.h'] === sample['geometry.h'];
	const base = geometry ? 'tests/geometry_test' : 'tests/example_test';
	let path = `${base}.cpp`;
	for (let i = 1; path in files; i++) path = `${base}_${target}${i > 1 ? `_${i}` : ''}.cpp`;
	write[path] = geometry ? GEOMETRY_TESTS[target](sample) : EXAMPLE_TESTS[target];
	const mixed = detectTestFramework({ ...files, ...write }).mixed;
	return { write, show: path, message: `Added ${path}, a sample ${label} test.${mixed ? mixedNote(target) : ''}`, mixed };
}

function mixedNote(target: TestFramework): string {
	return ` Other files in tests/ use another framework and were left as they are: Test runs once they are converted to ${frameworkInfo(target).label} or removed.`;
}
