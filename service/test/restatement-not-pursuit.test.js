// A turn that only restates an injected flash is not pursuit (re-flash
// investigation 2026-11-27): the judge said "pursued", the neuron was rewarded
// and ranked top again next tick. Dreamer now withholds an inferred pursuit when
// a paragraph of the assistant's own text echoes the neuron (echoOf), and logs it.
// Uses stubbed runCypher / callAnthropic and a temp transcript; no Neo4j or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleSummarize, restatementOf, assistantParagraphs } from '../daemons/dreamer.js';

const NEURON = {
  name: 'Tower curl exit code diagnosis',
  uid: '050999e7-0000-0000-0000-000000000000',
  flash_summary: 'Curl exit 28 on tower long-polls means the 300s server timeout, not a network fault',
  body: "When a curl against the tower exits with code 28, the long-poll hit the server's 300s cap. "
    + 'It is a timeout by design, not a network failure. Re-arm the poll instead of alerting.'
};

const RESTATED = 'Undertow reminds me: Tower curl exit code diagnosis. Curl exit 28 on tower long-polls '
  + "means the 300s server timeout, not a network fault, so it is the server's cap by design.";
const BUILT_ON = 'Exit 28 again at 300s, so I re-armed the tower poll with the same max-time and went back to the inbox review.';

const PURSUE_RE = /times_pursued = n\.times_pursued \+ 1/;
const DISMISS_RE = /times_dismissed = n\.times_dismissed \+ 1/;

function transcriptFile(...assistantTexts) {
  const dir = mkdtempSync(join(tmpdir(), 'undertow-restate-'));
  const path = join(dir, 't.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Heartbeat tick: check the tower long-poll.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -m 300 http://127.0.0.1:3050/poll' } }] } },
    ...assistantTexts.map(text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }))
  ];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n'));
  return path;
}

function harness({ transcript, status = 'pursued', feedback }) {
  const calls = [];
  const logs = [];
  const session = {
    activeTopics: [],
    pendingFlashes: [{
      turn: Date.now(),
      flashes: [`${NEURON.name}: ${NEURON.flash_summary}`],
      flashNeurons: [NEURON.name],
      sourceNeurons: [NEURON.name],
      neuronDomains: { [NEURON.name]: true },
      neuronDaemons: { [NEURON.name]: 'lexical' }
    }],
    explicitFeedback: feedback
  };
  const deps = {
    req_body: { session_id: 's1', transcript_path: transcript },
    session,
    runCypher: async (q, p) => {
      calls.push({ q, p });
      if (/RETURN n\.name AS name, n\.uid AS uid/.test(q) && p?.names?.includes(NEURON.name)) return [NEURON];
      return [];
    },
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: { content: [{ text: JSON.stringify({ insights: [], updates: [], train_of_thought: [], flash_results: [{ flash_text: session.pendingFlashes[0].flashes[0], status }] }) }] }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (...a) => logs.push(a)
  };
  const count = (re) => calls.filter(c => c.p && c.p.name === NEURON.name && re.test(c.q)).length;
  return { deps, calls, logs, count };
}

test('restatementOf: a paragraph that restates the neuron matches; one that builds on it does not', () => {
  const hit = restatementOf(NEURON, [BUILT_ON, RESTATED]);
  assert.ok(hit, 'restatement found');
  assert.equal(hit.neuron.uid, NEURON.uid);
  assert.equal(restatementOf(NEURON, [BUILT_ON]), null);
  assert.equal(restatementOf(NEURON, []), null);
});

test('assistantParagraphs: assistant text only, split on blank lines; [] for non-JSONL', () => {
  const raw = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'USER PROMPT' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'TOOL INPUT' } }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first para\n\nsecond para' }] } })
  ].join('\n');
  assert.deepEqual(assistantParagraphs(raw), ['first para', 'second para']);
  assert.deepEqual(assistantParagraphs('not jsonl'), []);
});

test('a turn that restates the flash is not counted as pursuit (neutral), and is logged with name and uid', async () => {
  const h = harness({ transcript: transcriptFile(RESTATED) });
  await handleSummarize(h.deps);
  assert.equal(h.count(PURSUE_RE), 0, 'no pursuit reward');
  assert.equal(h.count(DISMISS_RE), 0, 'not dismissed either');
  assert.ok(!h.calls.some(c => /d\.pursued|d\.dismissed/.test(c.q)), 'no daemon counter');
  const line = h.logs.find(l => l[1] === 'info' && /^pursuit withheld: restatement of /.test(l[2]));
  assert.ok(line, 'info log for the withheld pursuit');
  assert.ok(line[2].includes(NEURON.name) && line[2].includes(NEURON.uid));
  assert.ok(h.logs.some(l => /^pursuit: ○ restatement /.test(l[2])), 'per-flash line says restatement');
  assert.ok(!h.logs.some(l => /^pursuit: ✓/.test(l[2])));
});

test('genuine use (acts on it, builds on it without restating) still counts as pursuit', async () => {
  const h = harness({ transcript: transcriptFile(BUILT_ON) });
  await handleSummarize(h.deps);
  assert.equal(h.count(PURSUE_RE), 1);
  assert.ok(!h.logs.some(l => /restatement/.test(l[2])));
});

test('explicit used feedback still pursues, even when the turn restates the flash', async () => {
  const h = harness({ transcript: transcriptFile(RESTATED), status: 'dismissed', feedback: { [NEURON.name]: { verdict: 'used', note: '', ts: 1 } } });
  await handleSummarize(h.deps);
  assert.equal(h.count(PURSUE_RE), 1);
});

test('a judged dismissal is unaffected by the check', async () => {
  const h = harness({ transcript: transcriptFile(RESTATED), status: 'dismissed' });
  await handleSummarize(h.deps);
  assert.equal(h.count(DISMISS_RE), 1);
  assert.equal(h.count(PURSUE_RE), 0);
});
