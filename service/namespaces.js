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
