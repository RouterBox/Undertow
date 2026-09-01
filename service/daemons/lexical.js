// lexical.js — BM25 lexical daemon (hybrid retrieval, added 2026-09-01)
//
// The 2026-09-01 retrieval eval showed a plain BM25 over neuron full text
// (name + flash + body) beating summary-only vector search on literal queries
// (Recall@8 0.735 vs 0.653). Hybrid = this daemon alongside the vector daemon;
// Impulse's existing dedup/domain/diversity pipeline does the fusion.
//
// In-memory index per namespace (null = live), rebuilt lazily every 5 minutes.

import { nsPredicate, livePredicate } from '../namespaces.js';

const STOP = new Set('the a an and or of to in on for with is are was were be it this that i we you my our as at by from not do does did can could would should about what how why when where which'.split(' '));
const TTL_MS = 5 * 60 * 1000;

const indexes = new Map(); // nsKey -> { docs, df, avgLen, builtAt }

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

async function ensureIndex(runCypher, ns) {
  const key = ns || '~live~';
  const existing = indexes.get(key);
  if (existing && Date.now() - existing.builtAt < TTL_MS) return existing;
  const rows = await runCypher(`
    MATCH (n:Neuron) WHERE ${livePredicate('n')}
    RETURN n.name AS name, n.flash_summary AS flash, coalesce(n.body,'') AS body
  `, { ns });
  const docs = rows.map((n) => {
    const tokens = tokenize(`${n.name} ${n.flash || ''} ${n.body}`);
    const tf = {};
    for (const w of tokens) tf[w] = (tf[w] || 0) + 1;
    return { name: n.name, tf, len: tokens.length };
  });
  const df = {};
  for (const d of docs) for (const w of Object.keys(d.tf)) df[w] = (df[w] || 0) + 1;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  const idx = { docs, df, avgLen, builtAt: Date.now() };
  indexes.set(key, idx);
  return idx;
}

function bm25(queryTokens, d, idx) {
  const N = idx.docs.length;
  let score = 0;
  for (const w of new Set(queryTokens)) {
    const f = d.tf[w];
    if (!f) continue;
    const idf = Math.log(1 + (N - idx.df[w] + 0.5) / (idx.df[w] + 0.5));
    score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / idx.avgLen));
  }
  return score;
}

/**
 * BM25 top candidates, decay-scored like the other daemons.
 * Returns [{ name, flash, type, score, daemon: 'lexical', community_id, project }]
 */
export async function lexicalSearch({ prompt, runCypher, k = 8, ns = null }) {
  const idx = await ensureIndex(runCypher, ns);
  if (!idx.docs || idx.docs.length === 0) return [];
  const qt = tokenize(String(prompt).slice(0, 1000));
  if (qt.length === 0) return [];

  const scored = idx.docs.map((d) => ({ name: d.name, bm25: bm25(qt, d, idx) }))
    .filter((s) => s.bm25 > 0)
    .sort((a, b) => b.bm25 - a.bm25)
    .slice(0, k * 2);
  if (scored.length === 0) return [];
  const maxBm25 = scored[0].bm25;

  const rows = await runCypher(`
    UNWIND $names AS nm
    MATCH (n:Neuron {name: nm}) WHERE ${livePredicate('n')}
    WITH n,
         CASE n.tier WHEN 'T1_index' THEN 0.005 WHEN 'T2_working' THEN 0.02 ELSE 0.05 END AS lambda,
         duration.between(n.last_surfaced, datetime()).days AS daysSince
    WITH n, n.base_score * exp(-lambda * daysSince) AS liveDecay
    WHERE liveDecay > 10
    RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
           n.community_id AS community_id, n.project AS project, liveDecay,
           toString(n.event_date) AS event_date
  `, { names: scored.map((s) => s.name), ns });

  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const out = [];
  for (const s of scored) {
    const r = byName[s.name];
    if (!r) continue;
    out.push({
      name: r.name, flash: r.flash, type: r.type,
      score: (s.bm25 / maxBm25) * (Number(r.liveDecay) / 100.0),
      daemon: 'lexical', community_id: r.community_id, project: r.project,
      event_date: r.event_date || null,
    });
    if (out.length >= k) break;
  }
  return out;
}
