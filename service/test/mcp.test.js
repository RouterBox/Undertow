// /mcp endpoint: tool listing and result shape.
// Hermetic — a fake dispatch stands in for the Undertow routes (no Neo4j, no
// LLM). The HTTP server binds 127.0.0.1 on an ephemeral port.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountMcp, MCP_TOOL_NAMES } from '../mcp.js';

const calls = [];
async function fakeDispatch(method, path, opts = {}) {
  calls.push({ method, path, ...opts });
  if (path === '/undertow/neuron') return { ok: false, text: JSON.stringify({ http_status: 404, error: 'not found' }) };
  return { ok: true, text: JSON.stringify({ http_status: 200, path }) };
}

const app = express();
app.use(express.json());
mountMcp(app, { dispatch: fakeDispatch });
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
after(() => server.close());

async function connect() {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
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
