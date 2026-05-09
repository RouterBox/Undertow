#!/usr/bin/env node
/**
 * Backfill embeddings for all neurons missing them.
 * Uses Gemini text-embedding-004 (free tier, 768 dims).
 *
 * Usage:
 *   node backfill-embeddings.js              # Backfill all missing
 *   node backfill-embeddings.js --dry-run    # Count how many need backfill
 *   node backfill-embeddings.js --batch 50   # Process N at a time (default 20)
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import neo4j from 'neo4j-driver';
import { getEmbeddings, isAvailable } from './embeddings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASS = process.env.NEO4J_PASS;
if (!NEO4J_PASS) {
  console.error('NEO4J_PASS not set. Copy service/.env.example to service/.env and configure it.');
  process.exit(1);
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));

async function runCypher(query, params = {}) {
  const session = driver.session();
  try {
    const result = await session.run(query, params);
    return result.records.map(r => r.toObject());
  } finally {
    await session.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const batchSize = parseInt(args[args.indexOf('--batch') + 1]) || 20;

  if (!isAvailable()) {
    console.error('GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  // Count neurons needing embeddings
  const missing = await runCypher(`
    MATCH (n:Neuron)
    WHERE n.embedding IS NULL
    RETURN count(n) AS count
  `);
  const total = missing[0]?.count?.low ?? missing[0]?.count ?? 0;
  console.log(`Neurons needing embeddings: ${total}`);

  if (dryRun || total === 0) {
    await driver.close();
    return;
  }

  let processed = 0;
  let failed = 0;

  while (processed < total) {
    // Fetch batch of neurons without embeddings
    const batch = await runCypher(`
      MATCH (n:Neuron)
      WHERE n.embedding IS NULL
      RETURN n.name AS name, n.flash_summary AS flash
      LIMIT $limit
    `, { limit: neo4j.int(batchSize) });

    if (batch.length === 0) break;

    const texts = batch.map(n => n.flash || n.name);
    console.log(`  Embedding batch ${Math.floor(processed / batchSize) + 1}: ${batch.length} neurons...`);

    const embeddings = await getEmbeddings(texts);

    for (let i = 0; i < batch.length; i++) {
      if (embeddings[i]) {
        await runCypher(
          'MATCH (n:Neuron {name: $name}) SET n.embedding = $embedding',
          { name: batch[i].name, embedding: Array.from(embeddings[i]) }
        );
        processed++;
      } else {
        failed++;
        console.log(`    Failed: ${batch[i].name}`);
      }
    }

    console.log(`  Progress: ${processed}/${total} (${failed} failed)`);

    // Rate limit: Gemini free tier has limits
    if (processed < total) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\nBackfill complete: ${processed} embedded, ${failed} failed`);
  await driver.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
