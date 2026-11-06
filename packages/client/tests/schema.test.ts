import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { configJSONSchema, parseConfig, SCHEMA_URL } from '../src/lib/yukibana.js';

test('the published JSON schema is the one the parser checks with, generated from it', async () => {
  // `npm run schema` writes the file (vitest --update); anywhere else, and in
  // CI, a committed file that is not exactly this fails.
  await expect(`${JSON.stringify(configJSONSchema(), null, 2)}
`).toMatchFileSnapshot('../../../docs/cloud/yukibana.schema.json');
});

test('the schema says where it lives and what a file must have', () => {
  const schema = configJSONSchema();
  assert.equal(schema['$id'], SCHEMA_URL);
  assert.deepEqual(schema['required'], ['version', 'kind']);
});

test('a file that names the schema as $schema parses without a warning', () => {
  const p = parseConfig(JSON.stringify({ $schema: SCHEMA_URL, version: 1, kind: 'rust-cargo' }));
  assert.ok(p.ok);
  assert.deepEqual(p.warnings, []);
});
