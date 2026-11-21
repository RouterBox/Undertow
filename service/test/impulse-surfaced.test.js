// Impulse: times_surfaced is incremented once per injected neuron per push.
// Drives handleQuery with stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleQuery } from '../daemons/impulse.js';

const SURFACED_RE = /times_surfaced = coalesce\(n\.times_surfaced, 0\) \+ 1/;

let promptSeq = 0;

// `candidates` come back from the keyword search; every other read returns nothing.
function harness({ candidates, flashMode, haikuText, namespace, failSurfacedWrite }) {
  const calls = [];
  const logs = [];
  const session = { activeTopics: [], pendingFlashes: [] };
  const deps = {
    // A distinct prompt per run keeps the module-level query cache out of the way.
    req_body: { prompt: `kettle thermostat tuning question number ${++promptSeq}`, session_id: 's1', ...(namespace ? { namespace } : {}) },
    session,
    runCypher: async (q, p) => {
      calls.push({ q, p });
      if (SURFACED_RE.test(q) && failSurfacedWrite) throw new Error('neo4j down');
      if (/'keyword' AS daemon/.test(q)) return candidates.map((name, i) => ({ name, flash: `flash ${name}`, type: 'fact', score: 1 - i * 0.01, daemon: 'keyword' }));
      return [];
    },
    callAnthropic: async () => ({ response: { content: [{ text: haikuText }] } }),
    getEmbedding: async () => null, embeddingsAvailable: () => false,
    isDaemonEnabled: () => false, getDaemonConfig: () => ({ decomposeQueries: false }),
    wonder: {}, prowler: {},
    log: (...a) => logs.push(a),
    flashMode
  };
  const surfaced = () => calls.filter(c => SURFACED_RE.test(c.q));
  return { deps, session, calls, logs, surfaced };
}

test('raw: one statement per push, counting only the neurons written into the block (first 8)', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `N${i + 1}`);
  const h = harness({ candidates: names, flashMode: 'raw' });
  const out = await handleQuery(h.deps);

  assert.equal(h.session.pendingFlashes.length, 1);
  assert.equal(h.surfaced().length, 1, 'one Cypher statement per push');
  const { q, p } = h.surfaced()[0];
  assert.deepEqual(p.names, names.slice(0, 8));
  assert.equal(p.ns, null);
  assert.match(q, /UNWIND \$names AS name/);
  assert.match(q, /\$ns IS NULL AND n\.namespace IS NULL/, 'namespace predicate applied');
  assert.doesNotMatch(q, /last_surfaced/);
  const block = out.responseJson.hookSpecificOutput.additionalContext;
  for (const n of p.names) assert.ok(block.includes(`${n}:`), `${n} is in the injected block`);
  assert.ok(!block.includes('N9:') && !block.includes('N10:'), 'uncounted neurons were not injected');
});

test('curated: counts only the selected neurons, in the session namespace', async () => {
  const h = harness({
    candidates: ['A', 'B', 'C'], flashMode: 'curated', namespace: 'work',
    haikuText: JSON.stringify({ selected: [{ n: 1, why: 'x' }, { n: 3, why: 'y' }], topics_detected: [] })
  });
  await handleQuery(h.deps);

  assert.equal(h.session.pendingFlashes.length, 1);
  assert.equal(h.surfaced().length, 1);
  assert.deepEqual(h.surfaced()[0].p, { names: ['A', 'C'], ns: 'work' });
});

test('curated: nothing selected => no push and no increment', async () => {
  const h = harness({ candidates: ['A', 'B'], flashMode: 'curated', haikuText: JSON.stringify({ selected: [], topics_detected: [] }) });
  await handleQuery(h.deps);

  assert.equal(h.session.pendingFlashes.length, 0);
  assert.equal(h.surfaced().length, 0);
});

test('haiku: counts every candidate when it flashes, nothing when it stays silent', async () => {
  const flashed = harness({ candidates: ['A', 'B', 'C'], flashMode: 'haiku', haikuText: JSON.stringify({ flashes: ['~ something about A'], topics_detected: [] }) });
  await handleQuery(flashed.deps);
  assert.equal(flashed.surfaced().length, 1);
  assert.deepEqual(flashed.surfaced()[0].p.names, ['A', 'B', 'C']);

  const silent = harness({ candidates: ['A', 'B', 'C'], flashMode: 'haiku', haikuText: JSON.stringify({ flashes: [], topics_detected: [] }) });
  await handleQuery(silent.deps);
  assert.equal(silent.surfaced().length, 0);
});

test('a failed increment is logged, not thrown, and the flash is still returned', async () => {
  const h = harness({ candidates: ['A'], flashMode: 'raw', failSurfacedWrite: true });
  const out = await handleQuery(h.deps);
  await new Promise(r => setImmediate(r)); // let the un-awaited write settle

  assert.ok(out.responseJson.hookSpecificOutput.additionalContext.includes('A:'));
  assert.ok(h.logs.some(l => l[0] === 'error' && l[1] === 'warn' && /neo4j down/.test(l[2])));
});
