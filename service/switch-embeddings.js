#!/usr/bin/env node
/**
 * Rebuild the vector index and re-embed all LIVE neurons for the ACTIVE
 * embedding provider (set EMBEDDINGS_PROVIDER in .env first, then run this).
 *
 * Usage:
 *   node switch-embeddings.js            # rebuild index + re-embed live neurons
 *   node switch-embeddings.js --dry-run  # show what would happen
 *
 * Legacy/quarantine/benchmark namespaces are left untouched (their embeddings
 * become unreadable by the new index, which is fine — they're excluded from
 * recall anyway; re-run this after promoting anything back to live).
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import neo4j from 'neo4j-driver';
import { getEmbedding, getProviderInfo } from './embeddings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_PASS = process.env.NEO4J_PASS;
if (!NEO4J_PASS) { console.error('NEO4J_PASS not set'); process.exit(1); }
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', NEO4J_PASS));

async function runCypher(q, p = {}) {
  const s = driver.session();
  try { return (await s.run(q, p)).records.map((r) => r.toObject()); }
  finally { await s.close(); }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const info = getProviderInfo();
  console.log(`active provider: ${info.provider} (${info.model}, ${info.dims} dims)`);

  const count = await runCypher(`MATCH (n:Neuron) WHERE n.namespace IS NULL RETURN count(n) AS c`);
  const total = count[0].c.low ?? count[0].c;
  console.log(`live neurons to re-embed: ${total}`);
  if (dryRun) { await driver.close(); return; }

  console.log('rebuilding vector index...');
  await runCypher(`DROP INDEX neuron_embedding IF EXISTS`);
  await runCypher(`
    CREATE VECTOR INDEX neuron_embedding IF NOT EXISTS
    FOR (n:Neuron) ON (n.embedding)
    OPTIONS { indexConfig: { \`vector.dimensions\`: ${info.dims}, \`vector.similarity_function\`: 'cosine' } }
  `);

  const neurons = await runCypher(`
    MATCH (n:Neuron) WHERE n.namespace IS NULL
    RETURN n.name AS name, n.flash_summary AS flash, coalesce(n.body,'') AS body
  `);
  let done = 0, failed = 0;
  for (const n of neurons) {
    const text = `${n.name}. ${n.flash || ''} ${n.body}`.slice(0, 1500);
    const vec = await getEmbedding(text);
    if (vec) {
      await runCypher(`MATCH (n:Neuron {name: $name}) WHERE n.namespace IS NULL SET n.embedding = $v`, { name: n.name, v: Array.from(vec) });
      done++;
    } else failed++;
    if ((done + failed) % 100 === 0) {
      console.log(`  ${done + failed}/${neurons.length} (${failed} failed)`);
      if (info.provider === 'gemini') await new Promise((r) => setTimeout(r, 1500)); // pace free tier
    }
  }
  console.log(`done: ${done} re-embedded, ${failed} failed — index now ${info.dims}-dim ${info.provider}`);
  console.log('restart the Undertow service to pick up the provider for query-time embeds.');
  await driver.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
