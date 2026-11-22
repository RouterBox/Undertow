// Tier 'off' excludes a place from Undertow entirely. The hook routes already
// return nothing for an off session; this guard refuses everything else (the
// MCP tools' routes and plain HTTP) when the request names an off cwd or an off
// session. Stubs only: no Neo4j, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import keeper, { offPlaceGuard } from '../daemons/keeper.js';

// The Keeper persists its ledger to disk, so ids are unique per run.
const RUN = Date.now().toString(36);
const OFF_CWD = '/places/excluded-place/project';
const DRONE_CWD = '/places/robot-farm/job';
const HOOK_ROUTES = ['/undertow/query', '/undertow/session-start', '/undertow/ingest', '/undertow/summarize', '/undertow/rehydrate'];

function init(extra = {}) {
  keeper.init({ daemonConfig: { cwdRules: [{ pattern: 'excluded-place', tier: 'off' }, { pattern: 'robot-farm', tier: 'drone' }], ...extra }, log: () => {} });
}

// Run the guard against a fake request; says what the client would get.
function send(guard, { method = 'GET', path, body, query } = {}) {
  const out = { nexted: false, status: 200, json: undefined };
  const res = { status(code) { out.status = code; return res; }, json(payload) { out.json = payload; return res; } };
  guard({ method, path, body, query }, res, () => { out.nexted = true; });
  return out;
}

test('helpers: cwdIsOff follows the cwd rules; sessionIsOff reads the ledger and never creates an entry', () => {
  init();
  assert.equal(keeper.cwdIsOff(OFF_CWD), true);
  assert.equal(keeper.cwdIsOff('C:\\Places\\Excluded-Place\\x'), true, 'case-insensitive, like the rules');
  assert.equal(keeper.cwdIsOff(DRONE_CWD), false);
  assert.equal(keeper.cwdIsOff('/work/app'), false);
  assert.equal(keeper.cwdIsOff(undefined), false);
  const unknown = `off-unknown-${RUN}`;
  assert.equal(keeper.sessionIsOff(unknown), false);
  assert.equal(keeper.tierOf(unknown), 'candidate', 'asking did not create a ledger entry with a tier');
  const sid = `off-sess-${RUN}`;
  keeper.register(sid, OFF_CWD);
  assert.equal(keeper.tierOf(sid), 'off');
  assert.equal(keeper.sessionIsOff(sid), true);
});

test('an MCP query from an off folder, with no session id, is refused', () => {
  init();
  const logs = [];
  const guard = offPlaceGuard({ log: (...a) => logs.push(a) });
  const r = send(guard, { method: 'POST', path: '/undertow/query', body: { via: 'mcp', cwd: OFF_CWD, prompt: 'what do you know' } });
  assert.equal(r.nexted, false);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /excluded from Undertow/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], 'warn');
  assert.doesNotMatch(JSON.stringify(logs[0]), /excluded-place/, 'the log says a rule matched, not which folder');
});

test('an off session id is refused on the tool and HTTP routes', () => {
  init();
  const sid = `off-routes-${RUN}`;
  keeper.register(sid, OFF_CWD);
  const guard = offPlaceGuard();
  for (const path of ['/undertow/neuron', '/undertow/held', '/undertow/stats', '/undertow/logs', '/undertow/patterns', '/undertow/health']) {
    const r = send(guard, { method: 'GET', path, query: { session_id: sid } });
    assert.equal(r.status, 403, path);
    assert.equal(r.nexted, false, path);
  }
  for (const path of ['/undertow/chase', '/undertow/feedback', '/undertow/correct']) {
    const r = send(guard, { method: 'POST', path, body: { session_id: sid, neuron: 'n' } });
    assert.equal(r.status, 403, path);
  }
  // The folder alone is enough, with no session id at all.
  assert.equal(send(guard, { method: 'GET', path: '/undertow/stats', query: { via: 'mcp', cwd: OFF_CWD } }).status, 403);
  assert.equal(send(guard, { method: 'POST', path: '/undertow/chase', body: { via: 'mcp', cwd: OFF_CWD, neuron: 'n' } }).status, 403);
});

test('hook calls are left to their routes, which already answer an off session with nothing', () => {
  init();
  const sid = `off-hooks-${RUN}`;
  keeper.register(sid, OFF_CWD);
  const guard = offPlaceGuard();
  for (const path of HOOK_ROUTES) {
    const r = send(guard, { method: 'POST', path, body: { session_id: sid, cwd: OFF_CWD, hook_event_name: 'Stop' } });
    assert.equal(r.nexted, true, path);
    assert.equal(r.json, undefined, path);
  }
  // ...but a tool call to a hook route (via 'mcp') is not a hook: refused.
  assert.equal(send(guard, { method: 'POST', path: '/undertow/ingest', body: { via: 'mcp', session_id: sid } }).status, 403);
});

test('everyone else is unaffected: ordinary folder, drone folder, no cwd, unknown session', () => {
  init();
  const logs = [];
  const guard = offPlaceGuard({ log: (...a) => logs.push(a) });
  const cases = [
    { method: 'POST', path: '/undertow/query', body: { via: 'mcp', cwd: '/work/app', prompt: 'q' } },
    { method: 'POST', path: '/undertow/query', body: { via: 'mcp', cwd: DRONE_CWD, prompt: 'q' } },
    { method: 'GET', path: '/undertow/stats', query: { via: 'mcp' } },
    { method: 'GET', path: '/undertow/stats' },
    { method: 'GET', path: '/undertow/neuron', query: { name: 'n', session_id: `off-nobody-${RUN}` } },
    { method: 'POST', path: '/undertow/chase', body: { neuron: 'n', cwd: DRONE_CWD } },
    { method: 'POST', path: '/mcp', body: { jsonrpc: '2.0', method: 'tools/list' } },
  ];
  for (const c of cases) assert.equal(send(guard, c).nexted, true, `${c.method} ${c.path}`);
  assert.equal(logs.length, 0);
});

test('with the Keeper disabled nothing is refused', () => {
  init({ enabled: false });
  const guard = offPlaceGuard();
  assert.equal(send(guard, { method: 'GET', path: '/undertow/stats', query: { cwd: OFF_CWD } }).nexted, true);
  init({ enabled: true });
});

test('refusals are logged at most once a minute per route', () => {
  init();
  const logs = [];
  let t = 1_000_000;
  const guard = offPlaceGuard({ log: (...a) => logs.push(a), now: () => t });
  const req = { method: 'GET', path: '/undertow/stats', query: { cwd: OFF_CWD, session_id: 'abcdefgh-rest-of-id' } };
  for (let i = 0; i < 5; i++) assert.equal(send(guard, req).status, 403);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0][3]?.detail), /session abcdefgh$/, 'only the 8-character session prefix');
  send(guard, { ...req, path: '/undertow/logs' });
  assert.equal(logs.length, 2, 'another route logs on its own clock');
  t += 60_000;
  send(guard, req);
  assert.equal(logs.length, 3);
});
