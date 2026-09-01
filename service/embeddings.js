/**
 * Embedding provider abstraction (configurable, added 2026-09-01).
 *
 * EMBEDDINGS_PROVIDER in service/.env selects the backend:
 *   gemini (default) — Google gemini-embedding-001, 3072 dims. Needs GEMINI_API_KEY.
 *   local            — @xenova/transformers ONNX in-process, no API, no network
 *                      after first model download. Default model
 *                      Xenova/all-MiniLM-L6-v2 (384 dims); override with
 *                      EMBEDDINGS_LOCAL_MODEL.
 *
 * IMPORTANT: the Neo4j vector index is built for one dimension count. After
 * changing provider, run `node switch-embeddings.js` to rebuild the index and
 * re-embed all live neurons. Until then vector search will silently miss.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const LOCAL_DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const LOCAL_DIMS = { 'Xenova/all-MiniLM-L6-v2': 384, 'Xenova/bge-small-en-v1.5': 384, 'Xenova/bge-base-en-v1.5': 768, 'Xenova/nomic-embed-text-v1': 768 };

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
let localExtractor = null;
let localLoading = null;
async function getLocalExtractor() {
  if (localExtractor) return localExtractor;
  if (!localLoading) {
    localLoading = import('@xenova/transformers').then(async ({ pipeline }) => {
      const model = process.env.EMBEDDINGS_LOCAL_MODEL || LOCAL_DEFAULT_MODEL;
      localExtractor = await pipeline('feature-extraction', model);
      return localExtractor;
    });
  }
  return localLoading;
}

/**
 * Get embedding for a text string. Returns an array of floats, or null.
 */
export async function getEmbedding(text) {
  try {
    if (providerName() === 'local') {
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
  if (providerName() === 'local') return true; // model downloads on first use
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
