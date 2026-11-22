// agent-roster.js — ask a launcher which sessions it runs
//
// A launcher that starts agent sessions can publish a roster: a URL returning
// JSON that lists the sessions it runs. A session id on a roster is an agent
// session as a matter of fact, not an inference from how the session behaves.
// The Keeper asks here at Stop (see docs/KEEPER.md, "Agent sessions").
//
// Accepted shapes: {contexts: [...]}, {sessions: [...]} or a bare array. An
// entry counts when it has a string sessionId (or session_id) and, if it has a
// `kind` field, that kind is one of the accepted kinds.

const TIMEOUT_MS = 1500;
const CACHE_MS = 60_000;
const RETRY_MS = 5_000; // a refresh in which a roster did not answer is retried sooner

let cache = null; // { key, at, ids: Map<sessionId, label>, complete }
// The last answer each roster gave (key: kinds + url). When a refresh fails,
// its last good list still counts: a session a launcher listed a minute ago is
// still that launcher's while the launcher restarts.
const lastGood = new Map();

function entriesOf(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.contexts)) return body.contexts;
  if (Array.isArray(body?.sessions)) return body.sessions;
  return null;
}

async function fetchRoster(url, kinds, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const entries = entriesOf(await res.json());
    if (!entries) return null;
    const ids = new Map();
    for (const e of entries) {
      const id = e?.sessionId ?? e?.session_id;
      if (typeof id !== 'string' || !id) continue;
      if (e.kind !== undefined && !kinds.includes(e.kind)) continue;
      ids.set(id, typeof e.name === 'string' && e.name ? e.name : 'roster');
    }
    return ids;
  } catch {
    return null; // down, slow or not JSON: this roster did not answer
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this session on a launcher's roster? Never throws.
 *   { status: 'agent', label }  — the id is on a roster
 *   { status: 'not-listed' }    — every roster answered and none lists the id
 *   { status: 'unknown' }       — no roster configured, or one did not answer
 * The combined id set is cached for 60s (5s when a roster did not answer);
 * each roster gets 1.5s to answer. A roster that does not answer keeps
 * counting with its last good list, so 'unknown' is only for an id that list
 * does not have, or when there never was one.
 */
export async function lookupAgent(sessionId, { urls = [], kinds = ['spawned'], fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const list = (Array.isArray(urls) ? urls : []).filter(u => typeof u === 'string' && u);
  if (!list.length || typeof fetchImpl !== 'function') return { status: 'unknown' };
  const accepted = Array.isArray(kinds) ? kinds : ['spawned'];
  const key = JSON.stringify([list, accepted]);
  if (!cache || cache.key !== key || now() - cache.at >= (cache.complete ? CACHE_MS : RETRY_MS)) {
    const results = await Promise.all(list.map(u => fetchRoster(u, accepted, fetchImpl)));
    const ids = new Map();
    list.forEach((u, i) => {
      const goodKey = JSON.stringify([accepted, u]);
      if (results[i]) lastGood.set(goodKey, results[i]);
      for (const [id, label] of results[i] || lastGood.get(goodKey) || []) ids.set(id, label);
    });
    cache = { key, at: now(), ids, complete: results.every(Boolean) };
  }
  if (cache.ids.has(sessionId)) return { status: 'agent', label: cache.ids.get(sessionId) };
  return { status: cache.complete ? 'not-listed' : 'unknown' };
}

/** Test hook: forget the cached roster (and, unless told to keep them, the last good lists). */
export function resetRosterCache({ keepLastGood = false } = {}) {
  cache = null;
  if (!keepLastGood) lastGood.clear();
}
