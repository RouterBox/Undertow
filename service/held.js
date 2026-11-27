// held.js — the held tier for what agent sessions write
//
// Insights Dreamer writes from an agent session go into the quarantine
// namespace, which every recall path already excludes: they are never flashed.
// A held neuron joins the live graph only when a human session uses it: a
// chase, or a used/useful feedback verdict, carrying that session's id.
// See docs/KEEPER.md, "Agent sessions".

import { supersedeNeuron } from './supersede.js';

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
  skippedEcho: 0,         // offered, but it restates a neuron injected into the same session minutes before
  heldWritten: 0,         // written into the held tier
  heldOnUnknownTurns: 0,  // ...turns held because a launcher roster did not answer (the session may be a person's)
  heldOnUnknownInsights: 0,    // ...insights of any kind held from such turns
  heldUpdates: 0,              // ...updates to existing neurons such turns offered: held as carriers, applied on release
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

/** Name of the held carrier for an update to `target` (unique, and says what it is). */
export function heldUpdateName(target, uid) {
  return `Update: ${target} (${String(uid).slice(0, 8)})`;
}

/**
 * The connections an insight offered, as a JSON string to keep on a held
 * neuron (edges cannot cross into the live graph until release), or null
 * when there is nothing usable. `targetOf` reads a connection's target.
 */
export function packConnections(connections, targetOf, selfName) {
  if (!Array.isArray(connections)) return null;
  const out = [];
  for (const c of connections) {
    const target = targetOf(c);
    if (!target || target === selfName) continue;
    out.push({ target, weight: typeof c.weight === 'number' ? c.weight : 0.5, edge_type: c.edge_type || 'associative', context: String(c.context || '').slice(0, 300) });
  }
  return out.length ? JSON.stringify(out) : null;
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
 * May this caller release a held neuron? Only a session that is known to be a
 * person's, which takes all of:
 *   - a session id, with a ledger entry that real hook traffic made (an entry
 *     created by a bare POST does not qualify);
 *   - a launcher roster is configured, answered, and does not list the session
 *     (asked on every path, also for a session declared human: a roster's fact
 *     beats a declaration, and when no roster is configured nobody can vouch
 *     that the caller is not an agent, so nothing is released);
 *   - the session is not an agent by declaration or by its cwd (the request's
 *     cwd when given, else the one in the ledger).
 * Returns { ok, reason }.
 * (The id is whatever the caller sent. This stops an agent releasing its own
 * insight through ordinary tool use; a caller on the loopback interface that
 * sends a person's session id, or forges hook payloads, is not stopped.)
 */
export async function canRelease(keeper, sessionId, { cwd = null, fetchImpl } = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'no session_id: a held neuron is released only by a human session' };
  }
  if (!keeper.knows(sessionId)) {
    return { ok: false, reason: 'session_id is not a session the Keeper has seen' };
  }
  if (!keeper.fromHooks(sessionId)) {
    return { ok: false, reason: 'no hook traffic has been seen for this session_id: a held neuron is released only by a session whose hooks reach Undertow' };
  }
  const roster = await keeper.askRoster(sessionId, fetchImpl);
  if (roster === 'none') {
    return { ok: false, reason: 'no launcher roster is configured (keeper.agentRosters), so no session can be confirmed as human: held neurons cannot be released through this endpoint' };
  }
  if (roster === 'agent' || roster === 'flagged') {
    return { ok: false, reason: 'agent session (a launcher roster lists it): an agent cannot release a held neuron' };
  }
  if (roster === 'unknown') {
    return { ok: false, reason: 'a launcher roster did not answer, so this session cannot be confirmed as human: try again' };
  }
  const { kind, why } = keeper.sessionKind(sessionId, cwd);
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
export async function releaseHeld({ runCypher, name = null, uid = null, by, log = () => {}, randomUUID = null }) {
  const match = `MATCH (n:Neuron)
      WHERE n.namespace = $held AND n.superseded IS NULL
        AND ${uid ? 'toLower(n.uid) STARTS WITH $uid' : 'n.name = $name'}
      WITH n ORDER BY n.created_at LIMIT 1`;
  const params = { name, uid: uid ? String(uid).toLowerCase() : null, held: HELD_NAMESPACE, by };

  // A held UPDATE (from a turn of unknown origin) is not a neuron of its own:
  // releasing it applies it, as the usual supersession of its live target, and
  // the carrier is removed. If the target is gone, the carrier is released as
  // an ordinary neuron below, so its text is still not lost.
  const found = await runCypher(`${match}
      RETURN n.uid AS uid, n.held_update_of AS target, n.flash_summary AS flash_summary, n.body AS body,
             n.held_update_reason AS reason, n.held_update_event_date AS event_date`, params);
  const carrier = Array.isArray(found) ? found[0] : null;
  if (carrier?.target && typeof randomUUID === 'function') {
    const applied = await supersedeNeuron({
      runCypher, randomUUID, log, name: carrier.target, ns: null,
      flash: carrier.flash_summary, body: carrier.body,
      eventDate: carrier.event_date || null, reason: carrier.reason || 'held update released'
    });
    if (applied) {
      await runCypher(`MATCH (n:Neuron {uid: $uid}) WHERE n.namespace = $held DETACH DELETE n`, { uid: carrier.uid, held: HELD_NAMESPACE });
      countHeld('released');
      log('keeper', 'info', `held update applied to the live graph: ${carrier.target}`, { detail: `by ${by}` });
      return { released: true, name: carrier.target, uid: carrier.uid, flash_summary: carrier.flash_summary, renamed: false, applied_update_to: carrier.target, connections_created: 0 };
    }
  }

  const rows = await runCypher(`${match}
      OPTIONAL MATCH (l:Neuron {name: n.name}) WHERE l.namespace IS NULL
      WITH n, n.name AS held_name, n.held_connections AS held_connections, count(l) AS taken
      SET n.name = CASE WHEN taken > 0 THEN n.name + ' (held ' + substring(coalesce(n.uid, ''), 0, 8) + ')' ELSE n.name END,
          n.namespace = null, n.released_at = datetime(), n.released_by = $by, n.spidered = false
      REMOVE n.held_connections
      RETURN n.name AS name, n.uid AS uid, n.flash_summary AS flash_summary, held_name, held_connections
    `, params);
  if (rows.length === 0) return { released: false };
  const r = rows[0];

  // The connections it offered when it was held: made now, to targets that
  // exist in the live graph. (Spider links it as well, on its next run.)
  let connectionsCreated = 0;
  let conns = [];
  try { conns = r.held_connections ? JSON.parse(r.held_connections) : []; } catch { conns = []; }
  for (const c of Array.isArray(conns) ? conns : []) {
    if (!c?.target || c.target === r.name) continue;
    const linked = await runCypher(`
        MATCH (src:Neuron {uid: $uid}) WHERE src.namespace IS NULL AND src.superseded IS NULL
        MATCH (tgt:Neuron {name: $tgt}) WHERE tgt.namespace IS NULL AND tgt.superseded IS NULL
        CREATE (src)-[:SYNAPSE { weight: $weight, edge_type: $edgeType, context: $context, created_at: datetime() }]->(tgt)
        RETURN tgt.name AS linked
      `, { uid: r.uid, tgt: c.target, weight: typeof c.weight === 'number' ? c.weight : 0.5, edgeType: c.edge_type || 'associative', context: c.context || '' })
      .catch(e => { log('error', 'warn', e.message); return []; });
    if (Array.isArray(linked) && linked.length > 0) connectionsCreated++;
  }

  countHeld('released');
  log('keeper', 'info', `held neuron released to the live graph: ${r.name}`, { detail: `by ${by}` });
  return {
    released: true, name: r.name, uid: r.uid, flash_summary: r.flash_summary, renamed: r.name !== r.held_name,
    connections_created: connectionsCreated,
    ...(carrier?.target ? { update_target_missing: carrier.target } : {})
  };
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
             n.flash_summary AS flash_summary, n.origin_session AS origin_session, n.origin_kind AS origin_kind,
             n.held_update_of AS update_of,
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
