// held.js — the held tier for what agent sessions write
//
// Insights Dreamer writes from an agent session go into the quarantine
// namespace, which every recall path already excludes: they are never flashed.
// A held neuron joins the live graph only when something uses it: a chase, or
// a used/useful feedback verdict. See docs/KEEPER.md, "Agent sessions".

/** The namespace held neurons live in (the same one observer ingest writes to). */
export const HELD_NAMESPACE = 'quarantine';

/** The only kinds of insight an agent session may write. */
export const DURABLE_KINDS = ['lesson', 'procedure', 'decision'];

/** node_type stored for each durable kind (node_type stays a closed vocabulary). */
const KIND_NODE_TYPE = { lesson: 'insight', procedure: 'insight', decision: 'decision' };

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
 * Move a held neuron into the live graph because something used it.
 * `by` says what did: 'chase' or 'feedback:used' / 'feedback:useful'.
 * Nothing moves when no held neuron has that name, or when a live neuron
 * already has it (two live neurons must not share a name).
 * The neuron is marked un-spidered so Spider links it on its next run: it has
 * no edges yet, because edges never cross a namespace boundary.
 * Returns true when a neuron was released.
 */
export async function releaseHeld({ runCypher, name, by, log = () => {} }) {
  const rows = await runCypher(`
      MATCH (n:Neuron {name: $name})
      WHERE n.namespace = $held AND n.superseded IS NULL
        AND NOT EXISTS {
          MATCH (l:Neuron {name: $name}) WHERE l.namespace IS NULL AND l.superseded IS NULL
        }
      WITH n LIMIT 1
      SET n.namespace = null, n.released_at = datetime(), n.released_by = $by, n.spidered = false
      RETURN n.name AS name
    `, { name, held: HELD_NAMESPACE, by });
  const released = rows.length > 0;
  if (released) log('keeper', 'info', `held neuron released to the live graph: ${name}`, { detail: `by ${by}` });
  return released;
}
