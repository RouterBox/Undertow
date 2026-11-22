// Dreamer links a new insight to the neurons the model names, whatever shape
// the model used for a connection, and skips one that names nothing.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize, connectionTarget } from '../daemons/dreamer.js';

test('connectionTarget reads the usual shapes and rejects the rest', () => {
  assert.equal(connectionTarget({ target_name: 'Kettle config' }), 'Kettle config');
  assert.equal(connectionTarget({ target: 'Kettle config' }), 'Kettle config');
  assert.equal(connectionTarget({ name: 'Kettle config' }), 'Kettle config');
  assert.equal(connectionTarget('  Kettle config '), 'Kettle config');
  assert.equal(connectionTarget({ target_name: '' }), null);
  assert.equal(connectionTarget({ edge_type: 'causal' }), null);
  assert.equal(connectionTarget({ target_name: 42 }), null);
  assert.equal(connectionTarget(null), null);
  assert.equal(connectionTarget(undefined), null);
});

async function summarizeWith(connections, { existing = null } = {}) {
  const calls = [];
  const logs = [];
  await handleSummarize({
    req_body: { session_id: 's1' },
    session: { activeTopics: [], pendingFlashes: [], explicitFeedback: {} },
    // The real driver rejects a query whose parameter is undefined; do the same.
    runCypher: async (q, p) => {
      for (const m of q.matchAll(/\$([a-zA-Z_]+)/g)) {
        if (p?.[m[1]] === undefined) throw new Error(`Expected parameter(s): ${m[1]}`);
      }
      calls.push({ q, p });
      // An edge query returns the linked name when the target exists (all do unless `existing` says otherwise).
      if (/CREATE \(src\)-\[:SYNAPSE/.test(q)) return !existing || existing.includes(p.tgt) ? [{ linked: p.tgt }] : [];
      return [];
    },
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: { content: [{ text: JSON.stringify({
        insights: [{ name: 'Gate design', node_type: 'insight', flash_summary: 'One run at a time', body: 'Two sentences of body. Enough to pass.', connections }],
        updates: [], train_of_thought: [], flash_results: []
      }) }] }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (...a) => logs.push(a)
  });
  const edges = calls.filter(c => /CREATE \(src\)-\[:SYNAPSE/.test(c.q)).map(c => c.p.tgt);
  const warns = logs.filter(l => l[1] === 'warn').map(l => l[2]);
  const notFound = logs.filter(l => /connection target not found/.test(l[2])).map(l => l[2]);
  return { edges, warns, notFound };
}

test('every connection that names a neuron gets an edge query, in any shape', async () => {
  const { edges, warns } = await summarizeWith([
    { target_name: 'A', edge_type: 'causal', weight: 0.7, context: 'because' },
    { target: 'B' },
    'C'
  ]);
  assert.deepEqual(edges, ['A', 'B', 'C']);
  assert.deepEqual(warns, []);
});

test('a connection that names nothing is skipped without a warning', async () => {
  const { edges, warns } = await summarizeWith([{ edge_type: 'causal', context: 'no target given' }, { target_name: 'A' }]);
  assert.deepEqual(edges, ['A']);
  assert.deepEqual(warns, [], 'no "Expected parameter(s): tgt" from the driver');
});

test('an insight never links to itself', async () => {
  const { edges } = await summarizeWith([{ target_name: 'Gate design' }, { target_name: 'A' }]);
  assert.deepEqual(edges, ['A'], 'the self-link is not sent');
});

test('a target that does not exist is logged, not silently dropped', async () => {
  const { edges, notFound, warns } = await summarizeWith([{ target_name: 'A' }, { target_name: 'Made up name' }], { existing: ['A'] });
  assert.deepEqual(edges, ['A', 'Made up name'], 'both are attempted');
  assert.equal(notFound.length, 1);
  assert.match(notFound[0], /connection target not found: "Made up name" \(from "Gate design"\)/);
  assert.deepEqual(warns, [], 'it is an info line, not a warning');
});

test('the summarize prompt tells the model what a connection is and what shape it has', async () => {
  const { SUMMARIZE_SYSTEM_PROMPT } = await import('../daemons/dreamer.js');
  assert.match(SUMMARIZE_SYSTEM_PROMPT, /"connections": \[\{"target_name": /);
  assert.match(SUMMARIZE_SYSTEM_PROMPT, /Never invent a name/);
  // The example the model is shown must itself be read correctly by the code.
  const example = JSON.parse(SUMMARIZE_SYSTEM_PROMPT.match(/"connections": (\[\{[^\]]*\}\])/)[1]);
  assert.equal(connectionTarget(example[0]), 'exact name of an existing neuron');
});
