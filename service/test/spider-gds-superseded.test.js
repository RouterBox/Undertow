// Spider's GDS projection must survive a superseded neuron that still has edges.
//
// The text check runs everywhere. The projection check needs a real Neo4j with
// the GDS plugin: it runs when NEO4J_PASS is set (NEO4J_URI / NEO4J_USER as the
// service reads them) and is skipped otherwise. It works in a throwaway
// namespace and deletes what it created.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import neo4j from 'neo4j-driver';

import { recomputeGDS, GDS_NODE_QUERY, GDS_REL_QUERY } from '../daemons/spider.js';

test('the relationship query leaves out edges that touch a superseded neuron', () => {
  assert.match(GDS_NODE_QUERY, /n\.superseded IS NULL/);
  assert.match(GDS_REL_QUERY, /a\.superseded IS NULL AND b\.superseded IS NULL/);
});

const PASS = process.env.NEO4J_PASS;
const ns = `test-gds-${randomUUID().slice(0, 8)}`;
let driver;

async function connect() {
  if (!PASS) return null;
  const d = neo4j.driver(process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', PASS), { connectionTimeout: 3000 });
  try {
    await d.executeQuery('CALL gds.version()');
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

test('a projection with a superseded neuron that still has an edge does not fail', async (t) => {
  driver = await connect();
  if (!driver) return t.skip('no Neo4j with GDS reachable (set NEO4J_PASS to run)');

  const runCypher = async (q, p = {}) => (await driver.executeQuery(q, p)).records.map(r => r.toObject());
  // 12 live neurons in a ring, plus one superseded neuron still linked to the first.
  await runCypher(`
    UNWIND range(0, 11) AS i
    CREATE (:Neuron {name: $ns + '-n' + toString(i), namespace: $ns, flash_summary: 'x', body: 'x'})
  `, { ns });
  await runCypher(`
    MATCH (a:Neuron {namespace: $ns}), (b:Neuron {namespace: $ns})
    WHERE a.name = $ns + '-n' + toString(toInteger(substring(b.name, size($ns) + 2)) - 1)
    CREATE (a)-[:SYNAPSE {weight: 0.5}]->(b)
  `, { ns });
  await runCypher(`
    MATCH (a:Neuron {name: $ns + '-n0', namespace: $ns})
    CREATE (old:Neuron {name: $ns + '-old', namespace: $ns, superseded: true, flash_summary: 'x', body: 'x'})
    CREATE (old)-[:SYNAPSE {weight: 0.5}]->(a)
  `, { ns });

  const logs = [];
  await recomputeGDS(runCypher, (...a) => logs.push(a), ns);

  const warns = logs.filter(l => l[1] === 'warn').map(l => l[2]);
  assert.deepEqual(warns, [], 'no GDS step logged a warning');
  const scored = await runCypher(
    'MATCH (n:Neuron {namespace: $ns}) WHERE n.superseded IS NULL AND n.pagerank IS NOT NULL RETURN count(n) AS c', { ns });
  assert.equal(neo4j.integer.toNumber(scored[0].c), 12, 'every live neuron got a pagerank');
  const oldScored = await runCypher(
    'MATCH (n:Neuron {namespace: $ns, superseded: true}) RETURN n.pagerank AS pr', { ns });
  assert.equal(oldScored[0].pr, null, 'the superseded neuron was not projected');
});
