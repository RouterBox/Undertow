// Issue 38: a held insight that restates a neuron injected into the same
// session minutes before is an echo and is not written; a genuinely new insight
// in the same turn still is. Stubs only: no Neo4j, no Anthropic, no embeddings.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize, echoOf, ECHO_THRESHOLD } from '../daemons/dreamer.js';
import { HELD_NAMESPACE, heldCounters } from '../held.js';

// The live neuron Impulse injected into the session a minute ago.
const GATE = {
  name: 'Downstream gate pause', uid: 'gate-uid-0001',
  flash_summary: 'The downstream gate skips a run while another is active, pausing five minutes',
  body: 'Spider and Janitor start from session end and could overlap over the same neurons. The gate records a running flag per daemon and skips a new run while one is active. After a run it pauses five minutes before another can start, so bursts of Stops do not pile up runs.'
};

// The model restating GATE in its own words, under a new name.
const ECHO = {
  name: 'Gate prevents overlapping runs', kind: 'lesson',
  flash_summary: 'Downstream daemons skip a run while one is already active',
  body: 'The downstream gate keeps Spider and Janitor from overlapping over the same neurons at session end. It skips a new run while another is running and then pauses for five minutes, so a burst of Stops does not start many runs.'
};

// A new point on the same topic.
const NEW = {
  name: 'Gate needs a timeout', kind: 'lesson',
  flash_summary: 'A gate flag with no timeout blocks forever after a crash',
  body: 'If the service crashes mid-run, the running flag stays set and the daemon never runs again. The gate should expire the flag after a fixed timeout, longer than the slowest run, so a crash cannot disable Spider permanently.'
};

async function summarize({ insights, injectedAt = Date.now() - 60 * 1000, agentSession = true }) {
  const calls = [];
  const logs = [];
  await handleSummarize({
    req_body: { session_id: 'echo-s1' },
    session: {
      activeTopics: [], explicitFeedback: {},
      pendingFlashes: [{
        turn: injectedAt, judged: true, flashes: [`${GATE.name}: ${GATE.flash_summary}`],
        flashNeurons: [GATE.name], sourceNeurons: [GATE.name],
        neuronDomains: { [GATE.name]: true }, neuronDaemons: { [GATE.name]: 'vector' }
      }]
    },
    runCypher: async (q, p) => {
      for (const m of q.matchAll(/\$([a-zA-Z_]+)/g)) {
        if (p?.[m[1]] === undefined) throw new Error(`Expected parameter(s): ${m[1]}`);
      }
      calls.push({ q, p });
      if (/WHERE n\.name IN \$names/.test(q)) return p.names.includes(GATE.name) ? [GATE] : [];
      return [];
    },
    callAnthropic: async (model) => ({ model, response: { content: [{ text: JSON.stringify({ insights, train_of_thought: [], flash_results: [] }) }] } }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (...a) => logs.push(a),
    agentSession
  });
  const created = calls.filter(c => /CREATE \(n:Neuron/.test(c.q)).map(c => c.p);
  return { calls, created, logs };
}

test('an echo of an injected neuron is skipped and logged with the neuron name and uid', async () => {
  const before = heldCounters().skippedEcho;
  const r = await summarize({ insights: [ECHO] });
  assert.equal(r.created.length, 0, 'the echo is not held');
  const skip = r.logs.find(l => /^held insight skipped: echo of injected neuron/.test(l[2]));
  assert.ok(skip, 'the skip is logged');
  assert.equal(skip[1], 'info');
  assert.equal(skip[2], `held insight skipped: echo of injected neuron ${GATE.name} (${GATE.uid})`);
  assert.ok(!r.logs.some(l => JSON.stringify(l).includes(ECHO.name)), 'the held insight name does not reach the log');
  assert.equal(heldCounters().skippedEcho, before + 1);
});

test('a genuinely new insight in the same turn is still written and held', async () => {
  const r = await summarize({ insights: [ECHO, NEW] });
  assert.deepEqual(r.created.map(p => p.name), [NEW.name]);
  assert.equal(r.created[0].ns, HELD_NAMESPACE);
  assert.equal(r.logs.filter(l => /echo of injected neuron/.test(l[2])).length, 1);
});

test('an injection older than the window is not compared', async () => {
  const r = await summarize({ insights: [ECHO], injectedAt: Date.now() - 30 * 60 * 1000 });
  assert.deepEqual(r.created.map(p => p.name), [ECHO.name]);
  assert.ok(!r.calls.some(c => /WHERE n\.name IN \$names/.test(c.q)), 'no read when nothing was injected recently');
});

test('a human session writes live insights without the echo check', async () => {
  const r = await summarize({ insights: [{ ...ECHO, node_type: 'insight' }], agentSession: false });
  assert.deepEqual(r.created.map(p => p.name), [ECHO.name]);
});

test('echoOf: content match, not name match', () => {
  assert.equal(echoOf(ECHO, [GATE])?.neuron, GATE, 'different name, same content: an echo');
  assert.ok(echoOf(ECHO, [GATE]).score >= ECHO_THRESHOLD);
  assert.equal(echoOf(NEW, [GATE]), null, 'same topic, new point: not an echo');
  assert.equal(echoOf({ name: GATE.name, flash_summary: 'x', body: '' }, [GATE]), null, 'a few shared words are not enough');
  assert.equal(echoOf(ECHO, []), null);
});
