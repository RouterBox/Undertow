import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
import express from 'express';
import neo4j from 'neo4j-driver';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, appendFile, mkdir, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename as pathBasename } from 'path';
import { randomUUID } from 'crypto';
import { loadConfig, isDaemonEnabled, getDaemonConfig } from './daemons/loader.js';
import spider from './daemons/spider.js';
import prowler from './daemons/prowler.js';
import tapestry from './daemons/tapestry.js';
import wonder from './daemons/wonder.js';
import janitor from './daemons/janitor.js';
import { getEmbedding, isAvailable as embeddingsAvailable } from './embeddings.js';
import { handleQuery, QUERY_SYSTEM_PROMPT } from './daemons/impulse.js';
import { handleIngest, INGEST_SYSTEM_PROMPT } from './daemons/gobble.js';
import { handleSummarize, handleSessionStart, handleRehydrate, SUMMARIZE_SYSTEM_PROMPT, SESSION_START_SYSTEM_PROMPT } from './daemons/dreamer.js';

// Embed a neuron's flash_summary and store the vector (fire-and-forget)
async function embedNeuron(name, flashSummary) {
  if (!embeddingsAvailable()) return;
  try {
    const embedding = await getEmbedding(flashSummary);
    if (embedding) {
      await runCypher(
        'MATCH (n:Neuron {name: $name}) SET n.embedding = $embedding',
        { name, embedding: Array.from(embedding) }
      );
    }
  } catch {}
}

// --- Config ---
const PORT = 3030;
const LOG_DIR = join(__dirname, 'logs');
const LOG_FILE = join(LOG_DIR, `undertow-${new Date().toISOString().split('T')[0]}.log`);
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASS = process.env.NEO4J_PASS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// --- Env validation: fail fast on required keys, warn on optional ones ---
function requireEnv(name, value) {
  if (!value) {
    console.error(`[undertow] ${name} not set. Copy service/.env.example to service/.env and configure it.`);
    process.exit(1);
  }
}
function warnEnv(name, value, consequence) {
  if (!value) console.warn(`[undertow] ${name} not set — ${consequence}`);
}

requireEnv('NEO4J_PASS', NEO4J_PASS);
requireEnv('ANTHROPIC_API_KEY', ANTHROPIC_API_KEY);
warnEnv('GEMINI_API_KEY', process.env.GEMINI_API_KEY, 'vector search disabled');
warnEnv('BRAVE_API_KEY', process.env.BRAVE_API_KEY, 'Prowler upstream (Brave) disabled');
warnEnv('PERPLEXITY_API_KEY', process.env.PERPLEXITY_API_KEY, 'Prowler downstream (Perplexity) disabled');
const QUERY_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARIZE_MODEL = 'claude-sonnet-4-6';
const FALLBACK_MODEL = QUERY_MODEL; // Fall back to Haiku if Sonnet is overloaded

// Resilient API call with retry + model fallback
async function callAnthropic(model, system, userContent, maxTokens = 500) {
  const maxRetries = 2;
  let currentModel = model;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: currentModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userContent }]
      });
      return { response: message, model: currentModel };
    } catch (e) {
      const isOverloaded = e.status === 529 || e.message?.includes('Overloaded') || e.message?.includes('overloaded');
      const isRateLimit = e.status === 429;

      if (isOverloaded || isRateLimit) {
        if (attempt < maxRetries) {
          // First retry: wait and try same model
          if (attempt === 0) {
            const delay = 2000 + Math.random() * 1000;
            log('api', 'warn', `${currentModel} ${e.status} — retrying in ${Math.round(delay)}ms`);
            await new Promise(r => setTimeout(r, delay));
          }
          // Second retry: fall back to cheaper model
          if (attempt === 1 && currentModel !== FALLBACK_MODEL) {
            currentModel = FALLBACK_MODEL;
            log('api', 'warn', `falling back to ${FALLBACK_MODEL}`);
          }
        } else {
          log('api', 'error', `all retries exhausted for ${model} (${e.status})`);
          return null;
        }
      } else {
        log('api', 'error', `${currentModel}: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

// --- Logging ---
async function log(endpoint, level, message, data = {}) {
  const ts = new Date().toISOString();
  const entry = { ts, endpoint, level, message, ...data };
  const line = JSON.stringify(entry) + '\n';

  // Console (colored)
  const prefix = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
  console.log(`${prefix}[${endpoint}]\x1b[0m ${message}`, data.detail || '');

  // File (daily rotation)
  try {
    const logFile = join(LOG_DIR, `undertow-${new Date().toISOString().split('T')[0]}.log`);
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(logFile, line);
  } catch {}
}

// --- Clients ---
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Undertow Toggle & Config ---
// Persist toggle state to survive restarts
const TOGGLE_FILE = join(__dirname, '.undertow-enabled');
let undertowEnabled = (() => {
  try { return readFileSync(TOGGLE_FILE, 'utf8').trim() !== 'false'; } catch { return true; }
})();
let flashMode = 'both'; // 'both' (Haiku + raw), 'raw' (neurons only, fast), 'haiku' (Haiku only, crafted)

// --- Session State ---
const sessions = new Map(); // session_id -> { activeTopics: [], pendingFlashes: [] }

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      activeTopics: [], pendingFlashes: [], lastActivity: Date.now(),
      currentProject: null, researchCount: 0, promptTimestamps: []
    });
  }
  const s = sessions.get(sessionId);
  s.lastActivity = Date.now();
  return s;
}

// Clean up old sessions every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours
  for (const [id, s] of sessions) {
    if (s.lastActivity < cutoff) sessions.delete(id);
  }
}, 30 * 60 * 1000);

// --- Neo4j Helpers ---
async function runCypher(query, params = {}) {
  const session = driver.session();
  try {
    const result = await session.run(query, params);
    return result.records.map(r => r.toObject());
  } finally {
    await session.close();
  }
}

// --- Endpoints ---

// Health check
app.get('/health', async (req, res) => {
  try {
    await runCypher('RETURN 1');
    res.json({ status: 'ok', neo4j: 'connected', enabled: undertowEnabled, uptime: process.uptime() });
  } catch (e) {
    res.status(503).json({ status: 'error', neo4j: 'disconnected', error: e.message });
  }
});

// Toggle Undertow on/off
app.post('/undertow/toggle', (req, res) => {
  undertowEnabled = !undertowEnabled;
  try { writeFileSync(TOGGLE_FILE, String(undertowEnabled)); } catch {}
  log('toggle', 'info', `Undertow ${undertowEnabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ enabled: undertowEnabled });
});

app.get('/undertow/toggle', (req, res) => {
  res.json({ enabled: undertowEnabled, flashMode });
});

// Set flash mode: 'both', 'raw', 'haiku'
app.post('/undertow/mode/:mode', (req, res) => {
  const valid = ['both', 'raw', 'haiku'];
  if (!valid.includes(req.params.mode)) {
    return res.status(400).json({ error: `Invalid mode. Use: ${valid.join(', ')}` });
  }
  flashMode = req.params.mode;
  log('config', 'info', `Flash mode set to: ${flashMode}`);
  res.json({ flashMode });
});

// POST /undertow/query — UserPromptSubmit hook
app.post('/undertow/query', async (req, res) => {
  if (!undertowEnabled) return res.json({});
  try {
    const session = getSession(req.body.session_id || 'default');
    const { responseJson } = await handleQuery({
      req_body: req.body,
      session,
      runCypher,
      callAnthropic,
      getEmbedding,
      embeddingsAvailable,
      isDaemonEnabled,
      getDaemonConfig,
      wonder,
      prowler,
      log,
      flashMode
    });
    res.json(responseJson);
  } catch (e) {
    log('query', 'error', e.message);
    res.json({}); // Fail silently — don't block the conversation
  }
});

// POST /undertow/ingest — PostToolUse hook
app.post('/undertow/ingest', async (req, res) => {
  // Respond immediately, process async
  res.json({});
  if (!undertowEnabled) return;
  log('hook', 'info', 'PostToolUse');

  try {
    await handleIngest({
      req_body: req.body,
      runCypher,
      callAnthropic,
      embedNeuron,
      getSession,
      randomUUID,
      log
    });
  } catch (e) {
    log('ingest', 'error', e.message);
  }
});

// POST /undertow/summarize — Stop hook
app.post('/undertow/summarize', async (req, res) => {
  res.json({});
  if (!undertowEnabled) { log('toggle', 'info', 'Undertow DISABLED'); return; }
  log('hook', 'info', 'Stop');

  try {
    const session = getSession(req.body.session_id || 'default');
    await handleSummarize({
      req_body: req.body,
      session,
      runCypher,
      callAnthropic,
      embedNeuron,
      randomUUID,
      isDaemonEnabled,
      getDaemonConfig,
      wonder,
      spider,
      janitor,
      prowler,
      log
    });
  } catch (e) {
    log('summarize', 'error', e.message);
  }
});

// POST /undertow/session-start — SessionStart hook
app.post('/undertow/session-start', async (req, res) => {
  if (!undertowEnabled) return res.json({});
  log('hook', 'info', 'SessionStart');
  try {
    const session = getSession(req.body.session_id || 'default');
    const { responseJson } = await handleSessionStart({
      req_body: req.body,
      session,
      runCypher,
      callAnthropic,
      log
    });
    res.json(responseJson);
  } catch (e) {
    log('session-start', 'error', e.message);
    res.json({});
  }
});

// POST /undertow/rehydrate — PostCompact hook
app.post('/undertow/rehydrate', async (req, res) => {
  log('hook', 'info', 'PostCompact');
  try {
    const session = getSession(req.body.session_id || 'default');
    const { responseJson } = await handleRehydrate({
      req_body: req.body,
      session,
      runCypher,
      log
    });
    res.json(responseJson);
  } catch (e) {
    log('rehydrate', 'error', e.message);
    res.json({});
  }
});

// Shared data fetcher used by both /undertow/stats and /undertow/stats.html
async function gatherStats() {
  const [counts, topPursued, topDismissed, decayDistribution, sourceBreakdown, daemonStatsRaw] = await Promise.all([
    runCypher('MATCH (n:Neuron) RETURN count(n) AS neurons').then(r => r[0]),
    runCypher(`
      MATCH (n:Neuron) WHERE n.times_surfaced > 0
      RETURN n.name, n.times_pursued, n.times_dismissed,
             CASE WHEN n.times_surfaced > 0
               THEN toFloat(n.times_pursued) / n.times_surfaced ELSE 0 END AS pursuitRate
      ORDER BY pursuitRate DESC LIMIT 10
    `),
    runCypher(`
      MATCH (n:Neuron) WHERE n.times_surfaced > 2
      RETURN n.name, n.times_pursued, n.times_dismissed,
             CASE WHEN n.times_surfaced > 0
               THEN toFloat(n.times_dismissed) / n.times_surfaced ELSE 0 END AS dismissRate
      ORDER BY dismissRate DESC LIMIT 10
    `),
    runCypher(`
      MATCH (n:Neuron)
      WITH CASE
        WHEN n.decay_score > 80 THEN 'high (>80)'
        WHEN n.decay_score > 40 THEN 'medium (40-80)'
        WHEN n.decay_score > 10 THEN 'low (10-40)'
        ELSE 'faded (<10)'
      END AS bracket, count(n) AS count
      RETURN bracket, count ORDER BY count DESC
    `),
    runCypher('MATCH (n:Neuron) RETURN n.source AS source, count(n) AS count ORDER BY count DESC'),
    // Per-daemon pursuit/dismissal totals (Item 2: calibration loop)
    runCypher(`
      MATCH (d:DaemonStat)
      RETURN d.name AS daemon,
             coalesce(d.pursued, 0) AS pursued,
             coalesce(d.dismissed, 0) AS dismissed
      ORDER BY pursued DESC
    `)
  ]);

  const synapseCount = await runCypher('MATCH ()-[s:SYNAPSE]->() RETURN count(s) AS synapses').then(r => r[0]);

  // Compute pursuit rate per daemon
  const daemonStats = (daemonStatsRaw || []).map(d => {
    const pursued = d.pursued?.low ?? d.pursued ?? 0;
    const dismissed = d.dismissed?.low ?? d.dismissed ?? 0;
    const total = pursued + dismissed;
    return {
      daemon: d.daemon,
      pursued,
      dismissed,
      total,
      pursuitRate: total > 0 ? pursued / total : 0
    };
  });

  return {
    neurons: counts.neurons?.low ?? counts.neurons,
    synapses: synapseCount.synapses?.low ?? synapseCount.synapses,
    topPursued,
    topDismissed,
    decayDistribution,
    sourceBreakdown,
    daemonStats,
    enabled: undertowEnabled
  };
}

// GET /undertow/stats — JSON calibration dashboard
app.get('/undertow/stats', async (req, res) => {
  try {
    res.json(await gatherStats());
  } catch (e) {
    log('stats', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /undertow/stats.html — human-readable view of the same data
app.get('/undertow/stats.html', async (req, res) => {
  try {
    const s = await gatherStats();
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
    const num = (v) => v?.low ?? v ?? 0;
    const pct = (n) => (n * 100).toFixed(1) + '%';

    const rows = (arr, fn) => (arr || []).map(fn).join('');
    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<title>Undertow — stats</title>
<style>
  :root { --bone:#f4ecdb; --ink:#0b0b0d; --shade:#e8dec7; --murk:#1a3a3f; --lumen:#3a8a92; }
  * { box-sizing: border-box; }
  body {
    font-family: 'JetBrains Mono', 'Courier New', monospace;
    background: var(--bone); color: var(--ink);
    padding: 48px 32px; max-width: 980px; margin: 0 auto;
    font-size: 13px; line-height: 1.55;
  }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-weight: 300; font-size: 42px;
       letter-spacing: -0.02em; margin: 0 0 4px; }
  h1 em { font-style: italic; font-weight: 700; }
  .lede { opacity: 0.6; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
          border-bottom: 1px solid var(--ink); padding-bottom: 16px; margin-bottom: 28px; }
  h2 { font-family: Georgia, serif; font-weight: 400; font-style: italic; font-size: 20px;
       margin: 36px 0 12px; letter-spacing: -0.01em; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
  th, td { padding: 7px 12px; text-align: left; font-size: 12px; border-bottom: 1px solid rgba(11,11,13,0.12); }
  th { background: var(--shade); font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; font-size: 10px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .meta { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .meta div { padding: 8px 14px; background: var(--shade); }
  .meta strong { color: var(--murk); }
  .empty { opacity: 0.5; font-style: italic; padding: 12px 0; }
  .bar { display: inline-block; height: 6px; background: var(--murk); vertical-align: middle; margin-left: 4px; }
</style>
</head><body>

<h1>Under<em>tow</em> · stats</h1>
<p class="lede">calibration dashboard · ${s.enabled ? 'enabled' : 'disabled'}</p>

<div class="meta">
  <div><strong>${num(s.neurons)}</strong> neurons</div>
  <div><strong>${num(s.synapses)}</strong> synapses</div>
  <div>service: <strong>${s.enabled ? 'on' : 'off'}</strong></div>
</div>

<h2>Per-daemon pursuit rates</h2>
${s.daemonStats.length === 0 ? '<p class="empty">No daemon stats yet — calibration data accrues as flashes are pursued or dismissed.</p>' : `
<table>
  <thead><tr><th>daemon</th><th class="num">pursued</th><th class="num">dismissed</th><th class="num">total</th><th class="num">rate</th><th>distribution</th></tr></thead>
  <tbody>
    ${rows(s.daemonStats, d => `<tr>
      <td>${esc(d.daemon)}</td>
      <td class="num">${d.pursued}</td>
      <td class="num">${d.dismissed}</td>
      <td class="num">${d.total}</td>
      <td class="num">${pct(d.pursuitRate)}</td>
      <td><span class="bar" style="width:${(d.pursuitRate * 200).toFixed(0)}px;"></span></td>
    </tr>`)}
  </tbody>
</table>`}

<h2>Top pursued neurons</h2>
${(s.topPursued || []).length === 0 ? '<p class="empty">No pursued neurons yet.</p>' : `
<table>
  <thead><tr><th>name</th><th class="num">pursued</th><th class="num">dismissed</th><th class="num">rate</th></tr></thead>
  <tbody>
    ${rows(s.topPursued, r => `<tr>
      <td>${esc(r['n.name'])}</td>
      <td class="num">${num(r['n.times_pursued'])}</td>
      <td class="num">${num(r['n.times_dismissed'])}</td>
      <td class="num">${pct(r.pursuitRate)}</td>
    </tr>`)}
  </tbody>
</table>`}

<h2>Top dismissed neurons</h2>
${(s.topDismissed || []).length === 0 ? '<p class="empty">No dismissed neurons yet.</p>' : `
<table>
  <thead><tr><th>name</th><th class="num">pursued</th><th class="num">dismissed</th><th class="num">rate</th></tr></thead>
  <tbody>
    ${rows(s.topDismissed, r => `<tr>
      <td>${esc(r['n.name'])}</td>
      <td class="num">${num(r['n.times_pursued'])}</td>
      <td class="num">${num(r['n.times_dismissed'])}</td>
      <td class="num">${pct(r.dismissRate)}</td>
    </tr>`)}
  </tbody>
</table>`}

<h2>Decay distribution</h2>
<table>
  <thead><tr><th>bracket</th><th class="num">count</th></tr></thead>
  <tbody>${rows(s.decayDistribution, r => `<tr><td>${esc(r.bracket)}</td><td class="num">${num(r.count)}</td></tr>`)}</tbody>
</table>

<h2>Source breakdown</h2>
<table>
  <thead><tr><th>source</th><th class="num">count</th></tr></thead>
  <tbody>${rows(s.sourceBreakdown, r => `<tr><td>${esc(r.source || '(unknown)')}</td><td class="num">${num(r.count)}</td></tr>`)}</tbody>
</table>

</body></html>`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    log('stats', 'error', e.message);
    res.status(500).send(`<pre>error: ${e.message}</pre>`);
  }
});

// GET /undertow/patterns — Cross-session pattern detection (M5)
app.get('/undertow/patterns', async (req, res) => {
  try {
    const [recurringTopics, bridgeNodes, trainOfThought] = await Promise.all([
      // Topics that appear in 3+ temporal chains
      runCypher(`
        MATCH (n:Neuron)-[s:SYNAPSE {edge_type: 'temporal'}]-()
        WITH n, count(s) AS appearances
        WHERE appearances >= 3
        RETURN n.name, n.flash_summary, appearances
        ORDER BY appearances DESC LIMIT 10
      `),
      // Bridge nodes connecting otherwise disconnected clusters
      runCypher(`
        MATCH (a:Neuron)-[:SYNAPSE]-(bridge:Neuron)-[:SYNAPSE]-(b:Neuron)
        WHERE NOT (a)-[:SYNAPSE]-(b)
        AND a.node_type <> b.node_type
        AND a <> b AND a <> bridge AND b <> bridge
        WITH bridge, collect(DISTINCT a.name) AS cluster_a, collect(DISTINCT b.name) AS cluster_b
        RETURN bridge.name, bridge.flash_summary,
               size(cluster_a) + size(cluster_b) AS connections,
               cluster_a[..3] AS sample_a, cluster_b[..3] AS sample_b
        ORDER BY connections DESC LIMIT 10
      `),
      // Recent trains of thought
      runCypher(`
        MATCH path = (a:Neuron)-[:SYNAPSE {edge_type: 'temporal'}]->(b:Neuron)
        WHERE a.created_at > datetime() - duration('P7D')
        RETURN a.name AS from_topic, b.name AS to_topic, a.created_at AS when
        ORDER BY a.created_at DESC LIMIT 20
      `)
    ]);

    res.json({ recurringTopics, bridgeNodes, trainOfThought });
  } catch (e) {
    log('patterns', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /undertow/external-ingest — Cross-agent memory intake (M5)
app.post('/undertow/external-ingest', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  try {
    const { text, source, agent_name } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const agentSource = source || agent_name || 'external';

    // Use Haiku to evaluate and create neurons
    const extResult = await callAnthropic(QUERY_MODEL, INGEST_SYSTEM_PROMPT, `Tool: ExternalIngest
Input: ${JSON.stringify({ source: agentSource, text: text.substring(0, 1000) })}
Response: [external agent memory submission]`);
    if (!extResult) return res.json({ status: 'api_error' });

    const responseText = extResult.response.content[0]?.text || '{}';
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'skip' };
    } catch {
      return res.json({ status: 'parse_error' });
    }

    if (parsed.action === 'skip' || !parsed.neuron) {
      return res.json({ status: 'skipped' });
    }

    const n = parsed.neuron;
    await runCypher(`
      CREATE (n:Neuron {
        uid: $uid, name: $name, node_type: $type, tier: $tier,
        flash_summary: $flash, body: $body,
        source: $source, decay_score: 50, base_score: 50,
        times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
        created_at: datetime(), last_surfaced: datetime()
      })
    `, {
      uid: randomUUID(), name: n.name, type: n.node_type || 'fact', tier: n.tier || 'T2_working',
      flash: n.flash_summary, body: n.body || '', source: agentSource
    });

    if (parsed.connections?.length) {
      for (const conn of parsed.connections) {
        await runCypher(`
          MATCH (src:Neuron {name: $src})
          MATCH (tgt:Neuron {name: $tgt})
          CREATE (src)-[:SYNAPSE {
            weight: $weight, edge_type: $edgeType,
            context: $context, created_at: datetime()
          }]->(tgt)
        `, {
          src: n.name, tgt: conn.target_name,
          weight: conn.weight || 0.5, edgeType: conn.edge_type || 'associative',
          context: conn.context || ''
        }).catch(e => log('error', 'warn', e.message));
      }
    }

    log('external-ingest', 'info', `${agentSource}: ${n.name}`);
    res.json({ status: 'created', neuron: n.name });
  } catch (e) {
    log('external-ingest', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /undertow/correct — Agent-initiated memory correction
// The ego corrects the Id. Investigate the neuron, verify the change is sound, then apply.
app.post('/undertow/correct', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  try {
    const { neuron, action, flash_summary, body, reason, tier } = req.body;
    if (!neuron) return res.status(400).json({ error: 'neuron name required' });
    if (!action) return res.status(400).json({ error: 'action required (update, delete, demote)' });
    if (!reason) return res.status(400).json({ error: 'reason required — explain why this correction is needed' });

    // Step 1: Investigate — fetch the neuron and its connections
    const existing = await runCypher(`
      MATCH (n:Neuron {name: $name})
      OPTIONAL MATCH (n)-[s:SYNAPSE]-(connected:Neuron)
      RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
             n.tier AS tier, n.base_score AS score, n.source AS source,
             n.times_surfaced AS surfaced, n.times_pursued AS pursued,
             n.created_at AS created,
             collect(DISTINCT connected.name) AS connections
      LIMIT 1
    `, { name: neuron });

    if (existing.length === 0) {
      return res.json({ status: 'not_found', neuron });
    }

    const node = existing[0];
    log('correct', 'info', `investigating: ${neuron}`, {
      detail: `action: ${action}, reason: ${reason}, connections: ${node.connections?.length || 0}`
    });

    if (action === 'delete') {
      // Only delete if it has few connections (structural safety)
      const connCount = node.connections?.length || 0;
      if (connCount > 5) {
        log('correct', 'warn', `refused delete: ${neuron} has ${connCount} connections — demote instead`);
        return res.json({
          status: 'refused',
          reason: `neuron has ${connCount} connections — too structurally important to delete. Use action: "demote" instead.`,
          connections: node.connections
        });
      }
      await runCypher('MATCH (n:Neuron {name: $name}) DETACH DELETE n', { name: neuron });
      log('correct', 'info', `DELETED: ${neuron}`, { detail: reason });
      return res.json({ status: 'deleted', neuron, reason });
    }

    if (action === 'demote') {
      await runCypher(`
        MATCH (n:Neuron {name: $name})
        SET n.tier = 'T3_archive', n.base_score = 10, n.last_surfaced = datetime()
      `, { name: neuron });
      log('correct', 'info', `DEMOTED: ${neuron} → T3_archive, base_score=10`, { detail: reason });
      return res.json({ status: 'demoted', neuron, reason });
    }

    if (action === 'update') {
      const setClauses = ['n.last_surfaced = datetime()', 'n.updated_at = datetime()'];
      const params = { name: neuron };

      if (flash_summary) {
        setClauses.push('n.flash_summary = $flash');
        params.flash = flash_summary;
      }
      if (body !== undefined) {
        setClauses.push('n.body = $body');
        params.body = body;
      }
      if (tier) {
        setClauses.push('n.tier = $tier');
        params.tier = tier;
      }

      await runCypher(
        `MATCH (n:Neuron {name: $name}) SET ${setClauses.join(', ')} RETURN n.name`,
        params
      );
      log('correct', 'info', `UPDATED: ${neuron}`, { detail: `reason: ${reason}, changes: ${flash_summary ? 'flash' : ''} ${body !== undefined ? 'body' : ''} ${tier ? 'tier' : ''}`.trim() });
      return res.json({ status: 'updated', neuron, reason, previous: node.flash });
    }

    res.status(400).json({ error: `unknown action: ${action}. Use update, delete, or demote.` });
  } catch (e) {
    log('correct', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /undertow/janitor — Run janitor daemon (content-quality cleanup)
app.post('/undertow/janitor', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  if (!isDaemonEnabled('janitor')) return res.json({ status: 'daemon disabled' });

  try {
    const result = await janitor.run({ runCypher, log });
    res.json({ status: 'ok', ...result });
  } catch (e) {
    log('janitor', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /undertow/chase — Agent followed up on a flash by exploring the graph
// This is the strongest pursuit signal — reward the neuron and its connections
app.post('/undertow/chase', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  try {
    const { neuron } = req.body;
    if (!neuron) return res.status(400).json({ error: 'neuron name required' });

    // Strong pursuit reward: +15 base_score (vs +10 for normal pursuit)
    await runCypher(`
      MATCH (n:Neuron {name: $name})
      SET n.times_pursued = n.times_pursued + 1,
          n.base_score = CASE WHEN n.base_score + 15 > 100 THEN 100 ELSE n.base_score + 15 END,
          n.last_surfaced = datetime()
      RETURN n.name, n.base_score
    `, { name: neuron }).catch(e => log('error', 'warn', e.message));

    // Strengthen outbound synapses more aggressively (+0.08 vs +0.05 for normal pursuit)
    await runCypher(`
      MATCH (n:Neuron {name: $name})-[s:SYNAPSE]->()
      SET s.weight = CASE WHEN s.weight + 0.08 > 0.95 THEN 0.95 ELSE s.weight + 0.08 END
    `, { name: neuron }).catch(e => log('error', 'warn', e.message));

    log('chase', 'info', `chased: ${neuron}`, { detail: 'base_score +15, synapses +0.08' });
    res.json({ status: 'chased', neuron });
  } catch (e) {
    log('chase', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /undertow/spider — Run spider daemon (batch edge discovery + pruning + GDS)
app.post('/undertow/spider', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  if (!isDaemonEnabled('spider')) return res.json({ status: 'daemon disabled' });

  // Respond with accepted, process async
  res.json({ status: 'started' });

  try {
    const result = await spider.run({ runCypher, callAnthropic, config: getDaemonConfig('spider'), log });
    log('spider', 'info', 'spider run complete', { detail: JSON.stringify(result) });
  } catch (e) {
    log('spider', 'error', `spider failed: ${e.message}`);
  }
});

// POST /undertow/ingest-url — Web content ingestion (M8)
app.post('/undertow/ingest-url', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  try {
    const { url, context } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    log('ingest-url', 'info', `ingesting: ${url}`);

    // Fetch URL content
    let content;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Undertow/1.0 (knowledge-graph-ingestor)' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return res.json({ status: 'fetch_failed', code: response.status });
      const html = await response.text();
      // Simple HTML to text: strip tags, decode entities, collapse whitespace
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 4000);
    } catch (e) {
      return res.json({ status: 'fetch_error', error: e.message });
    }

    if (!content || content.length < 50) {
      return res.json({ status: 'empty_content' });
    }

    // Haiku evaluates what's worth remembering
    const evalResult = await callAnthropic(QUERY_MODEL,
      `You are Undertow's web ingestor. Extract key insights worth remembering from this web page.

CRITICAL: Return ONLY valid JSON. No markdown fences. No code blocks. No backticks.
CRITICAL: In flash_summary and body fields, use ONLY plain text. Never include code, JSON, curly braces, or special characters. Describe concepts in plain English.
CRITICAL: Keep body fields SHORT (under 100 chars) or omit them.

Return this exact structure:
{"neurons": [{"name": "short name", "node_type": "topic", "tier": "T2_working", "flash_summary": "plain text sentence under 100 chars"}], "connections": []}

Maximum 5 neurons. If nothing worth remembering, return {"neurons": [], "connections": []}.`,
      `URL: ${url}\n${context ? `Context: ${context}\n` : ''}Content:\n${content}`, 1500);

    if (!evalResult) return res.json({ status: 'api_error' });

    let responseText = evalResult.response.content[0]?.text || '{}';
    responseText = responseText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      let jsonStr = jsonMatch ? jsonMatch[0] : '{"neurons":[]}';
      const openBrackets = (jsonStr.match(/\[/g) || []).length;
      const closeBrackets = (jsonStr.match(/\]/g) || []).length;
      const openBraces = (jsonStr.match(/\{/g) || []).length;
      const closeBraces = (jsonStr.match(/\}/g) || []).length;
      for (let i = 0; i < openBrackets - closeBrackets; i++) jsonStr += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += '}';
      jsonStr = jsonStr.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');
      parsed = JSON.parse(jsonStr);
    } catch { parsed = { neurons: [] }; }

    const created = [];
    for (const n of (parsed.neurons || [])) {
      const existing = await runCypher('MATCH (n:Neuron {name: $name}) RETURN n.name LIMIT 1', { name: n.name });
      if (existing.length === 0) {
        await runCypher(`
          CREATE (n:Neuron {
            name: $name, node_type: $type, tier: $tier,
            flash_summary: $flash, body: $body,
            source: 'web', base_score: 50, decay_score: 50,
            times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
            created_at: datetime(), last_surfaced: datetime(),
            source_url: $url, project: 'general'
          })
        `, {
          uid: randomUUID(), name: n.name, type: n.node_type || 'fact', tier: n.tier || 'T2_working',
          flash: n.flash_summary, body: n.body || '', url
        });
        created.push(n.name);
        embedNeuron(n.name, n.flash_summary).catch(e => log('error', 'warn', e.message));
      }
    }

    // Create connections
    for (const conn of (parsed.connections || [])) {
      await runCypher(`
        MATCH (src:Neuron {name: $src})
        MATCH (tgt:Neuron {name: $tgt})
        WHERE NOT (src)-[:SYNAPSE]-(tgt)
        CREATE (src)-[:SYNAPSE {
          weight: $weight, edge_type: $edgeType,
          context: $context, created_at: datetime(), source: 'web'
        }]->(tgt)
      `, {
        src: conn.source, tgt: conn.target,
        weight: conn.weight || 0.5, edgeType: conn.edge_type || 'associative',
        context: conn.context || ''
      }).catch(e => log('error', 'warn', e.message));
    }

    log('ingest-url', 'info', `created ${created.length} neurons from ${url}`, { detail: created.join(', ') });
    res.json({ status: 'ok', neurons: created });
  } catch (e) {
    log('ingest-url', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /undertow/ingest-file — Local file ingestion (M8)
app.post('/undertow/ingest-file', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  try {
    const { path: filePath, context } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });

    log('ingest-file', 'info', `ingesting: ${filePath}`);

    let content;
    try {
      content = await readFile(filePath, 'utf8');
      content = content.substring(0, 4000); // Chunk limit
    } catch (e) {
      return res.json({ status: 'read_error', error: e.message });
    }

    if (!content || content.length < 20) {
      return res.json({ status: 'empty_content' });
    }

    const evalResult = await callAnthropic(QUERY_MODEL,
      `You are Undertow's file ingestor. Extract key insights, facts, or concepts worth remembering from this file content.

CRITICAL: Return ONLY valid JSON. No markdown fences. No code blocks. No backticks.
CRITICAL: In flash_summary and body fields, use ONLY plain text. Never include code snippets, JSON, curly braces, square brackets, or special characters that could break JSON parsing. Describe code concepts in plain English instead of quoting code.
CRITICAL: Keep body fields SHORT (under 100 chars) or omit them. Do not paste source content into body.

Return this exact structure:
{"neurons": [{"name": "short name", "node_type": "topic", "tier": "T2_working", "flash_summary": "plain text sentence under 100 chars"}], "connections": []}

Maximum 5 neurons. Quality over quantity. If nothing is worth remembering, return {"neurons": [], "connections": []}.`,
      `File: ${filePath}\n${context ? `Context: ${context}\n` : ''}Content (summarize, do not quote verbatim):\n${content.replace(/[{}[\]]/g, ' ')}`, 1500);

    if (!evalResult) return res.json({ status: 'api_error' });

    let responseText = evalResult.response.content[0]?.text || '{}';
    // Strip markdown code fences if present
    responseText = responseText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      let jsonStr = jsonMatch ? jsonMatch[0] : '{"neurons":[]}';
      // Fix truncated JSON: if array is cut off, close it
      const openBrackets = (jsonStr.match(/\[/g) || []).length;
      const closeBrackets = (jsonStr.match(/\]/g) || []).length;
      const openBraces = (jsonStr.match(/\{/g) || []).length;
      const closeBraces = (jsonStr.match(/\}/g) || []).length;
      for (let i = 0; i < openBrackets - closeBrackets; i++) jsonStr += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += '}';
      // Remove trailing comma before closing bracket/brace
      jsonStr = jsonStr.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');
      parsed = JSON.parse(jsonStr);
    } catch (pe) {
      log('ingest-file', 'warn', `parse error: ${pe.message}`);
      log('ingest-file', 'info', `raw_response: ${responseText.substring(0, 300)}`);
      parsed = { neurons: [] };
    }
    log('ingest-file', 'info', `parsed_neurons_count: ${(parsed.neurons || []).length}`);

    const created = [];
    for (const n of (parsed.neurons || [])) {
      const existing = await runCypher('MATCH (n:Neuron {name: $name}) RETURN n.name LIMIT 1', { name: n.name });
      if (existing.length === 0) {
        await runCypher(`
          CREATE (n:Neuron {
            name: $name, node_type: $type, tier: $tier,
            flash_summary: $flash, body: $body,
            source: 'file', base_score: 50, decay_score: 50,
            times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
            created_at: datetime(), last_surfaced: datetime(),
            source_path: $path, project: $project
          })
        `, {
          uid: randomUUID(), name: n.name, type: n.node_type || 'fact', tier: n.tier || 'T2_working',
          flash: n.flash_summary, body: n.body || '', path: filePath,
          project: req.body.project || 'general'
        });
        created.push(n.name);
        embedNeuron(n.name, n.flash_summary).catch(e => log('error', 'warn', e.message));
      } else {
        log('ingest-file', 'info', `duplicate_skipped: ${n.name}`);
      }
    }

    for (const conn of (parsed.connections || [])) {
      await runCypher(`
        MATCH (src:Neuron {name: $src})
        MATCH (tgt:Neuron {name: $tgt})
        WHERE NOT (src)-[:SYNAPSE]-(tgt)
        CREATE (src)-[:SYNAPSE {
          weight: $weight, edge_type: $edgeType,
          context: $context, created_at: datetime(), source: 'file'
        }]->(tgt)
      `, {
        src: conn.source, tgt: conn.target,
        weight: conn.weight || 0.5, edgeType: conn.edge_type || 'associative',
        context: conn.context || ''
      }).catch(e => log('error', 'warn', e.message));
    }

    log('ingest-file', 'info', `created ${created.length} neurons from ${filePath}`, { detail: created.join(', ') });
    res.json({ status: 'ok', neurons: created });
  } catch (e) {
    log('ingest-file', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /undertow/wiki-sync — Generate/update Obsidian vault from graph
app.post('/undertow/wiki-sync', async (req, res) => {
  if (!undertowEnabled) return res.json({ status: 'disabled' });
  if (!isDaemonEnabled('tapestry')) return res.json({ status: 'daemon disabled — enable via POST /undertow/daemon-config/tapestry {"enabled": true}' });

  try {
    const result = await tapestry.project({ runCypher, config: getDaemonConfig('tapestry'), log });
    res.json({ status: 'ok', ...result });
  } catch (e) {
    log('tapestry', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /undertow/daemon-config — View current daemon configuration
app.get('/undertow/daemon-config', async (req, res) => {
  const config = await loadConfig();
  res.json(config);
});

// POST /undertow/daemon-config/:daemon — Update daemon configuration
app.post('/undertow/daemon-config/:daemon', async (req, res) => {
  try {
    const config = await loadConfig();
    const daemonName = req.params.daemon;
    if (!config.daemons[daemonName]) {
      config.daemons[daemonName] = {};
    }
    Object.assign(config.daemons[daemonName], req.body);
    await writeFile(
      join(__dirname, 'daemon-config.json'),
      JSON.stringify(config, null, 2)
    );
    log('config', 'info', `daemon config updated: ${daemonName}`, { detail: JSON.stringify(req.body) });
    res.json({ status: 'ok', config: config.daemons[daemonName] });
  } catch (e) {
    log('config', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /undertow/health — Graph health metrics (from GRAPH_THEORY.md research)
app.get('/undertow/health', async (req, res) => {
  try {
    const [neuronCount, synapseCount, diversityCheck, communityHealth, ageDistribution, growthRatio, topRetrieved] = await Promise.all([
      runCypher('MATCH (n:Neuron) RETURN count(n) AS count'),
      runCypher('MATCH ()-[s:SYNAPSE]->() RETURN count(s) AS count'),
      // Filter bubble check: are top neurons dominating retrievals?
      runCypher(`
        MATCH (n:Neuron) WHERE n.times_surfaced > 0
        WITH n ORDER BY n.times_surfaced DESC
        WITH collect(n.times_surfaced) AS surfacedList, sum(n.times_surfaced) AS totalSurfaced
        WITH surfacedList, totalSurfaced,
             reduce(s = 0, x IN surfacedList[..toInteger(size(surfacedList) * 0.1) + 1] | s + x) AS top10pctSurfaced
        RETURN totalSurfaced, top10pctSurfaced,
               CASE WHEN totalSurfaced > 0 THEN toFloat(top10pctSurfaced) / totalSurfaced ELSE 0 END AS concentration
      `).catch(() => [{ totalSurfaced: 0, top10pctSurfaced: 0, concentration: 0 }]),
      // Community health
      runCypher(`
        MATCH (n:Neuron) WHERE n.community_id IS NOT NULL
        WITH n.community_id AS cid, count(n) AS members
        RETURN count(cid) AS communities, avg(members) AS avgSize,
               min(members) AS smallest, max(members) AS largest
      `).catch(() => [{ communities: 0, avgSize: 0, smallest: 0, largest: 0 }]),
      // Age distribution
      runCypher(`
        MATCH (n:Neuron)
        WITH CASE
          WHEN n.created_at > datetime() - duration('P7D') THEN 'last_7_days'
          WHEN n.created_at > datetime() - duration('P30D') THEN 'last_30_days'
          WHEN n.created_at > datetime() - duration('P90D') THEN 'last_90_days'
          ELSE 'older'
        END AS age_bucket, count(n) AS count
        RETURN age_bucket, count ORDER BY count DESC
      `).catch(() => []),
      // Growth ratio: pursuits vs dismissals in recent data
      runCypher(`
        MATCH (n:Neuron) WHERE n.times_surfaced > 0
        RETURN sum(n.times_pursued) AS totalPursued,
               sum(n.times_dismissed) AS totalDismissed,
               CASE WHEN sum(n.times_dismissed) > 0
                 THEN toFloat(sum(n.times_pursued)) / sum(n.times_dismissed) ELSE 0 END AS ratio
      `).catch(() => [{ totalPursued: 0, totalDismissed: 0, ratio: 0 }]),
      // Most retrieved neurons (filter bubble candidates)
      runCypher(`
        MATCH (n:Neuron) WHERE n.times_surfaced > 3
        RETURN n.name, n.times_surfaced, n.times_pursued, n.times_dismissed
        ORDER BY n.times_surfaced DESC LIMIT 10
      `).catch(() => [])
    ]);

    const concentration = diversityCheck[0]?.concentration || 0;
    const alerts = [];
    if (concentration > 0.8) alerts.push('FILTER_BUBBLE: top 10% of neurons account for >' + Math.round(concentration * 100) + '% of retrievals');
    const ratioVal = typeof growthRatio[0]?.ratio === 'object' ? growthRatio[0].ratio.low : (growthRatio[0]?.ratio || 0);
    if (ratioVal < 0.5) alerts.push('GRAPH_DYING: pursuit/dismissal ratio is ' + Number(ratioVal).toFixed(2) + ' (healthy > 1.0)');
    if ((communityHealth[0]?.communities || 0) < 3) alerts.push('LOW_DIVERSITY: only ' + (communityHealth[0]?.communities || 0) + ' communities detected');

    // Unwrap Neo4j integers
    const unwrap = v => (v && typeof v === 'object' && 'low' in v) ? v.low : v;
    const unwrapObj = obj => {
      if (!obj) return obj;
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = unwrap(v);
      return out;
    };

    res.json({
      neurons: unwrap(neuronCount[0]?.count),
      synapses: unwrap(synapseCount[0]?.count),
      diversity: {
        concentration: unwrap(concentration),
        status: unwrap(concentration) > 0.8 ? 'FILTER_BUBBLE' : unwrap(concentration) > 0.5 ? 'WATCH' : 'HEALTHY'
      },
      communities: unwrapObj(communityHealth[0]),
      ageDistribution: ageDistribution.map(unwrapObj),
      growthRatio: unwrapObj(growthRatio[0]),
      topRetrieved: topRetrieved.map(unwrapObj),
      alerts,
      status: alerts.length === 0 ? 'HEALTHY' : 'NEEDS_ATTENTION'
    });
  } catch (e) {
    log('health', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /undertow/logs — View recent log entries
app.get('/undertow/logs', async (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  const level = req.query.level; // optional filter: info, warn, error
  try {
    const logFile = join(LOG_DIR, `undertow-${new Date().toISOString().split('T')[0]}.log`);
    const content = await readFile(logFile, 'utf8').catch(() => '');
    let entries = content.trim().split('\n').filter(Boolean);

    if (level) {
      entries = entries.filter(line => {
        try { return JSON.parse(line).level === level; } catch { return false; }
      });
    }

    entries = entries.slice(-lines);
    const parsed = entries.map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
    res.json({ count: parsed.length, entries: parsed });
  } catch (e) {
    log('logs', 'error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Startup ---
app.listen(PORT, async () => {
  try {
    await runCypher('RETURN 1');
    const daemonCfg = await loadConfig();
    const enabledDaemons = Object.entries(daemonCfg.daemons || {})
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
    log('startup', 'info', `Undertow online — localhost:${PORT} — Neo4j connected — daemons: ${enabledDaemons.join(', ') || 'none'}`);
  } catch (e) {
    log('startup', 'error', `Neo4j connection failed: ${e.message}. Make sure Docker container is running.`);
  }
});
