// Prowler deep research: no paid call for a known topic, a per-session budget,
// and complete neurons. fetch and runCypher are stubbed; no network or Neo4j.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import prowler from '../daemons/prowler.js';

const ANSWER = 'Event sourcing keeps an append-only log of changes and rebuilds state by replaying it. '.repeat(2);
let fetchCalls;
let realFetch;
let realKey;

beforeEach(() => {
  fetchCalls = [];
  realFetch = globalThis.fetch;
  realKey = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'test-key';
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push(JSON.parse(opts.body).messages[0].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: ANSWER } }] }) };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = realKey;
});

function harness({ existingNames = [] } = {}) {
  const creates = [];
  const embedded = [];
  const runCypher = async (q, p) => {
    if (/RETURN n\.name LIMIT 1/.test(q)) return existingNames.includes(p.name) ? [{ 'n.name': p.name }] : [];
    if (/CREATE \(n:Neuron/.test(q)) creates.push({ q, p });
    return [];
  };
  const embedNeuron = async (name) => { embedded.push(name); };
  return { creates, embedded, runCypher, embedNeuron, log: () => {} };
}

const T1 = 'event sourcing architecture pattern';
const T2 = 'vector index design strategy';
const T3 = 'graph pruning algorithm approach';

test('a topic that already has a research neuron makes no paid call', async () => {
  const h = harness({ existingNames: [`Research: ${T1}`] });
  const r = await prowler.deepResearch({ topics: [T1], session: {}, runCypher: h.runCypher, embedNeuron: h.embedNeuron, log: h.log });
  assert.equal(fetchCalls.length, 0);
  assert.equal(r.neurons, 0);
  assert.equal(h.creates.length, 0);
});

test('a new neuron has a uid, the session project and an embedding', async () => {
  const h = harness();
  const session = { currentProject: 'c:\\work\\myrepo' };
  const r = await prowler.deepResearch({ topics: [T1], session, runCypher: h.runCypher, embedNeuron: h.embedNeuron, log: h.log });
  assert.equal(r.neurons, 1);
  assert.equal(fetchCalls.length, 1);
  const c = h.creates[0];
  assert.ok(c.p.uid && c.p.uid.length > 10);
  assert.equal(c.p.project, 'c:\\work\\myrepo');
  assert.match(c.q, /uid: \$uid/);
  assert.match(c.q, /project: \$project/);
  assert.deepEqual(h.embedded, [`Research: ${T1}`]);
});

test('the same topics on a later Stop are not researched again', async () => {
  const h = harness();
  const session = {};
  const args = { topics: [T1, T2], session, runCypher: h.runCypher, embedNeuron: h.embedNeuron, log: h.log };
  await prowler.deepResearch(args);
  await prowler.deepResearch(args);
  await prowler.deepResearch(args);
  assert.equal(fetchCalls.length, 2);
});

test('a session stops at its budget even when new topics keep arriving', async () => {
  const h = harness();
  const session = {};
  const base = { session, runCypher: h.runCypher, embedNeuron: h.embedNeuron, log: h.log };
  await prowler.deepResearch({ ...base, topics: [T1] });
  await prowler.deepResearch({ ...base, topics: [T2] });
  await prowler.deepResearch({ ...base, topics: [T3] });
  assert.equal(fetchCalls.length, 2, 'default budget is 2 per session');
  assert.equal(h.creates.length, 2);
});
