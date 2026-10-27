// curated.js — pure helpers for the `curated` flash mode and explicit feedback.
//
// Kept free of I/O (except applyVerdictToNeuron, which takes runCypher) so the
// parser, formatter and verdict mapping can be unit-tested without Neo4j.

import { nsPredicate } from '../namespaces.js';

export const MAX_CURATED_PICKS = 4;
export const BODY_PREVIEW_CHARS = 300;
export const FEEDBACK_VERDICTS = ['used', 'useful', 'irrelevant', 'wrong'];

/**
 * Parse Haiku's curated selection.
 * Expected: {"selected":[{"n":<1-based candidate number>,"why":"..."}],"topics_detected":[...]}
 * Defensive: bad / duplicate / out-of-range numbers are ignored; at most `max` picks.
 * Returns { selected: [{n, why}], topics: string[], malformed: boolean }.
 * `malformed` = no parsable JSON object or `selected` is not an array (caller logs a warn).
 */
export function parseCuratedSelection(responseText, candidateCount, max = MAX_CURATED_PICKS) {
  const out = { selected: [], topics: [], malformed: false };
  let parsed = null;
  try {
    const m = String(responseText || '').match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.selected)) {
    out.malformed = true;
    return out;
  }
  if (Array.isArray(parsed.topics_detected)) {
    out.topics = parsed.topics_detected.filter((t) => typeof t === 'string' && t.trim()).slice(0, 10);
  }
  const seen = new Set();
  for (const item of parsed.selected) {
    const n = Number(item && typeof item === 'object' ? item.n : item);
    if (!Number.isInteger(n) || n < 1 || n > candidateCount || seen.has(n)) continue;
    seen.add(n);
    const why = item && typeof item.why === 'string' ? item.why.trim().substring(0, 120) : '';
    out.selected.push({ n, why });
    if (out.selected.length >= max) break;
  }
  return out;
}

/** Truncate a neuron body to a one-line preview (~300 chars). */
export function bodyPreview(body, max = BODY_PREVIEW_CHARS) {
  const s = String(body || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.substring(0, max).trimEnd()}...` : s;
}

/**
 * Build the injected block from the selected picks only.
 * picks: [{ type, name, flash, body?, uid?, why? }]
 * Contains no Cypher by design — exploration goes through the MCP tools.
 */
export function formatCuratedBlock(picks, totalCandidates, elapsedMs) {
  const lines = [`[UNDERTOW-FLASH] (${picks.length} selected from ${totalCandidates} candidates, ${elapsedMs}ms, curated)`];
  for (const p of picks) {
    lines.push(`  [${p.type || 'neuron'}] ${p.name}: ${p.flash}`);
    const body = bodyPreview(p.body);
    if (body) lines.push(`    body: ${body}`);
    const handle = p.uid ? `{name: ${JSON.stringify(p.name)}, uid: "${String(p.uid).substring(0, 8)}"}` : `{name: ${JSON.stringify(p.name)}}`;
    lines.push(`    handle: ${handle}`);
    if (p.why) lines.push(`    why: ${p.why}`);
  }
  lines.push('Explore any of these with the Undertow MCP tools: undertow_neighbors (connected neurons) or undertow_chase (follow a lead).');
  lines.push('Call undertow_feedback only when a neuron clearly helped or misled you (verdicts: used, useful, irrelevant, wrong).');
  return lines.join('\n');
}

/**
 * Map an explicit feedback verdict to a pursuit status for Dreamer.
 * used/useful => pursued; irrelevant => dismissed; wrong => dismissed + review flag.
 * Returns null for an unknown verdict.
 */
export function verdictToOutcome(verdict) {
  switch (verdict) {
    case 'used':
    case 'useful': return { status: 'pursued', flagReview: false };
    case 'irrelevant': return { status: 'dismissed', flagReview: false };
    case 'wrong': return { status: 'dismissed', flagReview: true };
    default: return null;
  }
}

/**
 * Flag a neuron for human review (never edits or deletes it).
 * Properties: needs_review, review_note, review_at.
 */
export async function flagNeuronForReview({ runCypher, name, ns, note, log }) {
  await runCypher(`
      MATCH (n:Neuron {name: $name})
      WHERE ${nsPredicate('n')} AND n.superseded IS NULL
      SET n.needs_review = true, n.review_note = $note, n.review_at = datetime()
    `, { name, note: note || '', ns: ns ?? null });
  log('feedback', 'warn', `neuron flagged for review (wrong): ${name}`, { detail: note || '' });
}

/**
 * Apply a verdict straight to a neuron when no session pursuit pass will see it.
 * Mirrors Dreamer's per-neuron effects in a deliberately small form:
 * pursued => times_pursued +1, base_score +10; dismissed => times_dismissed +1;
 * wrong additionally flags the neuron for review.
 */
export async function applyVerdictToNeuron({ runCypher, name, ns, verdict, note, log }) {
  const outcome = verdictToOutcome(verdict);
  if (!outcome) return null;
  const params = { name, ns: ns ?? null };
  if (outcome.status === 'pursued') {
    await runCypher(`
        MATCH (n:Neuron {name: $name})
        WHERE ${nsPredicate('n')} AND n.superseded IS NULL
        SET n.times_pursued = coalesce(n.times_pursued, 0) + 1,
            n.base_score = CASE WHEN coalesce(n.base_score, 0) + 10 > 100 THEN 100 ELSE coalesce(n.base_score, 0) + 10 END,
            n.last_surfaced = datetime()
      `, params);
  } else {
    await runCypher(`
        MATCH (n:Neuron {name: $name})
        WHERE ${nsPredicate('n')} AND n.superseded IS NULL
        SET n.times_dismissed = coalesce(n.times_dismissed, 0) + 1,
            n.last_surfaced = datetime()
      `, params);
  }
  if (outcome.flagReview) await flagNeuronForReview({ runCypher, name, ns, note, log });
  return outcome;
}
