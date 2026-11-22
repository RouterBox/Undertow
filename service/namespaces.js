// namespaces.js — namespace isolation helpers (added 2026-09-01)
//
// A namespace is an isolated sub-graph inside the one Neo4j database.
// NULL namespace = the live graph. A client agent may declare a namespace in
// any hook payload ({ "namespace": "work" }); every daemon read and write must
// then stay inside that namespace. Daemons default to the live graph and must
// never create edges, delete nodes, or surface memories across the boundary.

/** Cypher predicate: node `alias` belongs to namespace $ns (NULL = live). */
export function nsPredicate(alias) {
  return `(($ns IS NULL AND ${alias}.namespace IS NULL) OR ${alias}.namespace = $ns)`;
}

/**
 * Recall predicate: node `alias` is in namespace $ns AND is the current
 * (non-superseded) version. Use on every read path that surfaces memories;
 * write/maintenance paths that must see archived versions use nsPredicate.
 */
export function livePredicate(alias) {
  return `(${nsPredicate(alias)} AND ${alias}.superseded IS NULL)`;
}

/** Sanitize a client-supplied namespace. Returns a clean string or null (live). */
export function sanitizeNamespace(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s) ? s : null;
}

// --- Reserved namespaces ---
//
// A deployment can reserve namespaces (config `reservedNamespaces`): sub-graphs
// it keeps for its own use that no client may name. A request naming one is
// refused; it is never redirected to the live graph.

let reserved = new Set();

/** Set the reserved namespaces (from config, at startup). */
export function setReservedNamespaces(list) {
  reserved = new Set((Array.isArray(list) ? list : []).map(sanitizeNamespace).filter(Boolean));
}

/** True unless `v` names a reserved namespace. The live graph (null) is always allowed. */
export function namespaceAllowed(v) {
  const ns = sanitizeNamespace(v);
  return ns === null || !reserved.has(ns);
}

// Hook routes: Claude Code ignores an error body there, so a refused request
// gets an empty result (nothing read, nothing written) instead of a 403.
export const HOOK_ROUTES = Object.freeze([
  '/undertow/query', '/undertow/session-start', '/undertow/ingest',
  '/undertow/summarize', '/undertow/rehydrate',
]);

/**
 * Express middleware: refuse any request whose body or query names a reserved
 * namespace, before a route can read or write it. Mount after the JSON body
 * parser. `ready` is an optional promise to await first (config still loading).
 */
export function reservedNamespaceGuard({ log = () => {}, ready = null } = {}) {
  return async function guard(req, res, next) {
    if (ready) await ready;
    const named = [req.body?.namespace, req.query?.namespace].find(v => !namespaceAllowed(v));
    if (named === undefined) return next();
    const ns = sanitizeNamespace(named);
    log('namespace', 'warn', `refused: ${req.method} ${req.path} named reserved namespace "${ns}"`);
    if (HOOK_ROUTES.includes(req.path)) return res.json({});
    return res.status(403).json({ error: `namespace "${ns}" is reserved on this deployment and cannot be named by a client` });
  };
}
