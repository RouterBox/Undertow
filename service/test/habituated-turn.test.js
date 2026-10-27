// Habituated turn = heartbeat: Keeper remembers why, Stop/ingest honour it.
// Stubs only: no Neo4j, no Anthropic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import keeper from '../daemons/keeper.js';
import { summarizeForTurn } from '../daemons/dreamer.js';

const PLUMBING = '<task-notification><task-id>abc</task-id>done</task-notification>';

function stubs(sid) {
  const calls = [];
  const logs = [];
  const mark = (n) => async () => { calls.push(n); };
  const deps = {
    req_body: { session_id: sid },
    session: { activeTopics: ['t'], pendingFlashes: [] },
    runCypher: async () => [],
    callAnthropic: async () => { calls.push('dreamer'); return { model: 'm', response: { content: [{ text: '{"insights":[],"updates":[],"train_of_thought":[]}' }] } }; },
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => true,
    getDaemonConfig: () => ({ schedule: 'session-end' }),
    wonder: { prepare: async () => { calls.push('wonder'); } },
    spider: { run: async () => { calls.push('spider'); } },
    janitor: { run: async () => { calls.push('janitor'); } },
    prowler: { deepResearch: async () => { calls.push('prowler'); } },
    log: (...a) => logs.push(a)
  };
  return { deps, calls, logs };
}
const tick = () => new Promise(r => setImmediate(r));

test('reason: normal -> null, repeat -> repeat, plumbing -> plumbing; return shape kept', () => {
  const sid = 'hv-reason';
  const a = keeper.recordPrompt(sid, 'C:/x', 'conscious', 'first thought about apples');
  assert.deepEqual(Object.keys(a).sort(), ['habituated', 'promoted', 'reason', 'tier']);
  assert.equal(a.habituated, false);
  assert.equal(keeper.turnHabituation(sid), null);
  const b = keeper.recordPrompt(sid, 'C:/x', 'conscious', 'first thought about apples');
  assert.equal(b.habituated, true);
  assert.equal(b.reason, 'repeat');
  assert.equal(keeper.turnHabituation(sid), 'repeat');
  const c = keeper.recordPrompt(sid, 'C:/x', 'conscious', PLUMBING);
  assert.equal(c.habituated, true);
  assert.equal(keeper.turnHabituation(sid), 'plumbing');
  assert.equal(keeper.turnHabituation('never-seen'), null);
});

test('flag clears on the next normal prompt', () => {
  const sid = 'hv-clear';
  keeper.recordPrompt(sid, 'C:/x', 'conscious', 'same heartbeat');
  keeper.recordPrompt(sid, 'C:/x', 'conscious', 'same heartbeat');
  assert.equal(keeper.turnHabituation(sid), 'repeat');
  keeper.recordPrompt(sid, 'C:/x', 'conscious', 'a genuinely different question');
  assert.equal(keeper.turnHabituation(sid), null);
});

test('summarize on repeat skips every daemon', async () => {
  const sid = 'hv-sum-repeat';
  keeper.recordPrompt(sid, 'C:/x', 'conscious', 'tick');
  keeper.recordPrompt(sid, 'C:/x', 'conscious', 'tick');
  const h = stubs(sid);
  const r = await summarizeForTurn(h.deps, keeper);
  await tick();
  assert.equal(r.skipped, true);
  assert.deepEqual(h.calls, []);
  assert.ok(h.logs.some(l => /habituated turn \(repeat\) - skipped/.test(l[2])));
});

test('summarize on plumbing runs Dreamer and the rest but not Wonder prepare', async () => {
  const sid = 'hv-sum-plumb';
  keeper.recordPrompt(sid, 'C:/x', 'conscious', PLUMBING);
  const h = stubs(sid);
  const r = await summarizeForTurn(h.deps, keeper);
  await tick();
  assert.equal(r.skipped, false);
  assert.ok(h.calls.includes('dreamer'));
  assert.ok(!h.calls.includes('wonder'));
  assert.ok(h.calls.includes('spider') && h.calls.includes('janitor') && h.calls.includes('prowler'));
});

test('summarize on a normal turn (or missing flag) is unchanged: Wonder runs', async () => {
  const sid = 'hv-sum-normal';
  keeper.recordPrompt(sid, 'C:/x', 'conscious', 'a normal prompt');
  const h = stubs(sid);
  await summarizeForTurn(h.deps, keeper);
  await tick();
  assert.ok(h.calls.includes('dreamer') && h.calls.includes('wonder'));
  const h2 = stubs('hv-no-flag-at-all');
  await summarizeForTurn(h2.deps, keeper);
  await tick();
  assert.ok(h2.calls.includes('wonder'));
});

test('ingest gate: only a repeat turn skips (plumbing and normal do not)', () => {
  // server.js ingest skips iff keeper.turnHabituation(sid) === 'repeat'
  const skip = (sid) => keeper.turnHabituation(sid) === 'repeat';
  keeper.recordPrompt('hv-i1', 'C:/x', 'conscious', 'beat');
  keeper.recordPrompt('hv-i1', 'C:/x', 'conscious', 'beat');
  keeper.recordPrompt('hv-i2', 'C:/x', 'conscious', PLUMBING);
  keeper.recordPrompt('hv-i3', 'C:/x', 'conscious', 'real work');
  assert.equal(skip('hv-i1'), true);
  assert.equal(skip('hv-i2'), false);
  assert.equal(skip('hv-i3'), false);
});
