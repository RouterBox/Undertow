// Impulse: a neuron injected into a session is not injected again by the hook
// within impulse.reflashWindowHours, until a compaction (rehydrate) resets it.
// Stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleQuery } from '../daemons/impulse.js';
import { handleRehydrate } from '../daemons/dreamer.js';

const HOUR = 3600_000;
let promptSeq = 0;

function newSession() {
  return { activeTopics: [], pendingFlashes: [] };
}

// One query in raw mode: `candidates` (names, or {name, uid}) come back from the
// keyword search. Returns the names written into the block and the logs.
async function query(session, candidates, { sessionId = 's1', via, config = {} } = {}) {
  const logs = [];
  const rows = candidates.map((c, i) => {
    const { name, uid } = typeof c === 'string' ? { name: c } : c;
    return { name, uid, flash: `flash ${name}`, type: 'fact', score: 1 - i * 0.01, daemon: 'keyword' };
  });
  const out = await handleQuery({
    // A distinct prompt per run keeps the module-level query cache out of the way;
    // over 100 chars so flow-state detection (3 prompts in 30s) does not fire.
    req_body: { prompt: `heartbeat tick number ${++promptSeq}: tower curl status, long-poll backstop check, inbox poll still running, nothing else to report`, session_id: sessionId, ...(via ? { via } : {}) },
    session,
    runCypher: async (q) => (/'keyword' AS daemon/.test(q) ? rows : []),
    callAnthropic: async () => null,
    getEmbedding: async () => null, embeddingsAvailable: () => false,
    isDaemonEnabled: () => false, getDaemonConfig: () => ({ decomposeQueries: false, ...config }),
    wonder: {}, prowler: {},
    log: (...a) => logs.push(a),
    flashMode: 'raw'
  });
  const block = out.responseJson.hookSpecificOutput?.additionalContext || '';
  const shown = rows.map(r => r.name).filter(n => block.includes(`] ${n}:`));
  return { shown, logs };
}

const suppressedLog = (logs) => logs.find(l => /^reflash suppressed/.test(l[2]));

test('a neuron shown to a session is suppressed on the next hook query within the window', async () => {
  const s = newSession();
  assert.deepEqual((await query(s, ['A', 'B'])).shown, ['A', 'B']);

  const second = await query(s, ['A', 'B', 'C'], { sessionId: 's1abcdef99' });
  assert.deepEqual(second.shown, ['C']);
  const line = suppressedLog(second.logs);
  assert.ok(line, 'suppression is logged');
  assert.equal(line[1], 'info');
  assert.equal(line[2], 'reflash suppressed: 2 candidate(s) already shown to session s1abcdef within 6h');
});

test('a haiku-mode entry (sourceNeurons only, no flashNeurons) suppresses nothing', async () => {
  const s = newSession();
  s.pendingFlashes.push({ turn: Date.now() - 60_000, flashes: ['free text'], sourceNeurons: ['A', 'B'], neuronDomains: {}, neuronDaemons: {} });
  const out = await query(s, ['A', 'B']);
  assert.deepEqual(out.shown, ['A', 'B']);
  assert.equal(suppressedLog(out.logs), undefined, 'no suppression is logged');
});

test('when every candidate was already shown, nothing is injected', async () => {
  const s = newSession();
  await query(s, ['A']);
  assert.deepEqual((await query(s, ['A'])).shown, []);
  assert.equal(s.pendingFlashes.length, 1, 'no new entry for an empty turn');
});

test('a neuron is shown again once the window has passed, and the old entry is pruned', async () => {
  const s = newSession();
  await query(s, ['A']);
  s.pendingFlashes[0].turn = Date.now() - 7 * HOUR;

  assert.deepEqual((await query(s, ['A'])).shown, ['A']);
  assert.equal(s.pendingFlashes.length, 1, 'the 7h-old entry was pruned, the new one kept');
  assert.ok(Date.now() - s.pendingFlashes[0].turn < 60_000);
});

test('reflashWindowHours from the impulse config sets the window', async () => {
  const s = newSession();
  await query(s, ['A']);
  s.pendingFlashes[0].turn = Date.now() - 2 * HOUR;

  assert.deepEqual((await query(s, ['A'], { config: { reflashWindowHours: 3 } })).shown, []);
  assert.deepEqual((await query(s, ['A'], { config: { reflashWindowHours: 1 } })).shown, ['A']);
});

test('after a compaction (rehydrate) the neuron may be shown again; pendingFlashes is kept for Dreamer', async () => {
  const s = newSession();
  await query(s, ['A']);
  await new Promise(r => setTimeout(r, 2)); // the injection lies strictly before the reset

  await handleRehydrate({ req_body: {}, session: s, runCypher: async () => [], log: () => {} });
  assert.equal(s.pendingFlashes.length, 1, 'rehydrate does not clear what Dreamer judges');
  assert.ok(!s.pendingFlashes[0].judged);

  await new Promise(r => setTimeout(r, 2));
  assert.deepEqual((await query(s, ['A'])).shown, ['A']);
  // And what was injected after the compaction is suppressed again.
  assert.deepEqual((await query(s, ['A'])).shown, []);
});

test('a different session still gets the neuron', async () => {
  const one = newSession();
  const two = newSession();
  await query(one, ['A'], { sessionId: 'one' });
  assert.deepEqual((await query(two, ['A'], { sessionId: 'two' })).shown, ['A']);
});

test('an explicit undertow_query MCP call (via mcp) is not suppressed', async () => {
  const s = newSession();
  await query(s, ['A', 'B']);
  const explicit = await query(s, ['A', 'B'], { via: 'mcp' });
  assert.deepEqual(explicit.shown, ['A', 'B']);
  assert.ok(!suppressedLog(explicit.logs));
  // The hook path right after is still suppressed.
  assert.deepEqual((await query(s, ['A', 'B'])).shown, []);
});

test('a candidate is matched on uid when it has one', async () => {
  const s = newSession();
  await query(s, [{ name: 'Old name', uid: 'u-1' }]);
  assert.deepEqual(s.pendingFlashes[0].flashUids, ['u-1']);
  assert.deepEqual((await query(s, [{ name: 'Renamed', uid: 'u-1' }, 'B'])).shown, ['B']);
});

test('pruning keeps entries Dreamer still reads (10 min) even with a zero window', async () => {
  const s = newSession();
  s.pendingFlashes.push(
    { turn: Date.now() - 5 * 60_000, flashes: ['x'], flashNeurons: ['Recent'], sourceNeurons: ['Recent'], neuronDomains: {}, neuronDaemons: {} },
    { turn: Date.now() - 20 * 60_000, flashes: ['y'], flashNeurons: ['Older'], sourceNeurons: ['Older'], neuronDomains: {}, neuronDaemons: {} }
  );
  const r = await query(s, ['Recent', 'Older'], { config: { reflashWindowHours: 0 } });
  assert.deepEqual(r.shown, ['Recent', 'Older'], 'a zero window suppresses nothing');
  assert.deepEqual(s.pendingFlashes.map(f => f.flashNeurons[0]), ['Recent', 'Recent'], 'the 20-min entry is pruned, the 5-min one kept');
});
