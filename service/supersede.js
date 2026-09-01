// supersede.js — fact supersession (Wave 1, 2026-09-01)
//
// When a fact changes, we never overwrite it silently. The current neuron is
// renamed and marked superseded (kept, retrievable for "what was it before"),
// and a fresh neuron takes over the name with the new content, linked by
// (new)-[:SUPERSEDES]->(old). Recall paths filter `n.superseded IS NULL`.

import { nsPredicate } from './namespaces.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Supersede the live neuron `name` in namespace `ns` with new content.
 * Returns true if a supersession happened, false if no live neuron matched.
 */
export async function supersedeNeuron({ runCypher, randomUUID, log, name, ns = null, flash, body, eventDate = null, reason = '' }) {
  const rows = await runCypher(`
    MATCH (n:Neuron {name: $name})
    WHERE ${nsPredicate('n')} AND n.superseded IS NULL
    RETURN n.node_type AS type, n.tier AS tier, n.flash_summary AS flash,
           coalesce(n.body,'') AS body, n.project AS project
    LIMIT 1
  `, { name, ns }).catch((e) => { log('error', 'warn', e.message); return []; });
  if (!rows.length) return false;
  const old = rows[0];

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const archivedName = `${name} (superseded ${stamp})`;

  await runCypher(`
    MATCH (n:Neuron {name: $name})
    WHERE ${nsPredicate('n')} AND n.superseded IS NULL
    SET n.name = $archivedName, n.superseded = true, n.superseded_at = datetime()
  `, { name, ns, archivedName }).catch((e) => log('error', 'warn', e.message));

  const validDate = typeof eventDate === 'string' && DATE_RE.test(eventDate) ? eventDate : null;
  await runCypher(`
    CREATE (n:Neuron {
      uid: $uid, name: $name, node_type: $type, tier: $tier,
      flash_summary: $flash, body: $body,
      source: 'supersession', decay_score: 50, base_score: 50,
      times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
      created_at: datetime(), last_surfaced: datetime(),
      project: $project, namespace: $ns,
      event_date: CASE WHEN $eventDate IS NULL THEN NULL ELSE date($eventDate) END
    })
  `, {
    uid: randomUUID(), name, type: old.type || 'fact', tier: old.tier || 'T2_working',
    flash: flash || old.flash, body: body || old.body,
    project: old.project || 'general', ns, eventDate: validDate
  }).catch((e) => log('error', 'warn', e.message));

  await runCypher(`
    MATCH (a:Neuron {name: $name})
    WHERE ${nsPredicate('a')} AND a.superseded IS NULL
    MATCH (b:Neuron {name: $archivedName})
    WHERE ${nsPredicate('b')}
    CREATE (a)-[:SUPERSEDES { reason: $reason, created_at: datetime() }]->(b)
  `, { name, ns, archivedName, reason: String(reason).slice(0, 300) }).catch((e) => log('error', 'warn', e.message));

  return true;
}
