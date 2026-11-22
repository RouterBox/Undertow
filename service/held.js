// held.js — the held tier for what agent sessions write
//
// Insights Dreamer writes from an agent session go into the quarantine
// namespace, which every recall path already excludes: they are never flashed.
// A held neuron joins the live graph only when a human session uses it: a
// chase, or a used/useful feedback verdict, carrying that session's id.
// See docs/KEEPER.md, "Agent sessions".

/** The namespace held neurons live in (the same one observer ingest writes to). */
export const HELD_NAMESPACE = 'quarantine';

/** The only kinds of insight an agent session may write. */
export const DURABLE_KINDS = ['lesson', 'procedure', 'decision'];

/** node_type stored for each durable kind (node_type stays a closed vocabulary). */
const KIND_NODE_TYPE = { lesson: 'insight', procedure: 'insight', decision: 'decision' };

// Per-process counters (reset on restart), shown in GET /undertow/keeper.
// A log line per drop is not a measurement; these are.
const counters = {
  agentTurns: 0,          // agent-session turns Dreamer summarized
  zeroInsightTurns: 0,    // ...of which the model offered no insight at all
  insightsOffered: 0,     // insights the model offered from agent sessions
  droppedNoKind: 0,       // offered without a durable kind: not written
  skippedNameTaken: 0,    // offered, but a live or held neuron already has the name
  heldWritten: 0,         // written into the held tier
  released: 0,            // moved to the live graph by a human session
  releaseRefused: 0,      // release asked for and refused (no session, agent session, unknown session)
};

export function countHeld(key, n = 1) {
  if (key in counters) counters[key] += n;
}

export function heldCounters() {
  return { ...counters };
}

/**
 * The durable kind an agent-session insight declares, or null when it declares
 * none of the three. An insight with no durable kind is not written.
 */
export function durableKind(insight) {
  const k = typeof insight?.kind === 'string' ? insight.kind.trim().toLowerCase() : '';
  return DURABLE_KINDS.includes(k) ? k : null;
}

export function nodeTypeForKind(kind) {
  return KIND_NODE_TYPE[kind] || 'insight';
}

/** True when a current (non-superseded) held neuron has this name. */
export async function isHeld({ runCypher, name }) {
  const rows = await runCypher(
    `MATCH (n:Neuron {name: $name}) WHERE n.namespace = $held AND n.superseded IS NULL RETURN n.name AS name LIMIT 1`,
    { name, held: HELD_NAMESPACE }
  );
  return rows.length > 0;
}

/**
 * May this caller release a held neuron? Only a session the Keeper knows and
 * classes as human. No session id, an id the Keeper has never seen, or an
 * agent session: no. Returns { ok, reason }.
 * (The id is whatever the caller sent: this stops an agent releasing its own
 * insight through ordinary tool use, not a caller that forges a human id.)
 */
export function canRelease(keeper, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'no session_id: a held neuron is released only by a human session' };
  }
  if (!keeper.knows(sessionId)) {
    return { ok: false, reason: 'session_id is not a session the Keeper has seen' };
  }
  const { kind, why } = keeper.sessionKind(sessionId);
  if (kind !== 'human') return { ok: false, reason: `agent session (${why}): an agent cannot release a held neuron` };
  return { ok: true, reason: null };
}

/**
 * Move a held neuron into the live graph because a human session used it.
 * Identify it by `uid` (or a prefix of 8+ characters, as the held listing
 * shows) or by `name`. `by` says what did it: 'chase', 'feedback:used', ...
 * If a live neuron has taken the name since, the held one is released under
 * "<name> (held <uid8>)" so that it is never lost; the new name is returned.
 * The neuron is marked un-spidered so Spider links it on its next run: it has
 * no edges yet, because edges never cross a namespace boundary.
 * The caller embeds it (held neurons carry no embedding until release).
 * Returns { released: false } or { released: true, name, uid, flash_summary, renamed }.
 */
export async function releaseHeld({ runCypher, name = null, uid = null, by, log = () => {} }) {
  const rows = await runCypher(`
      MATCH (n:Neuron)
      WHERE n.namespace = $held AND n.superseded IS NULL
        AND ${uid ? 'toLower(n.uid) STARTS WITH $uid' : 'n.name = $name'}
      WITH n ORDER BY n.created_at LIMIT 1
      OPTIONAL MATCH (l:Neuron {name: n.name}) WHERE l.namespace IS NULL
      WITH n, n.name AS held_name, count(l) AS taken
      SET n.name = CASE WHEN taken > 0 THEN n.name + ' (held ' + substring(coalesce(n.uid, ''), 0, 8) + ')' ELSE n.name END,
          n.namespace = null, n.released_at = datetime(), n.released_by = $by, n.spidered = false
      RETURN n.name AS name, n.uid AS uid, n.flash_summary AS flash_summary, held_name
    `, { name, uid: uid ? String(uid).toLowerCase() : null, held: HELD_NAMESPACE, by });
  if (rows.length === 0) return { released: false };
  const r = rows[0];
  countHeld('released');
  log('keeper', 'info', `held neuron released to the live graph: ${r.name}`, { detail: `by ${by}` });
  return { released: true, name: r.name, uid: r.uid, flash_summary: r.flash_summary, renamed: r.name !== r.held_name };
}

/**
 * What is held, newest first. `name_taken` marks a held neuron whose name a
 * live neuron now has: release that one by uid.
 */
export async function listHeld({ runCypher, limit = 50 }) {
  const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const rows = await runCypher(`
      MATCH (n:Neuron)
      WHERE n.namespace = $held AND n.superseded IS NULL
      WITH n ORDER BY n.created_at DESC LIMIT toInteger($limit)
      OPTIONAL MATCH (l:Neuron {name: n.name}) WHERE l.namespace IS NULL
      WITH n, count(l) AS taken
      RETURN n.name AS name, n.uid AS uid, n.durable_kind AS durable_kind, n.node_type AS type,
             n.flash_summary AS flash_summary, n.origin_session AS origin_session,
             toString(n.created_at) AS created_at, taken > 0 AS name_taken
      ORDER BY created_at DESC
    `, { held: HELD_NAMESPACE, limit: lim });
  return rows;
}

export async function countHeldNeurons({ runCypher }) {
  const rows = await runCypher(
    `MATCH (n:Neuron) WHERE n.namespace = $held AND n.superseded IS NULL RETURN count(n) AS held`,
    { held: HELD_NAMESPACE }
  );
  const v = rows[0]?.held;
  return typeof v?.toNumber === 'function' ? v.toNumber() : Number(v || 0);
}
