// Agent sessions: Keeper says who a session is; Dreamer writes only durable
// kinds from an agent session and holds them in the quarantine namespace; a
// chase or a used/useful verdict releases a held neuron.
// Stubs only: no Neo4j, no Anthropic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import keeper from '../daemons/keeper.js';
import { handleSummarize, summarizeForTurn, SUMMARIZE_SYSTEM_PROMPT, AGENT_SUMMARIZE_SYSTEM_PROMPT } from '../daemons/dreamer.js';
import { HELD_NAMESPACE, DURABLE_KINDS, durableKind, nodeTypeForKind, isHeld, releaseHeld } from '../held.js';

// Small thresholds so a test can reach both promotion paths. Session ids are
// unique per run: setKind persists the ledger file.
keeper.init({ daemonConfig: { agenticToolEvents: 2, agenticMinHours: 1e-9, minCadenceSeconds: 0.001, agentCwdPatterns: ['AgentPlace'] } });
const run = Date.now().toString(36);
const id = (s) => `held-${s}-${run}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Keeper: who is on the other end ----------

test('a session promoted by tool volume is an agent session', async () => {
  const sid = id('volume');
  keeper.recordPrompt(sid, 'C:/work/app', undefined, 'one long instruction to go and do a job');
  assert.equal(keeper.sessionKind(sid).kind, 'human', 'a candidate is not an agent yet');
  await sleep(5);
  keeper.recordToolEvent(sid);
  keeper.recordToolEvent(sid);
  assert.equal(keeper.tierOf(sid), 'conscious');
  assert.deepEqual(keeper.sessionKind(sid), { kind: 'agent', why: 'promoted by tool volume' });
});

test('a session promoted by turn-taking is a human session', async () => {
  const sid = id('turns');
  for (const p of ['what does the gate do', 'and why is the pause five minutes', 'ok, show me the config']) {
    keeper.recordPrompt(sid, 'C:/work/app', undefined, p);
    await sleep(5);
  }
  assert.equal(keeper.tierOf(sid), 'conscious');
  assert.equal(keeper.sessionKind(sid).kind, 'human');
});

test('tool-volume promotion followed by real turn-taking becomes human', async () => {
  const sid = id('volume-then-turns');
  keeper.recordPrompt(sid, 'C:/work/app', undefined, 'start on the refactor please');
  await sleep(5);
  keeper.recordToolEvent(sid);
  keeper.recordToolEvent(sid);
  assert.equal(keeper.sessionKind(sid).kind, 'agent');
  keeper.recordPrompt(sid, 'C:/work/app', undefined, 'that looks wrong, why did you move the helper');
  await sleep(5);
  keeper.recordPrompt(sid, 'C:/work/app', undefined, 'fine, keep it but rename the file');
  assert.equal(keeper.sessionKind(sid).kind, 'human');
});

test('a cwd on the agent list marks the session as agent, case-insensitively', () => {
  const sid = id('cwd');
  keeper.recordPrompt(sid, 'c:/github/agentplace/worker', 'conscious', 'an order that arrives as a prompt');
  assert.deepEqual(keeper.sessionKind(sid), { kind: 'agent', why: 'cwd matches "AgentPlace"' });
  assert.equal(keeper.sessionKind(sid, 'C:/github/AGENTPLACE').kind, 'agent', 'cwd from the hook body works too');
  const other = id('cwd-other');
  keeper.recordPrompt(other, 'C:/github/elsewhere', 'conscious', 'a person asking something');
  assert.equal(keeper.sessionKind(other).kind, 'human');
});

test('a declared kind wins, can be cleared, and rejects anything else', () => {
  const sid = id('declared');
  keeper.recordPrompt(sid, 'C:/github/AgentPlace', 'conscious', 'hello there');
  assert.equal(keeper.setKind(sid, 'human'), true);
  assert.deepEqual(keeper.sessionKind(sid), { kind: 'human', why: 'declared' });
  assert.equal(keeper.setKind(sid, null), true);
  assert.equal(keeper.sessionKind(sid).kind, 'agent', 'back to the cwd rule');
  assert.equal(keeper.setKind(sid, 'robot'), false);
  const plain = id('declared-agent');
  keeper.recordPrompt(plain, 'C:/github/elsewhere', 'conscious', 'hello again');
  keeper.setKind(plain, 'agent');
  assert.deepEqual(keeper.sessionKind(plain), { kind: 'agent', why: 'declared' });
  assert.equal(keeper.sessionKind('never-seen-' + run).kind, 'human');
});

// ---------- Dreamer: what an agent session may write ----------

const REPLY = {
  insights: [
    { name: 'Gate needs a timeout', kind: 'lesson', flash_summary: 'A gate with no timeout blocks forever', body: 'Two sentences of body. Enough to pass.', connections: [{ target_name: 'Downstream gate' }] },
    { name: 'Restore a backup', kind: 'procedure', flash_summary: 'Run restore.cjs from the service folder', body: 'Two sentences of body. Enough to pass.' },
    { name: 'Hold agent insights', kind: 'Decision', flash_summary: 'Agent insights are held until used', body: 'Two sentences of body. Enough to pass.' },
    { name: 'PR 16 sent back', kind: 'status', flash_summary: 'PR 16 has three defects', body: 'Two sentences of body. Enough to pass.' },
    { name: 'Service restarted', node_type: 'fact', flash_summary: 'Restarted at noon', body: 'Two sentences of body. Enough to pass.' }
  ],
  updates: [{ existing_name: 'Old neuron', flash_summary: 'rewritten', body: 'rewritten body', reason: 'agent said so' }],
  train_of_thought: [], flash_results: []
};

async function summarize({ agentSession, namespace = null, reply = REPLY } = {}) {
  const calls = [];
  const logs = [];
  let systemPrompt = null;
  await handleSummarize({
    req_body: { session_id: 's1', namespace },
    session: { activeTopics: [], pendingFlashes: [], explicitFeedback: {} },
    // The real driver rejects a query whose parameter is undefined; do the same.
    runCypher: async (q, p) => {
      for (const m of q.matchAll(/\$([a-zA-Z_]+)/g)) {
        if (p?.[m[1]] === undefined) throw new Error(`Expected parameter(s): ${m[1]}`);
      }
      calls.push({ q, p });
      return [];
    },
    callAnthropic: async (model, system) => { systemPrompt = system; return { model, response: { content: [{ text: JSON.stringify(reply) }] } }; },
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (...a) => logs.push(a),
    agentSession
  });
  const created = calls.filter(c => /CREATE \(n:Neuron/.test(c.q)).map(c => c.p);
  const edges = calls.filter(c => /CREATE \(src\)-\[:SYNAPSE/.test(c.q));
  return { calls, created, edges, logs, systemPrompt };
}

test('agent session: only lesson, procedure and decision are written, and they are held', async () => {
  const r = await summarize({ agentSession: true });
  assert.equal(r.systemPrompt, AGENT_SUMMARIZE_SYSTEM_PROMPT);
  assert.deepEqual(r.created.map(p => p.name), ['Gate needs a timeout', 'Restore a backup', 'Hold agent insights']);
  for (const p of r.created) {
    assert.equal(p.ns, HELD_NAMESPACE);
    assert.equal(p.originKind, 'agent');
    assert.equal(p.originSession, 's1');
  }
  assert.deepEqual(r.created.map(p => p.durableKind), ['lesson', 'procedure', 'decision']);
  assert.deepEqual(r.created.map(p => p.type), ['insight', 'insight', 'decision']);
  const dropped = r.logs.filter(l => /insight not written, no durable kind/.test(l[2])).map(l => l[2]);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.some(m => m.includes('PR 16 sent back')) && dropped.some(m => m.includes('Service restarted')));
  assert.deepEqual(r.logs.filter(l => l[1] === 'warn' || l[1] === 'error'), []);
});

test('agent session: nothing existing is rewritten and no edge is made', async () => {
  const r = await summarize({ agentSession: true });
  assert.equal(r.calls.filter(c => c.p?.name === 'Old neuron').length, 0, 'the update is ignored');
  assert.equal(r.edges.length, 0);
});

test('agent session: the name check covers the live graph and the held tier', async () => {
  const r = await summarize({ agentSession: true });
  const check = r.calls.find(c => /RETURN n\.name LIMIT 1/.test(c.q) && c.p.name === 'Restore a backup');
  assert.match(check.q, /n\.namespace = \$held/);
  assert.deepEqual(check.p, { name: 'Restore a backup', ns: null, held: HELD_NAMESPACE });
});

test('agent session in its own namespace: strict rule applies, the namespace is kept', async () => {
  const r = await summarize({ agentSession: true, namespace: 'work' });
  assert.equal(r.created.length, 3);
  for (const p of r.created) assert.equal(p.ns, 'work');
});

test('human session: prompt, types, namespace, updates and connections are as before; origin is recorded', async () => {
  const r = await summarize({ agentSession: false });
  assert.equal(r.systemPrompt, SUMMARIZE_SYSTEM_PROMPT);
  assert.equal(r.created.length, 5, 'no kind filter');
  for (const p of r.created) {
    assert.equal(p.ns, null);
    assert.equal(p.originKind, 'human');
    assert.equal(p.originSession, 's1');
    assert.equal(p.durableKind, null);
  }
  assert.equal(r.created[4].type, 'fact');
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].p.tgt, 'Downstream gate');
  assert.ok(r.calls.some(c => c.p?.name === 'Old neuron'), 'the update is attempted');
});

test('the agent prompt states the rule and forbids naming actors; it asks for no updates or connections', () => {
  for (const k of DURABLE_KINDS) assert.ok(AGENT_SUMMARIZE_SYSTEM_PROMPT.includes(`"${k}"`));
  assert.match(AGENT_SUMMARIZE_SYSTEM_PROMPT, /still be true and useful a month from now/);
  assert.match(AGENT_SUMMARIZE_SYSTEM_PROMPT, /pull requests, branches, commits, merges, deploys/);
  assert.match(AGENT_SUMMARIZE_SYSTEM_PROMPT, /Do not say who did, said, found or decided/);
  assert.doesNotMatch(AGENT_SUMMARIZE_SYSTEM_PROMPT, /"updates"|"connections"/);
});

test('Stop: Keeper decides which rule Dreamer uses', async () => {
  const prompts = [];
  const deps = (sid) => ({
    req_body: { session_id: sid },
    session: { activeTopics: [], pendingFlashes: [] },
    runCypher: async () => [],
    callAnthropic: async (m, system) => { prompts.push(system); return { model: m, response: { content: [{ text: '{"insights":[],"train_of_thought":[],"flash_results":[]}' }] } }; },
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: () => {}
  });
  const agent = id('stop-agent');
  keeper.recordPrompt(agent, 'C:/work/app', 'conscious', 'do the nightly job');
  keeper.setKind(agent, 'agent');
  await summarizeForTurn(deps(agent), keeper);
  const human = id('stop-human');
  keeper.recordPrompt(human, 'C:/work/app', 'conscious', 'a person with a question');
  await summarizeForTurn(deps(human), keeper);
  assert.deepEqual(prompts, [AGENT_SUMMARIZE_SYSTEM_PROMPT, SUMMARIZE_SYSTEM_PROMPT]);
});

// ---------- Held tier: kinds and release ----------

test('durableKind accepts the three kinds only', () => {
  assert.equal(durableKind({ kind: 'lesson' }), 'lesson');
  assert.equal(durableKind({ kind: ' Procedure ' }), 'procedure');
  assert.equal(durableKind({ kind: 'decision' }), 'decision');
  assert.equal(durableKind({ kind: 'status' }), null);
  assert.equal(durableKind({ node_type: 'decision' }), null, 'node_type is not a kind');
  assert.equal(durableKind({ kind: 42 }), null);
  assert.equal(durableKind(null), null);
  assert.equal(nodeTypeForKind('decision'), 'decision');
  assert.equal(nodeTypeForKind('lesson'), 'insight');
});

test('releaseHeld moves a held neuron to the live graph and says what released it', async () => {
  const calls = [];
  const logs = [];
  const released = await releaseHeld({
    runCypher: async (q, p) => { calls.push({ q, p }); return [{ name: p.name }]; },
    name: 'Restore a backup', by: 'chase', log: (...a) => logs.push(a)
  });
  assert.equal(released, true);
  assert.deepEqual(calls[0].p, { name: 'Restore a backup', held: HELD_NAMESPACE, by: 'chase' });
  assert.match(calls[0].q, /n\.namespace = \$held AND n\.superseded IS NULL/);
  assert.match(calls[0].q, /NOT EXISTS \{\s*MATCH \(l:Neuron \{name: \$name\}\) WHERE l\.namespace IS NULL/, 'a live neuron of the same name blocks the release');
  assert.match(calls[0].q, /SET n\.namespace = null, n\.released_at = datetime\(\), n\.released_by = \$by, n\.spidered = false/);
  assert.ok(logs.some(l => /held neuron released to the live graph: Restore a backup/.test(l[2])));
});

test('releaseHeld reports false and logs nothing when no held neuron matched', async () => {
  const logs = [];
  const released = await releaseHeld({ runCypher: async () => [], name: 'Live already', by: 'feedback:used', log: (...a) => logs.push(a) });
  assert.equal(released, false);
  assert.deepEqual(logs, []);
});

test('isHeld asks only the held namespace', async () => {
  const seen = [];
  assert.equal(await isHeld({ runCypher: async (q, p) => { seen.push({ q, p }); return [{ name: 'x' }]; }, name: 'x' }), true);
  assert.equal(await isHeld({ runCypher: async () => [], name: 'x' }), false);
  assert.deepEqual(seen[0].p, { name: 'x', held: HELD_NAMESPACE });
});
