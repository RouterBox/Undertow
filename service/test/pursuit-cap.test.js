// base_score is capped at 100 on every pursuit increment: Dreamer's pursuit (+10),
// chase (+15) and explicit feedback without a session (+10). Dreamer's path had
// no cap (re-flash investigation 2026-11-27: a neuron reached 110).
// The stubbed runCypher captures each SET, and the test evaluates the captured
// base_score CASE expression for a given starting score. No Neo4j is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize } from '../daemons/dreamer.js';
import { rewardChase } from '../chase.js';
import { applyVerdictToNeuron } from '../daemons/curated.js';

// Evaluate the `n.base_score = CASE ... END` assignment in a captured query for a
// neuron whose stored base_score is `score`. Handles the flat CASE WHEN/THEN/ELSE
// forms these queries use, with NOT, coalesce(n.base_score, 0) and $params.
function evalBaseScore(query, params, score) {
  const m = query.match(/n\.base_score\s*=\s*(CASE[\s\S]*?END)/);
  assert.ok(m, 'query sets base_score with a CASE');
  let js = m[1]
    .replace(/coalesce\(n\.base_score,\s*0\)/g, 'S')
    .replace(/n\.base_score/g, 'S')
    .replace(/\$(\w+)/g, (_, k) => JSON.stringify(params[k]))
    .replace(/\bNOT\b/g, '!')
    .replace(/\s+/g, ' ')
    .trim();
  js = js.replace(/^CASE /, '(').replace(/ END$/, ')')
    .replace(/WHEN (.+?) THEN (.+?)(?= WHEN | ELSE )/g, '($1) ? ($2) :')
    .replace(/ ELSE (.+)\)$/, ' ($1))');
  return Function('S', `return ${js};`)(score);
}

async function dreamerPursuit(score, { alreadyReinforced = false } = {}) {
  const calls = [];
  const session = {
    activeTopics: [],
    pendingFlashes: [{
      turn: Date.now(), flashes: ['A: flash A'], flashNeurons: ['A'], sourceNeurons: ['A'],
      neuronDomains: { A: true }, neuronDaemons: { A: 'vector' }
    }],
    pursuedThisSession: alreadyReinforced ? new Set(['A']) : undefined
  };
  await handleSummarize({
    req_body: { session_id: 's1' },
    session,
    runCypher: async (q, p) => { calls.push({ q, p }); return []; },
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: { content: [{ text: JSON.stringify({ insights: [], updates: [], train_of_thought: [], flash_results: [{ flash_text: 'A: flash A', status: 'pursued' }] }) }] }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: () => {}
  });
  const set = calls.find(c => c.p?.name === 'A' && /times_pursued = n\.times_pursued \+ 1/.test(c.q));
  assert.ok(set, 'pursuit write captured');
  return evalBaseScore(set.q, set.p, score);
}

test('Dreamer pursuit: 98 + 10 ends at 100; 100 stays 100; below the cap it adds 10', async () => {
  assert.equal(await dreamerPursuit(98), 100);
  assert.equal(await dreamerPursuit(100), 100);
  assert.equal(await dreamerPursuit(50), 60);
});

test('Dreamer pursuit already reinforced this session: score unchanged', async () => {
  assert.equal(await dreamerPursuit(98, { alreadyReinforced: true }), 98);
  assert.equal(await dreamerPursuit(50, { alreadyReinforced: true }), 50);
});

test('chase and no-session feedback use the same cap at 100', async () => {
  const calls = [];
  const runCypher = async (q, p) => { calls.push({ q, p }); return [{ 'n.name': 'A' }]; };
  await rewardChase({ runCypher, name: 'A' });
  const chase = calls.find(c => /n\.base_score\s*=/.test(c.q));
  assert.equal(evalBaseScore(chase.q, chase.p, 98), 100);
  assert.equal(evalBaseScore(chase.q, chase.p, 100), 100);

  calls.length = 0;
  await applyVerdictToNeuron({ runCypher, name: 'A', ns: null, verdict: 'used', log: () => {} });
  const fb = calls.find(c => /n\.base_score\s*=/.test(c.q));
  assert.equal(evalBaseScore(fb.q, fb.p, 98), 100);
  assert.equal(evalBaseScore(fb.q, fb.p, 100), 100);
});
