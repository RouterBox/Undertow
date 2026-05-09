/**
 * Embedding helper — uses Gemini text-embedding-004 (free tier)
 * 768 dimensions, fast, good quality for semantic search
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let genAI = null;
let model = null;

function getModel() {
  const key = process.env.GEMINI_API_KEY; // Read lazily so dotenv has time to load
  if (!model && key) {
    genAI = new GoogleGenerativeAI(key);
    model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  }
  return model;
}

/**
 * Get embedding for a text string
 * Returns Float32Array of 768 dimensions, or null on failure
 */
export async function getEmbedding(text) {
  const m = getModel();
  if (!m) return null;

  try {
    const result = await m.embedContent(text);
    return result.embedding.values;
  } catch (e) {
    console.error(`Embedding error: ${e.message}`);
    return null;
  }
}

/**
 * Get embeddings for multiple texts sequentially
 * Returns array of embeddings (or nulls for failures)
 */
export async function getEmbeddings(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await getEmbedding(text));
  }
  return results;
}

export function isAvailable() {
  return !!process.env.GEMINI_API_KEY;
}
