// Dreamer's summarize call: a reply cut off at the output limit is reported as
// truncated and asked for once more, not dropped as bad JSON.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize } from '../daemons/dreamer.js';

const FULL = JSON.stringify({
  insights: [], updates: [], train_of_thought: [],
  flash_results: [{ flash_text: 'kettle flash', status: 'dismissed' }]
});
// What a reply cut off mid-array looks like: valid so far, never closed.
const CUT = FULL.slice(0, FULL.length - 20);

const reply = (text, stop_reason) => ({ model: 'claude-sonnet-5', response: { content: [{ text }], stop_reason } });

// `responses` is consumed one per model call; null is a failed call.
function harness(responses) {
  const calls = [];
  const logs = [];
  const entry = {
    turn: Date.now(), flashes: ['kettle flash'], sourceNeurons: ['Kettle'],
    neuronDomains: { Kettle: true }, neuronDaemons: { Kettle: 'vector' }
  };
  const session = { activeTopics: [], pendingFlashes: [entry] };
  const deps = {
    req_body: { session_id: 's1' },
    session,
    runCypher: async () => [],
    callAnthropic: async (model, system, user, maxTokens) => {
      calls.push({ system, user, maxTokens });
      const r = responses.shift();
      return r === undefined ? null : r;
    },
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (endpoint, level, message) => logs.push({ endpoint, level, message })
  };
  const at = level => logs.filter(l => l.endpoint === 'summarize' && l.level === level).map(l => l.message);
  return { deps, entry, calls, at };
}

test('a reply that finishes normally is used as it is, with one call', async () => {
  const h = harness([reply(FULL, 'end_turn')]);
  await handleSummarize(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].maxTokens, 2000);
  assert.equal(h.entry.judged, true);
  assert.deepEqual(h.at('warn'), []);
});

test('a reply cut off at the limit is logged as truncated and asked for once more with a higher limit', async () => {
  const h = harness([reply(CUT, 'max_tokens'), reply(FULL, 'end_turn')]);
  await handleSummarize(h.deps);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map(c => c.maxTokens), [2000, 4000]);
  assert.equal(h.calls[1].user, h.calls[0].user, 'the retry asks the same question');
  assert.equal(h.calls[1].system, h.calls[0].system);
  assert.equal(h.at('warn').length, 1);
  assert.match(h.at('warn')[0], /truncated at the 2000-token limit; retrying once with 4000/);
  assert.equal(h.entry.judged, true, 'the retried reply is the one that is used');
  assert.deepEqual(h.at('error'), []);
});

test('a reply cut off twice is given up loudly, after exactly one retry, and judges nothing', async () => {
  const h = harness([reply(CUT, 'max_tokens'), reply(CUT, 'max_tokens'), reply(FULL, 'end_turn')]);
  await handleSummarize(h.deps);
  assert.equal(h.calls.length, 2, 'one retry, not a loop');
  assert.equal(h.at('error').length, 1);
  assert.match(h.at('error')[0], /truncated again at the 4000-token limit: turn not summarized/);
  assert.notEqual(h.entry.judged, true, 'the entry is left for the next Stop');
  assert.ok(!h.entry.judging, 'the claim on the entry is released');
});

test('a retry whose call fails is reported, and judges nothing', async () => {
  const h = harness([reply(CUT, 'max_tokens'), null]);
  await handleSummarize(h.deps);
  assert.equal(h.calls.length, 2);
  assert.match(h.at('error')[0], /retry after a truncated reply failed: turn not summarized/);
  assert.notEqual(h.entry.judged, true);
});

test('a truncated reply that happens to parse is still retried, not trusted', async () => {
  // Cut off after a complete object: it parses, but it is not the whole answer.
  const partial = JSON.stringify({ insights: [], flash_results: [] });
  const h = harness([reply(partial, 'max_tokens'), reply(FULL, 'end_turn')]);
  await handleSummarize(h.deps);
  assert.equal(h.calls.length, 2);
  assert.equal(h.entry.judged, true);
});
