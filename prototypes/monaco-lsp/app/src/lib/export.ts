/**
 * A project as it leaves the browser, for an IDE and the language's own
 * tools: every file of the project unchanged and at the same path, plus the
 * build files those tools need and the project does not have (CMakeLists.txt,
 * Package.swift, pyproject.toml, package.json, build.sbt), a README.md that
 * says how to build, run and test, and a .gitignore. The folder layout is the
 * browser's: each generated build file points its tool at the flat layout
 * instead of moving files into the tool's default one.
 *
 * Pure: the same project always gives the same files. A file the project
 * already has is never replaced, whatever it contains.
 *
 * Imports only types, so `node` can load this file directly (tests/export.mjs).
 */
import type { Files, Language, LanguageId } from './languages';

/** What a download contains. */
export interface ExportedProject {
	/** The project's files, unchanged, plus the generated ones. */
	files: Files;
	/** The paths in `files` that were generated, sorted. None of them was in the project. */
	generated: string[];
}

/** What a generator is given. */
interface Project {
	language: Language;
	/** The project's own files. */
	files: Files;
	/**
	 * Every path the export will contain, the generated files included, so
	 * that a manifest can name the files its tool must not treat as sources
	 * (Package.swift's `exclude`).
	 */
	paths: readonly string[];
}

/** A language's build files: the paths it can generate, and their contents. */
interface BuildFiles {
	paths: readonly string[];
	generate(project: Project): Files;
}

const BUILD: Record<LanguageId, BuildFiles> = {
	cpp: { paths: ['CMakeLists.txt'], generate: (p) => ({ 'CMakeLists.txt': cmakeLists(p.files, p.language.entry) }) },
	swift: { paths: ['Package.swift'], generate: (p) => ({ 'Package.swift': packageSwift(p.files, p.paths) }) },
	python: { paths: ['pyproject.toml'], generate: (p) => ({ 'pyproject.toml': pyprojectToml(p.files) }) },
	javascript: { paths: ['package.json'], generate: (p) => ({ 'package.json': packageJson(p.language.entry) }) },
	scala: { paths: ['build.sbt', 'project/build.properties'], generate: (p) => ({ 'build.sbt': buildSbt(p.files), 'project/build.properties': `sbt.version=${SBT_VERSION}\n` }) },
};

/**
 * The files to download for a project: `files` unchanged, plus each build
 * file of the language, README.md and .gitignore that the project does not
 * have. A README in any case or with any extension (readme.txt, README)
 * counts as having one.
 */
export function exportProject(language: Language, files: Files): ExportedProject {
	const build = BUILD[language.id];
	const absent = (path: string) => !(path in files);
	const hasReadme = Object.keys(files).some((p) => /^readme(\.[^/]*)?$/i.test(p));
	const generated = [...build.paths.filter(absent), ...(hasReadme ? [] : ['README.md']), ...['.gitignore'].filter(absent)].sort();
	const project: Project = { language, files, paths: [...Object.keys(files), ...generated].sort() };
	const candidates: Files = {
		...build.generate(project),
		'README.md': readme(language, files, generated),
		'.gitignore': gitignore(language.id),
	};
	const out: Files = { ...files };
	for (const path of generated) out[path] = candidates[path] ?? '';
	return { files: out, generated };
}

// ---- C and C++: CMake

/** Sources, as the C++ runner tells them apart (packs/cpp/src/runner.js). */
const CXX = /\.(cpp|cc|cxx|c\+\+|C)$/;
const C = /\.c$/;
/** Where tests live, for the runner and so here. */
const TESTS = /^tests\//;

/**
 * GoogleTest as the browser runs it: the release the C++ pack builds
 * (packs/cpp/build-cxx-runtime.sh), with its checksum, so a local build tests
 * against the same version.
 */
const GTEST_VERSION = '1.18.0';
const GTEST_SHA256 = '6e3191c1455468b3fc35a417fb565c1c5071aee1b7e7f85e30cf48a98d37d8b5';

/**
 * Whether a source defines main: `int main(` or `auto main(` outside
 * comments. The runner's heuristic, so the test executable leaves out the
 * same files a Test in the browser does.
 */
function definesMain(text: string): boolean {
	return /\b(?:int|auto)\s+main\s*\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));
}

/** What compile_flags.txt says, sorted into what CMake has a word for. */
interface Flags {
	/** `-std=c++20` as `{ standard: '20', extensions: false }`; null when not given. */
	cxx: { standard: string; extensions: boolean } | null;
	c: { standard: string; extensions: boolean } | null;
	/** `-I` directories, relative to the project. */
	includes: string[];
	/** `-D` definitions, without the `-D`. */
	definitions: string[];
	/** Everything else, in order: warnings, `-f` options, optimisation. */
	options: string[];
}

/** C++ standard aliases clang accepts, by CMake's name for them. */
const CXX_ALIASES: Record<string, string> = { '0x': '11', '1y': '14', '1z': '17', '2a': '20', '2b': '23', '2c': '26' };
const C_ALIASES: Record<string, string> = { '89': '90', '9x': '99', '1x': '11', '18': '17', '2x': '23', '1999': '99', '2011': '11', '2017': '17', '2018': '17' };

/**
 * compile_flags.txt, one argument per line as clangd reads it (a `-I` whose
 * directory is on the next line included). A `-std=` CMake cannot name is
 * kept as a plain option.
 */
export function parseCompileFlags(text: string): Flags {
	const flags: Flags = { cxx: null, c: null, includes: [], definitions: [], options: [] };
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = 0; i < lines.length; i++) {
		const flag = lines[i]!;
		const cxx = /^-std=(c|gnu)\+\+(\w+)$/.exec(flag);
		const c = /^-std=(c|gnu|iso9899:)(\w+)$/.exec(flag);
		if (cxx) flags.cxx = { standard: CXX_ALIASES[cxx[2]!] ?? cxx[2]!, extensions: cxx[1] === 'gnu' };
		else if (c && /^\d+$/.test(C_ALIASES[c[2]!] ?? c[2]!)) flags.c = { standard: C_ALIASES[c[2]!] ?? c[2]!, extensions: c[1] === 'gnu' };
		else if (flag === '-I' && i + 1 < lines.length) flags.includes.push(lines[++i]!);
		else if (flag.startsWith('-I')) flags.includes.push(flag.slice(2));
		else if (flag === '-D' && i + 1 < lines.length) flags.definitions.push(lines[++i]!);
		else if (flag.startsWith('-D')) flags.definitions.push(flag.slice(2));
		else flags.options.push(flag);
	}
	return flags;
}

/** A CMake quoted argument: `"` `\` `$` and `;` escaped, so a path is one argument, verbatim. */
function cmakeQuote(s: string): string {
	return `"${s.replace(/[\\"$;]/g, (ch) => `\\${ch}`)}"`;
}

/** A CMake argument: as it is when that is one argument verbatim (`-Wall`), else quoted. */
function cmakeArg(s: string): string {
	return /^[\w.+=:,/-]+$/.test(s) ? s : cmakeQuote(s);
}

/** A `-I` directory for CMake: a relative one as `${CMAKE_CURRENT_SOURCE_DIR}/...`, an absolute one as it is. */
function cmakeDir(dir: string): string {
	if (dir.startsWith('/')) return cmakeQuote(dir);
	const rest = dir.replace(/^\.\/?/, '').replace(/\/$/, '');
	return rest ? `"\${CMAKE_CURRENT_SOURCE_DIR}/${rest.replace(/[\\"$;]/g, (ch) => `\\${ch}`)}"` : '"${CMAKE_CURRENT_SOURCE_DIR}"';
}

/**
 * CMakeLists.txt for the project as the C++ pack builds it: one executable,
 * `app`, from every C/C++ source outside tests/; when tests/ has sources, a
 * second one, `app_tests`, from those plus the program's sources without its
 * main, linked with GoogleTest (gtest_main unless a test defines main) and
 * registered with CTest. compile_flags.txt's standard, include directories,
 * definitions and options apply to both, not to GoogleTest itself, so a
 * `-Werror` there does not fail on GoogleTest's code. The options are left
 * out for MSVC, which does not take GCC-style flags. compile_commands.json is
 * written to the build folder for clangd. Without compile_flags.txt the
 * compiler's default standard applies, as it does for clangd.
 */
export function cmakeLists(files: Files, entry: string): string {
	const sources = Object.keys(files).filter((p) => CXX.test(p) || C.test(p)).sort();
	const tests = sources.filter((p) => TESTS.test(p));
	const program = sources.filter((p) => !TESTS.test(p));
	const underTest = program.filter((p) => p !== entry && !definesMain(files[p] ?? ''));
	const ownMain = tests.some((p) => definesMain(files[p] ?? ''));
	const hasMain = program.some((p) => p === entry || definesMain(files[p] ?? ''));
	const flags = parseCompileFlags(files['compile_flags.txt'] ?? '');
	const cxx = tests.length > 0 || !sources.some((p) => C.test(p)) || sources.some((p) => CXX.test(p));
	const languages = [...(cxx ? ['CXX'] : []), ...(sources.some((p) => C.test(p)) ? ['C'] : [])];
	const list = (paths: string[]) => paths.map((p) => `\n    ${cmakeQuote(p)}`).join('');

	const lines: string[] = [
		'# Builds the project where it is, with the layout it had in Yukibana Light:',
		'#   cmake -S . -B build && cmake --build build && ./build/app',
		...(tests.length ? ['#   ctest --test-dir build --output-on-failure'] : []),
		'cmake_minimum_required(VERSION 3.16...3.31)',
		`project(app LANGUAGES ${languages.join(' ')})`,
		'',
	];
	const fromFlags = files['compile_flags.txt'] !== undefined ? ' (from compile_flags.txt, which clangd reads too)' : '';
	if (flags.cxx) {
		lines.push(`# The C++ standard${fromFlags}.`);
		lines.push(`set(CMAKE_CXX_STANDARD ${flags.cxx.standard})`, 'set(CMAKE_CXX_STANDARD_REQUIRED ON)', `set(CMAKE_CXX_EXTENSIONS ${flags.cxx.extensions ? 'ON' : 'OFF'})`);
	}
	if (flags.c) {
		lines.push(`# The C standard${fromFlags}.`);
		lines.push(`set(CMAKE_C_STANDARD ${flags.c.standard})`, 'set(CMAKE_C_STANDARD_REQUIRED ON)', `set(CMAKE_C_EXTENSIONS ${flags.c.extensions ? 'ON' : 'OFF'})`);
	}
	lines.push('# build/compile_commands.json, which clangd and other tools read.', 'set(CMAKE_EXPORT_COMPILE_COMMANDS ON)', '');

	lines.push(`# The project's own flags${fromFlags}, for its targets only.`, 'add_library(project_flags INTERFACE)');
	if (flags.includes.length) lines.push(`target_include_directories(project_flags INTERFACE ${flags.includes.map(cmakeDir).join(' ')})`);
	if (flags.definitions.length) lines.push(`target_compile_definitions(project_flags INTERFACE ${flags.definitions.map(cmakeArg).join(' ')})`);
	if (flags.options.length) lines.push('if(NOT MSVC)', `    target_compile_options(project_flags INTERFACE ${flags.options.map(cmakeArg).join(' ')})`, 'endif()');
	lines.push('');

	if (program.length) {
		// No main anywhere: a library, which builds, rather than an executable that cannot link.
		lines.push(
			'# The program: every source outside tests/.',
			hasMain ? `add_executable(app${list(program)}\n)` : `add_library(app STATIC${list(program)}\n)`,
			'target_link_libraries(app PRIVATE project_flags)',
			'',
		);
	}
	if (tests.length) {
		lines.push(
			`# The tests: tests/ and the program's sources without its main, with GoogleTest ${GTEST_VERSION},`,
			'# the version the browser runs. Downloaded once, when the build is configured.',
			'include(FetchContent)',
			'FetchContent_Declare(googletest',
			`    URL https://github.com/google/googletest/releases/download/v${GTEST_VERSION}/googletest-${GTEST_VERSION}.tar.gz`,
			`    URL_HASH SHA256=${GTEST_SHA256}`,
			')',
			'# On Windows, use the same C runtime as the project; never install GoogleTest.',
			'set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)',
			'set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)',
			'FetchContent_MakeAvailable(googletest)',
			'',
			'enable_testing()',
			`add_executable(app_tests${list([...underTest, ...tests])}\n)`,
			`target_link_libraries(app_tests PRIVATE project_flags ${ownMain ? 'GTest::gtest' : 'GTest::gtest_main'})`,
			'include(GoogleTest)',
			'gtest_discover_tests(app_tests)',
			'',
		);
	}
	return lines.join('\n');
}

// ---- Swift: SwiftPM

/** Modules a test may import that are not the project (packs/swift/src/xctest.js). */
const NOT_THE_PROJECT = new Set(['XCTest', 'Testing', 'Foundation', 'FoundationEssentials', 'Dispatch', 'Glibc', 'Musl', 'Darwin', 'WASILibc', 'Swift', '_Concurrency', 'Synchronization', 'RegexBuilder']);

/** Where SwiftPM's tests are, and the browser's. */
const SWIFT_TESTS = 'Tests/';

/** The names a Swift file `@testable import`s, its comments and strings aside only roughly (a heuristic, as in the pack). */
function testableImports(text: string): string[] {
	const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	return [...code.matchAll(/@testable\s+import\s+([A-Za-z_]\w*)/g)].map((m) => m[1]!).filter((name) => !NOT_THE_PROJECT.has(name));
}

/**
 * The module the project is, by the Swift pack's rule (projectModuleName):
 * the one name the project's files `@testable import`, else `App`. The pack
 * compiles project and tests as one module, `main` unless a test names it;
 * SwiftPM needs a real name, and `App` is the one SwiftPM's own templates
 * and the course layout use.
 */
export function swiftModuleName(files: Files): string {
	const names = new Set(Object.entries(files).filter(([p]) => p.endsWith('.swift')).flatMap(([, text]) => testableImports(text)));
	return names.size === 1 ? [...names][0]! : 'App';
}

/**
 * Package.swift for the project where it is. One executable target, named
 * after the module (swiftModuleName), from every .swift file outside Tests/,
 * main.swift included: the browser compiles them as one module, and SwiftPM
 * lets tests `@testable import` an executable target, so nothing has to be
 * split into a library and nothing moves. Its path is the package root, so
 * every other file there (README.md, compile settings, Tests/) is excluded by
 * name, or SwiftPM warns about each as "unhandled".
 *
 * A test target, `<Module>Tests`, from Tests/ when it has .swift files. In
 * the browser, tests see the project's declarations without an import, since
 * they are compiled into the same module. Here they are another module, so a
 * test file without `@testable import <Module>` would not compile: when any
 * test file lacks it, the target imports the module into every file with the
 * compiler's `-testable-import-module`. That is an unsafe flag, which SwiftPM
 * allows in a package that is built on its own (as this one is) but not in a
 * dependency; adding the import to the tests and deleting the setting is the
 * conventional form.
 *
 * Swift 5 language mode, as the browser's compiler uses (no -swift-version),
 * so code that compiles there does not meet Swift 6's strict concurrency
 * here. libm linked on Linux: `squareRoot()` and friends inline to `sqrt`,
 * which the Swift 6.4 toolchain's link line does not otherwise satisfy there.
 */
export function packageSwift(files: Files, paths: readonly string[]): string {
	const module = swiftModuleName(files);
	const swift = Object.keys(files).filter((p) => p.endsWith('.swift')).sort();
	const sources = swift.filter((p) => !p.startsWith(SWIFT_TESTS));
	const tests = swift.filter((p) => p.startsWith(SWIFT_TESTS));
	const hidden = (p: string) => p.split('/').some((s) => s.startsWith('.'));
	const exclude = new Set<string>();
	for (const path of paths) {
		if (hidden(path) || path === 'Package.swift' || sources.includes(path)) continue;
		const top = path.split('/')[0]!;
		// A folder with no source in it goes as a whole; otherwise file by file.
		exclude.add(path.includes('/') && !sources.some((s) => s.startsWith(top + '/')) ? top : path);
	}
	const testExclude = paths.filter((p) => p.startsWith(SWIFT_TESTS) && !p.endsWith('.swift') && !hidden(p)).map((p) => p.slice(SWIFT_TESTS.length));
	const needsImport = tests.some((p) => !testableImports(files[p] ?? '').includes(module));
	const strings = (list: readonly string[], indent: string) => `[${list.map((s) => `\n${indent}    ${JSON.stringify(s)},`).join('')}\n${indent}]`;

	const targets = [
		[
			'        // The program: every .swift file outside Tests/, where it is.',
			'        .executableTarget(',
			`            name: ${JSON.stringify(module)},`,
			'            path: ".",',
			...(exclude.size ? [`            exclude: ${strings([...exclude].sort(), '            ')},`] : []),
			`            sources: ${strings(sources, '            ')},`,
			'            linkerSettings: [.linkedLibrary("m", .when(platforms: [.linux]))]',
			'        ),',
		].join('\n'),
	];
	if (tests.length) {
		targets.push(
			[
				'        // The tests in Tests/, with XCTest.',
				'        .testTarget(',
				`            name: ${JSON.stringify(module + 'Tests')},`,
				`            dependencies: [${JSON.stringify(module)}],`,
				`            path: ${JSON.stringify(SWIFT_TESTS.slice(0, -1))}${testExclude.length || needsImport ? ',' : ''}`,
				...(testExclude.length ? [`            exclude: ${strings(testExclude, '            ')}${needsImport ? ',' : ''}`] : []),
				...(needsImport
					? [
							`            // The tests use the program's declarations without \`@testable import ${module}\`,`,
							'            // as they can in the browser, where they are compiled into the same module.',
							'            // This adds that import to every test file; with the import written in the',
							'            // tests, this setting can go.',
							`            swiftSettings: [.unsafeFlags(["-Xfrontend", "-testable-import-module", "-Xfrontend", ${JSON.stringify(module)}])]`,
						]
					: []),
				'        ),',
			].join('\n'),
		);
	}
	return [
		'// swift-tools-version:6.0',
		'// Builds the project where it is, with the layout it had in Yukibana Light:',
		`//   swift build && swift run${tests.length ? ' && swift test' : ''}`,
		'import PackageDescription',
		'',
		'let package = Package(',
		`    name: ${JSON.stringify(module)},`,
		'    targets: [',
		...targets,
		'    ],',
		'    // The language mode the browser compiles with.',
		'    swiftLanguageModes: [.v5]',
		')',
		'',
	].join('\n');
}

// ---- Python: pyproject.toml

/**
 * pyproject.toml with pytest as a development dependency (the version the
 * browser runs, or later) and pytest told where the browser's run looks:
 * the project folder on the import path, so a test in tests/ can say `from
 * geometry import Point`, and tests/ as where tests are when there is one.
 * No build system: the project is a folder of modules, not a package to
 * install, which is also what uv assumes without one.
 */
export function pyprojectToml(files: Files): string {
	const hasTestsFolder = Object.keys(files).some((p) => p.startsWith('tests/') && p.endsWith('.py'));
	return [
		'[project]',
		'name = "python-project"',
		'version = "0.1.0"',
		'requires-python = ">=3.12"',
		'dependencies = []',
		'',
		'[dependency-groups]',
		'dev = ["pytest>=9"]',
		'',
		'[tool.pytest.ini_options]',
		...(hasTestsFolder ? ['testpaths = ["tests"]'] : []),
		'pythonpath = ["."]',
		'',
	].join('\n');
}

// ---- JavaScript: package.json

/**
 * package.json for Node: ES modules (the browser runs every .js as one),
 * `npm start` runs the entry file and `npm test` is `node --test`, whose
 * file discovery the browser's Test copies. No dependencies, since the
 * browser has none to offer.
 */
export function packageJson(entry: string): string {
	const json = {
		name: 'javascript-project',
		version: '0.1.0',
		private: true,
		type: 'module',
		main: entry,
		scripts: { start: `node ${entry}`, test: 'node --test' },
		engines: { node: '>=22' },
	};
	return JSON.stringify(json, null, 2) + '\n';
}

// ---- Scala: sbt

/** The Scala the browser compiles with (packs/scala/build.sh). */
const SCALA_VERSION = '3.7.4';
/** The sbt the Scala pack builds with, which is known to load this build. */
const SBT_VERSION = '1.11.7';
/** MUnit for tests in tests/, which the browser does not run yet. */
const MUNIT_VERSION = '1.2.1';

/**
 * build.sbt for the project where it is: the sources are every .scala and
 * .java file under the project folder, not src/main/scala, except tests/,
 * project/, target/ and hidden folders (.metals, .bsp, .idea), which hold
 * sbt's and the editors' own files; tests/ is the test sources, with MUnit.
 * `sourcesInBase` is off because the base folder is already the source
 * folder, and sbt would otherwise compile its files into the tests a second
 * time. sbt rather than scala-cli: IntelliJ imports an sbt build directly and
 * Metals does too, while scala-cli would need `scala-cli setup-ide` first and
 * counts tests by file name, not by folder.
 */
export function buildSbt(files: Files): string {
	const hasTests = Object.keys(files).some((p) => p.startsWith('tests/') && /\.(scala|java)$/.test(p));
	return [
		'// Builds the project where it is, with the layout it had in Yukibana Light:',
		`//   sbt run${hasTests ? ', sbt test' : ''}`,
		`ThisBuild / scalaVersion := ${JSON.stringify(SCALA_VERSION)}`,
		'',
		'lazy val root = (project in file("."))',
		'  .settings(',
		'    name := "scala-project",',
		'    // The sources are in the project folder itself, not in src/main/scala.',
		'    sourcesInBase := false,',
		'    Compile / scalaSource := baseDirectory.value,',
		'    Compile / javaSource := baseDirectory.value,',
		'    Compile / unmanagedSources / excludeFilter := {',
		'      val base = baseDirectory.value.toPath',
		'      val notSources = Seq("tests", "project", "target").map(base.resolve)',
		'      HiddenFileFilter || new SimpleFileFilter(file => {',
		'        val path = file.toPath',
		'        val relative = base.relativize(path)',
		'        notSources.exists(path.startsWith) || (0 until relative.getNameCount).exists(i => relative.getName(i).toString.startsWith("."))',
		'      })',
		'    },',
		'    // The tests are in tests/.',
		'    Test / scalaSource := baseDirectory.value / "tests",',
		'    Test / javaSource := baseDirectory.value / "tests",',
		'    Test / unmanagedSources / excludeFilter := HiddenFileFilter,',
		`    libraryDependencies += "org.scalameta" %% "munit" % ${JSON.stringify(MUNIT_VERSION)} % Test,`,
		'  )',
		'',
	].join('\n');
}

// ---- Every language: README.md and .gitignore

/** How to build, run and test with each language's tools, as Markdown sections. */
function instructions(language: Language, files: Files): string[] {
	const paths = Object.keys(files);
	switch (language.id) {
		case 'cpp': {
			const tests = paths.some((p) => TESTS.test(p) && (CXX.test(p) || C.test(p)));
			return [
				'## Build and run\n\nWith CMake 3.16 or later and a C++ compiler:\n\n```sh\ncmake -S . -B build\ncmake --build build\n./build/app\n```',
				...(tests ? [`## Test\n\nThe tests in \`tests/\` use GoogleTest ${GTEST_VERSION}, which CMake downloads the first time it configures the build:\n\n\`\`\`sh\nctest --test-dir build --output-on-failure\n\`\`\``] : []),
				'## Editors\n\nCLion, Visual Studio and VS Code (with CMake Tools) open the folder as a CMake project. clangd reads `build/compile_commands.json`, which CMake writes, and `compile_flags.txt` for files outside the build.',
			];
		}
		case 'swift': {
			const tests = paths.some((p) => p.startsWith(SWIFT_TESTS) && p.endsWith('.swift'));
			return [
				'## Build and run\n\nWith Swift 6 (Xcode 16, or the toolchain from swift.org):\n\n```sh\nswift build\nswift run\n```',
				...(tests ? ['## Test\n\nThe tests in `Tests/` use XCTest:\n\n```sh\nswift test\n```'] : []),
				'## Editors\n\nXcode opens `Package.swift`; VS Code needs the Swift extension, which runs SourceKit-LSP.',
			];
		}
		case 'python': {
			const tests = paths.some((p) => p.endsWith('.py') && /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p));
			return [
				`## Run\n\nWith Python 3.12 or later:\n\n\`\`\`sh\npython ${language.entry}\n\`\`\``,
				...(tests
					? ['## Test\n\nThe tests use pytest:\n\n```sh\npython -m venv .venv\n. .venv/bin/activate        # .venv\\Scripts\\activate on Windows\npython -m pip install pytest\npython -m pytest\n```\n\nOr, with uv: `uv run pytest`.']
					: []),
				'## Editors\n\nPyCharm and VS Code (with the Python extension) open the folder; pytest is configured in `pyproject.toml`.',
			];
		}
		case 'javascript': {
			const tests = paths.some((p) => /(^|\/)test\//.test(p) || /(^|\/)([^/]+[.\-_]test|test-[^/]*|test)\.m?js$/.test(p));
			return [
				`## Run\n\nWith Node.js 22 or later:\n\n\`\`\`sh\nnode ${language.entry}     # or: npm start\n\`\`\``,
				...(tests ? ['## Test\n\nThe tests use `node:test`:\n\n```sh\nnode --test               # or: npm test\n```'] : []),
				'## Editors\n\nVS Code and WebStorm open the folder as it is; there is nothing to install.',
			];
		}
		case 'scala': {
			const tests = paths.some((p) => p.startsWith('tests/') && /\.(scala|java)$/.test(p));
			return [
				`## Build and run\n\nWith sbt and a JDK 17 or later (sbt downloads Scala ${SCALA_VERSION}):\n\n\`\`\`sh\nsbt run\n\`\`\``,
				...(tests ? [`## Test\n\nThe tests in \`tests/\` use MUnit ${MUNIT_VERSION}:\n\n\`\`\`sh\nsbt test\n\`\`\``] : []),
				'## Editors\n\nIntelliJ IDEA (with the Scala plugin) opens the folder and imports `build.sbt`; VS Code with Metals offers to import the build when the folder is opened.',
			];
		}
	}
}

/**
 * A README for a project that has none: where the project came from, which
 * files were generated (each can be edited or deleted), and how to build,
 * run and test it with the language's own tools.
 */
function readme(language: Language, files: Files, generated: readonly string[]): string {
	const others = generated.filter((p) => p !== 'README.md');
	const quoted = others.map((p) => `\`${p}\``);
	const listed = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : (quoted[0] ?? '');
	return [
		`# ${language.label} project`,
		`Written in Yukibana Light. The files are where they were in the browser${others.length ? `; ${listed} ${others.length === 1 ? 'was' : 'were'} generated when it was downloaded, for the tools below, and can be changed like any other file` : ''}.`,
		...instructions(language, files),
		'',
	].join('\n\n');
}

/** What each language's tools write into the project folder, and editors' own files. */
const IGNORED: Record<LanguageId, readonly string[]> = {
	cpp: ['build/', 'cmake-build-*/', 'out/', '.cache/'],
	swift: ['.build/', '.swiftpm/', 'xcuserdata/', 'DerivedData/'],
	python: ['__pycache__/', '*.py[cod]', '.venv/', '.pytest_cache/'],
	javascript: ['node_modules/'],
	scala: ['target/', 'project/target/', 'project/project/', '.bsp/', '.bloop/', '.metals/', 'metals.sbt'],
};

/** A .gitignore for the build output of the language's tools. */
function gitignore(language: LanguageId): string {
	return ['# Build output', ...IGNORED[language], '', '# Editors and systems', '.idea/', '.DS_Store', ''].join('\n');
}
