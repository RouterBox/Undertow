// Provider seam (llm.js): model resolution, plugin loading, call semantics.
// Hermetic — no network, no API key; providers are fakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_MODELS, resolveModel, shouldDisableThinking,
  loadProvider, usesAnthropicProvider, callLLM,
} from '../llm.js';

// A minimal UNDERTOW_LLM_PROVIDER_MODULE plugin, written to a temp dir.
const FIXTURE = join(mkdtempSync(join(tmpdir(), 'undertow-llm-')), 'echo-provider.mjs');
writeFileSync(FIXTURE, `
export const name = 'echo';
export async function createMessage(req) {
  return { content: [{ type: 'text', text: 'echo:' + req.model + ':' + req.userContent }] };
}
`);

test('resolveModel: defaults preserve the historical model ids', () => {
  assert.equal(resolveModel('query', {}), 'claude-haiku-5-5');
  assert.equal(resolveModel('ingest', {}), 'claude-haiku-5-5');
  assert.equal(resolveModel('summarize', {}), 'claude-sonnet-5');
  assert.equal(resolveModel('fallback', {}), 'claude-haiku-5-5');
  assert.deepEqual({ ...DEFAULT_MODELS }, {
    query: 'claude-haiku-5-5', ingest: 'claude-haiku-5-5', summarize: 'claude-sonnet-5',
  });
});

test('resolveModel: per-role env overrides; fallback follows the query model', () => {
  const env = { UNDERTOW_QUERY_MODEL: 'q', UNDERTOW_INGEST_MODEL: 'i', UNDERTOW_SUMMARIZE_MODEL: 's' };
  assert.equal(resolveModel('query', env), 'q');
  assert.equal(resolveModel('ingest', env), 'i');
  assert.equal(resolveModel('summarize', env), 's');
  assert.equal(resolveModel('fallback', env), 'q');
  assert.equal(resolveModel('fallback', { ...env, UNDERTOW_FALLBACK_MODEL: 'f' }), 'f');
  assert.throws(() => resolveModel('nope', {}), /unknown model role/);
});

test('shouldDisableThinking: haiku and sonnet-5 only', () => {
  assert.equal(shouldDisableThinking('claude-haiku-5-5'), true);
  assert.equal(shouldDisableThinking('claude-sonnet-5'), true);
  assert.equal(shouldDisableThinking('claude-opus-5-5'), false);
  assert.equal(shouldDisableThinking('some-other-model'), false);
});

test('loadProvider: default is the built-in anthropic provider', async () => {
  assert.equal(usesAnthropicProvider({}), true);
  const p = await loadProvider({ ANTHROPIC_API_KEY: 'test' });
  assert.equal(p.name, 'anthropic');
  assert.equal(typeof p.createMessage, 'function');
});

test('loadProvider: unknown provider name is rejected', async () => {
  await assert.rejects(loadProvider({ UNDERTOW_LLM_PROVIDER: 'mystery' }), /unknown UNDERTOW_LLM_PROVIDER/);
});

test('loadProvider: UNDERTOW_LLM_PROVIDER_MODULE loads a plugin module', async () => {
  const env = { UNDERTOW_LLM_PROVIDER_MODULE: FIXTURE };
  assert.equal(usesAnthropicProvider(env), false);
  const p = await loadProvider(env);
  assert.equal(p.name, 'echo');
  const msg = await p.createMessage({ model: 'm', system: 's', userContent: 'hi', maxTokens: 10 });
  assert.equal(msg.content[0].text, 'echo:m:hi');
});

test('loadProvider: module without createMessage is rejected', async () => {
  const bad = fileURLToPath(new URL('../namespaces.js', import.meta.url));
  await assert.rejects(loadProvider({ UNDERTOW_LLM_PROVIDER_MODULE: bad }), /must export createMessage/);
});

test('callLLM: disables thinking for haiku, puts text blocks first', async () => {
  const seen = [];
  const provider = {
    async createMessage(req) {
      seen.push(req);
      return { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'answer' }] };
    },
  };
  const out = await callLLM('claude-haiku-5-5', 'sys', 'user', 123, { provider });
  assert.equal(out.model, 'claude-haiku-5-5');
  assert.equal(out.response.content[0].text, 'answer');
  assert.deepEqual(seen[0], {
    model: 'claude-haiku-5-5', system: 'sys', userContent: 'user', maxTokens: 123,
    thinking: { type: 'disabled' },
  });
  await callLLM('claude-opus-5-5', 'sys', 'user', 50, { provider });
  assert.equal(seen[1].thinking, undefined);
});

test('callLLM: non-retryable error returns null', async () => {
  const provider = { async createMessage() { throw Object.assign(new Error('bad request'), { status: 400 }); } };
  assert.equal(await callLLM('claude-haiku-5-5', 's', 'u', 10, { provider }), null);
});

test('callLLM: overloaded twice falls back to the query model', async () => {
  const models = [];
  const provider = {
    async createMessage(req) {
      models.push(req.model);
      if (models.length < 3) throw Object.assign(new Error('Overloaded'), { status: 529 });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const out = await callLLM('claude-sonnet-5', 's', 'u', 10, { provider });
  assert.deepEqual(models, ['claude-sonnet-5', 'claude-sonnet-5', resolveModel('fallback')]);
  assert.equal(out.model, resolveModel('fallback'));
});
