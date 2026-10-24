/**
 * The languages the app offers. Each one names its pack (the directory under
 * `static/packs/` its server comes from), the Monaco languages that server
 * answers for, and the sample project a first visit starts with.
 */

/** Identifies a language, and with it a pack and a saved project. */
export type LanguageId = 'python' | 'javascript' | 'typescript' | 'web' | 'cpp' | 'swift' | 'scala' | 'rust' | 'php' | 'java' | 'kotlin' | 'haskell';

/** Project files by path relative to the workspace root, `/`-separated. */
export type Files = Record<string, string>;

export interface Language {
	id: LanguageId;
	label: string;
	/** Monaco language ids whose editor features the pack's server answers. */
	monacoLanguages: readonly string[];
	/** Answers to the server's `workspace/configuration` requests, by section. */
	settings: Record<string, unknown>;
	/** The file the editor opens first. */
	entry: string;
	/** What a fresh project contains. Files refer to each other on purpose. */
	sample: Files;
	/** Extension suggested for a new file. */
	extension: string;
	/**
	 * Whether the pack has a runner (`runner.js`) that can run the project
	 * from `entry`. When false, `cannotRun` says why, for the Run button.
	 */
	runs: boolean;
	cannotRun?: string;
	/**
	 * Whether the runner also takes `type: 'test'` (packs/CONTRACT.md,
	 * "Running a program"): it builds the project's tests instead of its
	 * program and runs them, with the same messages as a run.
	 */
	tests?: boolean;
	/**
	 * Whether the runner also takes `type: 'mutate'` (packs/CONTRACT.md,
	 * "Running a program"): mutation testing of the project against its
	 * tests, with a report and a mutation score, with the same messages as a
	 * run. Only with `tests`.
	 */
	mutates?: boolean;
	/**
	 * The directory under `static/packs/` whose server and runner serve this
	 * language, when it is not `id`: TypeScript and web projects use the
	 * JavaScript pack's.
	 */
	pack?: string;
	/**
	 * For a web project, the page Run shows in the Preview panel (live
	 * reloaded as files change) instead of running `entry` in the terminal.
	 */
	preview?: string;
}

/** The pack directory of a language. */
export function packOf(language: Language): string {
	return language.pack ?? language.id;
}

export const LANGUAGES: readonly Language[] = [
	{
		id: 'python',
		label: 'Python',
		monacoLanguages: ['python'],
		settings: { python: { analysis: { typeCheckingMode: 'standard', diagnosticMode: 'workspace' } } },
		entry: 'main.py',
		extension: '.py',
		runs: true,
		tests: true,
		sample: {
			'main.py': `from geometry import Point, distance


def main() -> None:
    a = Point(0, 0)
    b = Point(3, 4)
    print(f"{a} to {b}: {distance(a, b)}")
    print(a.norm())


if __name__ == "__main__":
    main()
`,
			'geometry.py': `import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Point:
    """A point in the plane."""

    x: float
    y: float

    def norm(self) -> float:
        """Distance from the origin."""
        return math.hypot(self.x, self.y)


def distance(a: Point, b: Point) -> float:
    """Euclidean distance between two points."""
    return math.hypot(a.x - b.x, a.y - b.y)
`,
			'tests/test_geometry.py': `import dataclasses
import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from geometry import Point, distance

points = st.builds(Point, st.floats(-1e9, 1e9), st.floats(-1e9, 1e9))


def test_norm_of_3_4_is_5() -> None:
    assert Point(3, 4).norm() == 5


@given(points, points)
def test_distance_is_symmetric(a: Point, b: Point) -> None:
    assert distance(a, b) == distance(b, a)


@pytest.mark.parametrize(("x", "y", "expected"), [(0, 0, 0.0), (5, 12, 13.0), (1, 1, math.sqrt(2))])
def test_norm(x: float, y: float, expected: float) -> None:
    assert Point(x, y).norm() == pytest.approx(expected)


def test_points_are_immutable() -> None:
    p = Point(0, 0)
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(p, "x", 1)
`,
		},
	},
	{
		id: 'javascript',
		label: 'JavaScript',
		monacoLanguages: ['javascript', 'typescript'],
		settings: {},
		entry: 'main.js',
		extension: '.js',
		runs: true,
		tests: true,
		mutates: true,
		sample: {
			'main.js': `// @ts-check
import { Point, distance } from './geometry.js';

const a = new Point(0, 0);
const b = new Point(3, 4);
console.log(\`\${a} to \${b}: \${distance(a, b)}\`);
console.log(a.norm().toFixed(2));
`,
			'geometry.js': `// @ts-check

/** A point in the plane. */
export class Point {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  /** Distance from the origin. */
  norm() {
    return Math.hypot(this.x, this.y);
  }

  toString() {
    return \`(\${this.x}, \${this.y})\`;
  }
}

/**
 * Euclidean distance between two points.
 * @param {Point} a
 * @param {Point} b
 */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
`,
			'tests/geometry.test.js': `// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { Point, distance } from '../geometry.js';

const coordinate = fc.double({ min: -1e9, max: 1e9, noNaN: true });
const point = fc.tuple(coordinate, coordinate).map(([x, y]) => new Point(x, y));

describe('Point', () => {
  it('has norm 5 at (3, 4)', () => {
    assert.equal(new Point(3, 4).norm(), 5);
  });

  it('prints as a pair', () => {
    assert.equal(String(new Point(1, 2)), '(1, 2)');
  });
});

describe('distance', () => {
  it('is symmetric', () => {
    fc.assert(fc.property(point, point, (a, b) => distance(a, b) === distance(b, a)));
  });

  it('is 0 from a point to itself', () => {
    const p = new Point(7, -3);
    assert.equal(distance(p, p), 0);
  });
});
`,
			'jsconfig.json': `{
  "compilerOptions": {
    "target": "es2023",
    "module": "es2022",
    "checkJs": true,
    "strict": true
  }
}
`,
		},
	},
	{
		// TypeScript as Node 22.18+ runs it: types stripped, imports with their
		// .ts extension, so the download runs with plain `node main.ts`.
		id: 'typescript',
		label: 'TypeScript',
		pack: 'javascript',
		monacoLanguages: ['typescript', 'javascript'],
		settings: {},
		entry: 'main.ts',
		extension: '.ts',
		runs: true,
		tests: true,
		mutates: true,
		sample: {
			'main.ts': `import { Point, distance, type Shape, area } from './geometry.ts';

const a = new Point(0, 0);
const b = new Point(3, 4);
console.log(\`\${a} to \${b}: \${distance(a, b)}\`);

const shapes: Shape[] = [
  { kind: 'circle', radius: 1 },
  { kind: 'square', side: 2 },
];
for (const shape of shapes) console.log(shape.kind, area(shape).toFixed(2));
`,
			'geometry.ts': `/** A point in the plane. */
export class Point {
  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  /** Distance from the origin. */
  norm(): number {
    return Math.hypot(this.x, this.y);
  }

  toString(): string {
    return \`(\${this.x}, \${this.y})\`;
  }
}

/** Euclidean distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** A shape, told apart by its \`kind\`. */
export type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; side: number };

/** The area of a shape; the switch covers every kind, which TypeScript checks. */
export function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'square':
      return shape.side ** 2;
  }
}
`,
			'tests/geometry.test.ts': `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { Point, area, distance } from '../geometry.ts';

const coordinate = fc.double({ min: -1e9, max: 1e9, noNaN: true });
const point = fc.tuple(coordinate, coordinate).map(([x, y]) => new Point(x, y));

describe('Point', () => {
  it('has norm 5 at (3, 4)', () => {
    assert.equal(new Point(3, 4).norm(), 5);
  });

  it('prints as a pair', () => {
    assert.equal(String(new Point(1, 2)), '(1, 2)');
  });
});

describe('distance and area', () => {
  it('distance is symmetric', () => {
    fc.assert(fc.property(point, point, (a, b) => distance(a, b) === distance(b, a)));
  });

  it('a square of side 3 has area 9', () => {
    assert.equal(area({ kind: 'square', side: 3 }), 9);
  });
});
`,
			'tsconfig.json': `{
  "compilerOptions": {
    "target": "es2023",
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noEmit": true
  }
}
`,
		},
	},
	{
		// A page: index.html, its stylesheet and its TypeScript, shown by Run
		// in the Preview panel and reloaded live; downloads as a Vite project.
		id: 'web',
		label: 'Web (HTML, CSS, TypeScript)',
		pack: 'javascript',
		monacoLanguages: ['typescript', 'javascript'],
		settings: {},
		entry: 'main.ts',
		preview: 'index.html',
		extension: '.ts',
		runs: true,
		sample: {
			'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Counter</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main>
      <h1>Hello from TypeScript</h1>
      <p>You clicked <output id="count">0</output> times.</p>
      <button id="increment" type="button">Click me</button>
    </main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`,
			'style.css': `:root {
  font-family: system-ui, sans-serif;
  color-scheme: light dark;
}

main {
  max-width: 32rem;
  margin: 3rem auto;
  padding: 0 1rem;
}

h1 {
  color: #2f7d5b;
}

button {
  font: inherit;
  padding: 0.4rem 1rem;
}
`,
			'main.ts': `import { Counter } from './counter.ts';

const output = document.querySelector<HTMLOutputElement>('#count')!;
const button = document.querySelector<HTMLButtonElement>('#increment')!;
const counter = new Counter();

button.addEventListener('click', () => {
  output.value = String(counter.increment());
  console.log(\`clicked \${counter.value} times\`);
});
console.log('page ready');
`,
			'counter.ts': `/** Counts clicks. */
export class Counter {
  #value = 0;

  /** How many times \`increment\` was called. */
  get value(): number {
    return this.#value;
  }

  /** Adds one and returns the new value. */
  increment(): number {
    return ++this.#value;
  }
}
`,
			'tsconfig.json': `{
  "compilerOptions": {
    "target": "es2023",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2023", "dom", "dom.iterable"],
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noEmit": true
  }
}
`,
		},
	},
	{
		id: 'cpp',
		label: 'C++',
		monacoLanguages: ['cpp', 'c'],
		settings: {},
		entry: 'main.cpp',
		extension: '.cpp',
		runs: true,
		tests: true,
		sample: {
			'main.cpp': `#include <cstdio>
#include <vector>

#include "geometry.h"

int main() {
    std::vector<Point> points{{0, 0}, {3, 4}};
    std::printf("%f\\n", distance(points[0], points[1]));
    std::printf("%f\\n", points[1].norm());
    return 0;
}
`,
			'geometry.h': `#pragma once

/// A point in the plane.
struct Point {
    double x;
    double y;

    /// Distance from the origin.
    double norm() const;
};

/// Euclidean distance between two points.
double distance(const Point &a, const Point &b);
`,
			'geometry.cpp': `#include "geometry.h"

#include <cmath>

double Point::norm() const { return std::hypot(x, y); }

double distance(const Point &a, const Point &b) {
    return std::hypot(a.x - b.x, a.y - b.y);
}
`,
			'tests/geometry_test.cpp': `#include <gtest/gtest.h>

#include "geometry.h"

TEST(Geometry, NormOfThreeFourIsFive) {
    Point p{3, 4};
    EXPECT_DOUBLE_EQ(p.norm(), 5.0);
}

TEST(Geometry, DistanceIsSymmetric) {
    Point a{1, 2};
    Point b{-2, 6};
    EXPECT_DOUBLE_EQ(distance(a, b), distance(b, a));
    EXPECT_DOUBLE_EQ(distance(a, b), 5.0);
}

TEST(Geometry, DistanceToItselfIsZero) {
    Point a{1.5, -2.5};
    EXPECT_EQ(distance(a, a), 0.0);
}
`,
			'compile_flags.txt': `-std=c++20
-Wall
-Wextra
-I.
`,
		},
	},
	{
		id: 'swift',
		label: 'Swift',
		monacoLanguages: ['swift'],
		settings: {},
		entry: 'main.swift',
		extension: '.swift',
		runs: true,
		tests: true,
		sample: {
			'main.swift': `let a = Point(x: 0, y: 0)
let b = Point(x: 3, y: 4)
print("\\(a) to \\(b): \\(distance(a, b))")
print(b.norm())
`,
			'Geometry.swift': `/// A point in the plane.
struct Point: CustomStringConvertible {
    var x: Double
    var y: Double

    /// Distance from the origin.
    func norm() -> Double {
        (x * x + y * y).squareRoot()
    }

    var description: String { "(\\(x), \\(y))" }
}

/// Euclidean distance between two points.
func distance(_ a: Point, _ b: Point) -> Double {
    Point(x: a.x - b.x, y: a.y - b.y).norm()
}
`,
			'Tests/GeometryTests.swift': `import XCTest
@testable import App

final class GeometryTests: XCTestCase {
    func testNorm() {
        XCTAssertEqual(Point(x: 3, y: 4).norm(), 5)
    }

    func testDistanceIsSymmetric() {
        let a = Point(x: 1, y: 2)
        let b = Point(x: -2, y: 6)
        XCTAssertEqual(distance(a, b), distance(b, a), accuracy: 1e-12)
    }
}
`,
		},
	},
	{
		id: 'scala',
		label: 'Scala',
		monacoLanguages: ['scala'],
		settings: {},
		entry: 'Main.scala',
		extension: '.scala',
		runs: true,
		sample: {
			'Main.scala': `@main def run(): Unit =
  val a = Point(0, 0)
  val b = Point(3, 4)
  println(s"$a to $b: \${distance(a, b)}")
  println(List(a, b).map(_.norm).sum)
`,
			'Geometry.scala': `/** A point in the plane. */
case class Point(x: Double, y: Double):
  /** Distance from the origin. */
  def norm: Double = math.hypot(x, y)

/** Euclidean distance between two points. */
def distance(a: Point, b: Point): Double =
  math.hypot(a.x - b.x, a.y - b.y)
`,
		},
	},
	{
		// Cargo's layout: a library (src/lib.rs) the binary (src/main.rs) and
		// the integration tests (tests/) use under the package's name, which
		// both the pack's server and its runner read from Cargo.toml. The
		// tests use quickcheck, a dev-dependency in Cargo.toml, which the pack
		// ships compiled for its Miri (packs/rust/README.md).
		id: 'rust',
		label: 'Rust',
		monacoLanguages: ['rust'],
		settings: {},
		entry: 'src/main.rs',
		extension: '.rs',
		runs: true,
		tests: true,
		sample: {
			'Cargo.toml': `[package]
name = "geometry"
version = "0.1.0"
edition = "2021"

[dev-dependencies]
quickcheck = "1"
`,
			'src/main.rs': `use geometry::{distance, Point};

fn main() {
    let a = Point::new(0.0, 0.0);
    let b = Point::new(3.0, 4.0);
    println!("{a} to {b}: {}", distance(a, b));
    println!("{}", b.norm());
}
`,
			'src/lib.rs': `//! Points in the plane.

mod point;

pub use point::{distance, Point};
`,
			'src/point.rs': `use std::fmt;

/// A point in the plane.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    /// The point at \`(x, y)\`.
    pub fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    /// Distance from the origin.
    pub fn norm(&self) -> f64 {
        self.x.hypot(self.y)
    }
}

impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}

/// Euclidean distance between two points.
pub fn distance(a: Point, b: Point) -> f64 {
    Point::new(a.x - b.x, a.y - b.y).norm()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_of_3_4_is_5() {
        assert_eq!(Point::new(3.0, 4.0).norm(), 5.0);
    }
}
`,
			'tests/geometry.rs': `use geometry::{distance, Point};
use quickcheck::quickcheck;

quickcheck! {
    // A property: quickcheck tries it on 100 random points and, if one
    // fails, shrinks it to the simplest failing input it can find.
    fn distance_is_symmetric(ax: i32, ay: i32, bx: i32, by: i32) -> bool {
        let a = Point::new(ax as f64, ay as f64);
        let b = Point::new(bx as f64, by as f64);
        distance(a, b) == distance(b, a)
    }
}

#[test]
fn distance_to_itself_is_zero() {
    let p = Point::new(1.5, -2.5);
    assert_eq!(distance(p, p), 0.0);
}

#[test]
fn points_print_as_pairs() {
    assert_eq!(Point::new(1.0, 2.5).to_string(), "(1, 2.5)");
}
`,
		},
	},
	{
		// Plain PHP files with require_once, as `php main.php` runs them, and
		// PHPUnit tests in tests/. The runner's Test autoloads the project's
		// classes with a class map, as the downloaded composer.json does.
		id: 'php',
		label: 'PHP',
		monacoLanguages: ['php'],
		settings: {},
		entry: 'main.php',
		extension: '.php',
		runs: true,
		tests: true,
		sample: {
			'main.php': `<?php

declare(strict_types=1);

require_once __DIR__ . '/geometry.php';

use Geometry\\Point;

use function Geometry\\distance;

$a = new Point(0, 0);
$b = new Point(3, 4);
echo "{$a} to {$b}: " . distance($a, $b) . "\\n";
echo $b->norm() . "\\n";
`,
			'geometry.php': `<?php

declare(strict_types=1);

namespace Geometry;

/** A point in the plane. */
final class Point
{
    public function __construct(
        public readonly float $x,
        public readonly float $y,
    ) {
    }

    /** Distance from the origin. */
    public function norm(): float
    {
        return hypot($this->x, $this->y);
    }

    public function __toString(): string
    {
        return "({$this->x}, {$this->y})";
    }
}

/** Euclidean distance between two points. */
function distance(Point $a, Point $b): float
{
    return hypot($a->x - $b->x, $a->y - $b->y);
}
`,
			'tests/GeometryTest.php': `<?php

declare(strict_types=1);

namespace Geometry\\Tests;

use Geometry\\Point;
use PHPUnit\\Framework\\Attributes\\DataProvider;
use PHPUnit\\Framework\\TestCase;

use function Geometry\\distance;

require_once __DIR__ . '/../geometry.php';

final class GeometryTest extends TestCase
{
    public function testNormOfThreeFourIsFive(): void
    {
        $this->assertSame(5.0, (new Point(3, 4))->norm());
    }

    public function testDistanceIsSymmetric(): void
    {
        $a = new Point(1, 2);
        $b = new Point(-2, 6);
        $this->assertSame(distance($a, $b), distance($b, $a));
    }

    /** @return iterable<string, array{float, float, float}> */
    public static function norms(): iterable
    {
        yield 'origin' => [0, 0, 0.0];
        yield '5-12-13' => [5, 12, 13.0];
    }

    #[DataProvider('norms')]
    public function testNorm(float $x, float $y, float $expected): void
    {
        $this->assertEqualsWithDelta($expected, (new Point($x, $y))->norm(), 1e-12);
    }

    public function testPrintsAsAPair(): void
    {
        $this->assertSame('(1, 2)', (string) new Point(1, 2));
    }
}
`,
		},
	},
	{
		// Maven's layout (the downloaded pom.xml builds it as it is): the
		// program in src/main/java, JUnit 5 tests in src/test/java, one
		// package. The runner runs src/main/java only, and adds the tests
		// for Test.
		id: 'java',
		label: 'Java',
		monacoLanguages: ['java'],
		settings: {},
		entry: 'src/main/java/geometry/Main.java',
		extension: '.java',
		runs: true,
		tests: true,
		sample: {
			'src/main/java/geometry/Main.java': `package geometry;

public class Main {
    public static void main(String[] args) {
        var a = new Point(0, 0);
        var b = new Point(3, 4);
        System.out.println(a + " to " + b + ": " + Geometry.distance(a, b));
        System.out.println(b.norm());
    }
}
`,
			'src/main/java/geometry/Point.java': `package geometry;

/** A point in the plane. */
public record Point(double x, double y) {
    /** Distance from the origin. */
    public double norm() {
        return Math.hypot(x, y);
    }
}
`,
			'src/main/java/geometry/Geometry.java': `package geometry;

/** Functions of points. */
public final class Geometry {
    private Geometry() {
    }

    /** Euclidean distance between two points. */
    public static double distance(Point a, Point b) {
        return Math.hypot(a.x() - b.x(), a.y() - b.y());
    }
}
`,
			'src/test/java/geometry/GeometryTest.java': `package geometry;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class GeometryTest {
    @Test
    void normOfThreeFourIsFive() {
        assertEquals(5.0, new Point(3, 4).norm());
    }

    @Test
    void distanceIsSymmetric() {
        var a = new Point(1, 2);
        var b = new Point(-2, 6);
        assertEquals(Geometry.distance(a, b), Geometry.distance(b, a));
        assertEquals(5.0, Geometry.distance(a, b));
    }

    @Test
    void distanceToItselfIsZero() {
        var p = new Point(1.5, -2.5);
        assertEquals(0.0, Geometry.distance(p, p));
    }
}
`,
		},
	},
	{
		// Gradle's layout (the downloaded build.gradle.kts builds it as it
		// is): the program in src/main/kotlin, kotlin.test tests in
		// src/test/kotlin. The browser reads Kotlin's syntax only: no
		// compiler runs Kotlin there (packs/kotlin/README.md).
		id: 'kotlin',
		label: 'Kotlin',
		monacoLanguages: ['kotlin'],
		settings: {},
		entry: 'src/main/kotlin/Main.kt',
		extension: '.kt',
		runs: false,
		cannotRun:
			'Kotlin cannot run in the browser: its compiler runs only on a JVM. The editor knows Kotlin\'s syntax (errors, completion, hover, go to definition); Download the project to run it with Gradle.',
		sample: {
			'src/main/kotlin/Main.kt': `fun main() {
    val a = Point(0.0, 0.0)
    val b = Point(3.0, 4.0)
    println("$a to $b: \${distance(a, b)}")
    println(b.norm())
}
`,
			'src/main/kotlin/Geometry.kt': `import kotlin.math.hypot

/** A point in the plane. */
data class Point(val x: Double, val y: Double) {
    /** Distance from the origin. */
    fun norm(): Double = hypot(x, y)
}

/** Euclidean distance between two points. */
fun distance(a: Point, b: Point): Double = hypot(a.x - b.x, a.y - b.y)
`,
			'src/test/kotlin/GeometryTest.kt': `import kotlin.test.Test
import kotlin.test.assertEquals

class GeometryTest {
    @Test
    fun normOfThreeFourIsFive() {
        assertEquals(5.0, Point(3.0, 4.0).norm())
    }

    @Test
    fun distanceIsSymmetric() {
        val a = Point(1.0, 2.0)
        val b = Point(-2.0, 6.0)
        assertEquals(distance(a, b), distance(b, a))
        assertEquals(5.0, distance(a, b))
    }

    @Test
    fun distanceToItselfIsZero() {
        val p = Point(1.5, -2.5)
        assertEquals(0.0, distance(p, p))
    }
}
`,
		},
	},
	{
		// Cabal's layout (the downloaded haskell-project.cabal builds it as
		// it is): the program's modules at the root, an hspec suite in
		// tests/Spec.hs. MicroHs compiles and type-checks it in the browser
		// (packs/haskell/README.md).
		id: 'haskell',
		label: 'Haskell',
		monacoLanguages: ['haskell'],
		settings: {},
		entry: 'Main.hs',
		extension: '.hs',
		runs: true,
		tests: true,
		sample: {
			'Main.hs': `module Main (main) where

import Geometry

main :: IO ()
main = do
  let a = Point 0 0
      b = Point 3 4
  putStrLn (show a ++ " to " ++ show b ++ ": " ++ show (distance a b))
  print (norm b)
  mapM_ (print . area) [Circle 1, Square 2]
`,
			'Geometry.hs': `-- | Points and shapes in the plane.
module Geometry
  ( Point (..)
  , norm
  , distance
  , Shape (..)
  , area
  ) where

-- | A point in the plane.
data Point = Point {px :: Double, py :: Double}
  deriving (Eq)

instance Show Point where
  show (Point x y) = "(" ++ show x ++ ", " ++ show y ++ ")"

-- | Distance from the origin.
norm :: Point -> Double
norm (Point x y) = sqrt (x * x + y * y)

-- | Euclidean distance between two points.
distance :: Point -> Point -> Double
distance a b = norm (Point (px a - px b) (py a - py b))

-- | A shape, told apart by its constructor.
data Shape = Circle Double | Square Double
  deriving (Show)

-- | The area of a shape; the cases cover every constructor.
area :: Shape -> Double
area (Circle r) = pi * r * r
area (Square side) = side * side
`,
			'tests/Spec.hs': `module Main (main) where

import Geometry
import Test.Hspec

main :: IO ()
main = hspec $ do
  describe "norm" $
    it "is 5 at (3, 4)" $
      norm (Point 3 4) \`shouldBe\` 5

  describe "distance" $ do
    it "is symmetric" $ do
      let a = Point 1 2
          b = Point (-2) 6
      distance a b \`shouldBe\` distance b a

    it "is 0 from a point to itself" $
      distance (Point 7 (-3)) (Point 7 (-3)) \`shouldBe\` 0

  describe "area" $
    it "of a square of side 3 is 9" $
      area (Square 3) \`shouldBe\` 9
`,
		},
	},
];

/** The language with this id; the ids are a closed set, so it always exists. */
export function languageOf(id: LanguageId): Language {
	const language = LANGUAGES.find((l) => l.id === id);
	if (!language) throw new Error(`unknown language ${id}`);
	return language;
}

/** Narrows a stored or typed string to a language id. */
export function isLanguageId(value: unknown): value is LanguageId {
	return LANGUAGES.some((l) => l.id === value);
}
