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
import { exportProject } from '../src/lib/export.ts';
import { zip } from '../src/lib/zip.ts';

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

async function cpp(name, files) {
	const dir = await download(name, sample('cpp'), files);
	if (!dir) return;
	if (!has('cmake') || !(has('c++') || has('g++') || has('clang++'))) return skip(`${name}: cmake or a C++ compiler is missing`);
	if (step(`${name}: cmake configures (and downloads GoogleTest)`, 'cmake', ['-S', '.', '-B', 'build'], dir).status !== 0) return;
	step(`${name}: cmake --build`, 'cmake', ['--build', 'build', '-j'], dir);
	check(existsSync(join(dir, 'build', 'compile_commands.json')), `${name}: build/compile_commands.json is written for clangd`);
	step(`${name}: ./build/app prints the distance`, join(dir, 'build', 'app'), [], dir, '5.000000');
	step(`${name}: ctest runs the GoogleTest tests`, 'ctest', ['--test-dir', 'build', '--output-on-failure'], dir, '100% tests passed');
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

async function javascript(name, files) {
	const dir = await download(name, sample('javascript'), files);
	if (!dir) return;
	step(`${name}: npm start prints the distance`, 'npm', ['start', '--silent'], dir, '(0, 0) to (3, 4): 5');
	step(`${name}: npm test runs node --test`, 'npm', ['test', '--silent'], dir, 'pass 4');
}

async function python(name, files) {
	const dir = await download(name, sample('python'), files);
	if (!dir) return;
	const venv = join(work, 'venv');
	if (!existsSync(venv)) {
		const r = run('python3', ['-m', 'venv', venv], work);
		const pip = r.status === 0 && run(join(venv, 'bin', 'python'), ['-m', 'pip', 'install', '--quiet', 'pytest>=9'], work);
		if (!pip || pip.status !== 0) return skip(`${name}: could not install pytest into a venv: ${tail((pip || r).output)}`);
	}
	const py = join(venv, 'bin', 'python');
	step(`${name}: python main.py prints the distance`, py, ['main.py'], dir, 'to Point(x=3, y=4): 5.0');
	step(`${name}: python -m pytest finds tests/ through pyproject.toml`, py, ['-m', 'pytest'], dir, '6 passed');
	step(`${name}: pytest run on the tests folder imports the project's modules`, py, ['-m', 'pytest', 'tests'], dir, '6 passed');
}

async function scala(name, files, expectTests) {
	const dir = await download(name, sample('scala'), files);
	if (!dir) return;
	// sbt on the PATH, or the one the Scala pack built with, with its caches and mirror.
	const cache = join(PACK_CACHE, 'scala');
	let sbt = 'sbt';
	let flags = [];
	if (!has('sbt')) {
		sbt = join(cache, 'bin', 'sbt-1.11.7', 'bin', 'sbt');
		if (!existsSync(sbt)) return skip(`${name}: sbt is missing`);
		flags = [`-Dsbt.global.base=${cache}/sbt-global`, `-Dsbt.boot.directory=${cache}/sbt-boot`, `-Dsbt.ivy.home=${cache}/ivy2`, `-Dsbt.coursier.home=${cache}/coursier`];
		if (existsSync(join(cache, 'sbt-project', 'repositories'))) flags.push(`-Dsbt.repository.config=${cache}/sbt-project/repositories`, '-Dsbt.override.build.repos=true');
	}
	step(`${name}: sbt run prints the distance`, sbt, [...flags, '--batch', 'run'], dir, 'Point(0.0,0.0) to Point(3.0,4.0): 5.0');
	if (expectTests) step(`${name}: sbt test runs the MUnit suite in tests/`, sbt, [...flags, '--batch', 'test'], dir, `Passed: Total ${expectTests}`);
}

const swiftSample = sample('swift').sample;
const cases = {
	cpp: () => cpp('cpp', sample('cpp').sample),
	swift: async () => {
		// As the sample is: tests that use the project without importing it.
		await swift('swift', swiftSample);
		// As tests written for SwiftPM are, with the import.
		const imported = { ...swiftSample, 'Tests/GeometryTests.swift': swiftSample['Tests/GeometryTests.swift'].replace('import XCTest\n', 'import XCTest\n@testable import App\n') };
		check(!exportProject(sample('swift'), imported).files['Package.swift'].includes('unsafeFlags'), 'swift-imported: tests that import the module need no unsafe flag');
		await swift('swift-imported', imported);
	},
	javascript: () => javascript('javascript', sample('javascript').sample),
	python: () => python('python', sample('python').sample),
	scala: async () => {
		await scala('scala', sample('scala').sample, 0);
		const suite = 'class GeometrySuite extends munit.FunSuite:\n  test("norm of (3, 4) is 5") {\n    assertEquals(Point(3, 4).norm, 5.0)\n  }\n';
		await scala('scala-tests', { ...sample('scala').sample, 'tests/GeometrySuite.scala': suite, 'util/Twice.scala': 'def twice(x: Int): Int = 2 * x\n' }, 1);
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
