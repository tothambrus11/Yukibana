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
// With its extension: tests/export.mjs runs this file under Node's type stripping.
import { detectTestFramework, withoutComments, TEST_FRAMEWORKS, type TestFramework } from './cpp-tests.ts';
import { targetOf, type CppTarget } from './cpp-targets.ts';
import { CPP_LEVELS, defaultLevel, SWIFT_LEVELS } from './optimization.ts';

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
	/**
	 * The level chosen for a language whose level no project file holds
	 * (optimization.ts: Swift, Scala), as its flag; null for the default. A
	 * C or C++ project's is in its compile_flags.txt. Scala's is not
	 * exported: build.sbt builds for the JVM, where the Scala.js optimizer
	 * does not exist.
	 */
	optimization: string | null;
}

/** A language's build files: the paths it can generate, and their contents. */
interface BuildFiles {
	paths: readonly string[];
	generate(project: Project): Files;
}

/** The C++ runner's level for a project without a -O line (optimization.ts, packs/cpp/src/toolchain.js). */
const CPP_DEFAULT_LEVEL = defaultLevel(CPP_LEVELS).flag;

const BUILD: Record<LanguageId, BuildFiles> = {
	cpp: { paths: ['CMakeLists.txt'], generate: (p) => ({ 'CMakeLists.txt': cmakeLists(p.files, p.language.entry) }) },
	swift: { paths: ['Package.swift'], generate: (p) => ({ 'Package.swift': packageSwift(p.files, p.paths, p.optimization) }) },
	python: { paths: ['pyproject.toml'], generate: (p) => ({ 'pyproject.toml': pyprojectToml(p.files) }) },
	javascript: { paths: ['package.json', 'stryker.config.json'], generate: (p) => ({ 'package.json': packageJson(p.language.entry, p.files), 'stryker.config.json': strykerConfig() }) },
	typescript: { paths: ['package.json', 'stryker.config.json'], generate: (p) => ({ 'package.json': typescriptPackageJson(p.language.entry, p.files), 'stryker.config.json': strykerConfig() }) },
	web: { paths: ['package.json'], generate: (p) => ({ 'package.json': vitePackageJson('web-project', p.files) }) },
	p5: { paths: ['package.json'], generate: (p) => ({ 'package.json': vitePackageJson('p5-project', p.files) }) },
	scala: { paths: ['build.sbt', 'project/build.properties'], generate: (p) => ({ 'build.sbt': buildSbt(p.files), 'project/build.properties': `sbt.version=${SBT_VERSION}\n` }) },
	php: { paths: ['composer.json', 'phpunit.xml'], generate: (p) => ({ 'composer.json': composerJson(p.language.entry, p.files), 'phpunit.xml': phpunitXml(p.files) }) },
	rust: { paths: ['Cargo.toml'], generate: (p) => ({ 'Cargo.toml': cargoToml(p.files) }) },
	java: { paths: ['pom.xml'], generate: (p) => ({ 'pom.xml': pomXml(p.files, p.language.entry) }) },
	kotlin: {
		paths: ['build.gradle.kts', 'settings.gradle.kts'],
		generate: (p) => ({ 'build.gradle.kts': buildGradleKts(p.files, p.language.entry), 'settings.gradle.kts': 'rootProject.name = "kotlin-project"\n' }),
	},
	haskell: {
		paths: ['haskell-project.cabal', 'cabal.project'],
		generate: (p) => ({ 'haskell-project.cabal': haskellCabal(p.files, p.language.entry), 'cabal.project': 'packages: .\n' }),
	},
};

/**
 * The files to download for a project: `files` unchanged, plus each build
 * file of the language, README.md and .gitignore that the project does not
 * have. A README in any case or with any extension (readme.txt, README)
 * counts as having one.
 */
export function exportProject(language: Language, files: Files, optimization: string | null = null): ExportedProject {
	const build = BUILD[language.id];
	const absent = (path: string) => !(path in files);
	const hasReadme = Object.keys(files).some((p) => /^readme(\.[^/]*)?$/i.test(p));
	const generated = [...build.paths.filter(absent), ...(hasReadme ? [] : ['README.md']), ...['.gitignore'].filter(absent)].sort();
	const project: Project = { language, files, paths: [...Object.keys(files), ...generated].sort(), optimization };
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
 * Catch2 and doctest as the browser runs them (packs/cpp/build-test-frameworks.sh),
 * pinned by the commit of their release tags: neither publishes a source
 * archive of its own, and a commit names its whole tree.
 */
const CATCH2_VERSION = '3.16.1';
const CATCH2_COMMIT = '08092139210881f01a34e60c5f2fd6afa0ea4024';
const DOCTEST_VERSION = '2.5.3';
const DOCTEST_COMMIT = '2d0a9359a60c51affe2a9bebb1be1dca47868151';
/**
 * RapidCheck as the browser runs it (packs/cpp/build-test-frameworks.sh): a
 * commit of its master branch, since RapidCheck has no releases or tags.
 */
const RAPIDCHECK_COMMIT = '2c3c4365aca21ef4e612768fdc95b1ce8b39a651';
const RAPIDCHECK_DATE = '2026-10-05';

/** Whether a source includes RapidCheck (<rapidcheck.h> or <rapidcheck/...>), the runner's test for linking it. */
function includesRapidCheck(text: string): boolean {
	return /^[ \t]*#[ \t]*include[ \t]*[<"]rapidcheck(?:\.h[>"]|\/)/m.test(withoutComments(text));
}


/**
 * Whether a source defines main: `int main(` or `auto main(` outside
 * comments, or doctest's DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN. The runner's
 * heuristic, so the test executable leaves out the same files a Test in the
 * browser does.
 */
function definesMain(text: string): boolean {
	const code = withoutComments(text);
	return /\b(?:int|auto)\s+main\s*\(/.test(code) || /^[ \t]*#[ \t]*define[ \t]+DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN\b/m.test(code);
}

/** Whether a source implements doctest itself (DOCTEST_CONFIG_IMPLEMENT, with or without main). */
function implementsDoctest(text: string): boolean {
	return /^[ \t]*#[ \t]*define[ \t]+DOCTEST_CONFIG_IMPLEMENT/m.test(withoutComments(text));
}

/**
 * The test framework tests/ includes, as the runner and the app's picker
 * tell it (cpp-tests.ts detectTestFramework: C/C++ files only). When
 * several are, the first in TEST_FRAMEWORKS' order (the browser refuses to
 * build those tests; the CMakeLists links one and the compiler names what
 * is missing). GoogleTest when none is, as before there was a choice.
 */
function testFrameworkOf(files: Files): TestFramework {
	const found = detectTestFramework(files);
	if (!found.mixed) return found.framework ?? 'gtest';
	return TEST_FRAMEWORKS.map((f) => f.id).find((id) => id in found.files) ?? 'gtest';
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
	/**
	 * The last target flag's value (`--target=X`, `-target X`, and the
	 * spellings clang refuses, `-target=X` and `--target X`), or null. Never
	 * an option: CMake builds for the machine it runs on, or for the target
	 * of a toolchain file, not for whatever the browser built for.
	 */
	target: string | null;
}

/** C++ standard aliases clang accepts, by CMake's name for them. */
const CXX_ALIASES: Record<string, string> = { '0x': '11', '1y': '14', '1z': '17', '2a': '20', '2b': '23', '2c': '26' };
const C_ALIASES: Record<string, string> = { '89': '90', '9x': '99', '1x': '11', '18': '17', '2x': '23', '1999': '99', '2011': '11', '2017': '17', '2018': '17' };

/**
 * compile_flags.txt, one argument per line as clangd reads it (a `-I` whose
 * directory is on the next line included). A `-std=` CMake cannot name is
 * kept as a plain option; a target flag is set apart (`target`).
 */
export function parseCompileFlags(text: string): Flags {
	const flags: Flags = { cxx: null, c: null, includes: [], definitions: [], options: [], target: null };
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = 0; i < lines.length; i++) {
		const flag = lines[i]!;
		const cxx = /^-std=(c|gnu)\+\+(\w+)$/.exec(flag);
		const c = /^-std=(c|gnu|iso9899:)(\w+)$/.exec(flag);
		if (cxx) flags.cxx = { standard: CXX_ALIASES[cxx[2]!] ?? cxx[2]!, extensions: cxx[1] === 'gnu' };
		else if (c && /^\d+$/.test(C_ALIASES[c[2]!] ?? c[2]!)) flags.c = { standard: C_ALIASES[c[2]!] ?? c[2]!, extensions: c[1] === 'gnu' };
		else if (flag === '-I' && i + 1 < lines.length) flags.includes.push(lines[++i]!);
		else if (flag.startsWith('-I')) flags.includes.push(flag.slice(2));
		else if (flag === '-target' || flag === '--target') flags.target = lines[++i] ?? '';
		else if (flag.startsWith('--target=') || flag.startsWith('-target=')) flags.target = flag.slice(flag.indexOf('=') + 1);
		else if (flag === '-D' && i + 1 < lines.length) flags.definitions.push(lines[++i]!);
		else if (flag.startsWith('-D')) flags.definitions.push(flag.slice(2));
		else flags.options.push(flag);
	}
	return flags;
}

/**
 * The CMakeLists.txt comment for a project the browser builds for a Linux
 * target: CMake builds natively, and what cross compiling would take.
 * Nothing for the default target.
 */
function crossNote(target: CppTarget | null, languages: readonly string[]): string[] {
	if (!target) return [];
	const variables = languages.map((l) => `CMAKE_${l}_COMPILER_TARGET=${target.triple}`).join(' and ');
	return [
		`# In the browser, this project is built for ${target.triple} (the --target line of compile_flags.txt).`,
		'# CMake builds for the machine it runs on. To cross compile, configure with a toolchain file',
		`# that sets ${variables} and a musl sysroot (CMAKE_SYSROOT).`,
	];
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
 * The Linux target compile_flags.txt puts the project on (cpp-targets.ts),
 * or null for the default target (WebAssembly) and for a triple the browser
 * does not know.
 */
function linuxTarget(files: Files): CppTarget | null {
	const choice = targetOf(files['compile_flags.txt']);
	return choice.kind === 'target' && choice.target.runtime === 'linux' ? choice.target : null;
}

/**
 * CMakeLists.txt for the project as the C++ pack builds it: one executable,
 * `app`, from every C/C++ source outside tests/; when tests/ has sources, a
 * second one, `app_tests`, from those plus the program's sources without its
 * main, linked with the test framework tests/ includes (GoogleTest, doctest
 * or Catch2, fetched with FetchContent; its main unless a test defines one)
 * and registered with CTest test by test. RapidCheck, when a source
 * includes it, is fetched the same way, pinned to the browser's commit, and
 * linked to whichever of the two needs it. compile_flags.txt's standard,
 * include directories, definitions and options apply to both, not to the
 * framework itself, so a `-Werror` there does not fail on the framework's code. The options are left
 * out for MSVC, which does not take GCC-style flags. compile_commands.json is
 * written to the build folder for clangd. Without compile_flags.txt the
 * compiler's default standard applies, as it does for clangd. A target
 * flag is never passed on: for a Linux target a comment at the top says
 * what cross compiling would take (crossNote).
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
	// RapidCheck, where the browser links it: for the program when one of its
	// sources includes it, for the tests when they or the program's sources
	// under test do.
	const rcProgram = program.some((p) => includesRapidCheck(files[p] ?? ''));
	const rcTests = tests.length > 0 && [...tests, ...underTest].some((p) => includesRapidCheck(files[p] ?? ''));
	const testFramework = tests.length ? testFrameworkOf(files) : null;

	const lines: string[] = [
		'# Builds the project where it is, with the layout it had in Yukibana Light:',
		'#   cmake -S . -B build && cmake --build build && ./build/app',
		...(tests.length ? ['#   ctest --test-dir build --output-on-failure'] : []),
		...crossNote(linuxTarget(files), languages),
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
	// The level is one of the options when compile_flags.txt has a -O line
	// (optimization.ts); otherwise Run's default, which the build then uses
	// too. Either comes after the build type's flags, so it is what applies.
	if (!flags.options.some((o) => o.startsWith('-O')))
		lines.push(`# The optimisation level Run uses when compile_flags.txt has no -O line, whatever the build type.`, 'if(NOT MSVC)', `    target_compile_options(project_flags INTERFACE ${CPP_DEFAULT_LEVEL})`, 'endif()');
	lines.push('');

	if (rcProgram || rcTests) {
		lines.push(
			`# RapidCheck, property-based testing, at the commit the browser runs (its master`,
			`# on ${RAPIDCHECK_DATE}; RapidCheck has no releases). Downloaded once, when the build is`,
			'# configured, without its submodules, which only its own tests use.',
			'include(FetchContent)',
			'FetchContent_Declare(rapidcheck',
			'    GIT_REPOSITORY https://github.com/emil-e/rapidcheck.git',
			`    GIT_TAG ${RAPIDCHECK_COMMIT}`,
			'    GIT_SUBMODULES ""',
			')',
			...(rcTests && testFramework === 'gtest' ? ['# rapidcheck_gtest: RC_GTEST_PROP (rapidcheck/gtest.h).', 'set(RC_ENABLE_GTEST ON CACHE BOOL "" FORCE)'] : []),
			'FetchContent_MakeAvailable(rapidcheck)',
			'',
		);
	}
	if (program.length) {
		// No main anywhere: a library, which builds, rather than an executable that cannot link.
		lines.push(
			'# The program: every source outside tests/.',
			hasMain ? `add_executable(app${list(program)}\n)` : `add_library(app STATIC${list(program)}\n)`,
			`target_link_libraries(app PRIVATE project_flags${rcProgram ? ' rapidcheck' : ''})`,
			'',
		);
	}
	if (tests.length) {
		const framework = testFramework ?? 'gtest';
		const testSources = list([...underTest, ...tests]);
		if (framework === 'gtest') {
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
				`add_executable(app_tests${testSources}\n)`,
				`target_link_libraries(app_tests PRIVATE project_flags ${ownMain ? 'GTest::gtest' : 'GTest::gtest_main'}${rcTests ? ' rapidcheck_gtest' : ''})`,
				'include(GoogleTest)',
				'gtest_discover_tests(app_tests)',
				'',
			);
		} else if (framework === 'doctest') {
			// doctest is header-only; doctest_with_main is its implementation and
			// main, the library the browser links unless a test implements doctest.
			const ownDoctest = ownMain || tests.some((p) => implementsDoctest(files[p] ?? ''));
			lines.push(
				`# The tests: tests/ and the program's sources without its main, with doctest ${DOCTEST_VERSION},`,
				'# the version the browser runs. Downloaded once, when the build is configured.',
				'include(FetchContent)',
				'FetchContent_Declare(doctest',
				'    GIT_REPOSITORY https://github.com/doctest/doctest.git',
				`    GIT_TAG ${DOCTEST_COMMIT} # v${DOCTEST_VERSION}`,
				')',
				'set(DOCTEST_NO_INSTALL ON CACHE BOOL "" FORCE)',
				'FetchContent_MakeAvailable(doctest)',
				'',
				'enable_testing()',
				`add_executable(app_tests${testSources}\n)`,
				`target_link_libraries(app_tests PRIVATE project_flags ${ownDoctest ? 'doctest::doctest' : 'doctest::doctest_with_main'}${rcTests ? ' rapidcheck' : ''})`,
				'include(${doctest_SOURCE_DIR}/scripts/cmake/doctest.cmake)',
				'doctest_discover_tests(app_tests)',
				'',
			);
		} else {
			lines.push(
				`# The tests: tests/ and the program's sources without its main, with Catch2 ${CATCH2_VERSION},`,
				'# the version the browser runs. Downloaded once, when the build is configured.',
				'include(FetchContent)',
				'FetchContent_Declare(Catch2',
				'    GIT_REPOSITORY https://github.com/catchorg/Catch2.git',
				`    GIT_TAG ${CATCH2_COMMIT} # v${CATCH2_VERSION}`,
				')',
				'FetchContent_MakeAvailable(Catch2)',
				'',
				'enable_testing()',
				`add_executable(app_tests${testSources}\n)`,
				`target_link_libraries(app_tests PRIVATE project_flags ${ownMain ? 'Catch2::Catch2' : 'Catch2::Catch2WithMain'}${rcTests ? ' rapidcheck' : ''})`,
				// RC_ENABLE_CATCH would also add RapidCheck's ext/catch submodule
				// (Catch 2); rapidcheck/catch.h is one header, used as it is.
				...(rcTests ? ['target_include_directories(app_tests PRIVATE ${rapidcheck_SOURCE_DIR}/extras/catch/include)'] : []),
				'list(APPEND CMAKE_MODULE_PATH ${catch2_SOURCE_DIR}/extras)',
				'include(Catch)',
				'catch_discover_tests(app_tests)',
				'',
			);
		}
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
export function packageSwift(files: Files, paths: readonly string[], optimization: string | null = null): string {
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
	// A level other than the default goes to every configuration, as in the
	// browser; SwiftPM's own -Onone (debug) or -O (release) comes first.
	const level = SWIFT_LEVELS.find((l) => l.flag === optimization && !l.default)?.flag ?? null;
	const levelSetting = level ? [`            // The optimisation level chosen in the browser (${level}), in debug builds too.`, `            swiftSettings: [.unsafeFlags([${JSON.stringify(level)}])],`] : [];

	const targets = [
		[
			'        // The program: every .swift file outside Tests/, where it is.',
			'        .executableTarget(',
			`            name: ${JSON.stringify(module)},`,
			'            path: ".",',
			...(exclude.size ? [`            exclude: ${strings([...exclude].sort(), '            ')},`] : []),
			`            sources: ${strings(sources, '            ')},`,
			...levelSetting,
			'            linkerSettings: [.linkedLibrary("m", .when(platforms: [.linux]))]',
			'        ),',
		].join('\n'),
	];
	if (tests.length) {
		const testFlags = [...(level ? [level] : []), ...(needsImport ? ['-Xfrontend', '-testable-import-module', '-Xfrontend', module] : [])];
		targets.push(
			[
				'        // The tests in Tests/, with XCTest.',
				'        .testTarget(',
				`            name: ${JSON.stringify(module + 'Tests')},`,
				`            dependencies: [${JSON.stringify(module)}],`,
				`            path: ${JSON.stringify(SWIFT_TESTS.slice(0, -1))}${testExclude.length || testFlags.length ? ',' : ''}`,
				...(testExclude.length ? [`            exclude: ${strings(testExclude, '            ')}${testFlags.length ? ',' : ''}`] : []),
				...(needsImport
					? [
							`            // The tests use the program's declarations without \`@testable import ${module}\`,`,
							'            // as they can in the browser, where they are compiled into the same module.',
							'            // This adds that import to every test file; with the import written in the',
							'            // tests, this setting can go.',
						]
					: []),
				...(level ? [`            // The optimisation level chosen in the browser (${level}), as for the program.`] : []),
				...(testFlags.length ? [`            swiftSettings: [.unsafeFlags([${testFlags.map((f) => JSON.stringify(f)).join(', ')}])]`] : []),
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
 * Whether a Python project imports Hypothesis: the same test as the
 * runner's (packs/python/runner/runner.js, IMPORTS_HYPOTHESIS), which then
 * installs it.
 */
export function usesHypothesis(files: Files): boolean {
	const imports = /^[ \t]*(?:from[ \t]+hypothesis(?:[ \t.]|$)|import[ \t]+(?:[\w.]+[ \t]*(?:as[ \t]+\w+)?[ \t]*,[ \t]*)*hypothesis\b)/m;
	return Object.entries(files).some(([path, text]) => path.endsWith('.py') && imports.test(text));
}

/**
 * pyproject.toml with pytest as a development dependency (the version the
 * browser runs, or later; Hypothesis too when the project imports it) and
 * pytest told where the browser's run looks:
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
		usesHypothesis(files) ? 'dev = ["pytest>=9", "hypothesis>=6.170"]' : 'dev = ["pytest>=9"]',
		'',
		'[tool.pytest.ini_options]',
		...(hasTestsFolder ? ['testpaths = ["tests"]'] : []),
		'pythonpath = ["."]',
		'',
	].join('\n');
}

// ---- JavaScript: package.json

/** The fast-check the browser runs and types (packs/javascript/package.json). */
const FAST_CHECK_VERSION = '4.10.2';

/**
 * The npm packages a JavaScript or TypeScript project imports out of those
 * the browser ships (packs/javascript/README.md, "Packages"): fast-check
 * only, imported by its bare name from a script or module file.
 */
function shippedPackages(files: Files): Record<string, string> {
	return importsPackage(files, 'fast-check') ? { 'fast-check': `^${FAST_CHECK_VERSION}` } : {};
}

/**
 * Whether a script or module file of the project imports `name` or a
 * subpath of it (`p5/global`) by its bare name, statically or with
 * `import()`.
 */
function importsPackage(files: Files, name: string): boolean {
	const quoted = `['"]${name}(?:/[^'"]*)?['"]`;
	const imports = new RegExp(`(?:^|[;\\s])(?:import|export)\\s[^'"]*?\\bfrom\\s*${quoted}|\\bimport\\s*(?:\\(\\s*)?${quoted}`, 'm');
	return Object.entries(files).some(([path, text]) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) && imports.test(text));
}

/** The StrykerJS whose instrumenter and reporter the browser's Mutate runs (packs/javascript/package.json). */
const STRYKER_VERSION = '10.1.1';

/**
 * `npm run mutate`: StrykerJS and its tap runner, fetched by npx the first
 * time rather than installed with the project, as they are large (some 180
 * packages) and only this script uses them. TypeScript too for a project
 * with a tsconfig.json, which Stryker's core rewrites in its sandbox.
 */
function mutateScript(typescript: boolean): string {
	const packages = [`@stryker-mutator/core@${STRYKER_VERSION}`, `@stryker-mutator/tap-runner@${STRYKER_VERSION}`, ...(typescript ? [`typescript@${TYPESCRIPT_VERSION}`] : [])];
	return `npx --yes ${packages.map((p) => `--package ${p}`).join(' ')} stryker run`;
}

/** File names `node --test` runs (Node 22's defaults), as a minimatch pattern for Stryker. */
const NODE_TEST_FILES = '{**/@(*.test|*[-_]test|test-*|test).@(js|mjs|ts|mts),**/test/**/*.@(js|mjs|ts|mts)}';

/**
 * stryker.config.json: StrykerJS configured as the browser's Mutate runs it
 * (packs/javascript/README.md, "Mutation testing"): the tap runner, which
 * runs each file `node --test` would find as a process of its own, and every
 * other JavaScript or TypeScript file mutated (Stryker's default looks in
 * `src/` and `lib/` only). Each pattern is one, braces and all, so that
 * Stryker does not warn about a part of it that matches nothing.
 */
export function strykerConfig(): string {
	const json = {
		$schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
		testRunner: 'tap',
		tap: { testFiles: [NODE_TEST_FILES] },
		mutate: ['**/*.@(js|mjs|ts|mts)', `!{**/*.d.@(ts|mts),${NODE_TEST_FILES.slice(1, -1)}}`],
		reporters: ['clear-text', 'progress', 'html'],
	};
	return JSON.stringify(json, null, 2) + '\n';
}

/**
 * package.json for Node: ES modules (the browser runs every .js as one),
 * `npm start` runs the entry file, `npm test` is `node --test`, whose file
 * discovery the browser's Test copies, and `npm run mutate` is StrykerJS, as
 * the browser's Mutate. Dependencies only for what the browser ships and the
 * project imports (fast-check, for the tests, so a development dependency).
 */
export function packageJson(entry: string, files: Files = {}): string {
	const dev = shippedPackages(files);
	const json = {
		name: 'javascript-project',
		version: '0.1.0',
		private: true,
		type: 'module',
		main: entry,
		scripts: { start: `node ${entry}`, test: 'node --test', mutate: mutateScript(false) },
		engines: { node: '>=22' },
		...(Object.keys(dev).length ? { devDependencies: dev } : {}),
	};
	return JSON.stringify(json, null, 2) + '\n';
}

// ---- TypeScript: package.json for Node's type stripping

/**
 * package.json for a TypeScript project run as the browser runs it: Node
 * 22.18 and later strip the types of a `.ts` file themselves, so `npm start`
 * is `node main.ts` and `npm test` is `node --test` (which finds
 * `*.test.ts`), with nothing to install but fast-check when the project
 * imports it.
 */
export function typescriptPackageJson(entry: string, files: Files = {}): string {
	const dev = shippedPackages(files);
	const json = {
		name: 'typescript-project',
		version: '0.1.0',
		private: true,
		type: 'module',
		main: entry,
		scripts: { start: `node ${entry}`, test: 'node --test', mutate: mutateScript(true) },
		engines: { node: '>=22.18' },
		...(Object.keys(dev).length ? { devDependencies: dev } : {}),
	};
	return JSON.stringify(json, null, 2) + '\n';
}

// ---- Web: Vite

/** The Vite the app itself is built with (app/package.json). */
const VITE_VERSION = '8.3.5';
/** The TypeScript of the JavaScript pack's language server, for `npm run typecheck`. */
const TYPESCRIPT_VERSION = '6.0.3';

/** The p5.js a web page's Preview runs and the editor types (packs/javascript/package.json). */
const P5_VERSION = '2.3.4';

/**
 * package.json for a web project: Vite serves index.html at the project's
 * root as it is (`npm run dev`, with hot module replacement) and builds it
 * into dist/ (`npm run build`); `tsc` checks the types, which Vite does not.
 * p5.js is a dependency when a file imports it, at the version Preview runs
 * (packs/javascript/README.md, "Packages"): the page needs it at run time,
 * and its types come with it.
 */
export function vitePackageJson(name: string, files: Files = {}): string {
	const json = {
		name,
		version: '0.1.0',
		private: true,
		type: 'module',
		scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', typecheck: 'tsc' },
		...(importsPackage(files, 'p5') ? { dependencies: { p5: `^${P5_VERSION}` } } : {}),
		devDependencies: { typescript: TYPESCRIPT_VERSION, vite: VITE_VERSION },
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
/** The ScalaCheck the browser's Scala pack adds for a project that names it (packs/scala/build.sh). */
const SCALACHECK_VERSION = '1.18.1';

/**
 * Where a Scala project names ScalaCheck's package, as the browser's runner
 * looks for it (packs/scala/src/runner.js, `usesScalaCheck`): 'main' when a
 * source outside tests/ does (the browser runs properties from main, so the
 * dependency is a compile one), 'test' when only tests/ do, or null.
 */
export function scalaCheckScope(files: Files): 'main' | 'test' | null {
	const uses = Object.entries(files).filter(([path, text]) => path.endsWith('.scala') && /\borg\.scalacheck\b/.test(text));
	if (uses.some(([path]) => !path.startsWith('tests/'))) return 'main';
	return uses.length ? 'test' : null;
}

/**
 * build.sbt for the project where it is: the sources are every .scala and
 * .java file under the project folder, not src/main/scala, except tests/,
 * project/, target/ and hidden folders (.metals, .bsp, .idea), which hold
 * sbt's and the editors' own files; tests/ is the test sources, with MUnit.
 * ScalaCheck is a dependency when the project names it (`scalaCheckScope`):
 * of the main sources, or of the tests only.
 * `sourcesInBase` is off because the base folder is already the source
 * folder, and sbt would otherwise compile its files into the tests a second
 * time. sbt rather than scala-cli: IntelliJ imports an sbt build directly and
 * Metals does too, while scala-cli would need `scala-cli setup-ide` first and
 * counts tests by file name, not by folder.
 */
export function buildSbt(files: Files): string {
	const hasTests = Object.keys(files).some((p) => p.startsWith('tests/') && /\.(scala|java)$/.test(p));
	const scalaCheck = scalaCheckScope(files);
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
		...(scalaCheck ? [`    libraryDependencies += "org.scalacheck" %% "scalacheck" % ${JSON.stringify(SCALACHECK_VERSION)}${scalaCheck === 'test' ? ' % Test' : ''},`] : []),
		'  )',
		'',
	].join('\n');
}

// ---- PHP: Composer and PHPUnit

/** The PHPUnit the browser tests with (packs/php/build.sh). */
const PHPUNIT_VERSION = '12.5.40';
/** The Eris the browser's Test installs for a project that uses it (packs/php/build.sh). */
const ERIS_VERSION = '1.3.0';

/**
 * composer.json for the project where it is: PHPUnit as a development
 * dependency (the browser's version, or a later 12.x), `composer start`
 * running the entry and `composer test` running PHPUnit, and a class map of
 * every .php file outside tests/ and vendor/ as the autoloader, which is
 * what the browser's Test uses (packs/php/src/autoload.php): the project's
 * files are not in PSR-4 folders, so a class map is the autoloading that
 * fits them without moving anything. PHP 8.3 or later, which PHPUnit 12
 * needs; the browser runs 8.4. Eris too, when a PHP file names its
 * namespace, as the browser's Test then installs it (packs/php/src/runner.js,
 * `usesEris`).
 */
export function composerJson(entry: string, files: Files = {}): string {
	const eris = Object.entries(files).some(([path, text]) => path.endsWith('.php') && /\bEris\\/.test(text));
	const json = {
		name: 'yukibana/php-project',
		description: 'Written in Yukibana Light.',
		type: 'project',
		require: { php: '>=8.3' },
		'require-dev': { ...(eris ? { 'giorgiosironi/eris': `^${ERIS_VERSION}` } : {}), 'phpunit/phpunit': `^${PHPUNIT_VERSION}` },
		autoload: { classmap: ['./'], 'exclude-from-classmap': ['tests/', 'vendor/'] },
		scripts: { start: `php ${entry}`, test: 'phpunit' },
		config: { 'sort-packages': true },
	};
	return JSON.stringify(json, null, 4) + '\n';
}

/**
 * phpunit.xml: the tests in tests/ (PHPUnit's default *Test.php files) with
 * Composer's autoloader as the bootstrap, as the browser runs them. A
 * project that has phpunit.xml.dist already says what it wants, and a
 * phpunit.xml would take precedence over it, so then it is a copy.
 */
export function phpunitXml(files: Files): string {
	const dist = files['phpunit.xml.dist'] ?? files['phpunit.dist.xml'];
	if (dist !== undefined) return dist;
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
		'         xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"',
		'         bootstrap="vendor/autoload.php"',
		'         cacheDirectory=".phpunit.cache"',
		'         colors="true">',
		'    <testsuites>',
		'        <testsuite name="tests">',
		'            <directory>tests</directory>',
		'        </testsuite>',
		'    </testsuites>',
		'</phpunit>',
		'',
	].join('\n');
}

// ---- Rust: Cargo

/**
 * A Cargo.toml for a project without one (the sample has its own). The
 * package is `app`, the crate name the browser's server and runner use
 * without a manifest, and edition 2021, the newest the browser's rustc
 * (1.78) knows. Cargo finds src/main.rs, src/lib.rs, src/bin/ and tests/ by
 * itself; a main.rs at the root, which the browser also runs, is named as
 * the binary.
 */
export function cargoToml(files: Files): string {
	const lines = ['[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"', ''];
	if (!('src/main.rs' in files) && 'main.rs' in files) lines.push('[[bin]]', 'name = "app"', 'path = "main.rs"', '');
	return lines.join('\n');
}

// ---- Java: Maven

/** JUnit Jupiter, as the browser's Test compiles against (packs/java/build.sh). */
const JUNIT_VERSION = '5.14.4';
/** The Java the browser's javac is (OpenJDK 25u), so the release Maven compiles for. */
const JAVA_RELEASE = '25';
/** Folders the browser's Java runner treats as tests (packs/java/src/runner.js). */
const JAVA_TESTS = /^(src\/test\/|tests?\/)/;

/** The class a Java file's main is in: its package, and the file's name. */
export function javaMainClass(files: Files, entry: string): string {
	const code = (files[entry] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1];
	const name = entry.replace(/^.*\//, '').replace(/\.java$/, '');
	return pkg ? `${pkg}.${name}` : name;
}

/**
 * pom.xml for the project where it is. A project in Maven's layout (every
 * .java file under src/main/java or src/test/java, as the sample is) gets
 * Maven's defaults; any other one compiles every .java file of the folder
 * except the test folders the browser knows (src/test/, test/, tests/),
 * which are the tests. JUnit Jupiter is the version the browser tests with,
 * Surefire runs it, and `mvn exec:exec` runs the entry's class with `java`
 * itself: exec:java calls main by reflection from another package, which
 * fails for the package-private `void main()` of a compact source file (JEP
 * 512).
 */
export function pomXml(files: Files, entry: string): string {
	const java = Object.keys(files).filter((p) => p.endsWith('.java'));
	const maven = java.every((p) => p.startsWith('src/main/java/') || p.startsWith('src/test/java/'));
	const testDir = java.some((p) => p.startsWith('src/test/java/')) ? 'src/test/java' : java.some((p) => p.startsWith('tests/')) ? 'tests' : java.some((p) => p.startsWith('test/')) ? 'test' : 'src/test/java';
	const build = maven
		? []
		: [
				'    <!-- The sources are in the project folder itself, not in src/main/java. -->',
				'    <sourceDirectory>${project.basedir}</sourceDirectory>',
				`    <testSourceDirectory>\${project.basedir}/${testDir}</testSourceDirectory>`,
			];
	const excludes = maven
		? []
		: [
				'        <configuration>',
				'          <excludes>',
				...['src/test/**', 'test/**', 'tests/**', 'target/**', '.*/**'].map((e) => `            <exclude>${e}</exclude>`),
				'          </excludes>',
				'        </configuration>',
			];
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!-- Builds the project where it is, with the layout it had in Yukibana Light:',
		`     mvn compile exec:exec${java.some((p) => JAVA_TESTS.test(p)) ? ', mvn test' : ''} -->`,
		'<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
		'         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
		'  <modelVersion>4.0.0</modelVersion>',
		'  <groupId>yukibana</groupId>',
		'  <artifactId>java-project</artifactId>',
		'  <version>0.1.0</version>',
		'',
		'  <properties>',
		`    <maven.compiler.release>${JAVA_RELEASE}</maven.compiler.release>`,
		'    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
		`    <exec.mainClass>${javaMainClass(files, entry)}</exec.mainClass>`,
		'  </properties>',
		'',
		'  <dependencies>',
		'    <dependency>',
		'      <groupId>org.junit.jupiter</groupId>',
		'      <artifactId>junit-jupiter</artifactId>',
		`      <version>${JUNIT_VERSION}</version>`,
		'      <scope>test</scope>',
		'    </dependency>',
		'  </dependencies>',
		'',
		'  <build>',
		...build,
		'    <plugins>',
		'      <plugin>',
		'        <artifactId>maven-compiler-plugin</artifactId>',
		'        <version>3.14.1</version>',
		...excludes,
		'      </plugin>',
		'      <plugin>',
		'        <artifactId>maven-surefire-plugin</artifactId>',
		'        <version>3.5.6</version>',
		'      </plugin>',
		'      <plugin>',
		'        <groupId>org.codehaus.mojo</groupId>',
		'        <artifactId>exec-maven-plugin</artifactId>',
		'        <version>3.6.4</version>',
		'        <!-- mvn exec:exec runs the program with the JDK that runs Maven, as `java` would. -->',
		'        <configuration>',
		'          <executable>${java.home}/bin/java</executable>',
		'          <inheritIo>true</inheritIo>',
		'          <arguments>',
		'            <argument>-classpath</argument>',
		'            <classpath/>',
		'            <argument>${exec.mainClass}</argument>',
		'          </arguments>',
		'        </configuration>',
		'      </plugin>',
		'    </plugins>',
		'  </build>',
		'</project>',
		'',
	].join('\n');
}

// ---- Kotlin: Gradle

/** The Kotlin Gradle plugin, and so the Kotlin, the download builds with. */
const KOTLIN_VERSION = '2.4.21';
/** Folders treated as tests, as Java's are. */
const KOTLIN_TESTS = /^(src\/test\/|tests?\/)/;

/** The JVM class a Kotlin file's top-level `main` is in: its package, and FileNameKt. */
export function kotlinMainClass(files: Files, entry: string): string {
	const code = (files[entry] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1];
	const base = entry.replace(/^.*\//, '').replace(/\.kts?$/, '');
	const name = `${base.charAt(0).toUpperCase()}${base.slice(1)}Kt`;
	return pkg ? `${pkg}.${name}` : name;
}

/**
 * build.gradle.kts for the project where it is: Kotlin/JVM with the
 * application plugin (`gradle run`, stdin connected) and kotlin.test on
 * JUnit 5 (`gradle test`). A project in Gradle's layout (every .kt file
 * under src/main/kotlin or src/test/kotlin, as the sample is) gets Gradle's
 * defaults; any other one compiles the .kt files of the folder except the
 * test folders (src/test/, test/, tests/), which are the tests. No JVM
 * toolchain is named, so the JDK that runs Gradle compiles and runs it
 * instead of Gradle downloading another.
 */
export function buildGradleKts(files: Files, entry: string): string {
	const kt = Object.keys(files).filter((p) => /\.kts?$/.test(p) && !/(^|\/)(build|settings)\.gradle\.kts$/.test(p));
	const gradle = kt.every((p) => p.startsWith('src/main/kotlin/') || p.startsWith('src/test/kotlin/'));
	const testDir = kt.some((p) => p.startsWith('src/test/kotlin/')) ? 'src/test/kotlin' : kt.some((p) => p.startsWith('tests/')) ? 'tests' : kt.some((p) => p.startsWith('test/')) ? 'test' : 'src/test/kotlin';
	const layout = gradle
		? []
		: [
				'// The sources are in the project folder itself, not in src/main/kotlin.',
				'sourceSets {',
				'    main {',
				'        kotlin.setSrcDirs(listOf("."))',
				'        kotlin.exclude("src/test/**", "test/**", "tests/**", "build/**", ".gradle/**", "*.gradle.kts")',
				'    }',
				'    test {',
				`        kotlin.setSrcDirs(listOf(${JSON.stringify(testDir)}))`,
				'    }',
				'}',
				'',
			];
	return [
		'// Builds the project where it is, with the layout it had in Yukibana Light:',
		`//   gradle run${kt.some((p) => KOTLIN_TESTS.test(p)) ? ', gradle test' : ''}`,
		'plugins {',
		`    kotlin("jvm") version ${JSON.stringify(KOTLIN_VERSION)}`,
		'    application',
		'}',
		'',
		'repositories {',
		'    mavenCentral()',
		'}',
		'',
		'dependencies {',
		'    testImplementation(kotlin("test"))',
		'}',
		'',
		...layout,
		'application {',
		`    mainClass = ${JSON.stringify(kotlinMainClass(files, entry))}`,
		'}',
		'',
		'tasks.named<JavaExec>("run") {',
		'    standardInput = System.`in`',
		'}',
		'',
		'tasks.test {',
		'    useJUnitPlatform()',
		'}',
		'',
	].join('\n');
}

// ---- Haskell: Cabal

/** Folders treated as tests: hspec's `test/` and the sample's `tests/`. */
const HASKELL_TESTS = /^tests?\//;

/** A Haskell file's module and the source directory it is found from. */
interface HaskellModule {
	path: string;
	/** Main for a file without a header, as Haskell says. */
	name: string;
	/** As hs-source-dirs wants it: `.` for the project folder. */
	dir: string;
}

/**
 * Each `.hs` file's module and source directory, as the Haskell pack finds
 * them (packs/haskell/src/project.js, sourceRoots): a file whose path ends
 * as its module name says is found from the folder above that path, any
 * other from its own folder.
 */
function haskellModules(files: Files): HaskellModule[] {
	return Object.entries(files)
		.filter(([p]) => p.endsWith('.hs'))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, text]) => {
			const code = text.replace(/\{-[\s\S]*?-\}/g, ' ').replace(/--.*$/gm, '');
			const name = /^\s*module\s+([A-Z][\w']*(?:\.[A-Z][\w']*)*)/.exec(code)?.[1] ?? 'Main';
			const tail = `${name.replaceAll('.', '/')}.hs`;
			const own = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			const dir = path === tail || path.endsWith(`/${tail}`) ? path.slice(0, path.length - tail.length).replace(/\/$/, '') : own;
			return { path, name, dir: dir || '.' };
		});
}

/** A stanza field's list, one entry per line as cabal-fmt writes it. */
function cabalList(field: string, items: readonly string[]): string[] {
	if (items.length === 0) return [];
	return [`    ${field}:`, ...items.map((item, i) => `${i === 0 ? '        ' : '      , '}${item}`)];
}

/**
 * The packages a project's imports come from, as Yukibana's GHC has them
 * (packs/haskell: the ones a project may import there), each with the lower
 * bound a cabal build needs: `containers >=0.6` when a file imports
 * Data.Map. base is not among them. In the order of the table.
 */
const HASKELL_PACKAGES: readonly (readonly [string, RegExp])[] = [
	['containers >=0.6', /^Data\.(Map|Set|IntMap|IntSet|Sequence|Graph|Tree|Containers)\b/],
	['mtl >=2.2', /^Control\.Monad\.(State|Reader|Writer|Except|RWS|Cont|Identity|Error\.Class|Accum|Select)\b/],
	['transformers >=0.5', /^Control\.Monad\.Trans\b|^Data\.Functor\.(Constant|Reverse)\b|^Control\.Applicative\.(Backwards|Lift)\b/],
	['text >=2.0', /^Data\.Text\b/],
	['bytestring >=0.11', /^Data\.ByteString\b/],
	['array >=0.5', /^Data\.Array\b/],
	['deepseq >=1.4', /^Control\.DeepSeq\b/],
	['directory >=1.3', /^System\.Directory\b/],
	['filepath >=1.4', /^System\.(FilePath|OsPath)\b/],
	['time >=1.9', /^Data\.Time\b/],
	['stm >=2.5', /^Control\.(Concurrent\.STM|Monad\.STM)\b/],
	['exceptions >=0.10', /^Control\.Monad\.Catch\b/],
	['random >=1.2', /^System\.Random\b/],
	['QuickCheck >=2.14', /^Test\.QuickCheck\b/],
	['hspec >=2.10', /^Test\.Hspec\b/],
];

/** The build-depends of HASKELL_PACKAGES that some file of `files` imports a module of. */
export function haskellDepends(files: Files): string[] {
	const imported = Object.entries(files)
		.filter(([p]) => p.endsWith('.hs'))
		.flatMap(([, t]) => [...t.matchAll(/^\s*import\s+(?:safe\s+)?(?:qualified\s+)?(?:"[^"]*"\s+)?([A-Z][\w.']*)/gm)].map((m) => m[1] ?? ''));
	return HASKELL_PACKAGES.filter(([, re]) => imported.some((m) => re.test(m))).map(([d]) => d);
}

/**
 * haskell-project.cabal for the project where it is: the program from
 * `entry` with every other module outside the test folders, and, when the
 * project has tests, a test suite from tests/Spec.hs (or test/Spec.hs, or
 * the first test file with a `main`, the runner's choice) on hspec. The
 * browser checks and runs it with GHC 9.14 (-Wall, its default language
 * GHC2021), as `cabal build` does with this file. The packages the
 * project's imports come from are its dependencies (haskellDepends), hspec
 * the test suite's.
 */
export function haskellCabal(files: Files, entry: string): string {
	const modules = haskellModules(files);
	const main = modules.find((m) => m.path === entry);
	const tests = modules.filter((m) => HASKELL_TESTS.test(m.path));
	const testMain =
		['tests/Spec.hs', 'test/Spec.hs'].map((p) => tests.find((m) => m.path === p)).find((m) => m !== undefined) ??
		tests.find((m) => /^main\s*(::|=)/m.test(files[m.path] ?? ''));
	// Main modules other than the two entries are programs of their own,
	// which a component cannot hold beside its own Main.
	const library = modules.filter((m) => m.name !== 'Main' && !HASKELL_TESTS.test(m.path));
	const testOnly = tests.filter((m) => m.name !== 'Main');
	const depends = haskellDepends(files);
	const mainIs = (m: HaskellModule) => (m.dir === '.' ? m.path : m.path.slice(m.dir.length + 1));
	const dirs = (ms: readonly (HaskellModule | undefined)[]) => [...new Set(ms.flatMap((m) => (m ? [m.dir] : [])))];
	const lines = [
		'cabal-version: 3.0',
		'name:          haskell-project',
		'version:       0.1.0.0',
		'build-type:    Simple',
		'',
		'common shared',
		'    default-language: GHC2021',
		'    ghc-options:      -Wall',
		...cabalList('build-depends', ['base >=4.16 && <5', ...depends.filter((d) => !d.startsWith('hspec '))]),
		'',
		'executable haskell-project',
		'    import:           shared',
		`    main-is:          ${main ? mainIs(main) : entry}`,
		`    hs-source-dirs:   ${dirs([main ?? { path: entry, name: 'Main', dir: '.' }, ...library]).join(' ')}`,
		...cabalList('other-modules', library.map((m) => m.name)),
	];
	if (testMain) {
		lines.push(
			'',
			'test-suite spec',
			'    import:           shared',
			'    type:             exitcode-stdio-1.0',
			`    main-is:          ${mainIs(testMain)}`,
			`    hs-source-dirs:   ${dirs([testMain, ...testOnly, ...library]).join(' ')}`,
			...cabalList('other-modules', [...testOnly, ...library].map((m) => m.name)),
			...cabalList('build-depends', ['hspec >=2.10']),
		);
	}
	return `${lines.join('\n')}\n`;
}

// ---- Every language: README.md and .gitignore

/**
 * The README's Test section for a Node project: `node --test`, after `npm
 * install` when it uses fast-check, and mutation testing with StrykerJS.
 */
function testSection(files: Files): string {
	const test = Object.keys(shippedPackages(files)).length
		? '## Test\n\nThe tests use `node:test` and fast-check (property-based tests):\n\n```sh\nnpm install               # fast-check\nnode --test               # or: npm test\n```'
		: '## Test\n\nThe tests use `node:test`:\n\n```sh\nnode --test               # or: npm test\n```';
	return `${test}\n\n## Mutation testing\n\nStrykerJS ${STRYKER_VERSION}, as Mutate runs it in Yukibana, configured in \`stryker.config.json\` (its tap runner runs each test file in a process of its own):\n\n\`\`\`sh\nnpm run mutate            # npx fetches Stryker the first time\n\`\`\`\n\nThe report is printed and written to \`reports/mutation/mutation.html\`.`;
}

/** The README's section for a project the browser builds for a Linux target; none for the default target. */
function crossSection(target: CppTarget | null): string[] {
	if (!target) return [];
	return [
		`## Target\n\nIn Yukibana Light this project is built for ${target.label} (\`${target.triple}\`, the \`--target\` line of \`compile_flags.txt\`) and runs under QEMU. CMake leaves the target out and builds for the machine it runs on. To cross compile, use a toolchain file that sets \`CMAKE_CXX_COMPILER_TARGET=${target.triple}\` (and \`CMAKE_C_COMPILER_TARGET\` for C) with a clang and a musl sysroot for it (\`CMAKE_SYSROOT\`); the program then runs on a ${target.arch} Linux machine, or elsewhere under \`qemu-${target.arch}\`.`,
	];
}

/** How to build, run and test with each language's tools, as Markdown sections. */
function instructions(language: Language, files: Files): string[] {
	const paths = Object.keys(files);
	switch (language.id) {
		case 'cpp': {
			const tests = paths.some((p) => TESTS.test(p) && (CXX.test(p) || C.test(p)));
			return [
				'## Build and run\n\nWith CMake 3.16 or later and a C++ compiler:\n\n```sh\ncmake -S . -B build\ncmake --build build\n./build/app\n```',
				...(tests ? [`## Test\n\nThe tests in \`tests/\` use ${{ gtest: `GoogleTest ${GTEST_VERSION}`, doctest: `doctest ${DOCTEST_VERSION}`, catch2: `Catch2 ${CATCH2_VERSION}` }[testFrameworkOf(files)]}, which CMake downloads the first time it configures the build:\n\n\`\`\`sh\nctest --test-dir build --output-on-failure\n\`\`\``] : []),
				...crossSection(linuxTarget(files)),
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
			const hypothesis = usesHypothesis(files);
			return [
				`## Run\n\nWith Python 3.12 or later:\n\n\`\`\`sh\npython ${language.entry}\n\`\`\``,
				...(tests
					? [`## Test\n\nThe tests use pytest${hypothesis ? ' and Hypothesis' : ''}:\n\n\`\`\`sh\npython -m venv .venv\n. .venv/bin/activate        # .venv\\Scripts\\activate on Windows\npython -m pip install pytest${hypothesis ? ' hypothesis' : ''}\npython -m pytest\n\`\`\`\n\nOr, with uv: \`uv run pytest\`.`]
					: []),
				'## Editors\n\nPyCharm and VS Code (with the Python extension) open the folder; pytest is configured in `pyproject.toml`.',
			];
		}
		case 'javascript': {
			const tests = paths.some((p) => /(^|\/)test\//.test(p) || /(^|\/)([^/]+[.\-_]test|test-[^/]*|test)\.m?js$/.test(p));
			return [
				`## Run\n\nWith Node.js 22 or later:\n\n\`\`\`sh\nnode ${language.entry}     # or: npm start\n\`\`\``,
				...(tests ? [testSection(files)] : []),
				`## Editors\n\nVS Code and WebStorm open the folder as it is; ${Object.keys(shippedPackages(files)).length ? 'run `npm install` first, for fast-check' : 'there is nothing to install'}.`,
			];
		}
		case 'typescript': {
			const tests = paths.some((p) => /(^|\/)test\//.test(p) || /(^|\/)([^/]+[.\-_]test|test-[^/]*|test)\.m?[jt]s$/.test(p));
			return [
				`## Run\n\nWith Node.js 22.18 or later, which runs TypeScript by stripping its types (nothing to install):\n\n\`\`\`sh\nnode ${language.entry}     # or: npm start\n\`\`\``,
				...(tests ? [testSection(files)] : []),
				'## Editors\n\nVS Code and WebStorm open the folder as it is. Node only strips types, so `tsconfig.json` sets `erasableSyntaxOnly` (no `enum` or `namespace`) and imports name their `.ts` files. For the types of `node:test` and `process` outside Yukibana, `npm install -D @types/node` and add `"types": ["node"]` to `tsconfig.json`.',
			];
		}
		case 'web':
		case 'p5':
			return [
				'## Run\n\nWith Node.js 20.19 or later:\n\n```sh\nnpm install\nnpm run dev                 # a local server that reloads as you edit\nnpm run build               # the site, in dist/\nnpm run typecheck           # tsc: Vite does not check types\n```',
				'## Editors\n\nVS Code and WebStorm open the folder as it is.',
			];
		case 'scala': {
			const tests = paths.some((p) => p.startsWith('tests/') && /\.(scala|java)$/.test(p));
			return [
				`## Build and run\n\nWith sbt and a JDK 17 or later (sbt downloads Scala ${SCALA_VERSION}):\n\n\`\`\`sh\nsbt run\n\`\`\``,
				...(tests ? [`## Test\n\nThe tests in \`tests/\` use MUnit ${MUNIT_VERSION}:\n\n\`\`\`sh\nsbt test\n\`\`\``] : []),
				'## Editors\n\nIntelliJ IDEA (with the Scala plugin) opens the folder and imports `build.sbt`; VS Code with Metals offers to import the build when the folder is opened.',
			];
		}
		case 'rust': {
			const tests = paths.some((p) => /^tests\/[^/]+\.rs$/.test(p)) || Object.entries(files).some(([p, t]) => p.endsWith('.rs') && /#\[test\]/.test(t));
			return [
				'## Build and run\n\nWith Rust (rustup from rustup.rs installs cargo):\n\n```sh\ncargo run\n```\n\nThe browser runs the program with Miri on Rust 1.78, so code written there builds with that release or any later one.',
				...(tests ? ['## Test\n\nThe unit tests (`#[cfg(test)]` modules) and the integration tests in `tests/`:\n\n```sh\ncargo test\n```'] : []),
				'## Editors\n\nVS Code (with the rust-analyzer extension), RustRover and Zed open the folder and read `Cargo.toml`.',
			];
		}
		case 'php': {
			const tests = paths.some((p) => p.startsWith('tests/') && p.endsWith('.php'));
			return [
				`## Run\n\nWith PHP 8.3 or later:\n\n\`\`\`sh\nphp ${language.entry}\n\`\`\``,
				...(tests
					? [`## Test\n\nThe tests in \`tests/\` use PHPUnit ${PHPUNIT_VERSION}, which Composer installs into \`vendor/\`:\n\n\`\`\`sh\ncomposer install\ncomposer test               # or: vendor/bin/phpunit\n\`\`\``]
					: []),
				'## Editors\n\nPhpStorm and VS Code (with a PHP extension: Phpactor, Intelephense) open the folder; they read `composer.json` for the autoloading and `phpunit.xml` for the tests.',
			];
		}
		case 'kotlin': {
			const tests = paths.some((p) => KOTLIN_TESTS.test(p) && p.endsWith('.kt'));
			return [
				`## Build and run\n\nWith Gradle 8.14 or later and a JDK 17 or later (Gradle downloads Kotlin ${KOTLIN_VERSION}):\n\n\`\`\`sh\ngradle run -q --console=plain\n\`\`\`\n\n\`gradle wrapper\` adds \`./gradlew\`, which pins Gradle for everyone who builds the project.`,
				...(tests ? ['## Test\n\nThe tests use kotlin.test on JUnit 5:\n\n```sh\ngradle test\n```'] : []),
				'## Editors\n\nIntelliJ IDEA opens the folder and imports `build.gradle.kts`; so do Android Studio and, with the Kotlin extension, VS Code.',
			];
		}
		case 'haskell': {
			const tests = paths.some((p) => HASKELL_TESTS.test(p) && p.endsWith('.hs'));
			return [
				'## Build and run\n\nWith GHC 9.4 or later and cabal 3.8 or later (GHCup from haskell.org installs both):\n\n```sh\ncabal run -v0\n```\n\nThe browser checks and runs the project with GHC 9.14 and the flags this build uses (`GHC2021`, `-Wall`), so what it reported there is what GHC reports here.',
				...(tests ? ['## Test\n\nThe tests use hspec, which cabal downloads the first time:\n\n```sh\ncabal test --test-show-details=direct\n```'] : []),
				'## Editors\n\nVS Code (with the Haskell extension), Emacs, Vim and Zed run the Haskell Language Server, which reads the `.cabal` file; GHCup installs it with `ghcup install hls`.',
			];
		}
		case 'java': {
			const tests = paths.some((p) => JAVA_TESTS.test(p) && p.endsWith('.java'));
			return [
				`## Build and run\n\nWith Maven 3.9 or later and a JDK ${JAVA_RELEASE} or later:\n\n\`\`\`sh\nmvn -q compile exec:exec\n\`\`\`\n\nOr, without Maven: \`java ${language.entry}\` (\`java\` 22 or later compiles the other files the program uses from the same source folder).`,
				...(tests ? [`## Test\n\nThe tests use JUnit ${JUNIT_VERSION}:\n\n\`\`\`sh\nmvn test\n\`\`\``] : []),
				'## Editors\n\nIntelliJ IDEA, Eclipse and VS Code (with the Extension Pack for Java) open the folder and import `pom.xml`.',
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
	javascript: ['node_modules/', '.stryker-tmp/', 'reports/'],
	typescript: ['node_modules/', '.stryker-tmp/', 'reports/'],
	web: ['node_modules/', 'dist/'],
	p5: ['node_modules/', 'dist/'],
	scala: ['target/', 'project/target/', 'project/project/', '.bsp/', '.bloop/', '.metals/', 'metals.sbt'],
	php: ['vendor/', '.phpunit.cache/', '.phpunit.result.cache'],
	rust: ['target/'],
	java: ['target/', '*.class', '.classpath', '.project', '.settings/', '*.iml'],
	kotlin: ['build/', '.gradle/', '.kotlin/', '*.class', '*.iml'],
	haskell: ['dist-newstyle/', '.stack-work/', '*.hi', '*.o', '*.dyn_hi', '*.dyn_o'],
};

/** A .gitignore for the build output of the language's tools. */
function gitignore(language: LanguageId): string {
	return ['# Build output', ...IGNORED[language], '', '# Editors and systems', '.idea/', '.DS_Store', ''].join('\n');
}
