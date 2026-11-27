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
import { resetRosterCache, lookupAgent } from '../agent-roster.js';
import { rewardChase } from '../chase.js';
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

test('a declared human does not beat the cwd list or a roster flag; a declaration can be cleared, and anything else is rejected', async () => {
  const sid = id('declared');
  keeper.recordPrompt(sid, 'C:/github/AgentPlace', 'conscious', 'hello there');
  // An old declaration of human on a session in a listed directory: still an agent.
  assert.equal(keeper.setKind(sid, 'human'), true);
  assert.deepEqual(keeper.sessionKind(sid), { kind: 'agent', why: 'cwd matches "AgentPlace"' }, 'the cwd list beats a declared human');
  // And it cannot declare itself human: refused before any roster is asked.
  const refused = await keeper.declareHuman(sid);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /agent session \(cwd matches "AgentPlace"\).*cannot be declared human/);
  const byRequestCwd = id('declared-req-cwd');
  keeper.recordPrompt(byRequestCwd, 'C:/github/elsewhere', 'conscious', 'hello from elsewhere');
  assert.equal((await keeper.declareHuman(byRequestCwd, undefined, 'C:/github/AgentPlace/sub')).ok, false, 'the request cwd counts too');
  keeper.markAgent(sid, 'worker');
  assert.deepEqual(keeper.sessionKind(sid), { kind: 'agent', why: 'flagged (worker)' }, 'a roster fact beats a declared human');
  assert.equal(keeper.setKind(sid, null), true);
  assert.equal(keeper.sessionKind(sid).why, 'flagged (worker)', 'still the flag');
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
  assert.deepEqual(r, { released: true, name: 'Restore a backup', uid: 'abcdef0123', flash_summary: 'f', renamed: false, connections_created: 0 });
  // calls[0] reads the held neuron (is it an update?); calls[1] moves it.
  assert.doesNotMatch(calls[0].q, /SET /, 'the first query only reads');
  assert.deepEqual(calls[1].p, { name: 'Restore a backup', uid: null, held: HELD_NAMESPACE, by: 'chase' });
  assert.match(calls[1].q, /n\.namespace = \$held AND n\.superseded IS NULL/);
  assert.match(calls[1].q, /n\.namespace = null, n\.released_at = datetime\(\), n\.released_by = \$by, n\.spidered = false/);
  assert.equal(calls.length, 2, 'no held connections, no edge queries');
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
  assert.doesNotMatch(calls[1].q, /NOT EXISTS/, 'no clause that refuses the release on a collision');
  assert.match(calls[1].q, /OPTIONAL MATCH \(l:Neuron \{name: n\.name\}\) WHERE l\.namespace IS NULL/);
  assert.match(calls[1].q, /CASE WHEN taken > 0 THEN n\.name \+ ' \(held ' \+ substring\(coalesce\(n\.uid, ''\), 0, 8\) \+ '\)' ELSE n\.name END/);
  assert.match(calls[1].q, /toLower\(n\.uid\) STARTS WITH \$uid/, 'released by uid');
  assert.equal(calls[1].p.uid, 'abcdef01');
});

test('release makes the connections a held insight kept, to targets that exist live, and says how many', async () => {
  const calls = [];
  const conns = JSON.stringify([
    { target: 'Backups', weight: 0.7, edge_type: 'causal', context: 'why' },
    { target: 'Gone since', weight: 0.5, edge_type: 'associative', context: '' }
  ]);
  const r = await releaseHeld({
    runCypher: async (q, p) => {
      calls.push({ q, p });
      if (/held_update_of AS target/.test(q)) return [{ uid: 'abcdef0123', target: null }];
      if (/REMOVE n\.held_connections/.test(q)) return [{ name: 'Restore a backup', held_name: 'Restore a backup', uid: 'abcdef0123', flash_summary: 'f', held_connections: conns }];
      if (/CREATE \(src\)-\[:SYNAPSE/.test(q)) return p.tgt === 'Backups' ? [{ linked: 'Backups' }] : [];
      return [];
    },
    name: 'Restore a backup', by: 'chase'
  });
  assert.equal(r.released, true);
  assert.equal(r.connections_created, 1, 'one target exists live, the other does not');
  const edges = calls.filter(c => /CREATE \(src\)-\[:SYNAPSE/.test(c.q));
  assert.equal(edges.length, 2);
  assert.ok(edges.every(c => /src\.namespace IS NULL/.test(c.q) && /tgt\.namespace IS NULL AND tgt\.superseded IS NULL/.test(c.q)), 'live to live only');
  assert.deepEqual(edges[0].p, { uid: 'abcdef0123', tgt: 'Backups', weight: 0.7, edgeType: 'causal', context: 'why' });
});

test('releasing a held update applies it as the usual supersession of its live target and removes the carrier', async () => {
  const calls = [];
  const run = async (q, p) => {
    calls.push({ q, p });
    if (/held_update_of AS target/.test(q)) return [{ uid: 'cafe0000-1', target: 'Deploy window', flash_summary: 'Deploys now run at noon', body: 'New body.', reason: 'moved', event_date: null }];
    if (/RETURN n\.node_type AS type, n\.tier AS tier/.test(q)) return [{ type: 'fact', tier: 'T2_working', flash: 'old', body: 'old body', project: 'app' }];
    return [];
  };
  const before = heldCounters().released;
  const r = await releaseHeld({ runCypher: run, uid: 'CAFE0000', by: 'chase', randomUUID: () => 'new-uid' });
  assert.equal(r.released, true);
  assert.equal(r.applied_update_to, 'Deploy window');
  assert.equal(r.name, 'Deploy window', 'the caller embeds and rewards the live target');
  assert.ok(calls.some(c => /SET n\.name = \$archivedName, n\.superseded = true/.test(c.q) && c.p.name === 'Deploy window' && c.p.ns === null), 'the live target was archived');
  const created = calls.find(c => /source: 'supersession'/.test(c.q));
  assert.equal(created.p.flash, 'Deploys now run at noon');
  assert.equal(created.p.body, 'New body.');
  assert.equal(created.p.ns, null);
  assert.ok(calls.some(c => /SUPERSEDES/.test(c.q) && c.p.reason === 'moved'));
  const removed = calls.find(c => /DETACH DELETE n/.test(c.q));
  assert.deepEqual(removed.p, { uid: 'cafe0000-1', held: HELD_NAMESPACE });
  assert.match(removed.q, /n\.namespace = \$held/, 'only ever the held carrier');
  assert.ok(!calls.some(c => /n\.namespace = null, n\.released_at/.test(c.q)), 'the carrier itself never goes live');
  assert.equal(heldCounters().released - before, 1);
});

test('a held update whose target is gone is released as an ordinary neuron, so its text is not lost', async () => {
  const calls = [];
  const run = async (q, p) => {
    calls.push({ q, p });
    if (/held_update_of AS target/.test(q)) return [{ uid: 'cafe0000-2', target: 'Deleted since', flash_summary: 'f', body: 'b', reason: 'r', event_date: null }];
    if (/REMOVE n\.held_connections/.test(q)) return [{ name: 'Update: Deleted since (cafe0000)', held_name: 'Update: Deleted since (cafe0000)', uid: 'cafe0000-2', flash_summary: 'f', held_connections: null }];
    return []; // supersedeNeuron finds no live target
  };
  const r = await releaseHeld({ runCypher: run, uid: 'cafe0000', by: 'chase', randomUUID: () => 'x' });
  assert.equal(r.released, true);
  assert.equal(r.applied_update_to, undefined);
  assert.equal(r.update_target_missing, 'Deleted since');
  assert.ok(!calls.some(c => /DETACH DELETE/.test(c.q)));
});

test('releaseHeld reports released:false and logs nothing when no held neuron matched', async () => {
  const logs = [];
  const r = await releaseHeld({ runCypher: async () => [], name: 'Live already', by: 'feedback:used', log: (...a) => logs.push(a) });
  assert.deepEqual(r, { released: false });
  assert.deepEqual(logs, []);
});

// The release tests run with a roster configured and restore the file's Keeper config afterwards.
const BASE_CFG = { agenticToolEvents: 2, agenticMinHours: 1e-9, minCadenceSeconds: 0.001, agentCwdPatterns: ['AgentPlace'] };
const rosterUp = (listed) => async () => ({ ok: true, json: async () => ({ contexts: listed.map((sessionId, i) => ({ name: `worker-${i}`, sessionId, kind: 'spawned' })) }) });
const rosterDown = async () => { throw new Error('connection refused'); };
// A session as real hooks make it: a prompt, then the hook event noted.
const hookSession = (sid, cwd = 'C:/work/app') => {
  keeper.recordPrompt(sid, cwd, 'conscious', `a prompt from ${sid}`);
  keeper.noteHook(sid, 'UserPromptSubmit');
};

test('with no roster configured nothing is released, and the reason says so', async () => {
  const human = id('rel-noroster');
  hookSession(human);
  const r = await canRelease(keeper, human);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no launcher roster is configured/);
});

test('release needs a session id the Keeper has seen through real hook traffic', async () => {
  keeper.init({ daemonConfig: { ...BASE_CFG, agentRosters: ['http://roster/'] } });
  try {
    resetRosterCache();
    const fetchImpl = rosterUp([]);
    assert.equal((await canRelease(keeper, undefined, { fetchImpl })).ok, false);
    assert.match((await canRelease(keeper, '', { fetchImpl })).reason, /no session_id/);
    assert.equal((await canRelease(keeper, 42, { fetchImpl })).ok, false);
    assert.match((await canRelease(keeper, 'made-up-' + run, { fetchImpl })).reason, /not a session the Keeper has seen/);

    // An invented id made "known" by one bare POST to the query route (no hook fields).
    const bare = id('rel-bare');
    keeper.recordPrompt(bare, 'C:/work/app', 'conscious', 'one plain query call');
    keeper.noteHook(bare, undefined);
    keeper.noteHook(bare, 'NotAHookEvent');
    const b = await canRelease(keeper, bare, { fetchImpl });
    assert.equal(b.ok, false);
    assert.match(b.reason, /no hook traffic/);

    const human = id('rel-human');
    hookSession(human);
    assert.deepEqual(await canRelease(keeper, human, { fetchImpl }), { ok: true, reason: null });
    // noteHook never creates an entry: a stranger stays a stranger.
    keeper.noteHook('stranger-' + run, 'Stop');
    assert.equal(keeper.knows('stranger-' + run), false);
  } finally {
    resetRosterCache();
    keeper.init({ daemonConfig: BASE_CFG });
  }
});

test('the roster is asked on every release path: listed means agent even when declared human; no answer refuses everyone', async () => {
  keeper.init({ daemonConfig: { ...BASE_CFG, agentRosters: ['http://roster/'] } });
  try {
    const listed = id('rel-listed');
    const listedDeclared = id('rel-listed-declared');
    const person = id('rel-person');
    const declared = id('rel-declared');
    for (const s of [listed, listedDeclared, person, declared]) hookSession(s);
    keeper.setKind(listedDeclared, 'human');
    keeper.setKind(declared, 'human');
    const up = rosterUp([listed, listedDeclared]);

    // Not yet flagged (no Stop has asked the roster): sessionKind alone would say human.
    assert.equal(keeper.sessionKind(listed).kind, 'human');
    resetRosterCache();
    const l = await canRelease(keeper, listed, { fetchImpl: up });
    assert.equal(l.ok, false);
    assert.match(l.reason, /a launcher roster lists it/);
    const ld = await canRelease(keeper, listedDeclared, { fetchImpl: up });
    assert.equal(ld.ok, false, 'a declaration does not outrank the roster');
    assert.equal(keeper.sessionKind(listedDeclared).kind, 'agent');
    assert.deepEqual(await canRelease(keeper, person, { fetchImpl: up }), { ok: true, reason: null }, 'the roster answered and does not list a person');
    assert.deepEqual(await canRelease(keeper, declared, { fetchImpl: up }), { ok: true, reason: null });

    resetRosterCache();
    for (const s of [person, declared]) {
      const r = await canRelease(keeper, s, { fetchImpl: rosterDown });
      assert.equal(r.ok, false, 'nobody could vouch for the session, declared or not');
      assert.match(r.reason, /roster did not answer/);
    }
  } finally {
    resetRosterCache();
    keeper.init({ daemonConfig: BASE_CFG });
  }
});

test('release classifies by the request cwd when one is given', async () => {
  keeper.init({ daemonConfig: { ...BASE_CFG, agentRosters: ['http://roster/'] } });
  try {
    resetRosterCache();
    const sid = id('rel-cwd');
    hookSession(sid, 'C:/work/app');
    const fetchImpl = rosterUp([]);
    assert.equal((await canRelease(keeper, sid, { fetchImpl })).ok, true);
    const r = await canRelease(keeper, sid, { cwd: 'C:/github/AgentPlace/worker', fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.reason, /agent session \(cwd matches "AgentPlace"\)/);
  } finally {
    resetRosterCache();
    keeper.init({ daemonConfig: BASE_CFG });
  }
});

test('declaring a session human asks the roster first: refused when listed or when the roster does not answer', async () => {
  keeper.init({ daemonConfig: { ...BASE_CFG, agentRosters: ['http://roster/'] } });
  try {
    const listed = id('decl-listed');
    const person = id('decl-person');
    const later = id('decl-later');
    for (const s of [listed, person, later]) hookSession(s);
    resetRosterCache();
    const up = rosterUp([listed]);
    const l = await keeper.declareHuman(listed, up);
    assert.equal(l.ok, false);
    assert.match(l.reason, /roster lists this session/);
    assert.equal(keeper.sessionKind(listed).kind, 'agent');
    assert.deepEqual(await keeper.declareHuman(person, up), { ok: true, reason: null });
    assert.deepEqual(keeper.sessionKind(person), { kind: 'human', why: 'declared' });
    resetRosterCache();
    const d = await keeper.declareHuman(later, rosterDown);
    assert.equal(d.ok, false);
    assert.match(d.reason, /did not answer/);
    assert.equal(keeper.sessionKind(later).why, 'default', 'nothing was declared');
  } finally {
    resetRosterCache();
    keeper.init({ daemonConfig: BASE_CFG });
  }
});

// ---------- Stop: hold on unknown ----------

function stopDeps(sid, cwd = 'C:/work/app', extra = {}) {
  const calls = [];
  const prompts = [];
  const reply = { insights: [
    { name: 'Gate needs a timeout', kind: 'lesson', flash_summary: 'A gate with no timeout blocks forever', body: 'Two sentences of body. Enough to pass.' },
    { name: 'Service restarted', node_type: 'fact', flash_summary: 'Restarted at noon', body: 'Two sentences of body. Enough to pass.' }
  ], train_of_thought: [], flash_results: [], ...extra };
  return {
    calls, prompts,
    deps: {
      req_body: { session_id: sid, cwd },
      session: { activeTopics: [], pendingFlashes: [] },
      runCypher: async (q, p) => { calls.push({ q, p }); return []; },
      callAnthropic: async (m, system) => { prompts.push(system); return { model: m, response: { content: [{ text: JSON.stringify(reply) }] } }; },
      embedNeuron: async () => {}, randomUUID: () => 'u',
      isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
      wonder: {}, spider: {}, janitor: {}, prowler: {},
      log: () => {}
    }
  };
}
const createdBy = (h) => h.calls.filter(c => /CREATE \(n:Neuron/.test(c.q)).map(c => c.p);

test('Stop with a roster that does not answer: everything the turn offers is held as unknown, and the session is not flagged', async () => {
  const realFetch = globalThis.fetch;
  keeper.init({ daemonConfig: { ...BASE_CFG, agentRosters: ['http://roster/'] } });
  try {
    resetRosterCache();
    globalThis.fetch = rosterDown;
    const before = heldCounters();
    const sid = id('stop-unknown');
    hookSession(sid);
    const h = stopDeps(sid, 'C:/work/app', {
      insights: [
        { name: 'Gate needs a timeout', kind: 'lesson', flash_summary: 'A gate with no timeout blocks forever', body: 'Two sentences of body. Enough to pass.',
          connections: [{ target: 'Downstream gate', weight: 0.8, edge_type: 'causal', context: 'same gate' }, { target: 'Gate needs a timeout' }, { weight: 0.3 }] },
        { name: 'Service restarted', node_type: 'fact', flash_summary: 'Restarted at noon', body: 'Two sentences of body. Enough to pass.' }
      ],
      updates: [{ existing_name: 'Old fact', flash_summary: 'New text', body: 'Two sentences of body. Enough to pass.', reason: 'changed' }]
    });
    await summarizeForTurn(h.deps, keeper);
    // The session may be a person's: the ordinary prompt, and no kind rule.
    assert.deepEqual(h.prompts, [SUMMARIZE_SYSTEM_PROMPT], 'the ordinary prompt, not the agent one');
    const all = createdBy(h);
    assert.ok(all.every(p => p.ns === HELD_NAMESPACE), 'nothing from the turn goes live');
    const created = all.filter(p => !p.target);
    assert.equal(created.length, 2, 'both insights, the one with no durable kind too');
    assert.ok(created.every(p => p.originKind === 'unknown' && p.durableKind === null));
    assert.deepEqual(created.map(p => p.type), ['insight', 'fact'], 'node_type as the ordinary path sets it');
    // The update is held as a carrier that names its target; the live neuron is not touched.
    const carriers = all.filter(p => p.target);
    assert.equal(carriers.length, 1);
    assert.equal(carriers[0].target, 'Old fact');
    assert.equal(carriers[0].name, 'Update: Old fact (u)');
    assert.equal(carriers[0].flash, 'New text');
    assert.equal(carriers[0].reason, 'changed');
    const carrierQ = h.calls.find(c => c.p === carriers[0]).q;
    assert.match(carrierQ, /held_update_of: \$target/);
    assert.match(carrierQ, /origin_kind: 'unknown'/);
    assert.ok(!h.calls.some(c => /superseded = true|SUPERSEDES/.test(c.q)), 'no supersession on an unknown turn');
    // Connections are kept as data on the held insight, not made as edges.
    assert.ok(!h.calls.some(c => /SYNAPSE/.test(c.q) && /CREATE/.test(c.q)), 'no edges from a held turn');
    const kept = h.calls.filter(c => /SET n\.held_connections = \$conns/.test(c.q));
    assert.equal(kept.length, 1, 'only the insight that offered usable connections');
    assert.deepEqual(JSON.parse(kept[0].p.conns), [{ target: 'Downstream gate', weight: 0.8, edge_type: 'causal', context: 'same gate' }], 'self-link and target-less entries left out');
    const after = heldCounters();
    assert.equal(after.heldOnUnknownTurns - before.heldOnUnknownTurns, 1);
    assert.equal(after.heldOnUnknownInsights - before.heldOnUnknownInsights, 2);
    assert.equal(after.heldUpdates - before.heldUpdates, 1);
    assert.equal(after.heldWritten - before.heldWritten, 3);
    assert.equal(after.droppedNoKind, before.droppedNoKind, 'the kind rule did not run');
    assert.equal(keeper.isAgentSession(sid).agent, false, 'an unknown answer flags nobody');
    assert.equal(keeper.sessionKind(sid).kind, 'human');

    // A declared human is a person's session whatever the roster does.
    const declared = id('stop-unknown-declared');
    hookSession(declared);
    keeper.setKind(declared, 'human');
    resetRosterCache();
    const d = stopDeps(declared);
    await summarizeForTurn(d.deps, keeper);
    assert.deepEqual(d.prompts, [SUMMARIZE_SYSTEM_PROMPT]);
    assert.ok(createdBy(d).every(p => p.ns === null && p.originKind === 'human'));

    // The roster answers again: the same undeclared session is a person's.
    resetRosterCache();
    globalThis.fetch = rosterUp([]);
    const again = stopDeps(sid);
    await summarizeForTurn(again.deps, keeper);
    assert.deepEqual(again.prompts, [SUMMARIZE_SYSTEM_PROMPT]);
  } finally {
    globalThis.fetch = realFetch;
    resetRosterCache();
    keeper.init({ daemonConfig: BASE_CFG });
  }
});

test('Stop for a session known to be an agent: the strict prompt, and an insight with no durable kind is still dropped', async () => {
  const sid = id('stop-known-agent');
  hookSession(sid);
  keeper.markAgent(sid, 'worker');
  const before = heldCounters();
  const h = stopDeps(sid, 'C:/work/app', { updates: [{ existing_name: 'Old fact', flash_summary: 'New text', body: 'b' }] });
  await summarizeForTurn(h.deps, keeper);
  assert.deepEqual(h.prompts, [AGENT_SUMMARIZE_SYSTEM_PROMPT]);
  const created = createdBy(h);
  assert.equal(created.length, 1, 'only the lesson');
  assert.equal(created[0].ns, HELD_NAMESPACE);
  assert.equal(created[0].originKind, 'agent');
  assert.equal(created[0].durableKind, 'lesson');
  const after = heldCounters();
  assert.equal(after.droppedNoKind - before.droppedNoKind, 1);
  assert.equal(after.heldUpdates, before.heldUpdates, 'a known agent rewrites nothing and holds no update');
  assert.ok(!h.calls.some(c => /held_update_of|held_connections/.test(c.q)));
  assert.equal(after.heldOnUnknownInsights, before.heldOnUnknownInsights);
});

test('Stop with no roster configured is unchanged: an undeclared, unlisted session is a person\'s', async () => {
  const sid = id('stop-noroster');
  hookSession(sid);
  const h = stopDeps(sid);
  await summarizeForTurn(h.deps, keeper);
  assert.deepEqual(h.prompts, [SUMMARIZE_SYSTEM_PROMPT]);
  assert.ok(createdBy(h).length >= 1 && createdBy(h).every(p => p.ns === null && p.originKind === 'human'));
});

test('roster: when a refresh fails the last good list still counts; unknown is only for ids it does not have', async () => {
  resetRosterCache();
  let t = 1_000_000;
  const now = () => t;
  const up = rosterUp(['sess-known']);
  assert.equal((await lookupAgent('sess-known', { urls: ['http://r/'], fetchImpl: up, now })).status, 'agent');
  t += 61_000; // cache expired; the launcher is restarting
  assert.deepEqual(await lookupAgent('sess-known', { urls: ['http://r/'], fetchImpl: rosterDown, now }), { status: 'agent', label: 'worker-0' });
  assert.deepEqual(await lookupAgent('sess-new', { urls: ['http://r/'], fetchImpl: rosterDown, now }), { status: 'unknown' });
  // A failed refresh is retried after 5 seconds, not 60.
  let fetched = 0;
  const counting = async (...a) => { fetched++; return up(...a); };
  t += 2_000;
  await lookupAgent('sess-new', { urls: ['http://r/'], fetchImpl: counting, now });
  assert.equal(fetched, 0, 'still inside the retry window');
  t += 4_000;
  assert.deepEqual(await lookupAgent('sess-new', { urls: ['http://r/'], fetchImpl: counting, now }), { status: 'not-listed' });
  assert.equal(fetched, 1);
  resetRosterCache();
  assert.deepEqual(await lookupAgent('sess-known', { urls: ['http://r/'], fetchImpl: rosterDown, now }), { status: 'unknown' }, 'never a good list: unknown');
  resetRosterCache();
});

test('the agent prompt excludes private content the agent read', () => {
  const p = AGENT_SUMMARIZE_SYSTEM_PROMPT;
  assert.match(p, /NEVER KEEP/);
  const never = p.slice(p.indexOf('NEVER KEEP'), p.indexOf('ATTRIBUTION'));
  for (const word of ['message', 'text/SMS', 'e-mail', 'calendar item', 'voicemail', 'notification', 'third person', 'contact details', 'addresses', 'account, case or incident numbers']) {
    assert.ok(never.includes(word), `the NEVER KEEP list names: ${word}`);
  }
  assert.match(never, /quotes or restates/);
  assert.ok(!SUMMARIZE_SYSTEM_PROMPT.includes('text/SMS'), 'the human prompt is unchanged');
});

// ---------- Query gate and chase ----------

test('an undertow_query MCP call is answered whatever the tier, earns no turn-taking credit and makes no ledger entry', () => {
  const fresh = id('mcp-only');
  const g = keeper.gateQuery(fresh, 'C:/work/app', undefined, 'what do we know about the gate', 'mcp');
  assert.deepEqual(g, { tier: 'conscious', promoted: false, habituated: false, reason: null });
  assert.equal(keeper.knows(fresh), false, 'no ledger entry: an MCP call cannot make an id known');
  // The same prompt again is not habituated, and a candidate session is still answered.
  const cand = id('mcp-candidate');
  keeper.recordPrompt(cand, 'C:/work/app', undefined, 'a first real prompt');
  assert.equal(keeper.tierOf(cand), 'candidate');
  for (let i = 0; i < 3; i++) assert.equal(keeper.gateQuery(cand, 'C:/work/app', undefined, 'same question', 'mcp').tier, 'conscious');
  assert.equal(keeper.tierOf(cand), 'candidate', 'no promotion from MCP calls');
  // A session set off stays off.
  const off = id('mcp-off');
  keeper.setTier(off, 'off');
  assert.equal(keeper.gateQuery(off, null, undefined, 'q', 'mcp').tier, 'off');
  // A hook prompt goes through recordPrompt as before.
  assert.equal(keeper.gateQuery(id('hook-prompt'), 'C:/work/app', undefined, 'a person asks').tier, 'candidate');
});

test('a chase rewards the neuron in the caller\'s namespace only, the live graph by default', async () => {
  const seen = [];
  const runCypher = async (q, p) => { seen.push({ q, p }); return [{ 'n.name': 'x' }]; };
  assert.equal(await rewardChase({ runCypher, name: 'x' }), true);
  assert.equal(seen.length, 2, 'reward, then synapses');
  for (const c of seen) {
    assert.deepEqual(c.p, { name: 'x', ns: null });
    assert.match(c.q, /\(\$ns IS NULL AND n\.namespace IS NULL\) OR n\.namespace = \$ns/);
    assert.match(c.q, /n\.superseded IS NULL/);
  }
  seen.length = 0;
  assert.equal(await rewardChase({ runCypher, name: 'x', ns: 'work' }), true);
  assert.ok(seen.every(c => c.p.ns === 'work'), 'a client in its own namespace chases its own neuron');
  // Nothing by that name there: say so, and touch no synapse.
  seen.length = 0;
  assert.equal(await rewardChase({ runCypher: async (q, p) => { seen.push({ q, p }); return []; }, name: 'x', ns: 'work' }), false);
  assert.equal(seen.length, 1);
  // A failed query is not a "not found".
  assert.equal(await rewardChase({ runCypher: async () => { throw new Error('boom'); }, name: 'x' }), null);
});

test('listHeld marks a held update with the neuron it would update, and says the origin', async () => {
  let q = '';
  await listHeld({ runCypher: async (query) => { q = query; return []; } });
  assert.match(q, /n\.held_update_of AS update_of/);
  assert.match(q, /n\.origin_kind AS origin_kind/);
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
    skippedNameTaken: 0, skippedEcho: 0, heldWritten: 3, heldOnUnknownTurns: 0, heldOnUnknownInsights: 0,
    heldUpdates: 0, released: 1, releaseRefused: 0
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
