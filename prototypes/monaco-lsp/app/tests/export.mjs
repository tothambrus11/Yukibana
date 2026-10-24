// Downloads each sample project as the app does (src/lib/export.ts and
// src/lib/zip.ts), unpacks the zip, and builds, runs and tests it with the
// language's own tools where this machine has them: CMake and a C++
// compiler with CTest, SwiftPM, Node, Python with pytest (installed into a
// venv), sbt. A tool that is missing is reported as skipped, not as passed.
//
//   node tests/export.mjs [language ...]
//
// Needs Node 22.18 or later (it loads the TypeScript sources directly) and
// python3 (to check the zip with the standard zipfile module). Exits non-zero
// naming every check that failed. Set KEEP=1 to keep the unpacked projects.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LANGUAGES } from '../src/lib/languages.ts';
import { buildSbt, exportProject, parseCompileFlags } from '../src/lib/export.ts';
import { zip } from '../src/lib/zip.ts';
import { chooseTestFramework } from '../src/lib/cpp-tests.ts';
import { PROPERTIES } from '../../packs/cpp/tests/fixtures/properties.mjs';

const only = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), 'yukibana-export-'));
const failures = [];
const skipped = [];
const check = (ok, what, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what + (detail ? `\n${detail}` : ''));
	return ok;
};
const skip = (what) => {
	console.log(`skip ${what}`);
	skipped.push(what);
};

/** Runs a command; returns its status and output (stdout and stderr together). */
function run(command, args, cwd, env = {}) {
	const r = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 64 << 20 });
	return { status: r.error ? -1 : r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}
const has = (command) => run('sh', ['-c', `command -v ${command}`], work).status === 0;
const tail = (text) => text.trim().split('\n').slice(-15).join('\n');

/** Runs a step and checks its status and, if given, that its output says `expect`. */
function step(what, command, args, cwd, expect, env) {
	const r = run(command, args, cwd, env);
	const ok = r.status === 0 && (!expect || r.output.includes(expect));
	check(ok, what, tail(r.output));
	return r;
}

// ---- What the export must be, whatever the tools

const sample = (id) => LANGUAGES.find((l) => l.id === id);

for (const language of LANGUAGES) {
	const { files, generated } = exportProject(language, language.sample);
	check(Object.entries(language.sample).every(([p, t]) => files[p] === t), `${language.id}: every file of the project is in the download unchanged`);
	check(generated.every((p) => !(p in language.sample) && p in files), `${language.id}: only files the project lacks are generated (${generated.join(', ')})`);
}
{
	const cpp = sample('cpp');
	const own = { ...cpp.sample, 'CMakeLists.txt': '# mine\n', 'readme.txt': 'mine\n', '.gitignore': 'mine\n' };
	const { files, generated } = exportProject(cpp, own);
	check(files['CMakeLists.txt'] === '# mine\n' && files['.gitignore'] === 'mine\n' && !('README.md' in files) && generated.length === 0, "cpp: a project's own CMakeLists.txt, README and .gitignore are kept, and nothing is generated over them");
}

// ---- C++ targets: the browser's --target line is not CMake's business

{
	const cpp = sample('cpp');
	const forms = ['--target=aarch64-linux-musl', '-target\naarch64-linux-musl', '--target\naarch64-linux-musl', '-target=aarch64-linux-musl'];
	for (const form of forms) {
		const flags = parseCompileFlags(`-std=c++20\n${form}\n-Wall\n-I.\n`);
		check(flags.target === 'aarch64-linux-musl' && flags.options.join(' ') === '-Wall' && flags.includes.join(' ') === '.', `cpp: ${JSON.stringify(form)} in compile_flags.txt is read as the target, not as a CMake option (${JSON.stringify(flags)})`);
	}
	const plain = exportProject(cpp, cpp.sample).files;
	const onWasm = exportProject(cpp, { ...cpp.sample, 'compile_flags.txt': `--target=wasm32-wasip1\n${cpp.sample['compile_flags.txt']}` }).files;
	check(!/COMPILER_TARGET|--target|## Target/.test(plain['CMakeLists.txt'] + plain['README.md']), 'cpp: the sample, on the default target, gets no target note in CMakeLists.txt or README.md');
	check(onWasm['CMakeLists.txt'] === plain['CMakeLists.txt'] && onWasm['README.md'] === plain['README.md'], "cpp: naming the default target (--target=wasm32-wasip1) changes neither CMakeLists.txt nor README.md");
	for (const [triple, arch] of [['x86_64-linux-musl', 'x86_64'], ['aarch64-linux-musl', 'aarch64'], ['riscv64-linux-musl', 'riscv64']]) {
		const { files } = exportProject(cpp, { ...cpp.sample, 'compile_flags.txt': `--target=${triple}\n${cpp.sample['compile_flags.txt']}` });
		const cmake = files['CMakeLists.txt'];
		const options = /target_compile_options\(project_flags INTERFACE ([^)]*)\)/.exec(cmake)?.[1] ?? '';
		check(!options.includes('target') && options === '-Wall -Wextra', `cpp on ${arch}: --target is not passed to CMake (options: ${options})`);
		check(cmake.startsWith('# Builds the project') && cmake.includes(`# In the browser, this project is built for ${triple}`) && cmake.includes(`CMAKE_CXX_COMPILER_TARGET=${triple}`), `cpp on ${arch}: CMakeLists.txt says CMake builds natively and how to cross compile`);
		check(cmake.replace(/^# In the browser[^\n]*\n#[^\n]*\n#[^\n]*\n/m, '') === plain['CMakeLists.txt'], `cpp on ${arch}: apart from that note, CMakeLists.txt is the default target's`);
		check(files['README.md'].includes('## Target') && files['README.md'].includes(`\`CMAKE_CXX_COMPILER_TARGET=${triple}\``) && files['README.md'].includes(`qemu-${arch}`), `cpp on ${arch}: README.md has a Target section`);
	}
	const unknown = exportProject(cpp, { ...cpp.sample, 'compile_flags.txt': '--target=armv7-linux-musleabihf\n-Wall\n' }).files['CMakeLists.txt'];
	check(!/COMPILER_TARGET|armv7/.test(unknown), 'cpp: a target the browser does not know is left out of CMakeLists.txt, note and all');
}

// ---- Optimisation levels: Download builds at the level Run uses

{
	const cpp = sample('cpp');
	const levels = (cmake) => [...cmake.matchAll(/target_compile_options\(project_flags INTERFACE ([^)]*)\)/g)].flatMap((m) => m[1].split(' ')).filter((o) => o.startsWith('-O'));
	const plain = exportProject(cpp, cpp.sample).files['CMakeLists.txt'];
	check(levels(plain).join(' ') === '-O2', `cpp: without a -O line, CMake builds at -O2, Run's default (${levels(plain)})`);
	const chosen = exportProject(cpp, { ...cpp.sample, 'compile_flags.txt': `${cpp.sample['compile_flags.txt']}-O0\n` }).files['CMakeLists.txt'];
	check(levels(chosen).join(' ') === '-O0', `cpp: the -O line of compile_flags.txt is CMake's level, and the only one (${levels(chosen)})`);
	const swift = sample('swift');
	const settings = (pkg) => [...pkg.matchAll(/unsafeFlags\(\[([^\]]*)\]\)/g)].map((m) => m[1]);
	check(settings(exportProject(swift, swift.sample).files['Package.swift']).every((f) => !/"-O/.test(f)), 'swift: at the default level (-Onone), Package.swift sets none');
	const osize = settings(exportProject(swift, swift.sample, '-Osize').files['Package.swift']);
	check(osize.length === 2 && osize.every((f) => f.startsWith('"-Osize"')), `swift: a chosen level goes to the program and to the tests (${osize.join(' | ')})`);
}

// ---- The zip, unpacked by Python's zipfile

const unpack = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
if bad: sys.exit("corrupt: " + bad)
z.extractall(sys.argv[2])
print(json.dumps({i.filename: i.compress_type for i in z.infolist()}))
`;

/** Zips a project as the app does, unpacks it with Python and returns the folder. */
async function download(name, language, files, folders = []) {
	const exported = exportProject(language, files);
	const root = `${language.id}-project`;
	const paths = Object.keys(exported.files).sort();
	const archive = await zip([...folders.map((f) => ({ path: `${root}/${f}/` })), ...paths.map((p) => ({ path: `${root}/${p}`, text: exported.files[p] }))]);
	const zipPath = join(work, `${name}.zip`);
	writeFileSync(zipPath, new Uint8Array(await archive.arrayBuffer()));
	const out = join(work, name);
	const r = run('python3', ['-I', '-c', unpack, zipPath, out], work);
	if (!check(r.status === 0, `${name}: the zip is valid and unpacks`, r.output)) return null;
	const dir = join(out, root);
	const same = paths.every((p) => readFileSync(join(dir, p), 'utf8') === exported.files[p]) && folders.every((f) => existsSync(join(dir, f)));
	check(same, `${name}: unpacked, every file has its text and every empty folder is there`);
	return dir;
}

// ---- Each language with its own tools

const PACK_CACHE = process.env.PACK_CACHE ?? join(homedir(), '.cache', 'yukibana-packs');

/** The C++ sample with its tests in each framework, as the app's framework choice writes them. */
const CPP_FRAMEWORKS = { gtest: 'GoogleTest', doctest: 'doctest', catch2: 'Catch2' };

async function cpp(name, files, framework = 'gtest', { count = 3 } = {}) {
	const label = CPP_FRAMEWORKS[framework];
	const cmake = exportProject(sample('cpp'), files).files['CMakeLists.txt'];
	check(cmake.includes(`with ${label} `), `${name}: CMakeLists.txt fetches ${label}, the framework tests/ includes`);
	const rapidcheck = Object.values(files).some((text) => /#include <rapidcheck/.test(text));
	check(cmake.includes('GIT_REPOSITORY https://github.com/emil-e/rapidcheck.git') === rapidcheck, `${name}: CMakeLists.txt fetches RapidCheck ${rapidcheck ? 'because a test includes it' : 'only when a source includes it'}`);
	const dir = await download(name, sample('cpp'), files);
	if (!dir) return;
	if (!has('cmake') || !(has('c++') || has('g++') || has('clang++'))) return skip(`${name}: cmake or a C++ compiler is missing`);
	if (step(`${name}: cmake configures (and downloads ${label})`, 'cmake', ['-S', '.', '-B', 'build'], dir).status !== 0) return;
	// A bounded -j: Catch2 is a hundred translation units.
	step(`${name}: cmake --build`, 'cmake', ['--build', 'build', '-j', '3'], dir);
	check(existsSync(join(dir, 'build', 'compile_commands.json')), `${name}: build/compile_commands.json is written for clangd`);
	step(`${name}: ./build/app prints the distance`, join(dir, 'build', 'app'), [], dir, '5.000000');
	// Each framework's discovery registers the sample's three tests one by one.
	step(`${name}: ctest runs the ${label} tests, each on its own`, 'ctest', ['--test-dir', 'build', '--output-on-failure'], dir, `100% tests passed, 0 tests failed out of ${count}`);
}

async function swift(name, files) {
	const dir = await download(name, sample('swift'), files);
	if (!dir) return;
	const bin = has('swift') ? null : join(PACK_CACHE, 'swift', 'toolchain', 'usr', 'bin');
	if (bin && !existsSync(join(bin, 'swift'))) return skip(`${name}: swift is missing`);
	const env = bin ? { PATH: `${bin}:${process.env.PATH}` } : {};
	const build = step(`${name}: swift build`, 'swift', ['build'], dir, 'Build complete', env);
	check(!/unhandled/.test(build.output), `${name}: SwiftPM finds no unhandled file in the package`, tail(build.output));
	step(`${name}: swift run prints the distance`, 'swift', ['run'], dir, '(0.0, 0.0) to (3.0, 4.0): 5.0', env);
	step(`${name}: swift test runs the XCTest tests`, 'swift', ['test'], dir, 'Executed 2 tests, with 0 failures', env);
}

/** `npm install` for a download whose package.json has dependencies (fast-check); false, after a skip, when it fails. */
function npmInstall(name, dir) {
	const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	if (!json.dependencies && !json.devDependencies) return true;
	const install = run('npm', ['install', '--no-audit', '--no-fund'], dir);
	if (install.status === 0) return true;
	skip(`${name}: npm install failed (no registry?): ${tail(install.output)}`);
	return false;
}

async function javascript(name, files) {
	const dir = await download(name, sample('javascript'), files);
	if (!dir) return;
	if (!npmInstall(name, dir)) return;
	step(`${name}: npm start prints the distance`, 'npm', ['start', '--silent'], dir, '(0, 0) to (3, 4): 5');
	step(`${name}: npm test runs node --test`, 'npm', ['test', '--silent'], dir, 'pass 4');
	// The browser's Mutate prints this very row for the sample (packs/javascript/test-run.mjs).
	step(`${name}: npm run mutate runs StrykerJS with its tap runner, with the score Mutate gives`, 'npm', ['run', 'mutate', '--silent'], dir, 'All files    |  77.78 |  100.00 |        7 |         0 |          0 |        2 |        0 |');
}

async function typescript(name, files) {
	const dir = await download(name, sample('typescript'), files);
	if (!dir) return;
	// Node 22.18 and later run .ts files by stripping their types; earlier ones cannot run this project.
	const [major, minor] = process.versions.node.split('.').map(Number);
	if (major < 22 || (major === 22 && minor < 18)) return skip(`${name}: node ${process.version} cannot strip types (22.18 or later can)`);
	if (!npmInstall(name, dir)) return;
	step(`${name}: npm start runs main.ts with Node's type stripping`, 'npm', ['start', '--silent'], dir, '(0, 0) to (3, 4): 5');
	step(`${name}: npm test runs node --test, which finds tests/*.test.ts`, 'npm', ['test', '--silent'], dir, 'pass 4');
	step(`${name}: npm run mutate runs StrykerJS over the .ts files`, 'npm', ['run', 'mutate', '--silent'], dir, ' geometry.ts |');
}

/** A web project (`web`, or the p5.js sketch `p5`) as a Vite project: it builds, and tsc finds no errors. */
async function web(name, files, id = 'web') {
	const dir = await download(name, sample(id), files);
	if (!dir) return;
	const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	const p5 = Object.values(files).some((t) => /from 'p5'/.test(t));
	check(p5 ? json.dependencies?.p5 === '^2.3.4' : !json.dependencies, `${name}: package.json ${p5 ? 'has p5 as a dependency, at the version Preview runs' : 'has no dependencies'}`, JSON.stringify(json));
	const install = run('npm', ['install', '--no-audit', '--no-fund'], dir);
	if (install.status !== 0) return skip(`${name}: npm install failed (no registry?): ${tail(install.output)}`);
	step(`${name}: npm run build (vite build) builds the page`, 'npm', ['run', 'build'], dir, 'built in');
	const built = existsSync(join(dir, 'dist', 'index.html')) ? readFileSync(join(dir, 'dist', 'index.html'), 'utf8') : '';
	check(/<script type="module"[^>]*src="\/assets\/[^"]+\.js"/.test(built) && /<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/.test(built), `${name}: dist/index.html loads the bundled script and stylesheet`, built);
	step(`${name}: npm run typecheck (tsc) finds no errors`, 'npm', ['run', 'typecheck'], dir);
}

async function python(name, files) {
	const dir = await download(name, sample('python'), files);
	if (!dir) return;
	const venv = join(work, 'venv');
	if (!existsSync(venv)) {
		const r = run('python3', ['-m', 'venv', venv], work);
		const pip = r.status === 0 && run(join(venv, 'bin', 'python'), ['-m', 'pip', 'install', '--quiet', 'pytest>=9', 'hypothesis>=6.170'], work);
		if (!pip || pip.status !== 0) return skip(`${name}: could not install pytest and Hypothesis into a venv: ${tail((pip || r).output)}`);
	}
	const py = join(venv, 'bin', 'python');
	step(`${name}: python main.py prints the distance`, py, ['main.py'], dir, 'to Point(x=3, y=4): 5.0');
	step(`${name}: python -m pytest finds tests/ through pyproject.toml`, py, ['-m', 'pytest'], dir, '6 passed');
	step(`${name}: pytest run on the tests folder imports the project's modules`, py, ['-m', 'pytest', 'tests'], dir, '6 passed');
}

/** sbt run of a Scala project, its output expected to contain `expect`. */
async function scalaRun(name, files, expect) {
	const dir = await download(name, sample('scala'), files);
	if (!dir) return;
	const { sbt, flags } = sbtCommand();
	if (!sbt) return skip(`${name}: sbt is missing`);
	step(`${name}: sbt run prints the report`, sbt, [...flags, '--batch', 'run'], dir, expect);
}

/** sbt on the PATH, or the one the Scala pack built with, with its caches and mirror. */
function sbtCommand() {
	const cache = join(PACK_CACHE, 'scala');
	if (has('sbt')) return { sbt: 'sbt', flags: [] };
	const sbt = join(cache, 'bin', 'sbt-1.11.7', 'bin', 'sbt');
	if (!existsSync(sbt)) return { sbt: null, flags: [] };
	const flags = [`-Dsbt.global.base=${cache}/sbt-global`, `-Dsbt.boot.directory=${cache}/sbt-boot`, `-Dsbt.ivy.home=${cache}/ivy2`, `-Dsbt.coursier.home=${cache}/coursier`];
	if (existsSync(join(cache, 'sbt-project', 'repositories'))) flags.push(`-Dsbt.repository.config=${cache}/sbt-project/repositories`, '-Dsbt.override.build.repos=true');
	return { sbt, flags };
}

async function scala(name, files, expectTests) {
	const dir = await download(name, sample('scala'), files);
	if (!dir) return;
	const { sbt, flags } = sbtCommand();
	if (!sbt) return skip(`${name}: sbt is missing`);
	step(`${name}: sbt run prints the distance`, sbt, [...flags, '--batch', 'run'], dir, 'Point(0.0,0.0) to Point(3.0,4.0): 5.0');
	if (expectTests) step(`${name}: sbt test runs the MUnit suite in tests/`, sbt, [...flags, '--batch', 'test'], dir, `Passed: Total ${expectTests}`);
}

/**
 * PHP with the machine's php and composer. `composer install` is not run:
 * without a GitHub token Composer cannot fetch PHPUnit's release zips
 * through GitHub's API and falls back to cloning every repository with its
 * whole history (gigabytes). Instead: Composer resolves the dependencies
 * from Packagist without installing (`update --dry-run`), writes the
 * autoloader (`dump-autoload`, no download), and the tests run with the
 * PHPUnit phar the PHP pack uses in the browser, which reads phpunit.xml and
 * its bootstrap, vendor/autoload.php, as vendor/bin/phpunit would.
 */
async function php(name, files, expectTests) {
	const dir = await download(name, sample('php'), files);
	if (!dir) return;
	if (!has('php') || !has('composer')) return skip(`${name}: php or composer is missing`);
	const env = { COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_INTERACTION: '1' };
	if (files['main.php']?.includes('distance')) step(`${name}: php main.php prints the distance`, 'php', ['main.php'], dir, '(0, 0) to (3, 4): 5');
	step(`${name}: composer validates composer.json`, 'composer', ['validate', '--no-check-publish'], dir, undefined, env);
	const resolve = run('composer', ['update', '--dry-run', '--no-progress'], dir, env);
	if (resolve.status !== 0) skip(`${name}: composer could not resolve from Packagist (offline?): ${tail(resolve.output)}`);
	else check(/phpunit\/phpunit \(12\./.test(resolve.output), `${name}: composer resolves phpunit/phpunit 12 from Packagist`, tail(resolve.output));
	if (step(`${name}: composer dump-autoload writes the class map`, 'composer', ['dump-autoload'], dir, undefined, env).status !== 0) return;
	const phar = join(PACK_CACHE, 'php', 'dl', 'phpunit-12.5.40.phar');
	if (!existsSync(phar)) return skip(`${name}: ${phar} is missing (packs/php/build.sh downloads it)`);
	step(`${name}: PHPUnit runs tests/ through phpunit.xml and vendor/autoload.php`, 'php', [phar], dir, expectTests);
}

/**
 * A PHP project whose tests use Eris: composer.json asks for it and Composer
 * resolves it from Packagist. Not installed and run here (see `php`:
 * `composer install` clones every dependency's history without a GitHub
 * token); packs/php/test-run.mjs runs Eris tests in the browser.
 */
async function phpEris(name, files) {
	const dir = await download(name, sample('php'), files);
	if (!dir) return;
	if (!has('php') || !has('composer')) return skip(`${name}: php or composer is missing`);
	const env = { COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_INTERACTION: '1' };
	step(`${name}: composer validates composer.json`, 'composer', ['validate', '--no-check-publish'], dir, undefined, env);
	const resolve = run('composer', ['update', '--dry-run', '--no-progress'], dir, env);
	if (resolve.status !== 0) skip(`${name}: composer could not resolve from Packagist (offline?): ${tail(resolve.output)}`);
	else check(/giorgiosironi\/eris \(1\./.test(resolve.output) && /phpunit\/phpunit \(12\./.test(resolve.output), `${name}: composer resolves giorgiosironi/eris 1.x and phpunit/phpunit 12 from Packagist`, tail(resolve.output));
}

async function rust(name, files, expect) {
	const dir = await download(name, sample('rust'), files);
	if (!dir) return;
	if (!has('cargo')) return skip(`${name}: cargo is missing`);
	const env = { CARGO_TARGET_DIR: join(dir, 'target') };
	step(`${name}: cargo run prints the distance`, 'cargo', ['run', '--quiet'], dir, expect.run, env);
	if (expect.tests) step(`${name}: cargo test runs the unit and integration tests`, 'cargo', ['test', '--quiet'], dir, expect.tests, env);
}

const swiftSample = sample('swift').sample;
const cases = {
	rust: async () => {
		// The sample has its own Cargo.toml (package `geometry`).
		await rust('rust', sample('rust').sample, { run: '(0, 0) to (3, 4): 5', tests: 'test result: ok. 3 passed' });
		// Without one, the generated manifest names the package `app`, as
		// the browser's server and runner do.
		const bare = { 'main.rs': 'mod point;\n\nfn main() {\n    println!("{}", point::norm(3.0, 4.0));\n}\n', 'point.rs': 'pub fn norm(x: f64, y: f64) -> f64 {\n    x.hypot(y)\n}\n' };
		await rust('rust-bare', bare, { run: '5' });
	},
	cpp: async () => {
		const cppSample = sample('cpp').sample;
		await cpp('cpp', cppSample);
		for (const fw of ['doctest', 'catch2']) await cpp(`cpp-${fw}`, { ...cppSample, ...chooseTestFramework(cppSample, fw, cppSample).write }, fw);
		// RapidCheck properties beside each framework's tests (packs/cpp
		// README, "Properties"): fetched at the browser's commit, two more tests.
		for (const fw of ['gtest', 'doctest', 'catch2']) {
			const base = fw === 'gtest' ? cppSample : { ...cppSample, ...chooseTestFramework(cppSample, fw, cppSample).write };
			await cpp(`cpp-${fw}-rapidcheck`, { ...base, 'tests/properties_test.cpp': PROPERTIES[fw](false) }, fw, { count: 5 });
		}
	},
	swift: async () => {
		// As the sample is: tests that use the project without importing it.
		await swift('swift', swiftSample);
		// As tests written for SwiftPM are, with the import.
		const imported = { ...swiftSample, 'Tests/GeometryTests.swift': swiftSample['Tests/GeometryTests.swift'].replace('import XCTest\n', 'import XCTest\n@testable import App\n') };
		check(!exportProject(sample('swift'), imported).files['Package.swift'].includes('unsafeFlags'), 'swift-imported: tests that import the module need no unsafe flag');
		await swift('swift-imported', imported);
	},
	javascript: () => javascript('javascript', sample('javascript').sample),
	typescript: () => typescript('typescript', sample('typescript').sample),
	web: () => web('web', sample('web').sample),
	p5: () => web('p5', sample('p5').sample, 'p5'),
	python: () => python('python', sample('python').sample),
	php: async () => {
		await php('php', sample('php').sample, 'OK (5 tests, 5 assertions)');
		// A class the tests use without requiring its file: Composer's class map finds it.
		const money = '<?php\n\nnamespace App;\n\nfinal class Money\n{\n    public function __construct(public readonly int $cents)\n    {\n    }\n}\n';
		const test = '<?php\n\nuse App\\Money;\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class MoneyTest extends TestCase\n{\n    public function testCents(): void\n    {\n        $this->assertSame(5, (new Money(5))->cents);\n    }\n}\n';
		await php('php-classmap', { 'main.php': '<?php\necho "hi\\n";\n', 'src/Money.php': money, 'tests/MoneyTest.php': test }, 'OK (1 test, 1 assertion)');
		const property = '<?php\n\nuse Eris\\Generators;\nuse Eris\\TestTrait;\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class SumTest extends TestCase\n{\n    use TestTrait;\n\n    public function testCommutes(): void\n    {\n        $this->forAll(Generators::int(), Generators::int())->then(fn (int $a, int $b) => $this->assertSame($a + $b, $b + $a));\n    }\n}\n';
		await phpEris('php-eris', { 'main.php': '<?php\necho "hi\\n";\n', 'tests/SumTest.php': property });
	},
	scala: async () => {
		await scala('scala', sample('scala').sample, 0);
		const suite = 'class GeometrySuite extends munit.FunSuite:\n  test("norm of (3, 4) is 5") {\n    assertEquals(Point(3, 4).norm, 5.0)\n  }\n';
		await scala('scala-tests', { ...sample('scala').sample, 'tests/GeometrySuite.scala': suite, 'util/Twice.scala': 'def twice(x: Int): Int = 2 * x\n' }, 1);
		// Properties checked from a main, as the browser runs them: build.sbt
		// asks sbt for ScalaCheck, and the same program prints the same report.
		const props = 'import org.scalacheck.Prop.forAll\n\n@main def properties(): Unit =\n  forAll((a: Int, b: Int) => a + b == b + a).check()\n';
		check(buildSbt({ 'Props.scala': props }).includes('"org.scalacheck" %% "scalacheck" % "1.18.1",'), 'scala-scalacheck: build.sbt has ScalaCheck as a dependency of the main sources');
		await scalaRun('scala-scalacheck', { 'Props.scala': props }, '+ OK, passed 100 tests.');
		// A main that throws when a property fails ends non-zero under sbt as
		// in the browser (packs/scala/README.md, "Property-based tests").
		const failing = 'import org.scalacheck.{Properties, Test}\nimport org.scalacheck.Prop.forAll\nimport org.scalacheck.util.ConsoleReporter\n\nclass Spec extends Properties("Spec"):\n  property("small") = forAll((n: Int) => n < 100)\n\n@main def properties(): Unit =\n  val failed = Test.checkProperties(Test.Parameters.default.withTestCallback(ConsoleReporter(1)), Spec()).count((_, r) => !r.passed)\n  if failed > 0 then throw AssertionError(s"Found $failed failing properties.")\n';
		const dir = await download('scala-scalacheck-exit', sample('scala'), { 'Props.scala': failing });
		const { sbt, flags } = sbtCommand();
		if (dir && sbt) {
			const r = run(sbt, [...flags, '--batch', 'run'], dir);
			check(r.status !== 0 && r.output.includes('! Spec.small: Falsified') && r.output.includes('Found 1 failing properties.'), 'scala-scalacheck-exit: sbt run of a main that throws when a property fails prints the report and exits non-zero', tail(r.output));
		} else if (dir) skip('scala-scalacheck-exit: sbt is missing');
	},
};
// An empty folder survives the zip.
await download('empty-folder', sample('javascript'), sample('javascript').sample, ['docs/notes']);

for (const [id, fn] of Object.entries(cases)) if (!only.length || only.includes(id)) await fn();

if (process.env.KEEP) console.log(`\nprojects kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
if (skipped.length) console.log(`\n${skipped.length} skipped (tool missing):\n` + skipped.map((s) => `  - ${s}`).join('\n'));
if (failures.length) {
	console.error(`\n${failures.length} check(s) failed:\n` + failures.map((f) => `  - ${f}`).join('\n'));
	process.exit(1);
}
console.log('\nall checks passed');
