// Agent sessions: a launcher's roster (or a cwd pattern) says a session is an
// agent, and what Dreamer writes from it goes through the held tier unless agentInsights is on.
// Stubs only: no Neo4j, no Anthropic, no network (fetch is stubbed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lookupAgent, resetRosterCache } from '../agent-roster.js';
import keeper from '../daemons/keeper.js';
import { handleSummarize, summarizeForTurn } from '../daemons/dreamer.js';

// --- the roster module ---

// A fetch stub: `routes` maps a URL to a JSON body, or to null for a roster that is down.
function fakeFetch(routes) {
  const hits = [];
  const fetchImpl = async (url) => {
    hits.push(url);
    if (routes[url] === null || routes[url] === undefined) throw new Error('connection refused');
    return { ok: true, json: async () => routes[url] };
  };
  return { fetchImpl, hits };
}

// The Keeper persists its ledger to disk, so ids are unique per run.
const RUN = Date.now().toString(36);
const SESS_A = `sess-a-${RUN}`;
const DREAMER_SID = `ag-dreamer-${RUN}`;

const ROSTER = {
  contexts: [
    { name: 'worker-a', sessionId: SESS_A, cwd: 'C:/x', kind: 'spawned' },
    { name: 'by-hand', sessionId: 'sess-manual', kind: 'manual' },
    { name: 'no-session', kind: 'spawned' },
    { name: 'room', room: true },
  ],
};

test('roster: a listed session is an agent, with the entry name as label', async () => {
  resetRosterCache();
  const { fetchImpl } = fakeFetch({ 'http://r1/': ROSTER });
  assert.deepEqual(await lookupAgent(SESS_A, { urls: ['http://r1/'], fetchImpl }), { status: 'agent', label: 'worker-a' });
});

test('roster: an id no roster lists is not-listed when every roster answered', async () => {
  resetRosterCache();
  const { fetchImpl } = fakeFetch({ 'http://r1/': ROSTER });
  assert.deepEqual(await lookupAgent('someone-else', { urls: ['http://r1/'], fetchImpl }), { status: 'not-listed' });
});

test('roster: no roster configured, or a roster that did not answer, is unknown', async () => {
  resetRosterCache();
  assert.deepEqual(await lookupAgent(SESS_A, { urls: [] }), { status: 'unknown' });
  const { fetchImpl } = fakeFetch({ 'http://r1/': ROSTER, 'http://down/': null });
  assert.deepEqual(await lookupAgent('someone-else', { urls: ['http://r1/', 'http://down/'], fetchImpl }), { status: 'unknown' });
  // ...but a hit on the roster that did answer still counts.
  assert.equal((await lookupAgent(SESS_A, { urls: ['http://r1/', 'http://down/'], fetchImpl })).status, 'agent');
  resetRosterCache();
  const bad = async () => ({ ok: true, json: async () => ({ unexpected: 'shape' }) });
  assert.deepEqual(await lookupAgent(SESS_A, { urls: ['http://r1/'], fetchImpl: bad }), { status: 'unknown' });
  resetRosterCache();
  const http500 = async () => ({ ok: false, json: async () => ROSTER });
  assert.deepEqual(await lookupAgent(SESS_A, { urls: ['http://r1/'], fetchImpl: http500 }), { status: 'unknown' });
});

test('roster: an entry with a kind counts only for an accepted kind; one without a kind counts', async () => {
  resetRosterCache();
  const { fetchImpl } = fakeFetch({ 'http://r1/': ROSTER, 'http://bare/': [{ session_id: 'sess-bare' }], 'http://s/': { sessions: [{ sessionId: 'sess-s', name: 's' }] } });
  assert.equal((await lookupAgent('sess-manual', { urls: ['http://r1/'], fetchImpl })).status, 'not-listed');
  resetRosterCache();
  assert.equal((await lookupAgent('sess-manual', { urls: ['http://r1/'], kinds: ['spawned', 'manual'], fetchImpl })).status, 'agent');
  resetRosterCache();
  assert.deepEqual(await lookupAgent('sess-bare', { urls: ['http://bare/'], fetchImpl }), { status: 'agent', label: 'roster' });
  resetRosterCache();
  assert.deepEqual(await lookupAgent('sess-s', { urls: ['http://s/'], fetchImpl }), { status: 'agent', label: 's' });
});

test('roster: the answer is cached for 60 seconds', async () => {
  resetRosterCache();
  const { fetchImpl, hits } = fakeFetch({ 'http://r1/': ROSTER });
  let t = 1_000_000;
  const now = () => t;
  await lookupAgent(SESS_A, { urls: ['http://r1/'], fetchImpl, now });
  await lookupAgent('someone-else', { urls: ['http://r1/'], fetchImpl, now });
  t += 59_000;
  await lookupAgent(SESS_A, { urls: ['http://r1/'], fetchImpl, now });
  assert.equal(hits.length, 1);
  t += 2_000;
  await lookupAgent(SESS_A, { urls: ['http://r1/'], fetchImpl, now });
  assert.equal(hits.length, 2);
});

// --- the Keeper ---

const initKeeper = (cfg) => keeper.init({ daemonConfig: cfg });

test('keeper: a roster hit flags the session and the flag outlives a roster outage', async () => {
  resetRosterCache();
  initKeeper({ agentRosters: ['http://r1/'] });
  const up = fakeFetch({ 'http://r1/': ROSTER });
  assert.equal(keeper.isAgentSession(SESS_A, 'C:/x').agent, false, 'not an agent before anyone asked the roster');
  const a = await keeper.resolveAgent(SESS_A, 'C:/x', up.fetchImpl);
  assert.deepEqual(a, { agent: true, why: 'flagged (worker-a)' });
  assert.equal(keeper.snapshot().agentSessions[SESS_A], 'worker-a');
  resetRosterCache();
  const down = fakeFetch({ 'http://r1/': null });
  assert.equal((await keeper.resolveAgent(SESS_A, 'C:/x', down.fetchImpl)).agent, true);
  assert.equal(down.hits.length, 0, 'a flagged session does not ask the roster again');
  // A session the roster does not list, and one asked about while the roster is down, are not agents.
  resetRosterCache();
  assert.equal((await keeper.resolveAgent(`ag-person-${RUN}`, 'C:/x', up.fetchImpl)).agent, false);
  resetRosterCache();
  assert.equal((await keeper.resolveAgent(`ag-outage-${RUN}`, 'C:/x', down.fetchImpl)).agent, false);
});

test('keeper: a cwd pattern marks an agent that is on no roster; neither means not an agent', async () => {
  resetRosterCache();
  initKeeper({ agentCwdPatterns: ['Agent-Home'] });
  assert.deepEqual(keeper.isAgentSession(`ag-cwd-${RUN}`, 'C:/work/agent-home/repo'), { agent: true, why: 'cwd matches "Agent-Home"' });
  assert.deepEqual(keeper.isAgentSession(`ag-plain-${RUN}`, 'C:/work/other'), { agent: false, why: 'not flagged' });
  assert.deepEqual(await keeper.resolveAgent(`ag-plain-${RUN}`, 'C:/work/other'), { agent: false, why: 'not flagged' });
  // Behaviour is never the test: heavy tool use and a promotion do not make an agent.
  keeper.recordPrompt(`ag-busy-${RUN}`, 'C:/work/other', 'conscious', `one long task ${RUN}`);
  for (let i = 0; i < 200; i++) keeper.recordToolEvent(`ag-busy-${RUN}`);
  assert.equal(keeper.isAgentSession(`ag-busy-${RUN}`, 'C:/work/other').agent, false);
});

// --- Dreamer ---

const INSIGHT = { name: 'Gate design', node_type: 'insight', flash_summary: 'One run at a time', body: 'Two sentences of body. Enough to pass.' };
const UPDATE = { existing_name: 'Old fact', flash_summary: 'new', body: 'New body text here.', reason: 'changed' };

function dreamerHarness(extra = {}) {
  const calls = [];
  const logs = [];
  const entry = { turn: Date.now(), flashes: ['Kettle: flash'], sourceNeurons: ['Kettle'], neuronDomains: { Kettle: true }, neuronDaemons: { Kettle: 'vector' }, flashNeurons: ['Kettle'] };
  const deps = {
    req_body: { session_id: DREAMER_SID, cwd: 'C:/work/other' },
    session: { activeTopics: [], pendingFlashes: [entry], explicitFeedback: {} },
    runCypher: async (q, p) => { calls.push({ q, p }); return []; },
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: { content: [{ text: JSON.stringify({
        insights: [INSIGHT], updates: [UPDATE],
        train_of_thought: ['Topic one', 'Topic two'],
        flash_results: [{ flash_text: 'Kettle: flash', status: 'pursued' }]
      }) }] }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (...a) => logs.push(a),
    ...extra
  };
  const wrote = (name) => calls.some(c => /CREATE \(n:Neuron/.test(c.q) && c.p?.name === name);
  const superseded = () => calls.some(c => c.p?.name === 'Old fact');
  const pursued = () => calls.some(c => /times_pursued = n\.times_pursued \+ 1/.test(c.q));
  return { deps, calls, logs, wrote, superseded, pursued };
}

const HELD_QUERY = (c) => /CREATE \(n:Neuron/.test(c.q) && c.p?.ns === 'quarantine';

test('dreamer: from an agent session an insight with no durable kind is not written, a durable one is held, no update is applied; judging and train of thought still run', async () => {
  const h = dreamerHarness();
  await handleSummarize({ ...h.deps, agentSession: true });
  assert.equal(h.wrote('Gate design'), false, 'no durable kind: not written');
  assert.equal(h.superseded(), false, 'no query touches the neuron an update named');
  assert.equal(h.pursued(), true, 'the flash result is still applied');
  assert.equal(h.wrote('Topic one') && h.wrote('Topic two'), true, 'train of thought still runs');

  const d = dreamerHarness();
  d.deps.callAnthropic = async () => ({ model: 'claude-sonnet-5', response: { content: [{ text: JSON.stringify({ insights: [{ ...INSIGHT, kind: 'lesson' }], train_of_thought: [], flash_results: [] }) }] } });
  await handleSummarize({ ...d.deps, agentSession: true });
  const created = d.calls.filter(c => /CREATE \(n:Neuron/.test(c.q) && c.p?.name === 'Gate design');
  assert.equal(created.length, 1);
  assert.equal(HELD_QUERY(created[0]), true, 'a durable insight lands in the held namespace');
  assert.equal(created[0].p.originKind, 'agent');
});

test("dreamer: from a person's session the same turn writes the insight live and applies the update", async () => {
  const h = dreamerHarness();
  await handleSummarize(h.deps);
  assert.equal(h.wrote('Gate design'), true);
  assert.equal(h.superseded(), true);
  assert.equal(h.pursued(), true);
});

test("stop: an agent session goes through the held tier by default, and is summarized like a person's when agentInsights is on", async () => {
  resetRosterCache();
  initKeeper({});
  keeper.recordPrompt(DREAMER_SID, 'C:/work/other', 'conscious', `do the long task please ${RUN}`);
  keeper.markAgent(DREAMER_SID, 'worker-a');

  const off = dreamerHarness();
  await summarizeForTurn(off.deps, keeper);
  assert.equal(off.wrote('Gate design'), false);
  assert.equal(off.superseded(), false);
  assert.equal(off.pursued(), true);
  assert.equal(off.calls.some(HELD_QUERY), false, 'the offered insight has no durable kind, so nothing is held either');

  initKeeper({ agentInsights: true });
  const on = dreamerHarness();
  await summarizeForTurn(on.deps, keeper);
  assert.equal(on.wrote('Gate design'), true, 'agentInsights true restores the live write');
  assert.equal(on.calls.some(HELD_QUERY), false);
  assert.equal(on.superseded(), true);

  // A session that is not an agent is untouched by the default.
  initKeeper({});
  keeper.recordPrompt(`ag-person2-${RUN}`, 'C:/work/other', 'conscious', `a person asking something ${RUN}`);
  const person = dreamerHarness({ req_body: { session_id: `ag-person2-${RUN}`, cwd: 'C:/work/other' } });
  await summarizeForTurn(person.deps, keeper);
  assert.equal(person.wrote('Gate design'), true);
});
