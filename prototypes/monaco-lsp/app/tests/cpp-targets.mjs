// Unit tests of the C++ target choice (src/lib/cpp-targets.ts): which
// target compile_flags.txt puts a project on, how the Target picker rewrites
// that file, and that the app's copy of the target table and of the parse
// rule agree with the pack's (packs/cpp/src/targets.json and
// tests/fixtures/target-cases.json).
//
//   node --test tests/cpp-targets.mjs     (Node 22.18 or later: loads the TypeScript source)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { asmLanguageOf, runOptionsOf, TARGETS, targetOf, withTarget } from '../src/lib/cpp-targets.ts';

const pack = new URL('../../packs/cpp/', import.meta.url);
const said = (choice) => (choice.kind === 'unsupported' ? { kind: choice.kind, triple: choice.triple } : { kind: choice.kind, id: choice.target.id });

test('a project without compile_flags.txt, or without a target line, is on WebAssembly', () => {
	assert.deepEqual(said(targetOf(undefined)), { kind: 'default', id: 'wasm32-wasi' });
	assert.deepEqual(said(targetOf(null)), { kind: 'default', id: 'wasm32-wasi' });
	assert.deepEqual(said(targetOf('-std=c++20\n-Wall\n-I.\n')), { kind: 'default', id: 'wasm32-wasi' });
});

test('the spellings clang accepts select a target, and the last one wins', () => {
	const cases = [
		['--target=aarch64-linux-musl\n-std=c++20\n', 'aarch64-linux'],
		['-std=c++20\n-target\nx86_64-linux-musl\n', 'x86_64-linux'],
		['-target\n\n   \nriscv64-linux-musl\n', 'riscv64-linux'],
		['--target=aarch64-linux-musl\n-O2\n--target=x86_64-linux-musl', 'x86_64-linux'],
		['  --target=riscv64-linux-musl  \r\n-O2\r\n', 'riscv64-linux'],
		['--target=wasm32-wasip1\n', 'wasm32-wasi'],
	];
	for (const [flags, id] of cases) assert.equal(targetOf(flags).target?.id, id, JSON.stringify(flags));
	assert.equal(targetOf('--target=wasm32-wasip1\n').kind, 'target');
});

test('spellings clang refuses are not targets; unknown triples are reported as they were written', () => {
	assert.equal(targetOf('-target=riscv64-linux-musl\n').kind, 'default');
	assert.equal(targetOf('--target\naarch64-linux-musl\n').kind, 'default');
	assert.equal(targetOf('--targets=x\n-mtarget=y\n').kind, 'default');
	assert.deepEqual(said(targetOf('--target=x86_64-linux-gnu\n')), { kind: 'unsupported', triple: 'x86_64-linux-gnu' });
	assert.deepEqual(said(targetOf('--target=X86_64-linux-musl\n')), { kind: 'unsupported', triple: 'X86_64-linux-musl' });
	assert.deepEqual(said(targetOf('-O2\n-target\n')), { kind: 'unsupported', triple: '' });
	assert.deepEqual(said(targetOf('--target=\n')), { kind: 'unsupported', triple: '' });
});

test('choosing a Linux target puts its flag on the first line and keeps every other byte', () => {
	assert.equal(withTarget('-std=c++20\n-Wall\n-Wextra\n-I.\n', 'aarch64-linux'), '--target=aarch64-linux-musl\n-std=c++20\n-Wall\n-Wextra\n-I.\n');
	assert.equal(withTarget('-std=c++20\n  -Wall  \n\n-I.', 'x86_64-linux'), '--target=x86_64-linux-musl\n-std=c++20\n  -Wall  \n\n-I.');
	assert.equal(withTarget('-std=c++20\r\n-Wall\r\n', 'riscv64-linux'), '--target=riscv64-linux-musl\r\n-std=c++20\r\n-Wall\r\n');
});

test('choosing a target replaces the one there, in every spelling, duplicates included', () => {
	assert.equal(withTarget('--target=aarch64-linux-musl\n-std=c++20\n', 'x86_64-linux'), '--target=x86_64-linux-musl\n-std=c++20\n');
	assert.equal(withTarget('-std=c++20\n-target\nriscv64-linux-musl\n-Wall\n', 'aarch64-linux'), '--target=aarch64-linux-musl\n-std=c++20\n-Wall\n');
	assert.equal(withTarget('--target=a\n-O2\n--target=b\n-target=c\n--target\nd\n-Wall\n', 'riscv64-linux'), '--target=riscv64-linux-musl\n-O2\n-Wall\n');
	// The blank lines between -target and its value are not the value, and stay.
	assert.equal(withTarget('-target\n\nx86_64-linux-musl\n-Wall\n', 'aarch64-linux'), '--target=aarch64-linux-musl\n\n-Wall\n');
	// A -target with no value on the last line goes too.
	assert.equal(withTarget('-Wall\n-target\n', 'x86_64-linux'), '--target=x86_64-linux-musl\n-Wall\n');
});

test('choosing WebAssembly removes the target line and adds nothing', () => {
	assert.equal(withTarget('--target=x86_64-linux-musl\n-std=c++20\n-Wall\n', 'wasm32-wasi'), '-std=c++20\n-Wall\n');
	assert.equal(withTarget('-std=c++20\n--target=wasm32-wasip1\r\n', 'wasm32-wasi'), '-std=c++20\n');
	assert.equal(withTarget('-std=c++20\n', 'wasm32-wasi'), '-std=c++20\n');
});

test('without compile_flags.txt, a Linux target creates it and WebAssembly needs none', () => {
	assert.equal(withTarget(undefined, 'aarch64-linux'), '--target=aarch64-linux-musl\n');
	assert.equal(withTarget('', 'riscv64-linux'), '--target=riscv64-linux-musl\n');
	assert.equal(withTarget(undefined, 'wasm32-wasi'), '');
});

test('what the picker writes is read back as the target chosen', () => {
	for (const t of TARGETS) {
		for (const before of [undefined, '-std=c++20\n', '--target=x86_64-linux-musl\r\n-O2\r\n', '-target\naarch64-linux-musl']) {
			const after = withTarget(before, t.id);
			assert.equal(targetOf(after).target?.id, t.id, `${t.id} from ${JSON.stringify(before)}`);
			assert.equal(withTarget(after, t.id), after, 'choosing it again changes nothing');
		}
	}
});

test('each target has the assembly language of its architecture', () => {
	assert.equal(asmLanguageOf('wasm32-wasi'), 'asm-wasm32');
	assert.equal(asmLanguageOf('x86_64-linux'), 'asm-x86_64');
	assert.equal(asmLanguageOf('aarch64-linux'), 'asm-aarch64');
	assert.equal(asmLanguageOf('riscv64-linux'), 'asm-riscv64');
});

test('saved run options keep what is valid and fall back to the defaults for the rest', () => {
	assert.deepEqual(runOptionsOf(undefined), { emulation: 'system', cpus: 1, strace: false });
	assert.deepEqual(runOptionsOf({ emulation: 'user', cpus: 4, strace: true }), { emulation: 'user', cpus: 4, strace: true });
	assert.deepEqual(runOptionsOf({ emulation: 'kvm', cpus: 3, strace: 'yes' }), { emulation: 'system', cpus: 1, strace: false });
	assert.deepEqual(runOptionsOf({ cpus: 2 }), { emulation: 'system', cpus: 2, strace: false });
	assert.deepEqual(runOptionsOf([1, 2]), { emulation: 'system', cpus: 1, strace: false });
});

const json = new URL('src/targets.json', pack);
test("the app's target table is the pack's targets.json", { skip: !existsSync(json) && 'packs/cpp/src/targets.json does not exist' }, () => {
	assert.deepEqual(JSON.parse(JSON.stringify(TARGETS)), JSON.parse(readFileSync(json, 'utf8')));
});

const fixtures = new URL('tests/fixtures/target-cases.json', pack);
test("the app reads compile_flags.txt as the pack's runner and explorer do", { skip: !existsSync(fixtures) && 'packs/cpp/tests/fixtures/target-cases.json does not exist' }, () => {
	const cases = JSON.parse(readFileSync(fixtures, 'utf8'));
	assert.ok(cases.length > 0);
	for (const c of cases) assert.deepEqual(said(targetOf(c.flags)), c.expect, c.name);
});
