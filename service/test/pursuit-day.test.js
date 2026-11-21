// PursuitDay: per-UTC-day pursuit/dismissal counters and the 30-day health window.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordPursuitDay, pursuitWindow, windowStart, ensurePursuitDayConstraint, WINDOW_DAYS, MIN_OUTCOMES } from '../pursuit-day.js';
import { applyVerdictToNeuron } from '../daemons/curated.js';
import { handleSummarize } from '../daemons/dreamer.js';

const DAY_RE = /MERGE \(day:PursuitDay \{date: \$date\}\)/;
const PURSUED_RE = /ON MATCH SET day\.pursued = coalesce\(day\.pursued, 0\) \+ 1/;
const DISMISSED_RE = /ON MATCH SET day\.dismissed = coalesce\(day\.dismissed, 0\) \+ 1/;

function recorder() {
  const calls = [];
  const logs = [];
  return {
    calls, logs,
    runCypher: async (q, p) => { calls.push({ q, p }); return []; },
    log: (...a) => logs.push(a),
    days: (re) => calls.filter(c => DAY_RE.test(c.q) && (!re || re.test(c.q)))
  };
}

// --- recordPursuitDay ---

test('record: one MERGE on the UTC day, pursued or dismissed', async () => {
  const r = recorder();
  const now = new Date('2026-11-21T23:30:00-05:00'); // already the 22nd in UTC
  await recordPursuitDay({ runCypher: r.runCypher, status: 'pursued', ns: null, log: r.log, now });
  await recordPursuitDay({ runCypher: r.runCypher, status: 'dismissed', ns: null, log: r.log, now });

  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map(c => c.p), [{ date: '2026-11-22' }, { date: '2026-11-22' }]);
  assert.match(r.calls[0].q, PURSUED_RE);
  assert.match(r.calls[0].q, /ON CREATE SET day\.pursued = 1, day\.dismissed = 0/);
  assert.match(r.calls[1].q, DISMISSED_RE);
  assert.match(r.calls[1].q, /ON CREATE SET day\.pursued = 0, day\.dismissed = 1/);
});

test('record: a namespaced session writes nothing; a failed write is logged, not thrown', async () => {
  const r = recorder();
  await recordPursuitDay({ runCypher: r.runCypher, status: 'pursued', ns: 'work', log: r.log });
  assert.equal(r.calls.length, 0);

  await recordPursuitDay({ runCypher: async () => { throw new Error('neo4j down'); }, status: 'pursued', ns: null, log: r.log });
  assert.ok(r.logs.some(l => l[0] === 'error' && l[1] === 'warn' && /neo4j down/.test(l[2])));
});

// --- direct feedback path ---

test('applyVerdictToNeuron: counts the day once per verdict on the live graph, never in a namespace', async () => {
  const r = recorder();
  await applyVerdictToNeuron({ runCypher: r.runCypher, name: 'N', ns: null, verdict: 'used', log: r.log });
  assert.equal(r.days().length, 1);
  assert.equal(r.days(PURSUED_RE).length, 1);

  await applyVerdictToNeuron({ runCypher: r.runCypher, name: 'N', ns: null, verdict: 'wrong', note: 'stale', log: r.log });
  assert.equal(r.days().length, 2);
  assert.equal(r.days(DISMISSED_RE).length, 1);

  await applyVerdictToNeuron({ runCypher: r.runCypher, name: 'N', ns: 'work', verdict: 'used', log: r.log });
  assert.equal(r.days().length, 2, 'namespaced verdict leaves PursuitDay alone');
});

// --- Dreamer ---

function dreamerHarness({ neurons, domains = {}, flashResults, namespace }) {
  const r = recorder();
  const session = {
    activeTopics: [],
    pendingFlashes: [{
      turn: Date.now(),
      flashes: neurons.map(n => `${n}: flash ${n}`),
      flashNeurons: neurons,
      sourceNeurons: neurons,
      neuronDomains: Object.fromEntries(neurons.map(n => [n, domains[n] !== false])),
      neuronDaemons: Object.fromEntries(neurons.map(n => [n, 'vector']))
    }]
  };
  const deps = {
    req_body: { session_id: 's1', ...(namespace ? { namespace } : {}) },
    session,
    runCypher: r.runCypher,
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: { content: [{ text: JSON.stringify({ insights: [], updates: [], train_of_thought: [], flash_results: flashResults }) }] }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: r.log
  };
  return { ...r, deps };
}

const results = [
  { flash_text: 'A: flash A', status: 'pursued' },
  { flash_text: 'B: flash B', status: 'dismissed' },
  { flash_text: 'C: flash C', status: 'dismissed' }
];

test('dreamer: one PursuitDay increment per applied outcome, none for a cross-project skip', async () => {
  const h = dreamerHarness({ neurons: ['A', 'B', 'C'], domains: { C: false }, flashResults: results });
  await handleSummarize(h.deps);

  assert.ok(h.calls.some(c => c.p?.name === 'A' && /times_pursued = n\.times_pursued \+ 1/.test(c.q)), 'A pursued');
  assert.ok(h.calls.some(c => c.p?.name === 'B' && /times_dismissed = n\.times_dismissed \+ 1/.test(c.q)), 'B dismissed');
  assert.ok(!h.calls.some(c => c.p?.name === 'C' && /times_dismissed/.test(c.q)), 'C skipped (cross-project)');
  assert.equal(h.days(PURSUED_RE).length, 1, 'A');
  assert.equal(h.days(DISMISSED_RE).length, 1, 'B only, not C');
  assert.equal(h.days().length, 2);
});

test('dreamer: a namespaced session applies outcomes but writes no PursuitDay', async () => {
  const h = dreamerHarness({ neurons: ['A', 'B', 'C'], flashResults: results, namespace: 'work' });
  await handleSummarize(h.deps);

  assert.ok(h.calls.some(c => c.p?.name === 'A' && c.p.ns === 'work' && /times_pursued/.test(c.q)), 'outcome still applied in-namespace');
  assert.equal(h.days().length, 0);
});

// --- health window ---

const NOW = new Date('2026-11-21T12:00:00Z');
const day = (date, pursued, dismissed) => ({ date, pursued, dismissed });

test('window: GRAPH_DYING under 0.5 once the window holds at least 20 outcomes', () => {
  assert.equal(MIN_OUTCOMES, 20);
  const w = pursuitWindow([day('2026-11-20', 2, 10), day('2026-11-21', 2, 6)], NOW);
  assert.deepEqual(w, { days: 30, pursued: 4, dismissed: 16, ratio: 0.25, status: 'GRAPH_DYING' });
});

test('window: silent below 20 outcomes, however bad the ratio', () => {
  const w = pursuitWindow([day('2026-11-21', 0, 19)], NOW);
  assert.equal(w.status, 'insufficient data');
  assert.equal(w.ratio, 0);
  assert.equal(pursuitWindow([], NOW).status, 'insufficient data');
});

test('window: healthy at or above 0.5, and when there are no dismissals at all', () => {
  assert.equal(pursuitWindow([day('2026-11-21', 10, 20)], NOW).status, 'HEALTHY'); // exactly 0.5
  assert.deepEqual(pursuitWindow([day('2026-11-21', 25, 0)], NOW), { days: 30, pursued: 25, dismissed: 0, ratio: null, status: 'HEALTHY' });
});

test('window: days older than 30 are ignored', () => {
  assert.equal(WINDOW_DAYS, 30);
  assert.equal(windowStart(NOW), '2026-10-23'); // 30 UTC days ending today
  const w = pursuitWindow([
    day('2024-11-21', 0, 5000), // two years of bad history
    day('2026-10-22', 0, 500),  // one day outside the window
    day('2026-10-23', 15, 5),   // first day inside
    day('2026-11-21', 5, 5)
  ], NOW);
  assert.deepEqual(w, { days: 30, pursued: 20, dismissed: 10, ratio: 2, status: 'HEALTHY' });
});

test('window: Neo4j integer objects are unwrapped', () => {
  const w = pursuitWindow([{ date: '2026-11-21', pursued: { low: 3, high: 0 }, dismissed: { low: 27, high: 0 } }], NOW);
  assert.equal(w.pursued, 3);
  assert.equal(w.dismissed, 27);
  assert.equal(w.status, 'GRAPH_DYING');
});

test('window: a failed query (null rows) is "unavailable", not "insufficient data"', () => {
  const w = pursuitWindow(null);
  assert.equal(w.status, 'unavailable');
  assert.equal(w.pursued, null);
  assert.equal(pursuitWindow([]).status, 'insufficient data');
});

test('constraint: created once with IF NOT EXISTS; a failure is logged, not thrown', async () => {
  const calls = [];
  await ensurePursuitDayConstraint({ runCypher: async (q) => { calls.push(q); return []; }, log: () => {} });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /CREATE CONSTRAINT pursuit_day_date IF NOT EXISTS FOR \(d:PursuitDay\) REQUIRE d\.date IS UNIQUE/);

  const logs = [];
  await ensurePursuitDayConstraint({ runCypher: async () => { throw new Error('duplicates exist'); }, log: (...a) => logs.push(a) });
  assert.ok(logs.some(l => l[1] === 'warn' && /duplicates exist/.test(l[2])));
});
