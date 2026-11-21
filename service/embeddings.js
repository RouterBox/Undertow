/**
 * Embedding provider abstraction (configurable, added 2026-09-01).
 *
 * EMBEDDINGS_PROVIDER in service/.env selects the backend:
 *   gemini (default) — Google gemini-embedding-001, 3072 dims. Needs GEMINI_API_KEY.
 *   local            — @huggingface/transformers ONNX in-process, no API, no network
 *                      after first model download. Default model
 *                      Xenova/all-MiniLM-L6-v2 (384 dims); override with
 *                      EMBEDDINGS_LOCAL_MODEL.
 *
 * Local provider options:
 *   EMBEDDINGS_MODEL_DIR   — where models are cached / pre-staged
 *                            (<dir>/<model id>/...). Default service/.models.
 *                            Relative paths resolve from the service dir.
 *   EMBEDDINGS_OFFLINE     — true: load from EMBEDDINGS_MODEL_DIR only, never
 *                            download.
 *   EMBEDDINGS_REMOTE_HOST — download from this mirror instead of the
 *                            Hugging Face Hub.
 *
 * IMPORTANT: the Neo4j vector index is built for one dimension count. After
 * changing provider, run `node switch-embeddings.js` to rebuild the index and
 * re-embed all live neurons. Until then vector search will silently miss.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const LOCAL_DIMS = { 'Xenova/all-MiniLM-L6-v2': 384, 'Xenova/bge-small-en-v1.5': 384, 'Xenova/bge-base-en-v1.5': 768, 'Xenova/nomic-embed-text-v1': 768 };
// q8 = the quantized ONNX weights @xenova/transformers v2 loaded by default,
// so vectors stay compatible with ones already stored.
const LOCAL_DTYPE = 'q8';
export const LOCAL_EXPECTED_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

function providerName() {
  return (process.env.EMBEDDINGS_PROVIDER || 'gemini').toLowerCase();
}

// --- gemini backend ---
let genAI = null;
let geminiModel = null;
function getGeminiModel() {
  const key = process.env.GEMINI_API_KEY; // Read lazily so dotenv has time to load
  if (!geminiModel && key) {
    genAI = new GoogleGenerativeAI(key);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  }
  return geminiModel;
}

// --- local backend (transformers.js, lazy-loaded) ---

/** Resolve local-provider settings from env (pure). */
export function resolveLocalConfig(env = process.env) {
  return {
    model: env.EMBEDDINGS_LOCAL_MODEL || LOCAL_DEFAULT_MODEL,
    modelDir: env.EMBEDDINGS_MODEL_DIR ? resolve(SERVICE_DIR, env.EMBEDDINGS_MODEL_DIR) : join(SERVICE_DIR, '.models'),
    offline: /^(1|true|yes|on)$/i.test(env.EMBEDDINGS_OFFLINE || ''),
    remoteHost: env.EMBEDDINGS_REMOTE_HOST || null,
  };
}

/** Apply local-provider settings to a transformers.js `env` object. */
export function applyTransformersEnv(tenv, cfg) {
  // Same <dir>/<model id>/<file> layout for both: downloads land where a
  // pre-staged copy would be looked up, outside node_modules.
  tenv.cacheDir = cfg.modelDir;
  tenv.localModelPath = cfg.modelDir;
  tenv.allowLocalModels = true;
  tenv.allowRemoteModels = !cfg.offline;
  if (cfg.remoteHost) tenv.remoteHost = cfg.remoteHost.endsWith('/') ? cfg.remoteHost : cfg.remoteHost + '/';
  return tenv;
}

/** The loud, actionable message for a local model load failure. */
export function describeLocalLoadFailure(cfg, err) {
  const base = join(cfg.modelDir, ...cfg.model.split('/'));
  return [
    `LOCAL EMBEDDINGS UNAVAILABLE: could not load model "${cfg.model}" — vector search is disabled.`,
    `  cause: ${err?.message || err}`,
    `  model dir: ${cfg.modelDir} (offline: ${cfg.offline}, remote host: ${cfg.remoteHost || 'Hugging Face Hub'})`,
    `  expected files: ${LOCAL_EXPECTED_FILES.map((f) => join(base, f)).join(', ')}`,
    `  fix: allow downloads from the model host, set EMBEDDINGS_REMOTE_HOST to a mirror, or pre-stage the files above and set EMBEDDINGS_OFFLINE=true (EMBEDDINGS_MODEL_DIR changes the dir).`,
  ].join('\n');
}

let localExtractor = null;
let localLoading = null;
let localLoadError = null;
async function getLocalExtractor() {
  if (localExtractor) return localExtractor;
  if (!localLoading) {
    const cfg = resolveLocalConfig();
    localLoading = import('@huggingface/transformers')
      .then(async ({ pipeline, env }) => {
        applyTransformersEnv(env, cfg);
        localExtractor = await pipeline('feature-extraction', cfg.model, { dtype: LOCAL_DTYPE });
        return localExtractor;
      })
      .catch((e) => {
        localLoadError = describeLocalLoadFailure(cfg, e);
        throw new Error(localLoadError);
      });
  }
  return localLoading;
}

/**
 * Load the local model eagerly (call at startup). No-op for gemini.
 * Returns { ok, error? }; on failure logs one loud error and isAvailable()
 * reports false from then on.
 */
export async function initEmbeddings({ log = (msg) => console.error(msg) } = {}) {
  if (providerName() !== 'local') return { ok: true };
  try {
    await getLocalExtractor();
    return { ok: true };
  } catch {
    log(localLoadError);
    return { ok: false, error: localLoadError };
  }
}

/** Forget local model state (tests). */
export function _resetLocalEmbeddings() {
  localExtractor = null;
  localLoading = null;
  localLoadError = null;
}

/**
 * Get embedding for a text string. Returns an array of floats, or null.
 */
export async function getEmbedding(text) {
  try {
    if (providerName() === 'local') {
      if (localLoadError) return null; // already reported loudly
      const extractor = await getLocalExtractor();
      const out = await extractor(String(text), { pooling: 'mean', normalize: true });
      return Array.from(out.data);
    }
    const m = getGeminiModel();
    if (!m) return null;
    const result = await m.embedContent(text);
    return result.embedding.values;
  } catch (e) {
    console.error(`Embedding error (${providerName()}): ${e.message}`);
    return null;
  }
}

/** Sequential batch helper. */
export async function getEmbeddings(texts) {
  const results = [];
  for (const text of texts) results.push(await getEmbedding(text));
  return results;
}

export function isAvailable() {
  if (providerName() === 'local') return !localLoadError; // model downloads on first use
  return !!process.env.GEMINI_API_KEY;
}

/** Active provider metadata — the index must match `dims`. */
export function getProviderInfo() {
  if (providerName() === 'local') {
    const model = process.env.EMBEDDINGS_LOCAL_MODEL || LOCAL_DEFAULT_MODEL;
    return { provider: 'local', model, dims: LOCAL_DIMS[model] || 384 };
  }
  return { provider: 'gemini', model: 'gemini-embedding-001', dims: 3072 };
}

/** Embedding status for /health. */
export function getEmbeddingStatus() {
  const info = getProviderInfo();
  const status = { provider: info.provider, model: info.model, available: isAvailable() };
  if (info.provider === 'local' && localLoadError) status.error = localLoadError.split('\n')[0];
  return status;
}
