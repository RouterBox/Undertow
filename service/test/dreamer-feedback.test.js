// Dreamer + explicit feedback: feedback overrides Sonnet's pursuit inference.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize } from '../daemons/dreamer.js';

function harness({ flashResults, feedback, domains = {}, neurons = ['A', 'B', 'C'] }) {
  const calls = [];
  const logs = [];
  const session = {
    activeTopics: [],
    pendingFlashes: [{
      turn: Date.now(),
      flashes: neurons.map(n => `${n}: flash ${n}`),
      sourceNeurons: neurons,
      neuronDomains: Object.fromEntries(neurons.map(n => [n, domains[n] !== false])),
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
    log: (...a) => logs.push(a)
  };
  const has = (name, re) => calls.some(c => c.p && c.p.name === name && re.test(c.q));
  return { deps, session, calls, logs, has };
}

test('feedback overrides Sonnet: used => pursued, wrong => dismissed + needs_review; others untouched', async () => {
  const h = harness({
    flashResults: [{ flash_text: 'A: flash A', status: 'dismissed' }],
    feedback: { A: { verdict: 'used', note: '', ts: 1 }, B: { verdict: 'wrong', note: 'stale fact', ts: 2 } }
  });
  await handleSummarize(h.deps);
  assert.ok(h.has('A', /times_pursued/), 'A pursued despite Sonnet saying dismissed');
  assert.ok(!h.has('A', /times_dismissed/));
  assert.ok(h.has('B', /times_dismissed/), 'B dismissed');
  const flag = h.calls.find(c => c.p && c.p.name === 'B' && /needs_review = true/.test(c.q));
  assert.ok(flag && flag.p.note === 'stale fact');
  assert.ok(h.logs.some(l => l[1] === 'warn' && /flagged for review/.test(l[2])));
  // C had no feedback: Sonnet's status (dismissed) still applies to it via the flash_result covering the entry
  assert.ok(h.has('C', /times_dismissed/));
  assert.deepEqual(h.session.explicitFeedback, {}, 'consumed feedback is cleared');
});

test('feedback is applied even when Sonnet returned no flash_results (synthetic path, feedback neurons only)', async () => {
  const h = harness({ flashResults: [], feedback: { A: { verdict: 'useful', note: '', ts: 1 }, B: { verdict: 'irrelevant', note: '', ts: 2 } } });
  await handleSummarize(h.deps);
  assert.ok(h.has('A', /times_pursued/));
  assert.ok(h.has('B', /times_dismissed/));
  assert.ok(!h.has('B', /needs_review/));
  assert.ok(!h.calls.some(c => c.p && c.p.name === 'C'), 'C (no feedback) untouched');
  assert.deepEqual(h.session.explicitFeedback, {});
});

test('cross-project dismissal stays neutral, but wrong still flags review', async () => {
  const h = harness({
    flashResults: [], domains: { B: false },
    feedback: { B: { verdict: 'wrong', note: 'n', ts: 1 } }
  });
  await handleSummarize(h.deps);
  assert.ok(!h.has('B', /times_dismissed/), 'no dismissal penalty across projects');
  assert.ok(h.has('B', /needs_review = true/));
});

test('no feedback: Sonnet inference is unchanged', async () => {
  const h = harness({ flashResults: [{ flash_text: 'A: flash A', status: 'pursued' }], feedback: undefined });
  await handleSummarize(h.deps);
  assert.ok(h.has('A', /times_pursued/) && h.has('B', /times_pursued/) && h.has('C', /times_pursued/));
  assert.ok(!h.calls.some(c => /needs_review/.test(c.q)));
});
