// Impulse: a neuron already flashed to a prompt is not flashed again to the
// same prompt in the same session.
// Drives handleQuery with stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleQuery } from '../daemons/impulse.js';

const SURFACED_RE = /times_surfaced = coalesce\(n\.times_surfaced, 0\) \+ 1/;

let run = 0;

// Prompts that differ only in a number have the same fingerprint (as a scheduled
// check with a timestamp in it does) but are distinct keys for the 60s query cache.
// Kept over 100 characters so the flow-state shortcut for short rapid prompts does not apply.
const recurring = (topic = 'kettle thermostat') => `Scheduled check ${++run}: confirm the ${topic} tuning is still correct, say what changed since the last check, and list anything that needs attention`;

function harness({ candidates, flashMode, haikuText }) {
  const calls = [];
  const logs = [];
  const session = { activeTopics: [], pendingFlashes: [] };
  const deps = (prompt, sess = session) => ({
    req_body: { prompt, session_id: 's1' },
    session: sess,
    runCypher: async (q, p) => {
      calls.push({ q, p });
      if (/'keyword' AS daemon/.test(q)) return candidates.map((name, i) => ({ name, flash: `flash ${name}`, type: 'fact', score: 1 - i * 0.01, daemon: 'keyword' }));
      return [];
    },
    callAnthropic: async () => ({ response: { content: [{ text: typeof haikuText === 'function' ? haikuText() : haikuText }] } }),
    getEmbedding: async () => null, embeddingsAvailable: () => false,
    isDaemonEnabled: () => false, getDaemonConfig: () => ({ decomposeQueries: false }),
    wonder: {}, prowler: {},
    log: (...a) => logs.push(a),
    flashMode
  });
  const surfacedNames = () => calls.filter(c => SURFACED_RE.test(c.q)).map(c => c.p.names);
  return { deps, session, logs, surfacedNames };
}

const blockOf = (out) => out.responseJson?.hookSpecificOutput?.additionalContext || '';

test('raw: the second time the same prompt comes, the neurons already shown are left out', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `N${i + 1}`);
  const h = harness({ candidates: names, flashMode: 'raw' });

  const first = await handleQuery(h.deps(recurring()));
  assert.ok(blockOf(first).includes('N1:') && blockOf(first).includes('N8:'));

  const second = await handleQuery(h.deps(recurring()));
  const block = blockOf(second);
  for (const n of names.slice(0, 8)) assert.ok(!block.includes(`${n}:`), `${n} was shown before and is not shown again`);
  assert.ok(block.includes('N9:') && block.includes('N10:'), 'candidates not shown before still come through');
  assert.deepEqual(h.surfacedNames(), [names.slice(0, 8), ['N9', 'N10']]);
  assert.ok(h.logs.some(l => /already flashed to this prompt in this session: 8 candidate/.test(l[2])));

  const third = await handleQuery(h.deps(recurring()));
  assert.equal(blockOf(third), '', 'nothing left to show: nothing is injected');
  assert.equal(h.surfacedNames().length, 2, 'and nothing is counted');
});

test('curated: a pick is not offered again to the same prompt', async () => {
  // Haiku always selects candidate 1 of whatever list it is given.
  const h = harness({ candidates: ['A', 'B', 'C'], flashMode: 'curated', haikuText: JSON.stringify({ selected: [{ n: 1, why: 'relevant' }] }) });

  await handleQuery(h.deps(recurring()));
  await handleQuery(h.deps(recurring()));
  await handleQuery(h.deps(recurring()));
  assert.deepEqual(h.surfacedNames(), [['A'], ['B'], ['C']], 'each neuron is flashed once, then the next best');

  const fourth = await handleQuery(h.deps(recurring()));
  assert.equal(blockOf(fourth), '');
  assert.equal(h.surfacedNames().length, 3);
});

test('a different prompt in the same session still gets the neuron', async () => {
  const h = harness({ candidates: ['A', 'B'], flashMode: 'raw' });
  await handleQuery(h.deps(recurring('kettle thermostat')));
  const other = await handleQuery(h.deps(recurring('greenhouse irrigation')));
  assert.ok(blockOf(other).includes('A:') && blockOf(other).includes('B:'));
});

test('the same prompt in another session still gets the neuron', async () => {
  const h = harness({ candidates: ['A', 'B'], flashMode: 'raw' });
  await handleQuery(h.deps(recurring()));
  const otherSession = { activeTopics: [], pendingFlashes: [] };
  const out = await handleQuery(h.deps(recurring(), otherSession));
  assert.ok(blockOf(out).includes('A:') && blockOf(out).includes('B:'));
});

test('a session remembers a bounded number of prompts', async () => {
  const h = harness({ candidates: ['A'], flashMode: 'raw' });
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike'];
  let made = 0;
  for (const a of words) {
    for (const b of words.slice(0, 5)) {
      await handleQuery(h.deps(recurring(`${a} ${b}`)));
      made++;
    }
  }
  assert.ok(made > 50);
  assert.ok(Object.keys(h.session.flashedByPrompt).length <= 50);
});
