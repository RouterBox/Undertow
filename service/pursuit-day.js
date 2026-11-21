// pursuit-day.js — per-UTC-day pursuit/dismissal counters and the health window.
//
// Neuron.times_pursued / times_dismissed are all-time totals, so a ratio built
// from them can never recover from old history. Each applied outcome is also
// counted on a (:PursuitDay {date: 'YYYY-MM-DD'}) node; GET /undertow/health
// reads the last WINDOW_DAYS of them.

export const WINDOW_DAYS = 30;
export const MIN_OUTCOMES = 20; // below this the window is too thin to alert on

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (d) => d.toISOString().slice(0, 10);

/** First UTC day (inclusive) of the window that ends today. */
export function windowStart(now = new Date()) {
  return utcDay(new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS));
}

/**
 * Count one applied outcome ('pursued' | 'dismissed') on today's PursuitDay.
 * Live graph only: a namespaced session writes nothing. Errors are logged, not thrown.
 */
export async function recordPursuitDay({ runCypher, status, ns, log, now = new Date() }) {
  if (ns) return;
  const date = utcDay(now);
  if (status === 'pursued') {
    await runCypher(`
        MERGE (day:PursuitDay {date: $date})
        ON CREATE SET day.pursued = 1, day.dismissed = 0
        ON MATCH SET day.pursued = coalesce(day.pursued, 0) + 1
      `, { date }).catch(e => log('error', 'warn', e.message));
  } else {
    await runCypher(`
        MERGE (day:PursuitDay {date: $date})
        ON CREATE SET day.pursued = 0, day.dismissed = 1
        ON MATCH SET day.dismissed = coalesce(day.dismissed, 0) + 1
      `, { date }).catch(e => log('error', 'warn', e.message));
  }
}

// Neo4j integers arrive as {low, high}.
const num = (v) => (v && typeof v === 'object' ? v.low : Number(v)) || 0;

/**
 * Sum PursuitDay rows ({date, pursued, dismissed}) that fall inside the window.
 * status: 'insufficient data' (fewer than MIN_OUTCOMES outcomes), 'GRAPH_DYING'
 * (ratio < 0.5) or 'HEALTHY'. ratio is null when the window holds no dismissals.
 */
export function pursuitWindow(rows, now = new Date()) {
  const since = windowStart(now);
  const today = utcDay(now);
  let pursued = 0;
  let dismissed = 0;
  for (const r of rows || []) {
    if (!(r.date >= since && r.date <= today)) continue;
    pursued += num(r.pursued);
    dismissed += num(r.dismissed);
  }
  const ratio = dismissed > 0 ? pursued / dismissed : null;
  const status = pursued + dismissed < MIN_OUTCOMES ? 'insufficient data'
    : ratio !== null && ratio < 0.5 ? 'GRAPH_DYING' : 'HEALTHY';
  return { days: WINDOW_DAYS, pursued, dismissed, ratio, status };
}
