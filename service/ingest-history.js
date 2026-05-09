#!/usr/bin/env node
/**
 * Historical Ingestion Script (M6)
 *
 * Processes Claude Code JSONL session files into Undertow neurons.
 * Usage:
 *   node ingest-history.js                    # Process top sessions by size
 *   node ingest-history.js --max-sessions 10  # Limit number of sessions
 *   node ingest-history.js --session <id>     # Process a specific session
 *   node ingest-history.js --dry-run          # Show what would be processed
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir, readFile, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import neo4j from 'neo4j-driver';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASS = process.env.NEO4J_PASS;
if (!NEO4J_PASS) {
  console.error('NEO4J_PASS not set. Copy service/.env.example to service/.env and configure it.');
  process.exit(1);
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const STATE_FILE = join(__dirname, '.ingest-history-state.json');

// --- Helpers ---

async function runCypher(query, params = {}) {
  const session = driver.session();
  try {
    const result = await session.run(query, params);
    return result.records.map(r => r.toObject());
  } finally {
    await session.close();
  }
}

async function callHaiku(system, user) {
  try {
    const msg = await anthropic.messages.create({
      model: MODEL, max_tokens: 800, system,
      messages: [{ role: 'user', content: user }]
    });
    return msg.content[0]?.text || '{}';
  } catch (e) {
    console.error(`  API error: ${e.message}`);
    if (e.status === 529 || e.status === 429) {
      console.log('  Rate limited, waiting 5s...');
      await new Promise(r => setTimeout(r, 5000));
      return callHaiku(system, user); // Retry once
    }
    return '{}';
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { processedSessions: [] };
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Find session files ---

async function findSessions() {
  const claudeDir = join(homedir(), '.claude', 'projects');
  const sessions = [];

  try {
    const projects = await readdir(claudeDir);
    for (const project of projects) {
      const projectDir = join(claudeDir, project);
      try {
        const files = await readdir(projectDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = join(projectDir, file);
          const fileStat = await stat(filePath);
          sessions.push({
            id: file.replace('.jsonl', ''),
            path: filePath,
            project,
            size: fileStat.size,
            modified: fileStat.mtime
          });
        }
      } catch {}
    }
  } catch (e) {
    console.error(`Could not read ${claudeDir}: ${e.message}`);
  }

  // Sort by size descending (biggest sessions = most content)
  sessions.sort((a, b) => b.size - a.size);
  return sessions;
}

// --- Process a single session ---

async function processSession(session) {
  console.log(`\n  Processing: ${session.id}`);
  console.log(`  Project: ${session.project}`);
  console.log(`  Size: ${(session.size / 1024).toFixed(1)} KB`);

  const content = await readFile(session.path, 'utf8');
  const lines = content.trim().split('\n');

  // Parse JSONL — extract user/assistant message pairs
  const turns = [];
  let currentTurn = { user: '', assistant: '', tools: [] };

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'human' || msg.role === 'user') {
        if (currentTurn.user && currentTurn.assistant) {
          turns.push({ ...currentTurn });
          currentTurn = { user: '', assistant: '', tools: [] };
        }
        const text = typeof msg.message === 'string' ? msg.message :
                     (msg.message?.content || msg.content || '');
        if (typeof text === 'string') currentTurn.user = text.substring(0, 500);
      } else if (msg.type === 'assistant' || msg.role === 'assistant') {
        const text = typeof msg.message === 'string' ? msg.message :
                     (msg.message?.content?.[0]?.text || msg.content?.[0]?.text || msg.content || '');
        if (typeof text === 'string') currentTurn.assistant += text.substring(0, 500);
      } else if (msg.type === 'tool_result' || msg.type === 'tool_use') {
        currentTurn.tools.push((msg.name || msg.tool_name || 'unknown').substring(0, 50));
      }
    } catch {}
  }
  // Push last turn
  if (currentTurn.user && currentTurn.assistant) {
    turns.push(currentTurn);
  }

  if (turns.length === 0) {
    console.log('  No meaningful turns found, skipping');
    return 0;
  }

  console.log(`  Turns: ${turns.length}`);

  // Filter to meaningful turns (skip short exchanges)
  const meaningful = turns.filter(t =>
    (t.user.length + t.assistant.length) > 100
  );

  if (meaningful.length === 0) {
    console.log('  No meaningful content, skipping');
    return 0;
  }

  // Batch turns into chunks for Haiku (max ~3000 tokens per chunk)
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  for (const turn of meaningful) {
    const turnSize = turn.user.length + turn.assistant.length;
    if (currentSize + turnSize > 3000 && currentChunk.length > 0) {
      chunks.push([...currentChunk]);
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(turn);
    currentSize += turnSize;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  console.log(`  Chunks: ${chunks.length}`);

  let neuronsCreated = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkText = chunk.map((t, j) => {
      const tools = t.tools.length > 0 ? ` [Tools: ${t.tools.join(', ')}]` : '';
      return `Turn ${j + 1}:\nUser: ${t.user}\nAssistant: ${t.assistant}${tools}`;
    }).join('\n\n');

    const response = await callHaiku(
      `You are Undertow's history processor. You receive a batch of conversation turns from a past Claude Code session and extract what's worth remembering.

Extract ONLY:
- Significant decisions (choosing X over Y, with reasoning)
- Key insights or realizations
- Project architecture decisions
- Important facts learned
- Preferences expressed by the user

Do NOT create neurons for:
- Routine tool usage, file reads, debugging steps
- Generic coding exchanges
- Anything that's just "the agent did X" without lasting significance

Return JSON:
{
  "neurons": [
    { "name": "short name (2-5 words)", "node_type": "fact|insight|preference|episode|decision", "tier": "T2_working", "flash_summary": "one sentence, <100 chars" }
  ]
}

Maximum 3 neurons per chunk. Most chunks should produce 0-1 neurons. Quality over quantity.`,
      chunkText
    );

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { neurons: [] };

      for (const n of (parsed.neurons || [])) {
        const existing = await runCypher(
          'MATCH (n:Neuron {name: $name}) RETURN n.name LIMIT 1',
          { name: n.name }
        );
        if (existing.length === 0) {
          await runCypher(`
            CREATE (n:Neuron {
              name: $name, node_type: $type, tier: $tier,
              flash_summary: $flash, body: '',
              source: 'history', base_score: 40, decay_score: 40,
              times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
              created_at: datetime(), last_surfaced: datetime(),
              source_session: $sessionId
            })
          `, {
            name: n.name, type: n.node_type || 'fact',
            tier: n.tier || 'T2_working', flash: n.flash_summary,
            sessionId: session.id
          });
          neuronsCreated++;
          console.log(`    + ${n.name} (${n.node_type})`);
        }
      }
    } catch {}

    // Brief pause between chunks to avoid rate limits
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`  Created: ${neuronsCreated} neurons`);
  return neuronsCreated;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const maxSessions = parseInt(args[args.indexOf('--max-sessions') + 1]) || 15;
  const specificSession = args[args.indexOf('--session') + 1];

  console.log('Undertow Historical Ingestion');
  console.log('============================\n');

  // Verify Neo4j connection
  try {
    await runCypher('RETURN 1');
    console.log('Neo4j: connected');
  } catch (e) {
    console.error(`Neo4j: ${e.message}`);
    process.exit(1);
  }

  const state = await loadState();
  const allSessions = await findSessions();
  console.log(`Found ${allSessions.length} session files\n`);

  // Filter
  let sessions = specificSession
    ? allSessions.filter(s => s.id === specificSession)
    : allSessions
        .filter(s => !state.processedSessions.includes(s.id))
        .filter(s => s.size > 5000) // Skip tiny sessions (<5KB)
        .slice(0, maxSessions);

  if (sessions.length === 0) {
    console.log('No new sessions to process.');
    await driver.close();
    return;
  }

  console.log(`Processing ${sessions.length} sessions (${dryRun ? 'DRY RUN' : 'LIVE'}):\n`);

  for (const s of sessions) {
    console.log(`  ${s.id.substring(0, 8)}... ${(s.size / 1024).toFixed(1)} KB  ${s.project.substring(0, 30)}`);
  }

  if (dryRun) {
    console.log('\nDry run — no changes made.');
    await driver.close();
    return;
  }

  let totalNeurons = 0;
  for (const session of sessions) {
    const created = await processSession(session);
    totalNeurons += created;
    state.processedSessions.push(session.id);
    await saveState(state);
  }

  console.log(`\n============================`);
  console.log(`Total neurons created: ${totalNeurons}`);
  console.log(`Sessions processed: ${sessions.length}`);

  await driver.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
