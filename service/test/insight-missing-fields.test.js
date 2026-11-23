// Dreamer's insight write: an insight the model returned with a field missing
// does not throw, and one bad insight does not cost the turn its other insights.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize } from '../daemons/dreamer.js';

const good = (name) => ({
  name, node_type: 'insight', flash_summary: `${name} in one line.`,
  body: `${name} has a body. It runs to two sentences.`
});

// `insights` is what the model returns; `failCreateFor` names an insight whose
// CREATE throws, as the driver does on a bad write.
function harness(insights, { failCreateFor } = {}) {
  const creates = [];
  const logs = [];
  const entry = {
    turn: Date.now(), flashes: ['kettle flash'], sourceNeurons: ['Kettle'],
    neuronDomains: { Kettle: true }, neuronDaemons: { Kettle: 'vector' }
  };
  const deps = {
    req_body: { session_id: 's1' },
    session: { activeTopics: [], pendingFlashes: [entry] },
    runCypher: async (q, p) => {
      if (/CREATE \(n:Neuron \{/.test(q) && /node_type: \$type/.test(q)) {
        // The real driver rejects a parameter that is undefined.
        for (const [k, v] of Object.entries(p)) if (v === undefined) throw new Error(`Expected parameter(s): ${k}`);
        if (failCreateFor && p.name === failCreateFor) throw new Error('write failed');
        creates.push(p);
      }
      return [];
    },
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: {
        stop_reason: 'end_turn',
        content: [{ text: JSON.stringify({
          insights, updates: [], train_of_thought: [],
          flash_results: [{ flash_text: 'kettle flash', status: 'dismissed' }]
        }) }]
      }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (endpoint, level, message) => logs.push({ endpoint, level, message })
  };
  const at = level => logs.filter(l => l.endpoint === 'summarize' && l.level === level).map(l => l.message);
  return { deps, entry, creates, at };
}

test('a complete insight is written as the model gave it', async () => {
  const h = harness([good('Kettle descaling')]);
  await handleSummarize(h.deps);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].name, 'Kettle descaling');
  assert.equal(h.creates[0].flash, 'Kettle descaling in one line.');
  assert.deepEqual(h.at('warn'), []);
  assert.deepEqual(h.at('error'), []);
});

test('an insight with no summary takes it from the first sentence of its body', async () => {
  const noSummary = { name: 'Kettle thermostat', node_type: 'insight', body: 'The thermostat trips at 96 degrees.  It resets after a minute.' };
  const h = harness([noSummary]);
  await handleSummarize(h.deps);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].flash, 'The thermostat trips at 96 degrees.');
  assert.deepEqual(h.at('error'), []);
});

test('a derived summary is cut to 100 characters', async () => {
  const long = { name: 'Long one', node_type: 'insight', body: `${'word '.repeat(60)}end.` };
  const h = harness([long]);
  await handleSummarize(h.deps);
  assert.equal(h.creates.length, 1);
  assert.ok(h.creates[0].flash.length <= 100, `length ${h.creates[0].flash.length}`);
  assert.ok(h.creates[0].flash.endsWith('...'));
});

test('an insight with no name is skipped with a warning, and the next one is still written', async () => {
  const h = harness([{ node_type: 'insight', flash_summary: 'Nameless.', body: 'A body.' }, good('Second')]);
  await handleSummarize(h.deps);
  assert.deepEqual(h.creates.map(c => c.name), ['Second']);
  assert.equal(h.at('warn').filter(m => /insight not written: it has no name/.test(m)).length, 1);
  assert.deepEqual(h.at('error'), []);
});

test('an insight with neither a summary nor a body is skipped with a warning', async () => {
  const h = harness([{ name: 'Just a tag', node_type: 'insight' }, good('Second')]);
  await handleSummarize(h.deps);
  assert.deepEqual(h.creates.map(c => c.name), ['Second']);
  assert.equal(h.at('warn').filter(m => /neither a summary nor a body/.test(m)).length, 1);
});

test('a write that throws for one insight is logged and does not stop the others', async () => {
  const h = harness([good('First'), good('Breaks'), good('Third')], { failCreateFor: 'Breaks' });
  await handleSummarize(h.deps);
  assert.deepEqual(h.creates.map(c => c.name), ['First', 'Third']);
  assert.equal(h.at('error').length, 1);
  assert.match(h.at('error')[0], /insight not written: write failed/);
});

test('an entry in the insights list that is not an object is skipped, not thrown on', async () => {
  const h = harness([null, 'a bare string', good('Real')]);
  await handleSummarize(h.deps);
  assert.deepEqual(h.creates.map(c => c.name), ['Real']);
});
