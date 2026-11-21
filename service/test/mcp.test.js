// /mcp endpoint: tool listing, result shape, mutation gating, bearer token.
// Hermetic — a fake dispatch stands in for the Undertow routes (no Neo4j, no
// LLM). The HTTP server binds 127.0.0.1 on an ephemeral port.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountMcp, MCP_TOOL_NAMES } from '../mcp.js';
import { apiTokenGuard } from '../auth.js';

const calls = [];
async function fakeDispatch(method, path, opts = {}) {
  calls.push({ method, path, ...opts });
  if (path === '/undertow/neuron') return { ok: false, text: JSON.stringify({ http_status: 404, error: 'not found' }) };
  return { ok: true, text: JSON.stringify({ http_status: 200, path }) };
}

async function startApp({ allowMutations = false, token = '' } = {}) {
  const app = express();
  if (token) app.use(apiTokenGuard(token));
  app.use(express.json());
  app.post('/undertow/toggle', (req, res) => res.json({ ok: true }));
  app.get('/undertow/stats', (req, res) => res.json({ ok: true }));
  mountMcp(app, { dispatch: fakeDispatch, allowMutations });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const base = await startApp();
const url = new URL(`${base}/mcp`);

async function connect(target = url, requestInit) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(target, requestInit ? { requestInit } : undefined));
  return client;
}

test('/mcp lists the 11 Undertow tools', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), [...MCP_TOOL_NAMES].sort());
  assert.equal(tools.length, 11);
  for (const t of tools) assert.doesNotMatch(t.description, /RouterBox/);
  await client.close();
});

test('/mcp tool call maps to the route and returns http_status JSON', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'undertow_query', arguments: { session_id: 's1', prompt: 'hello' } });
  assert.equal(r.isError, false);
  assert.deepEqual(JSON.parse(r.content[0].text), { http_status: 200, path: '/undertow/query' });
  const last = calls.at(-1);
  assert.equal(last.method, 'POST');
  assert.equal(last.body.prompt, 'hello');
  await client.close();
});

test('/mcp non-2xx route result is isError', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'undertow_neighbors', arguments: { name: 'x' } });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).http_status, 404);
  const missing = await client.callTool({ name: 'undertow_neighbors', arguments: {} });
  assert.equal(missing.isError, true);
  await client.close();
});

test('/mcp GET is 405 (stateless server)', async () => {
  const res = await fetch(url);
  assert.equal(res.status, 405);
});

test('/mcp mutating tools are refused when UNDERTOW_MCP_ALLOW_MUTATIONS is off', async () => {
  const client = await connect();
  const before = calls.length;
  const attempts = [
    ['undertow_spider', {}],
    ['undertow_ingest', { tool_name: 'Bash', tool_response: 'x' }],
    ['undertow_correct', { neuron: 'n', action: 'delete', reason: 'r' }],
  ];
  for (const [name, args] of attempts) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /UNDERTOW_MCP_ALLOW_MUTATIONS/);
  }
  assert.equal(calls.length, before, 'gated tools must not reach the routes');
  // Non-delete corrections are still allowed.
  const ok = await client.callTool({ name: 'undertow_correct', arguments: { neuron: 'n', action: 'demote', reason: 'r' } });
  assert.equal(ok.isError, false);
  await client.close();
});

test('/mcp mutating tools run when allowMutations is on', async () => {
  const b = await startApp({ allowMutations: true });
  const client = await connect(new URL(`${b}/mcp`));
  const r = await client.callTool({ name: 'undertow_spider', arguments: { mode: 'full' } });
  assert.equal(r.isError, false);
  assert.deepEqual(calls.at(-1).body, { mode: 'full' });
  await client.close();
});

test('UNDERTOW_API_TOKEN: /mcp and mutating routes require the bearer token', async () => {
  const token = randomBytes(16).toString('hex');
  const b = await startApp({ token });
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${b}/mcp`, init)).status, 401);
  assert.equal((await fetch(`${b}/mcp`, { ...init, headers: { ...init.headers, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${b}/undertow/toggle`, init)).status, 401);
  assert.equal((await fetch(`${b}/undertow/toggle`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${b}/undertow/stats`)).status, 200, 'read-only GET routes stay open');

  await assert.rejects(connect(new URL(`${b}/mcp`)));
  const client = await connect(new URL(`${b}/mcp`), { headers: { Authorization: `Bearer ${token}` } });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  await client.close();
});
