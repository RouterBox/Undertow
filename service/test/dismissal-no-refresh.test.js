// A dismissal must not refresh last_surfaced. Retrieval reads last_surfaced as
// freshness (score = base_score * exp(-lambda * daysSince)), so a dismissal that
// set it to now made the dismissed neuron rank as fresh. Pursuit still sets it.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize } from '../daemons/dreamer.js';
import { applyVerdictToNeuron } from '../daemons/curated.js';

const DISMISS_RE = /times_dismissed = (coalesce\()?n\.times_dismissed/;
const PURSUE_RE = /times_pursued = (coalesce\()?n\.times_pursued/;
const SURFACED_RE = /last_surfaced/;

function harness({ neurons, flashResults, feedback }) {
  const calls = [];
  const session = {
    activeTopics: [],
    pendingFlashes: [{
      turn: Date.now(),
      flashes: neurons.map(n => `${n}: flash ${n}`),
      flashNeurons: neurons,
      sourceNeurons: neurons,
      neuronDomains: Object.fromEntries(neurons.map(n => [n, true])),
      neuronDaemons: Object.fromEntries(neurons.map(n => [n, 'vector']))
    }],
    explicitFeedback: feedback
  };
  const deps = {
    req_body: { session_id: 's1' },
    session,
    runCypher: async (q, p) => { calls.push({ q, p }); return []; },
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: { content: [{ text: JSON.stringify({ insights: [], updates: [], train_of_thought: [], flash_results: flashResults }) }] }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: () => {}
  };
  const writes = (name, re) => calls.filter(c => c.p && c.p.name === name && re.test(c.q));
  return { deps, writes };
}

test('Dreamer judged dismissal: times_dismissed +1, last_surfaced untouched; pursuit still sets it', async () => {
  const h = harness({
    neurons: ['A', 'B'],
    flashResults: [
      { flash_text: 'A: flash A', status: 'pursued' },
      { flash_text: 'B: flash B', status: 'dismissed' }
    ]
  });
  await handleSummarize(h.deps);

  const dismissed = h.writes('B', DISMISS_RE);
  assert.equal(dismissed.length, 1, 'B dismissed once');
  assert.doesNotMatch(dismissed[0].q, SURFACED_RE, 'dismissal does not touch last_surfaced');
  assert.ok(!h.writes('B', SURFACED_RE).length, 'no other write to B sets last_surfaced');

  const pursued = h.writes('A', PURSUE_RE);
  assert.equal(pursued.length, 1, 'A pursued once');
  assert.match(pursued[0].q, /n\.last_surfaced = datetime\(\)/, 'pursuit still refreshes last_surfaced');
});

test('Dreamer explicit feedback irrelevant / wrong: dismissed without refreshing last_surfaced', async () => {
  const h = harness({
    neurons: ['A', 'B', 'C'],
    flashResults: [],
    feedback: {
      A: { verdict: 'irrelevant', note: '', ts: 1 },
      B: { verdict: 'wrong', note: 'stale', ts: 2 },
      C: { verdict: 'used', note: '', ts: 3 }
    }
  });
  await handleSummarize(h.deps);
  for (const n of ['A', 'B']) {
    assert.equal(h.writes(n, DISMISS_RE).length, 1, `${n} dismissed`);
    assert.ok(!h.writes(n, SURFACED_RE).length, `${n}: last_surfaced untouched`);
  }
  assert.ok(h.writes('B', /needs_review = true/).length, 'wrong still flags review');
  assert.match(h.writes('C', PURSUE_RE)[0].q, /n\.last_surfaced = datetime\(\)/, 'used still refreshes last_surfaced');
});

test('applyVerdictToNeuron (no session): irrelevant / wrong leave last_surfaced; used sets it', async () => {
  for (const verdict of ['irrelevant', 'wrong']) {
    const calls = [];
    const runCypher = async (q, p) => { calls.push({ q, p }); return []; };
    await applyVerdictToNeuron({ runCypher, name: 'N', ns: null, verdict, note: '', log: () => {} });
    const dismiss = calls.filter(c => DISMISS_RE.test(c.q));
    assert.equal(dismiss.length, 1, `${verdict}: one dismissal write`);
    assert.ok(!calls.some(c => SURFACED_RE.test(c.q)), `${verdict}: no write sets last_surfaced`);
  }

  const calls = [];
  const runCypher = async (q, p) => { calls.push({ q, p }); return []; };
  await applyVerdictToNeuron({ runCypher, name: 'N', ns: null, verdict: 'used', log: () => {} });
  const pursue = calls.find(c => PURSUE_RE.test(c.q));
  assert.match(pursue.q, /n\.last_surfaced = datetime\(\)/);
});
