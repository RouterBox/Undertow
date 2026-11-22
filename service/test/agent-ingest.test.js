// Gobble and agent sessions: the Keeper decides whether a PostToolUse ingest may
// be written. Not from an agent session, and not from a session a configured
// roster could not answer for. Stubs only: no Neo4j, no network (fetch is stubbed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resetRosterCache } from '../agent-roster.js';
import keeper from '../daemons/keeper.js';

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
const AGENT = `ing-agent-${RUN}`;
const ROSTER = { contexts: [{ name: 'worker-a', sessionId: AGENT, kind: 'spawned' }] };
const URL = 'http://r1/';

function initKeeper(cfg, logs = []) {
  resetRosterCache();
  keeper.init({ daemonConfig: cfg, log: (endpoint, level, message) => logs.push({ endpoint, level, message }) });
  return logs;
}
const counters = () => {
  const s = keeper.snapshot();
  return { agent: s.agentIngestsDropped, unknown: s.unknownIngestsDropped };
};

test('ingest: a session on the roster writes nothing, and the roster status is exposed', async () => {
  initKeeper({ agentRosters: [URL] });
  const up = fakeFetch({ [URL]: ROSTER });
  const before = counters();
  const d = await keeper.ingestDecision(AGENT, 'C:/x', up.fetchImpl);
  assert.equal(d.write, false);
  assert.match(d.why, /^agent session: flagged \(worker-a\)$/);
  assert.equal(counters().agent, before.agent + 1);
  assert.equal(counters().unknown, before.unknown);
  // Once flagged, the roster is not asked again and an outage changes nothing.
  resetRosterCache();
  const down = fakeFetch({ [URL]: null });
  assert.equal(await keeper.askRoster(AGENT, down.fetchImpl), 'flagged');
  assert.equal((await keeper.ingestDecision(AGENT, 'C:/x', down.fetchImpl)).write, false);
  assert.equal(down.hits.length, 0);
});

test('ingest: a cwd pattern is enough when the session is on no roster', async () => {
  initKeeper({ agentCwdPatterns: ['Agent-Home'] });
  const d = await keeper.ingestDecision(`ing-cwd-${RUN}`, 'C:/work/agent-home/repo');
  assert.equal(d.write, false);
  assert.match(d.why, /cwd matches/);
});

test('ingest: a roster that does not answer counts as an agent for Gobble, without flagging the session', async () => {
  initKeeper({ agentRosters: [URL] });
  const down = fakeFetch({ [URL]: null });
  const sid = `ing-unknown-${RUN}`;
  const before = counters();
  assert.equal(await keeper.askRoster(sid, down.fetchImpl), 'unknown');
  const d = await keeper.ingestDecision(sid, 'C:/x', down.fetchImpl);
  assert.deepEqual(d, { write: false, why: 'a roster did not answer' });
  assert.equal(counters().unknown, before.unknown + 1);
  assert.equal(counters().agent, before.agent);
  // Not sticky: when the roster answers again and does not list it, it writes.
  assert.equal(keeper.isAgentSession(sid, 'C:/x').agent, false);
  resetRosterCache();
  const up = fakeFetch({ [URL]: ROSTER });
  assert.equal((await keeper.ingestDecision(sid, 'C:/x', up.fetchImpl)).write, true);
});

test('ingest: a session the roster does not list writes as before', async () => {
  initKeeper({ agentRosters: [URL] });
  const up = fakeFetch({ [URL]: ROSTER });
  const sid = `ing-person-${RUN}`;
  const before = counters();
  assert.equal(await keeper.askRoster(sid, up.fetchImpl), 'not-listed');
  assert.deepEqual(await keeper.ingestDecision(sid, 'C:/anywhere', up.fetchImpl), { write: true, why: 'not an agent session' });
  assert.deepEqual(counters(), before);
});

test('ingest: with no roster configured and no cwd match nothing changes', async () => {
  initKeeper({});
  const never = fakeFetch({});
  const sid = `ing-plain-${RUN}`;
  assert.equal(await keeper.askRoster(sid, never.fetchImpl), 'none');
  assert.equal((await keeper.ingestDecision(sid, 'C:/x', never.fetchImpl)).write, true);
  assert.equal(never.hits.length, 0, 'no roster is asked when none is configured');
});

test('ingest: agentIngest true restores the old behaviour for an agent and for an unanswered roster', async () => {
  initKeeper({ agentRosters: [URL], agentIngest: true });
  const down = fakeFetch({ [URL]: null });
  const before = counters();
  assert.equal((await keeper.ingestDecision(AGENT, 'C:/x', down.fetchImpl)).write, true);
  assert.equal((await keeper.ingestDecision(`ing-unknown2-${RUN}`, 'C:/x', down.fetchImpl)).write, true);
  assert.deepEqual(counters(), before);
});

test('ingest: only the first drop of a session is logged, and the line carries no tool input', async () => {
  const logs = initKeeper({ agentCwdPatterns: ['agent-home'] });
  const sid = `ing-log-${RUN}`;
  const before = counters();
  for (let i = 0; i < 5; i++) await keeper.ingestDecision(sid, 'C:/agent-home');
  const lines = logs.filter(l => /ingest not written/.test(l.message));
  assert.equal(lines.length, 1);
  assert.match(lines[0].message, new RegExp(`^session ${sid.slice(0, 8)}: ingest not written \\(agent session: cwd matches`));
  assert.equal(counters().agent, before.agent + 5);
});

test('resolveAgent keeps its shape', async () => {
  initKeeper({ agentRosters: [URL] });
  const up = fakeFetch({ [URL]: ROSTER });
  assert.deepEqual(await keeper.resolveAgent(`ing-shape-${RUN}`, 'C:/x', up.fetchImpl), { agent: false, why: 'not flagged' });
});
