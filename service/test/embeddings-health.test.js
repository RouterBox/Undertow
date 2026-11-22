// A failing embedding provider must be visible: reported once, reflected in
// getEmbeddingStatus(), and cleared on recovery.
// The Gemini SDK is driven through a stubbed global fetch; nothing leaves the machine.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getEmbedding, getEmbeddingStatus, setEmbeddingReporter, _resetEmbeddingHealth } from '../embeddings.js';

const KEYS = ['EMBEDDINGS_PROVIDER', 'GEMINI_API_KEY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let realFetch;
let events;

const paymentRequired = async () => new Response(
  JSON.stringify({ error: { code: 402, message: 'Your prepayment credits are depleted.', status: 'PAYMENT_REQUIRED' } }),
  { status: 402, statusText: 'Payment Required', headers: { 'Content-Type': 'application/json' } }
);
const embeddingOk = async () => new Response(
  JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }
);

beforeEach(() => {
  realFetch = globalThis.fetch;
  process.env.EMBEDDINGS_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key-not-real';
  _resetEmbeddingHealth();
  events = [];
  setEmbeddingReporter((msg, level) => events.push({ msg, level }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _resetEmbeddingHealth();
});

test('before any call a configured provider is "untested", not "ok"', () => {
  const s = getEmbeddingStatus();
  assert.equal(s.state, 'untested');
  assert.equal(s.available, true);
});

test('no key: unconfigured and unavailable', () => {
  delete process.env.GEMINI_API_KEY;
  const s = getEmbeddingStatus();
  assert.equal(s.state, 'unconfigured');
  assert.equal(s.available, false);
});

test('a failing provider is reported, and status says degraded with the reason', async () => {
  globalThis.fetch = paymentRequired;
  assert.equal(await getEmbedding('hello'), null);

  assert.equal(events.length, 1, 'the first failure is reported');
  assert.equal(events[0].level, 'error');
  assert.match(events[0].msg, /EMBEDDINGS FAILING \(gemini\)/);
  assert.match(events[0].msg, /402/);
  assert.match(events[0].msg, /falling back to keywords/);

  const s = getEmbeddingStatus();
  assert.equal(s.state, 'degraded');
  assert.equal(s.available, false, 'a provider whose calls fail is not "available"');
  assert.match(s.reason, /402/);
  assert.equal(s.failedCalls, 1);
  assert.ok(s.lastErrorAt);
});

test('repeated failures are counted but not logged every time', async () => {
  globalThis.fetch = paymentRequired;
  for (let i = 0; i < 5; i++) await getEmbedding('hello');
  assert.equal(getEmbeddingStatus().failedCalls, 5);
  assert.equal(events.filter((e) => e.level === 'error').length, 1, 'one line per window, not one per call');
});

test('a success after failures reports recovery and clears the state', async () => {
  globalThis.fetch = paymentRequired;
  await getEmbedding('hello');
  await getEmbedding('hello');
  globalThis.fetch = embeddingOk;
  assert.deepEqual(await getEmbedding('hello'), [0.1, 0.2, 0.3]);

  const recovered = events.filter((e) => e.level === 'info');
  assert.equal(recovered.length, 1);
  assert.match(recovered[0].msg, /recovered \(gemini\) after 2 failed call/);

  const s = getEmbeddingStatus();
  assert.equal(s.state, 'ok');
  assert.equal(s.available, true);
  assert.equal(s.reason, undefined);
  assert.ok(s.lastSuccessAt);
});

test('the reason never includes the API key', async () => {
  globalThis.fetch = paymentRequired;
  await getEmbedding('hello');
  assert.ok(!getEmbeddingStatus().reason.includes('test-key-not-real'));
  assert.ok(!events[0].msg.includes('test-key-not-real'));
});
