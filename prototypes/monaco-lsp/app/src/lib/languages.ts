/**
 * The languages the app offers. Each one names its pack (the directory under
 * `static/packs/` its server comes from), the Monaco languages that server
 * answers for, and the sample project a first visit starts with.
 */

/** Identifies a language, and with it a pack and a saved project. */
export type LanguageId = 'python' | 'javascript' | 'cpp' | 'swift' | 'scala';

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
		id: 'cpp',
		label: 'C++',
		monacoLanguages: ['cpp', 'c'],
		settings: {},
		entry: 'main.cpp',
		extension: '.cpp',
		runs: true,
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
			'compile_flags.txt': `-std=c++20
-Wall
-Wextra
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
