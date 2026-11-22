// The boot-time embedding coverage count looks at the live graph only.
// Stubbed runCypher: no Neo4j needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embeddingCoverage } from '../embedding-coverage.js';

test('counts only live neurons: NULL namespace, not superseded', async () => {
  const calls = [];
  const out = await embeddingCoverage(async (q, p) => {
    calls.push({ q, p });
    return [{ total: 1535, embedded: 1171 }];
  });
  assert.deepEqual(out, { total: 1535, embedded: 1171 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].p, { ns: null }, 'asks for the live namespace');
  assert.match(calls[0].q, /\$ns IS NULL AND n\.namespace IS NULL/, 'filters by namespace');
  assert.match(calls[0].q, /n\.superseded IS NULL/, 'leaves archived versions out');
});

test('reads Neo4j integers and an empty result', async () => {
  const int = (v) => ({ toNumber: () => v });
  assert.deepEqual(await embeddingCoverage(async () => [{ total: int(10), embedded: int(4) }]), { total: 10, embedded: 4 });
  assert.deepEqual(await embeddingCoverage(async () => []), { total: 0, embedded: 0 });
});
