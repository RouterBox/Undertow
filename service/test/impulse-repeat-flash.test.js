// Impulse: a neuron already shown to a prompt is not shown again to the same
// prompt in the same session, for a limited time.
// Drives handleQuery with stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleQuery, promptKey } from '../daemons/impulse.js';

const SURFACED_RE = /times_surfaced = coalesce\(n\.times_surfaced, 0\) \+ 1/;

let run = 0;

// A scheduled prompt carries the time it ran. That makes each run a distinct key
// for the 60s query cache, while it is still the same prompt for repeat tracking.
// Kept over 100 characters so the flow-state shortcut for short rapid prompts does not apply.
const stamp = () => new Date(Date.UTC(2026, 0, 1) + (++run) * 1000).toISOString();
const recurring = (topic = 'kettle thermostat') => `Scheduled check at ${stamp()}: confirm the ${topic} tuning is still correct, say what changed since the last check, and list anything that needs attention`;

function harness({ candidates, flashMode, haikuText, impulseConfig = {} }) {
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
    isDaemonEnabled: () => false, getDaemonConfig: () => ({ decomposeQueries: false, ...impulseConfig }),
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

// --- Review defect 1: prompts that differ in a number are different prompts ---

test('promptKey keeps numbers: "review PR 16" and "review PR 17" are different prompts', () => {
  assert.notEqual(promptKey('review PR 16'), promptKey('review PR 17'));
  assert.notEqual(promptKey('check commit 9d58724'), promptKey('check commit 976bf44'));
});

test('promptKey ignores only what changes between runs of one scheduled prompt', () => {
  assert.equal(promptKey('Check at 2026-11-22T14:26:34.931Z: is PR 16 merged?'), promptKey('Check at 2026-11-23T02:00:01Z: is PR 16 merged?'));
  assert.equal(promptKey('tick 14:26 review PR 16'), promptKey('tick  09:05:10 review PR 16'));
  assert.equal(promptKey('session 8ace41c8-ec8c-4c9c-84dc-c161c2b2a994 done'), promptKey('session 9b10f77a-9fc2-4398-87d3-bdb56a33c47e done'));
  assert.equal(promptKey('<task-id>bop7nfjwh</task-id> finished'), promptKey('<task-id>bgr1tuyzx</task-id> finished'));
  assert.equal(promptKey('at 1763821594931 run'), promptKey('at 1763825194000 run'));
});

test('promptKey hashes the whole prompt, not a prefix', () => {
  const preamble = 'You are a careful reviewer. '.repeat(40); // over 600 characters
  assert.ok(preamble.length > 600);
  assert.notEqual(promptKey(`${preamble}Review the kettle thermostat.`), promptKey(`${preamble}Review the greenhouse irrigation.`));
});

test('a prompt that differs only in a number still gets the neuron', async () => {
  const h = harness({ candidates: ['A', 'B'], flashMode: 'raw' });
  const ask = (pr) => `Review PR ${pr} against the plan at ${stamp()}: confirm the kettle thermostat tuning is still correct and list anything that needs attention`;
  await handleQuery(h.deps(ask(16)));
  const other = await handleQuery(h.deps(ask(17)));
  assert.ok(blockOf(other).includes('A:') && blockOf(other).includes('B:'), 'PR 17 is not PR 16');
  const again = await handleQuery(h.deps(ask(16)));
  assert.equal(blockOf(again), '', 'the same prompt again is still recognised');
});

// --- Review defect 2: only what was shown is remembered ---

test('haiku: nothing is remembered and nothing is left out', async () => {
  const h = harness({ candidates: ['A', 'B', 'C'], flashMode: 'haiku', haikuText: JSON.stringify({ flashes: ['something about A'], topics_detected: [] }) });
  const first = await handleQuery(h.deps(recurring()));
  const second = await handleQuery(h.deps(recurring()));
  assert.ok(blockOf(first).includes('something about A'));
  assert.ok(blockOf(second).includes('something about A'), 'the repeat is flashed as before');
  assert.equal(h.session.flashedByPrompt, undefined, 'which neurons Haiku drew on is unknown, so none is remembered');
  assert.deepEqual(h.surfacedNames(), [['A', 'B', 'C'], ['A', 'B', 'C']], 'the surfaced count is unchanged');
  assert.ok(!h.logs.some(l => /already flashed/.test(l[2])));
});

test('both: only the 8 raw neurons written into the block are remembered, not every candidate', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `N${i + 1}`);
  const h = harness({ candidates: names, flashMode: 'both', haikuText: JSON.stringify({ flashes: ['a flash'], topics_detected: [] }) });
  await handleQuery(h.deps(recurring()));
  const second = await handleQuery(h.deps(recurring()));
  const block = blockOf(second);
  assert.ok(block.includes('N9:') && block.includes('N10:'), 'N9 and N10 were candidates but never shown: they come through');
  assert.ok(!block.includes('N1:'), 'N1 was shown and is left out');
});

// --- Review defect 3: it expires ---

test('after the expiry the neuron is shown again', async () => {
  const h = harness({ candidates: ['A', 'B'], flashMode: 'raw', impulseConfig: { repeatFlashMinutes: 30 } });
  await handleQuery(h.deps(recurring()));
  assert.equal(blockOf(await handleQuery(h.deps(recurring()))), '', 'inside the window: left out');

  // Age what the session remembers by 31 minutes.
  for (const shown of Object.values(h.session.flashedByPrompt)) for (const n of Object.keys(shown)) shown[n] -= 31 * 60_000;
  const later = await handleQuery(h.deps(recurring()));
  assert.ok(blockOf(later).includes('A:') && blockOf(later).includes('B:'), 'past the window: shown again');
});

test('repeatFlashMinutes 0 turns it off', async () => {
  const h = harness({ candidates: ['A'], flashMode: 'raw', impulseConfig: { repeatFlashMinutes: 0 } });
  await handleQuery(h.deps(recurring()));
  const second = await handleQuery(h.deps(recurring()));
  assert.ok(blockOf(second).includes('A:'));
  assert.equal(h.session.flashedByPrompt, undefined);
});
