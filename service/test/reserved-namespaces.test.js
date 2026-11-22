// Reserved namespaces: a client may not name a namespace the deployment keeps
// for itself. The guard refuses before any route runs; it never redirects the
// caller to the live graph.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setReservedNamespaces, namespaceAllowed, reservedNamespaceGuard, HOOK_ROUTES, sanitizeNamespace } from '../namespaces.js';

beforeEach(() => setReservedNamespaces([]));

// Run the guard against a fake request; says what the client would get.
async function send({ method = 'POST', path, body, query } = {}, opts = {}) {
  const logs = [];
  const out = { nexted: false, status: 200, json: undefined, logs };
  const res = {
    status(code) { out.status = code; return res; },
    json(payload) { out.json = payload; return res; },
  };
  await reservedNamespaceGuard({ log: (...a) => logs.push(a), ...opts })({ method, path, body, query }, res, () => { out.nexted = true; });
  return out;
}

test('default: no reserved list changes nothing', async () => {
  assert.equal(namespaceAllowed('anything'), true);
  assert.equal(namespaceAllowed(null), true);
  for (const path of [...HOOK_ROUTES, '/undertow/chase', '/undertow/neuron']) {
    const r = await send({ path, body: { namespace: 'work' }, query: { namespace: 'quarantine' } });
    assert.equal(r.nexted, true, path);
    assert.equal(r.logs.length, 0);
  }
});

test('namespaceAllowed: reserved names are refused however they are spelled; others and the live graph pass', () => {
  setReservedNamespaces(['Vault-Keep ', 'not a valid name!', 42]);
  assert.equal(namespaceAllowed('vault-keep'), false);
  assert.equal(namespaceAllowed('  VAULT-KEEP'), false);
  assert.equal(namespaceAllowed('work'), true);
  assert.equal(namespaceAllowed('quarantine'), true, 'the held tier is not reserved unless the deployment says so');
  assert.equal(namespaceAllowed(undefined), true);
  assert.equal(namespaceAllowed('not a valid name!'), true, 'an invalid name is the live graph, as before');
  assert.equal(sanitizeNamespace('vault-keep'), 'vault-keep', 'sanitizeNamespace itself is unchanged: no silent redirect to live');
});

test('hook routes: a reserved namespace gets an empty result, the route never runs, and it is logged', async () => {
  setReservedNamespaces(['vault-keep']);
  for (const path of HOOK_ROUTES) {
    const r = await send({ path, body: { session_id: 's1', namespace: 'vault-keep' } });
    assert.equal(r.nexted, false, path);
    assert.equal(r.status, 200, path);
    assert.deepEqual(r.json, {}, path);
    assert.equal(r.logs.length, 1);
    assert.equal(r.logs[0][1], 'warn');
    assert.match(r.logs[0][2], /reserved namespace "vault-keep"/);
  }
});

test('body routes (chase, feedback, correct, external-ingest, spider, janitor): 403 with a reason', async () => {
  setReservedNamespaces(['vault-keep']);
  for (const path of ['/undertow/chase', '/undertow/feedback', '/undertow/correct', '/undertow/external-ingest', '/undertow/spider', '/undertow/janitor']) {
    const r = await send({ path, body: { neuron: 'x', namespace: 'VAULT-KEEP' } });
    assert.equal(r.nexted, false, path);
    assert.equal(r.status, 403, path);
    assert.match(r.json.error, /"vault-keep" is reserved/);
  }
});

test('query-string routes (neuron): 403 for a reserved namespace, the held tier still readable', async () => {
  setReservedNamespaces(['vault-keep']);
  const refused = await send({ method: 'GET', path: '/undertow/neuron', query: { name: 'x', namespace: 'vault-keep' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.nexted, false);
  const held = await send({ method: 'GET', path: '/undertow/neuron', query: { name: 'x', namespace: 'quarantine' } });
  assert.equal(held.nexted, true);
});

test('an unreserved namespace and a request with no namespace still go through', async () => {
  setReservedNamespaces(['vault-keep']);
  assert.equal((await send({ path: '/undertow/query', body: { namespace: 'work' } })).nexted, true);
  assert.equal((await send({ path: '/undertow/chase', body: { neuron: 'x' } })).nexted, true);
  assert.equal((await send({ method: 'GET', path: '/undertow/held', query: { limit: '5' } })).nexted, true);
  assert.equal((await send({ method: 'GET', path: '/undertow/stats' })).nexted, true, 'no body, no query');
});

test('the guard waits for the config before deciding', async () => {
  let release;
  const ready = new Promise(r => { release = r; }).then(() => setReservedNamespaces(['vault-keep']));
  const pending = send({ path: '/undertow/chase', body: { namespace: 'vault-keep' } }, { ready });
  release();
  assert.equal((await pending).status, 403, 'a request that arrives before the config is loaded is still refused');
});
