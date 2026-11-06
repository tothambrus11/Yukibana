/** Sentences for zod's issues, so a schema says what it expects once, as its
 *  types, and every message follows from that. Only a rule zod cannot state
 *  (a glob relative to the root, a uuid) writes its own words, in the
 *  refinement that checks it.
 *
 *  Imports nothing but zod's types, so it runs in a browser with the config
 *  schema.
 */

import type * as z from 'zod';

/** What a value zod expected is called in a sentence. */
const NAMES: Readonly<Record<string, string>> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
  null: 'null',
};

/** Returns what `expected`, one of zod's type names, is called in a sentence. */
export function nameOf(expected: string): string {
  return NAMES[expected] ?? expected;
}

/** Returns `path` as a field name after `from`: `features.ai`,
 *  `submissions[1].author`. */
export function fieldOf(path: readonly PropertyKey[], from = ''): string {
  return path.reduce<string>((field, key) => (typeof key === 'number' ? `${field}[${key}]` : field === '' ? String(key) : `${field}.${String(key)}`), from);
}

/** Returns what `issue` says was wrong, as the end of a sentence: "must be
 *  true or false", "must be one of rust-cargo, scala-sbt". */
export function expectation(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `must be ${nameOf(issue.expected)}`;
    case 'invalid_value':
      return issue.values.length === 1 ? `must be ${String(issue.values[0])}` : `must be one of ${issue.values.map(String).join(', ')}`;
    case 'too_small':
      if (issue.origin === 'string' && Number(issue.minimum) === 1) return 'must not be empty';
      return `must be ${issue.inclusive === true ? 'at least' : 'more than'} ${String(issue.minimum)}`;
    case 'too_big':
      return `must be ${issue.inclusive === true ? 'at most' : 'less than'} ${String(issue.maximum)}`;
    default:
      return issue.message;
  }
}
