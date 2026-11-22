// The "gated 50x with no promotion" hint is for a person gated by mistake.
// An agent session is gated by design, so it gets no hint.
// Stubs only: no Neo4j, no Anthropic, no network (fetch is stubbed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resetRosterCache } from '../agent-roster.js';
import keeper from '../daemons/keeper.js';

function fakeFetch(routes) {
  return async (url) => {
    if (routes[url] === null || routes[url] === undefined) throw new Error('connection refused');
    return { ok: true, json: async () => routes[url] };
  };
}

// The Keeper persists its ledger to disk, so ids are unique per run.
const RUN = Date.now().toString(36);
const URL = 'http://r1/';

function initKeeper(cfg) {
  const logs = [];
  resetRosterCache();
  keeper.init({ daemonConfig: cfg, log: (endpoint, level, message) => logs.push({ endpoint, level, message }) });
  return logs;
}

// Gate a candidate session 50 times and return the hints logged for it.
async function gateFifty(sid, cwd, logs, fetchImpl) {
  keeper.register(sid, cwd);
  assert.equal(keeper.tierOf(sid), 'candidate');
  for (let i = 0; i < 50; i++) await keeper.countFastPath(sid, fetchImpl);
  return logs.filter(l => l.level === 'warn' && /gated 50x with no promotion/.test(l.message));
}

test('hint: a session nothing marks as an agent still gets the hint, once', async () => {
  const logs = initKeeper({});
  const sid = `hint-person-${RUN}`;
  assert.equal((await gateFifty(sid, 'C:/work/repo', logs)).length, 1);
  for (let i = 0; i < 10; i++) await keeper.countFastPath(sid);
  assert.equal(logs.filter(l => /gated \d+x with no promotion/.test(l.message)).length, 1);
});

test('hint: a session a roster lists gets none', async () => {
  const sid = `hint-roster-${RUN}`;
  const logs = initKeeper({ agentRosters: [URL] });
  const fetchImpl = fakeFetch({ [URL]: { contexts: [{ name: 'worker-a', sessionId: sid, kind: 'spawned' }] } });
  assert.equal((await gateFifty(sid, 'C:/work/repo', logs, fetchImpl)).length, 0);
});

test('hint: a session in an agent folder gets none', async () => {
  const logs = initKeeper({ agentCwdPatterns: ['Agent-Home'] });
  assert.equal((await gateFifty(`hint-cwd-${RUN}`, 'C:/work/agent-home/repo', logs)).length, 0);
});

test('hint: when the roster does not answer, the hint is still logged', async () => {
  const logs = initKeeper({ agentRosters: [URL] });
  const fetchImpl = fakeFetch({ [URL]: null });
  assert.equal((await gateFifty(`hint-down-${RUN}`, 'C:/work/repo', logs, fetchImpl)).length, 1);
});
