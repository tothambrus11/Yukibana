// Exercises most of node:test and node:assert. test-run.mjs runs it in the
// browser runner and under the real `node --test`, and compares the reports.
import { test, describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import strict from 'node:assert/strict';
import { inc } from '../counter.js';

const log = [];
before(() => log.push('file before'));
beforeEach(() => log.push('file beforeEach'));
afterEach(() => log.push('file afterEach'));

describe('hooks', () => {
  before(() => log.push('before'));
  beforeEach((t) => log.push(`beforeEach ${t.name}`));
  afterEach((t) => log.push(`afterEach ${t.name}`));
  after(() => log.push('after'));
  it('first', () => log.push('first'));
  describe('inner', () => {
    beforeEach(() => log.push('inner beforeEach'));
    it('second', () => log.push('second'));
  });
});

test('hooks ran in order', (t) => {
  t.diagnostic(log.join(', '));
});

test('each file has its own modules', () => strict.equal(inc(), 1));

test('async passes', async () => {
  await new Promise((r) => setTimeout(r, 5));
});

test('callback done', (t, done) => {
  setTimeout(done, 5);
});

test('subtests', async (t) => {
  await t.test('a', () => {});
  await t.test('b', () => strict.equal(1, 2));
});

test('nested subtests pass', async (t) => {
  await t.test('outer', async (t) => {
    await t.test('inner', () => {});
  });
});

test.skip('skipped', () => {});
test('skip with reason', { skip: 'not now' }, () => {});
test.todo('to do');
test('t.skip inside', (t) => {
  t.skip('later');
});
test('a todo that fails', { todo: true }, () => {
  throw new Error('not done');
});
describe.skip('skipped suite', () => {
  it('never runs', () => {
    throw new Error('ran');
  });
});

test('legacy equal is loose, strict is not', () => {
  assert.equal(1, '1');
  assert.deepEqual({ a: 1 }, { a: '1' });
  assert.notStrictEqual(1, '1');
  strict.throws(() => strict.equal(1, '1'), strict.AssertionError);
  strict.throws(() => strict.deepEqual({ a: 1 }, { a: '1' }), { code: 'ERR_ASSERTION', operator: 'deepStrictEqual' });
  assert.strict.equal(assert.strict, strict);
});

test('throws and rejects', async () => {
  strict.throws(() => { throw new TypeError('bad thing'); }, TypeError);
  strict.throws(() => { throw new TypeError('bad thing'); }, /bad/);
  strict.throws(() => { throw new TypeError('bad thing'); }, { name: 'TypeError', message: /thing/ });
  strict.throws(() => { throw new TypeError('bad thing'); }, (e) => e instanceof TypeError);
  strict.throws(() => { throw new TypeError('bad thing'); }, new TypeError('bad thing'));
  strict.doesNotThrow(() => 1);
  await strict.rejects(Promise.reject(new RangeError('no')), RangeError);
  await strict.rejects(async () => { throw new Error('later'); }, /later/);
  await strict.doesNotReject(Promise.resolve(1));
  strict.match('abc', /b/);
  strict.doesNotMatch('abc', /x/);
  strict.ifError(null);
  strict.ok(1);
  strict(true);
  strict.deepEqual(new Map([[1, { a: [1, 2] }]]), new Map([[1, { a: [1, 2] }]]));
  strict.deepEqual(new Set([1, 2]), new Set([2, 1]));
  strict.deepEqual(new Date(0), new Date(0));
  strict.notDeepEqual([1, 2], [1, 3]);
});

test('messages', (t) => {
  const msg = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.message;
    }
    return 'no error';
  };
  const x = 0;
  for (const m of [
    msg(() => strict.equal(5, 6)),
    msg(() => strict.equal('a', 'b')),
    msg(() => strict.deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] })),
    msg(() => strict.ok(x > 1)),
    msg(() => strict(x)),
    msg(() => strict.throws(() => {})),
    msg(() => strict.throws(() => {}, TypeError)),
    msg(() => strict.match('abc', /x/)),
    msg(() => strict.notEqual(1, 1)),
    msg(() => assert.equal(1, 2)),
    msg(() => strict.throws(() => { throw new RangeError('r'); }, TypeError)),
    msg(() => strict.equal([1], [1])),
    msg(() => strict.fail('boom')),
  ]) t.diagnostic(JSON.stringify(m));
});

test('fails with a diff', () => {
  strict.deepEqual({ name: 'p', at: [3, 4] }, { name: 'p', at: [3, 5] });
});

test('times out', { timeout: 30 }, async () => {
  await new Promise((r) => setTimeout(r, 300));
});

test('top-level await of a test', async () => {});
await test('awaited at top level', () => {});
test('after the await', () => {});
