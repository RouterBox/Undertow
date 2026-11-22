// chase.js — the reward a chase gives a neuron
//
// A chase is the strongest pursuit signal: +15 base_score (vs +10 for a normal
// pursuit) and +0.08 on the neuron's outbound synapses (vs +0.05). It lands in
// one namespace only (the live graph by default, or the calling client's own)
// and only on the current version of the neuron there: never on a held neuron
// or on a neuron of the same name in another namespace.

import { livePredicate } from './namespaces.js';

/**
 * Reward the named neuron in namespace `ns` (null = the live graph).
 * Returns true when it was rewarded, false when no such neuron exists there,
 * and null when the reward query itself failed (logged; not a "not found").
 */
export async function rewardChase({ runCypher, name, ns = null, log = () => {} }) {
  let rows;
  try {
    rows = await runCypher(`
      MATCH (n:Neuron {name: $name})
      WHERE ${livePredicate('n')}
      SET n.times_pursued = n.times_pursued + 1,
          n.base_score = CASE WHEN n.base_score + 15 > 100 THEN 100 ELSE n.base_score + 15 END,
          n.last_surfaced = datetime()
      RETURN n.name, n.base_score
    `, { name, ns });
  } catch (e) {
    log('error', 'warn', e.message);
    return null;
  }
  if (Array.isArray(rows) && rows.length === 0) return false;
  await runCypher(`
    MATCH (n:Neuron {name: $name})-[s:SYNAPSE]->()
    WHERE ${livePredicate('n')}
    SET s.weight = CASE WHEN s.weight + 0.08 > 0.95 THEN 0.95 ELSE s.weight + 0.08 END
  `, { name, ns }).catch(e => log('error', 'warn', e.message));
  return true;
}
