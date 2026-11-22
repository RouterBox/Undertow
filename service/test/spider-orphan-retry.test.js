// Spider retries a neuron that was marked spidered but never got an edge.
//
// Runs the real selection query against a real Neo4j, in a throwaway namespace
// that is deleted afterwards. Needs NEO4J_PASS (NEO4J_URI / NEO4J_USER as the
// service reads them); skipped when no database is reachable.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import neo4j from 'neo4j-driver';

import { findUnspidered, ORPHAN_RETRY_DAYS } from '../daemons/spider.js';

const PASS = process.env.NEO4J_PASS;
const ns = `test-orphan-${randomUUID().slice(0, 8)}`;
let driver;

async function connect() {
  if (!PASS) return null;
  const d = neo4j.driver(process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', PASS), { connectionTimeout: 3000 });
  try {
    await d.executeQuery('RETURN 1');
    return d;
  } catch {
    await d.close();
    return null;
  }
}

after(async () => {
  if (!driver) return;
  await driver.executeQuery('MATCH (n:Neuron {namespace: $ns}) DETACH DELETE n', { ns });
  await driver.close();
});

test('selection: never-spidered first, then stale orphans; fresh orphans and connected neurons are left alone', async (t) => {
  driver = await connect();
  if (!driver) return t.skip('no Neo4j reachable (set NEO4J_PASS to run)');
  const runCypher = async (q, p = {}) => (await driver.executeQuery(q, p)).records.map(r => r.toObject());

  const stale = ORPHAN_RETRY_DAYS + 1;
  await runCypher(`
    CREATE (:Neuron {name: 'never',          namespace: $ns, created_at: datetime()})
    CREATE (:Neuron {name: 'orphan-stale',   namespace: $ns, spidered: true, spidered_at: datetime() - duration({days: $stale}), created_at: datetime()})
    CREATE (:Neuron {name: 'orphan-staler',  namespace: $ns, spidered: true, spidered_at: datetime() - duration({days: $stale + 30}), created_at: datetime()})
    CREATE (:Neuron {name: 'orphan-undated', namespace: $ns, spidered: true, created_at: datetime()})
    CREATE (:Neuron {name: 'orphan-fresh',   namespace: $ns, spidered: true, spidered_at: datetime() - duration({days: 1}), created_at: datetime()})
    CREATE (:Neuron {name: 'orphan-archived', namespace: $ns, spidered: true, superseded: true, spidered_at: datetime() - duration({days: $stale}), created_at: datetime()})
    CREATE (a:Neuron {name: 'linked-a', namespace: $ns, spidered: true, spidered_at: datetime() - duration({days: $stale}), created_at: datetime()})
    CREATE (b:Neuron {name: 'linked-b', namespace: $ns, spidered: true, spidered_at: datetime() - duration({days: $stale}), created_at: datetime()})
    CREATE (a)-[:SYNAPSE {weight: 0.5}]->(b)
  `, { ns, stale });

  const picked = (await findUnspidered({ runCypher, ns })).map(r => r.name);

  assert.equal(picked[0], 'never', 'a never-spidered neuron comes first');
  assert.ok(picked.includes('orphan-stale'), 'a zero-edge neuron spidered over a week ago is retried');
  assert.ok(picked.includes('orphan-staler'));
  assert.ok(picked.includes('orphan-undated'), 'a zero-edge neuron with no spidered_at is retried');
  assert.ok(picked.indexOf('orphan-staler') < picked.indexOf('orphan-stale'), 'longest-waiting orphan first');
  assert.ok(!picked.includes('orphan-fresh'), 'an orphan spidered yesterday waits');
  assert.ok(!picked.includes('orphan-archived'), 'a superseded neuron is never picked');
  assert.ok(!picked.includes('linked-a') && !picked.includes('linked-b'), 'a neuron with an edge is not retried');
  assert.equal(picked.length, 4);
});

test('a retried orphan that gets marked again drops out until the next window', async (t) => {
  if (!driver) return t.skip('no Neo4j reachable (set NEO4J_PASS to run)');
  const runCypher = async (q, p = {}) => (await driver.executeQuery(q, p)).records.map(r => r.toObject());
  // What Spider does at the end of a pass over a neuron.
  await runCypher(`MATCH (n:Neuron {name: 'orphan-stale', namespace: $ns}) SET n.spidered = true, n.spidered_at = datetime()`, { ns });
  const picked = (await findUnspidered({ runCypher, ns })).map(r => r.name);
  assert.ok(!picked.includes('orphan-stale'), 'no retry storm: one pass per window');
  assert.ok(picked.includes('orphan-staler'));
});
