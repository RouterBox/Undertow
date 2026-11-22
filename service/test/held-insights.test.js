// Agent sessions: Keeper says who a session is (a declared fact, never
// behaviour); Dreamer writes only durable kinds from an agent session and holds
// them in the quarantine namespace; a chase or a used/useful verdict from a
// human session releases a held neuron.
// Stubs only: no Neo4j, no Anthropic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import keeper from '../daemons/keeper.js';
import { handleSummarize, summarizeForTurn, SUMMARIZE_SYSTEM_PROMPT, AGENT_SUMMARIZE_SYSTEM_PROMPT } from '../daemons/dreamer.js';
import { handleIngest } from '../daemons/gobble.js';
import { resetRosterCache } from '../agent-roster.js';
import { HELD_NAMESPACE, DURABLE_KINDS, durableKind, nodeTypeForKind, isHeld, releaseHeld, canRelease, listHeld, heldCounters } from '../held.js';

// Small thresholds so a test can reach both promotion paths. Session ids are
// unique per run: setKind persists the ledger file.
const keeperLogs = [];
keeper.init({ log: (...a) => keeperLogs.push(a), daemonConfig: { agenticToolEvents: 2, agenticMinHours: 1e-9, minCadenceSeconds: 0.001, agentCwdPatterns: ['AgentPlace'] } });
const run = Date.now().toString(36);
const id = (s) => `held-${s}-${run}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Keeper: who is on the other end ----------

test('behaviour never decides: tool-volume and turn-taking promotion both leave a session human', async () => {
  const volume = id('volume');
  keeper.recordPrompt(volume, 'C:/work/app', undefined, 'one long instruction to go and do a job');
  await sleep(5);
  keeper.recordToolEvent(volume);
  keeper.recordToolEvent(volume);
  assert.equal(keeper.tierOf(volume), 'conscious');
  assert.deepEqual(keeper.sessionKind(volume), { kind: 'human', why: 'default' });

  const turns = id('turns');
  for (const p of ['what does the gate do', 'and why is the pause five minutes', 'ok, show me the config']) {
    keeper.recordPrompt(turns, 'C:/work/app', undefined, p);
    await sleep(5);
  }
  assert.equal(keeper.tierOf(turns), 'conscious');
  assert.equal(keeper.sessionKind(turns).kind, 'human');
});

test('a flagged session is an agent whatever its turn-taking looks like', async () => {
  const sid = id('flagged');
  keeper.markAgent(sid, 'nightly-worker');
  for (const p of ['first varied prompt about gates', 'second varied prompt about pauses', 'third varied prompt about config']) {
    keeper.recordPrompt(sid, 'C:/work/app', undefined, p);
    await sleep(5);
  }
  assert.equal(keeper.tierOf(sid), 'conscious', 'it looks conversational');
  assert.deepEqual(keeper.sessionKind(sid), { kind: 'agent', why: 'flagged (nightly-worker)' });
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

test('a declared kind beats the flag and the cwd list, can be cleared, and rejects anything else', () => {
  const sid = id('declared');
  keeper.recordPrompt(sid, 'C:/github/AgentPlace', 'conscious', 'hello there');
  keeper.markAgent(sid, 'worker');
  assert.equal(keeper.setKind(sid, 'human'), true);
  assert.deepEqual(keeper.sessionKind(sid), { kind: 'human', why: 'declared' });
  assert.equal(keeper.setKind(sid, null), true);
  assert.equal(keeper.sessionKind(sid).why, 'flagged (worker)', 'back to the flag');
  assert.equal(keeper.setKind(sid, 'robot'), false);
  const plain = id('declared-agent');
  keeper.recordPrompt(plain, 'C:/github/elsewhere', 'conscious', 'hello again');
  keeper.setKind(plain, 'agent');
  assert.deepEqual(keeper.sessionKind(plain), { kind: 'agent', why: 'declared' });
  assert.equal(keeper.sessionKind('never-seen-' + run).kind, 'human');
});

test('the operator can see who a session is: one log line per rule, and the snapshot lists kind and why', () => {
  const sid = id('visible');
  keeper.recordPrompt(sid, 'C:/github/AgentPlace/x', 'conscious', 'working in a listed directory');
  const before = keeperLogs.length;
  keeper.sessionKind(sid);
  keeper.sessionKind(sid);
  keeper.sessionKind(sid);
  const lines = keeperLogs.slice(before).filter(l => /is an agent session/.test(l[2]));
  assert.equal(lines.length, 1, 'logged once, not every turn');
  assert.match(lines[0][2], /cwd matches "AgentPlace".*its insights are held/);
  const snap = keeper.snapshot();
  const row = snap.sessions.find(r => r.session === sid.slice(0, 8) && r.why === 'cwd matches "AgentPlace"');
  assert.ok(row, 'the snapshot has the session with its kind and why');
  assert.equal(row.kind, 'agent');
  assert.ok(snap.byKind.agent >= 1 && snap.byKind.human >= 1);
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
  const embedded = [];
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
    embedNeuron: async (name) => { embedded.push(name); }, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (...a) => logs.push(a),
    agentSession
  });
  const created = calls.filter(c => /CREATE \(n:Neuron/.test(c.q)).map(c => c.p);
  const edges = calls.filter(c => /CREATE \(src\)-\[:SYNAPSE/.test(c.q));
  return { calls, created, edges, logs, systemPrompt, embedded };
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
  assert.ok(!r.logs.some(l => /PR 16 sent back|Gate needs a timeout|Restore a backup/.test(JSON.stringify(l))), 'no held or dropped name reaches the log');
  assert.equal(r.logs.filter(l => /^held insight \((lesson|procedure|decision)\) u$/.test(l[2])).length, 3, 'a held write is logged by kind and uid');
  assert.equal(r.embedded.length, 0, 'a held insight is not embedded until release');
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
  const r = await releaseHeld({
    runCypher: async (q, p) => { calls.push({ q, p }); return [{ name: p.name, held_name: p.name, uid: 'abcdef0123', flash_summary: 'f' }]; },
    name: 'Restore a backup', by: 'chase', log: (...a) => logs.push(a)
  });
  assert.deepEqual(r, { released: true, name: 'Restore a backup', uid: 'abcdef0123', flash_summary: 'f', renamed: false });
  assert.deepEqual(calls[0].p, { name: 'Restore a backup', uid: null, held: HELD_NAMESPACE, by: 'chase' });
  assert.match(calls[0].q, /n\.namespace = \$held AND n\.superseded IS NULL/);
  assert.match(calls[0].q, /n\.namespace = null, n\.released_at = datetime\(\), n\.released_by = \$by, n\.spidered = false/);
  assert.ok(logs.some(l => /held neuron released to the live graph: Restore a backup/.test(l[2])));
});

test('a name a live neuron has since taken does not block release: the held one is renamed', async () => {
  const calls = [];
  const r = await releaseHeld({
    // What Neo4j returns when the CASE renamed it.
    runCypher: async (q, p) => { calls.push({ q, p }); return [{ name: 'Restore a backup (held abcdef01)', held_name: 'Restore a backup', uid: 'abcdef0123', flash_summary: 'f' }]; },
    uid: 'ABCDEF01', by: 'chase'
  });
  assert.equal(r.released, true);
  assert.equal(r.renamed, true);
  assert.equal(r.name, 'Restore a backup (held abcdef01)');
  assert.doesNotMatch(calls[0].q, /NOT EXISTS/, 'no clause that refuses the release on a collision');
  assert.match(calls[0].q, /OPTIONAL MATCH \(l:Neuron \{name: n\.name\}\) WHERE l\.namespace IS NULL/);
  assert.match(calls[0].q, /CASE WHEN taken > 0 THEN n\.name \+ ' \(held ' \+ substring\(coalesce\(n\.uid, ''\), 0, 8\) \+ '\)' ELSE n\.name END/);
  assert.match(calls[0].q, /toLower\(n\.uid\) STARTS WITH \$uid/, 'released by uid');
  assert.equal(calls[0].p.uid, 'abcdef01');
});

test('releaseHeld reports released:false and logs nothing when no held neuron matched', async () => {
  const logs = [];
  const r = await releaseHeld({ runCypher: async () => [], name: 'Live already', by: 'feedback:used', log: (...a) => logs.push(a) });
  assert.deepEqual(r, { released: false });
  assert.deepEqual(logs, []);
});

test('only a human session the Keeper knows may release: not an agent, not a stranger, not nobody', async () => {
  const agent = id('rel-agent');
  keeper.recordPrompt(agent, 'C:/work/app', 'conscious', 'an agent that wrote an insight');
  keeper.markAgent(agent, 'worker');
  const human = id('rel-human');
  keeper.recordPrompt(human, 'C:/work/app', 'conscious', 'a person looking at the held list');

  assert.deepEqual(await canRelease(keeper, human), { ok: true, reason: null });
  const a = await canRelease(keeper, agent);
  assert.equal(a.ok, false);
  assert.match(a.reason, /agent session \(flagged \(worker\)\)/);
  assert.equal((await canRelease(keeper, undefined)).ok, false);
  assert.match((await canRelease(keeper, '')).reason, /no session_id/);
  assert.match((await canRelease(keeper, 'made-up-' + run)).reason, /not a session the Keeper has seen/);
  assert.equal((await canRelease(keeper, 42)).ok, false);
});

// Runs with a roster configured; restores the file's Keeper config afterwards.
test('release asks the roster first: a listed agent that has not hit a Stop cannot release; a roster that does not answer refuses all but a declared human', async () => {
  const base = { agenticToolEvents: 2, agenticMinHours: 1e-9, minCadenceSeconds: 0.001, agentCwdPatterns: ['AgentPlace'] };
  keeper.init({ daemonConfig: { ...base, agentRosters: ['http://roster/'] } });
  try {
    const listed = id('rel-listed');
    const person = id('rel-person');
    const declared = id('rel-declared');
    for (const s of [listed, person, declared]) keeper.recordPrompt(s, 'C:/work/app', 'conscious', `a prompt from ${s}`);
    const up = async () => ({ ok: true, json: async () => ({ contexts: [{ name: 'worker-b', sessionId: listed, kind: 'spawned' }] }) });
    const down = async () => { throw new Error('connection refused'); };

    // Not yet flagged (no Stop has asked the roster): sessionKind alone would say human.
    assert.equal(keeper.sessionKind(listed).kind, 'human');
    resetRosterCache();
    const l = await canRelease(keeper, listed, up);
    assert.equal(l.ok, false);
    assert.match(l.reason, /agent session \(flagged \(worker-b\)\)/);
    assert.deepEqual(await canRelease(keeper, person, up), { ok: true, reason: null }, 'the roster answered and does not list a person');

    resetRosterCache();
    const p = await canRelease(keeper, person, down);
    assert.equal(p.ok, false, 'nobody could vouch for the session');
    assert.match(p.reason, /roster did not answer/);
    keeper.setKind(declared, 'human');
    assert.deepEqual(await canRelease(keeper, declared, down), { ok: true, reason: null }, 'a declared human does not need the roster');
  } finally {
    resetRosterCache();
    keeper.init({ daemonConfig: base });
  }
});

test('listHeld asks only the held namespace, newest first, with a bounded limit', async () => {
  const seen = [];
  const rows = [{ name: 'Restore a backup', uid: 'u1', durable_kind: 'procedure', type: 'insight', flash_summary: 'f', origin_session: 's1', created_at: '2026-11-22T15:00:00Z', name_taken: false }];
  const out = await listHeld({ runCypher: async (q, p) => { seen.push({ q, p }); return rows; }, limit: '9999' });
  assert.deepEqual(out, rows);
  assert.match(seen[0].q, /n\.namespace = \$held AND n\.superseded IS NULL/);
  assert.match(seen[0].q, /ORDER BY n\.created_at DESC LIMIT toInteger\(\$limit\)/);
  assert.deepEqual(seen[0].p, { held: HELD_NAMESPACE, limit: 200 });
  await listHeld({ runCypher: async (q, p) => { seen.push({ q, p }); return []; } });
  assert.equal(seen[1].p.limit, 50);
});

test('what an agent session offered, dropped and had held is counted', async () => {
  const before = heldCounters();
  await summarize({ agentSession: true });
  await summarize({ agentSession: true, reply: { insights: [], train_of_thought: [], flash_results: [] } });
  await summarize({ agentSession: false });
  await releaseHeld({ runCypher: async () => [{ name: 'x', held_name: 'x', uid: 'u', flash_summary: '' }], name: 'x', by: 'chase' });
  const after = heldCounters();
  const d = Object.fromEntries(Object.keys(after).map(k => [k, after[k] - before[k]]));
  assert.deepEqual(d, {
    agentTurns: 2, zeroInsightTurns: 1, insightsOffered: 5, droppedNoKind: 2,
    skippedNameTaken: 0, heldWritten: 3, released: 1, releaseRefused: 0
  });
});

test('observer ingest into quarantine is not embedded', async () => {
  const run1 = async (writeNamespace) => {
    const embedded = [];
    await handleIngest({
      req_body: { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'make deploy-check --all --verbose' }, tool_response: 'x'.repeat(400) },
      runCypher: async () => [],
      callAnthropic: async (model) => ({ model, response: { content: [{ text: JSON.stringify({ action: 'create', neuron: { name: 'Deploy check', node_type: 'fact', tier: 'T2_working', flash_summary: 'The deploy check runs all suites', body: 'Two sentences of body. Enough to pass.' } }) }] } }),
      embedNeuron: async (name) => { embedded.push(name); },
      getSession: () => ({ activeTopics: [], pendingFlashes: [], currentProject: null }),
      randomUUID: () => 'u', log: () => {}, writeNamespace
    });
    return embedded;
  };
  const live = await run1(null);
  const held = await run1('quarantine');
  assert.ok(live.length >= 1, 'the stub reply creates a neuron on the live path (otherwise this test proves nothing)');
  assert.deepEqual(held, []);
});

test('isHeld asks only the held namespace', async () => {
  const seen = [];
  assert.equal(await isHeld({ runCypher: async (q, p) => { seen.push({ q, p }); return [{ name: 'x' }]; }, name: 'x' }), true);
  assert.equal(await isHeld({ runCypher: async () => [], name: 'x' }), false);
  assert.deepEqual(seen[0].p, { name: 'x', held: HELD_NAMESPACE });
});
