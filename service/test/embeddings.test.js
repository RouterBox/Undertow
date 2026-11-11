// Local embedding provider config (embeddings.js): env → transformers.js env
// mapping, and loud failure when the model can't be loaded.
// Hermetic — offline mode against an empty temp dir, so nothing is downloaded.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  resolveLocalConfig, applyTransformersEnv, describeLocalLoadFailure, LOCAL_EXPECTED_FILES,
  initEmbeddings, isAvailable, getEmbedding, getEmbeddingStatus, _resetLocalEmbeddings,
} from '../embeddings.js';

const SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = ['EMBEDDINGS_PROVIDER', 'EMBEDDINGS_MODEL_DIR', 'EMBEDDINGS_OFFLINE', 'EMBEDDINGS_REMOTE_HOST', 'EMBEDDINGS_LOCAL_MODEL', 'GEMINI_API_KEY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _resetLocalEmbeddings();
});

test('resolveLocalConfig: defaults — service/.models, online, Hub', () => {
  const cfg = resolveLocalConfig({});
  assert.equal(cfg.model, 'Xenova/all-MiniLM-L6-v2');
  assert.equal(cfg.modelDir, join(SERVICE_DIR, '.models'));
  assert.equal(cfg.offline, false);
  assert.equal(cfg.remoteHost, null);
});

test('resolveLocalConfig: relative EMBEDDINGS_MODEL_DIR resolves from the service dir, not cwd', () => {
  assert.equal(resolveLocalConfig({ EMBEDDINGS_MODEL_DIR: 'm/x' }).modelDir, resolve(SERVICE_DIR, 'm/x'));
  const abs = mkdtempSync(join(tmpdir(), 'undertow-emb-'));
  assert.equal(resolveLocalConfig({ EMBEDDINGS_MODEL_DIR: abs }).modelDir, abs);
});

test('applyTransformersEnv: env vars map to transformers env settings', () => {
  const cfg = resolveLocalConfig({ EMBEDDINGS_MODEL_DIR: '/models', EMBEDDINGS_OFFLINE: 'true', EMBEDDINGS_REMOTE_HOST: 'https://your-mirror.example' });
  const tenv = applyTransformersEnv({ allowRemoteModels: true, remoteHost: 'https://huggingface.co/' }, cfg);
  assert.equal(tenv.cacheDir, cfg.modelDir);
  assert.equal(tenv.localModelPath, cfg.modelDir);
  assert.equal(tenv.allowLocalModels, true);
  assert.equal(tenv.allowRemoteModels, false);
  assert.equal(tenv.remoteHost, 'https://your-mirror.example/');

  const online = applyTransformersEnv({ remoteHost: 'https://huggingface.co/' }, resolveLocalConfig({}));
  assert.equal(online.allowRemoteModels, true);
  assert.equal(online.remoteHost, 'https://huggingface.co/', 'no mirror set leaves the default host');
});

test('describeLocalLoadFailure: names model dir, model id, expected files and the env hints', () => {
  const cfg = resolveLocalConfig({ EMBEDDINGS_MODEL_DIR: '/m' });
  const msg = describeLocalLoadFailure(cfg, new Error('Forbidden'));
  assert.match(msg, /Xenova\/all-MiniLM-L6-v2/);
  assert.ok(msg.includes(cfg.modelDir));
  for (const f of LOCAL_EXPECTED_FILES) assert.ok(msg.includes(f.split('/').pop()), f);
  assert.match(msg, /Forbidden/);
  assert.match(msg, /EMBEDDINGS_OFFLINE/);
  assert.match(msg, /EMBEDDINGS_REMOTE_HOST/);
});

test('local model load failure: one loud error, unavailable, /health status shows it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'undertow-emb-empty-'));
  process.env.EMBEDDINGS_PROVIDER = 'local';
  process.env.EMBEDDINGS_MODEL_DIR = dir;
  process.env.EMBEDDINGS_OFFLINE = 'true';
  assert.equal(isAvailable(), true, 'optimistic before the first load attempt');

  const logged = [];
  const r = await initEmbeddings({ log: (m) => logged.push(m) });
  assert.equal(r.ok, false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /LOCAL EMBEDDINGS UNAVAILABLE/);
  assert.ok(logged[0].includes(dir));
  assert.ok(logged[0].includes('model_quantized.onnx'));

  assert.equal(isAvailable(), false);
  assert.equal(await getEmbedding('hello'), null);
  const st = getEmbeddingStatus();
  assert.equal(st.provider, 'local');
  assert.equal(st.available, false);
  assert.match(st.error, /LOCAL EMBEDDINGS UNAVAILABLE/);
});

test('gemini provider: initEmbeddings is a no-op and availability is unchanged', async () => {
  delete process.env.EMBEDDINGS_PROVIDER;
  process.env.GEMINI_API_KEY = 'x';
  const logged = [];
  assert.deepEqual(await initEmbeddings({ log: (m) => logged.push(m) }), { ok: true });
  assert.equal(logged.length, 0);
  assert.equal(isAvailable(), true);
  delete process.env.GEMINI_API_KEY;
  assert.equal(isAvailable(), false);
});
