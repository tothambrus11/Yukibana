import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_FILENAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_SETTINGS,
  isProjectId,
  excludes,
  manifestProblems,
  parseConfig,
  parseSettings,
  protectedPaths,
  sameStudentConfig,
  starterConfig,
} from '../src/lib/yukibana.js';

const ok = (text: string) => {
  const p = parseConfig(text);
  assert.ok(p.ok, p.ok ? '' : p.error);
  return p.config;
};
const bad = (text: string) => {
  const p = parseConfig(text);
  assert.ok(!p.ok, 'expected a rejection');
  return p.error;
};

test('the smallest valid file is a version and a kind', () => {
  const c = ok('{"version":1,"kind":"scala-sbt"}');
  assert.equal(c.kind, 'scala-sbt');
  assert.deepEqual(c.hidden, []);
  assert.equal(c.submission.maxBytes, DEFAULT_MAX_BYTES);
});

test('every rejection names the field the teacher has to fix', () => {
  assert.match(bad('not json'), /not JSON/);
  assert.match(bad('[]'), /must be an object/);
  assert.match(bad('{"version":2,"kind":"rust-cargo"}'), /"version"/);
  assert.match(bad('{"version":1,"kind":"python"}'), /"kind" must be one of rust-cargo, scala-sbt/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","hidden":"tests"}'), /"hidden" must be a list/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","hidden":["../x"]}'), /relative to the project root/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","submission":{"maxBytes":-1}}'), /"submission.maxBytes"/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","readOnly":"README.md"}'), /"readOnly" must be a list/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","features":{"ai":"no"}}'), /"features.ai" must be true or false/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","layout":{"widgets":{"files":1}}}'), /"layout.widgets.files" must be true or false/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","openFiles":[1]}'), /"openFiles\[0\]" must be text/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","submission":{"exclude":["/abs"]}}'), /"submission.exclude" paths are relative/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","submission":{"filename":"a/b.tar.gz"}}'), /"submission.filename"/);
});

test('a file with several mistakes names every one of them, so one run is enough to fix it', () => {
  assert.equal(
    bad('{"version":1,"kind":"python","features":{"ai":"no"}}'),
    'yukibana.json: "kind" must be one of rust-cargo, scala-sbt; yukibana.json: "features.ai" must be true or false',
  );
});

test('a project id is a uuidv7, as the registry makes them, in any case', () => {
  assert.match(bad('{"version":1,"kind":"rust-cargo","projectId":"p-1"}'), /"projectId" must be a project id, a uuidv7/);
  assert.match(bad('{"version":1,"kind":"rust-cargo","projectId":"01a0b563-aeff-4c42-ae73-5aab2f2b5a01"}'), /"projectId"/, 'a uuidv4 is not one');
  assert.equal(ok('{"version":1,"kind":"rust-cargo","projectId":"01A0B563-AEFF-7C42-AE73-5AAB2F2B5A01"}').projectId, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01');
  assert.equal(isProjectId('01a0b563-aeff-7c42-ae73-5aab2f2b5a01'), true);
  assert.equal(isProjectId('p-1'), false, 'build --project refuses it before a starter carries it');
});

test('the IDE settings from the example file are a valid project, with the defaults filled in', () => {
  const p = parseConfig(
    JSON.stringify({
      version: 1,
      kind: 'scala-sbt',
      features: { codeSuggestions: true, squiggles: true, ai: false },
      layout: { widgets: { files: false, search: false }, containers: { 'metals-explorer': false } },
      openFiles: ['README.md', 'hello_world.scala'],
      submission: { exclude: ['.metals', '.scala-build'] },
      readOnly: ['tests/*', 'README.md', 'yukibana.json'],
    }),
  );
  assert.ok(p.ok);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.config.readOnly, ['tests/*', 'README.md', 'yukibana.json']);
  assert.equal(p.config.submission.include, null);
  assert.equal(p.config.submission.filename, DEFAULT_FILENAME);
  assert.equal(p.config.projectId, null);
});

test('an unknown field passes with a warning, so a misspelt "hiden" does not ship the tests in silence', () => {
  const p = parseConfig('{"version":1,"kind":"rust-cargo","hiden":["tests/hidden"]}');
  assert.ok(p.ok);
  assert.equal(p.config.hidden.length, 0);
  assert.match(p.warnings[0] ?? '', /unknown field "hiden"/);
});

test('an assembly protects the config itself, the read-only paths and the hidden ones', () => {
  const c = ok('{"version":1,"kind":"rust-cargo","readOnly":["tests/*"],"hidden":["tests/hidden"]}');
  assert.deepEqual(protectedPaths(c), ['yukibana.json', 'tests/*', 'tests/hidden']);
});

test('a student copy that says what the starter said is unchanged, whatever its formatting', () => {
  const c = ok('{"version":1,"kind":"rust-cargo","readOnly":["tests/*"],"hidden":["tests/hidden"]}');
  const copy = starterConfig(c, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01', null);
  assert.ok(sameStudentConfig(c, copy));
  assert.ok(sameStudentConfig(c, '{"readOnly":["tests/*"],"kind":"rust-cargo","version":1}'), 'key order and the project id do not matter');
  assert.ok(!sameStudentConfig(c, copy.replace('"tests/*"', '"nothing"')), 'an emptied read-only list is a change');
  assert.ok(!sameStudentConfig(c, 'not json'));
});

test('what is always dropped comes first, then the kind, then the teacher', () => {
  const c = ok('{"version":1,"kind":"scala-sbt","hidden":["src/test/scala/hidden"]}');
  const x = excludes(c);
  assert.deepEqual(x.slice(0, 4), ['.git', '.github', '.theia', 'yukibana.json']);
  assert.ok(x.includes('project/target'));
  assert.equal(x.at(-1), 'src/test/scala/hidden');
});

test('the starter copy carries the project id and not the hidden paths', () => {
  const c = ok('{"version":1,"kind":"rust-cargo","hidden":["tests/hidden"]}');
  const copy = JSON.parse(starterConfig(c, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01', null)) as Record<string, unknown>;
  assert.equal(copy['projectId'], '01a0b563-aeff-7c42-ae73-5aab2f2b5a01');
  assert.equal(copy['kind'], 'rust-cargo');
  assert.equal('hidden' in copy, false, 'the copy must not say what was removed');
});

test('a Cargo.toml that names a hidden path is a problem, not a surprise later', () => {
  const c = ok('{"version":1,"kind":"rust-cargo","hidden":["tests/hidden"]}');
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "x"\n[[test]]\nname = "secret"\npath = "tests/hidden/secret.rs"\n',
  };
  const problems = manifestProblems(c, p => files[p]);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /tests\/hidden\/secret.rs/);
  assert.deepEqual(
    manifestProblems(c, () => undefined),
    ['Cargo.toml is missing at the repository root'],
  );
  assert.deepEqual(
    manifestProblems(c, p => (p === 'Cargo.toml' ? '[package]\nname = "x"\n' : undefined)),
    [],
  );
});

test('a workspace member that is hidden is a problem too', () => {
  const c = ok('{"version":1,"kind":"rust-cargo","hidden":["grader"]}');
  const cargo = '[workspace]\nmembers = ["app", "grader"]\n';
  const problems = manifestProblems(c, p => (p === 'Cargo.toml' ? cargo : undefined));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /workspace member "grader"/);
});

test('a starter built without a project leaves the id out, and its copy still parses so a student can submit', () => {
  const c = ok('{"version":1,"kind":"rust-cargo","hidden":["tests/hidden"]}');
  const copy = starterConfig(c, '', null);
  assert.equal('projectId' in (JSON.parse(copy) as Record<string, unknown>), false);
  const back = parseConfig(copy);
  assert.ok(back.ok, back.ok ? '' : back.error);
  assert.equal(back.config.projectId, null);
});

test("a starter copy names its release, and a student's copy that does is not a change to the file", () => {
  const c = ok('{"version":1,"kind":"rust-cargo","readOnly":["tests/*"],"hidden":["tests/hidden"]}');
  const copy = starterConfig(c, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01', '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
  const back = parseConfig(copy);
  assert.ok(back.ok, back.ok ? '' : back.error);
  assert.equal(back.config.releaseId, '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
  assert.ok(sameStudentConfig(c, copy));
  assert.ok(sameStudentConfig(c, copy.replace('5a5c', '5a5d')), "nor is another release id: which release it names is the download's question");
  assert.equal('releaseId' in (JSON.parse(starterConfig(c, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01', null)) as Record<string, unknown>), false, 'a check names no release');
});

test("a release id that is not a uuid is refused, and a repository's own is never copied into a starter", () => {
  const notUuid = parseConfig('{"version":1,"kind":"rust-cargo","releaseId":"v2"}');
  assert.ok(!notUuid.ok);
  assert.match(notUuid.error, /"releaseId" must be a release id/);
  const c = ok('{"version":1,"kind":"rust-cargo","releaseId":"01a0b563-aeff-7c42-ae73-5aab2f2b5a5c"}');
  assert.equal('releaseId' in (JSON.parse(starterConfig(c, '01a0b563-aeff-7c42-ae73-5aab2f2b5a01', null)) as Record<string, unknown>), false);
  assert.equal(ok('{"version":1,"kind":"rust-cargo","releaseId":"01A0B563-AEFF-7C42-AE73-5AAB2F2B5A5C"}').releaseId, '01a0b563-aeff-7c42-ae73-5aab2f2b5a5c');
});

test('the IDE opens a folder whose file says nothing, or has no version or kind, with its defaults', () => {
  assert.deepEqual(parseSettings('{}'), { ok: true, settings: DEFAULT_SETTINGS });
  const p = parseSettings('{"features":{"ai":false},"submission":{"target":"file"}}');
  assert.ok(p.ok);
  assert.equal(p.settings.features.ai, false);
  assert.equal(p.settings.features.squiggles, true);
  assert.equal(p.settings.submission.target, 'file');
  assert.ok(!parseSettings('{"features":{"ai":"no"}}').ok, 'but a wrong type is still refused');
});

test('every IDE setting defaults to on, the assignment to ASSIGNMENT.md and submissions to the registry, honouring .gitignore', () => {
  assert.equal(DEFAULT_SETTINGS.assignmentFile, 'ASSIGNMENT.md');
  assert.ok(Object.values(DEFAULT_SETTINGS.features).every(on => on));
  assert.ok(Object.values(DEFAULT_SETTINGS.layout.widgets).every(on => on));
  assert.deepEqual(DEFAULT_SETTINGS.layout.containers, {});
  assert.equal(DEFAULT_SETTINGS.submission.target, 'cloud');
  assert.equal(DEFAULT_SETTINGS.submission.respectGitignore, true);
  assert.equal(DEFAULT_SETTINGS.projectId, null);
});

test('the config module runs in a browser: it and what it imports use nothing from Node', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['../src/lib/yukibana.ts', '../src/lib/glob.ts', '../src/lib/issues.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]);
    assert.deepEqual(
      imports.filter(i => !['zod', './glob.js', './issues.js'].includes(i ?? '')),
      [],
      `${file} imports only zod and its own modules`,
    );
  }
});
