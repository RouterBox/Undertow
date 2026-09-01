// impulse.js — Impulse daemon (flash-crafting pipeline)
// Extracted from server.js — no behavior changes

import neo4j from 'neo4j-driver';
import { lexicalSearch } from './lexical.js';
import { nsPredicate, livePredicate } from '../namespaces.js';

// --- Project helpers ---

// The project key is the cwd, lowercased and trimmed. Whatever the agent
// sends in the hook payload — a Windows path, a POSIX path, a bare bot
// identifier — that string IS the key. It's never shown to the user;
// Haiku just uses it as a stable fingerprint when scoring same-project
// vs cross-project neurons. No alias tables, no filesystem walks, no
// assumptions about folder structure or git.
function mapCwdToProject(cwd) {
  if (!cwd) return null;
  return cwd.toLowerCase().trim() || null;
}

function isNeuronInProject(neuron, projectTag) {
  if (!projectTag) return true;
  const neuronProject = neuron.project || 'general';
  if (neuronProject === projectTag) return true;
  if (neuronProject === 'general') return true;
  return false;
}

// --- System Prompt ---

const QUERY_SYSTEM_PROMPT = `You are Undertow, a subconscious memory daemon. You evaluate candidate memories and decide which are worth injecting into the agent's context.

THRESHOLD: Most of the time, the right answer is NOTHING. Return empty flashes unless a candidate would genuinely change how the agent approaches the current prompt. Silence is accuracy, not failure.

When you DO flash:
1. Prioritize NON-OBVIOUS connections. The agent will find the obvious things itself.
2. CONTRADICTION CHECK: If a stored fact conflicts with what the prompt assumes, that's always worth flashing.
3. Write concise flashes (1-2 sentences). Give just enough to decide whether to pursue.
4. Maximum 2 flashes per prompt. One is usually enough. Zero is often best.

SURFACE, DON'T COACH. A flash reports what is true or remembered — a fact, a prior decision, a connection, a contradiction. It is NOT advice about how the agent should behave. Never tell the agent what tone, voice, style, or persona to adopt. Never speculate about the agent's identity or the user's intent ("the user may be testing you", "answer this introspectively", "this is on-brand for your persona"). State the memory; let the agent (the ego) decide what to do with it. You are the Id — you surface material, you do not direct the response.

STAY IN DOMAIN. Stylistic or creative preferences (e.g. how the user likes fiction or narration written) are ONLY relevant when the current prompt is itself that kind of task. Do NOT surface a creative-writing preference, a tone preference, or a persona note during analytical, factual, or technical work.

NO IDENTITY BLEED. Undertow's own nature (subconscious daemon, Freudian framing, etc.) describes the memory system, NOT the main agent. Never attribute Undertow's identity, branding, or "persona" to the agent you are serving.

Return JSON:
{
  "flashes": ["~ flash text 1"],
  "topics_detected": ["topic1", "topic2"]
}

Return {"flashes": [], "topics_detected": []} when nothing is genuinely worth surfacing.`;

// --- Query cache (deduplicates retries) ---
const queryCache = new Map(); // key: prompt hash → { result, timestamp }
const QUERY_CACHE_TTL_MS = 60_000; // 60 seconds

function getQueryCacheKey(prompt, cwd) {
  // Simple hash: first 200 chars of prompt + cwd
  return `${(cwd || '').substring(0, 50)}::${prompt.substring(0, 200)}`;
}

function getCachedQuery(prompt, cwd) {
  const key = getQueryCacheKey(prompt, cwd);
  const cached = queryCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > QUERY_CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  return cached.result;
}

function setCachedQuery(prompt, cwd, result) {
  const key = getQueryCacheKey(prompt, cwd);
  queryCache.set(key, { result, timestamp: Date.now() });
  // Evict old entries
  if (queryCache.size > 100) {
    const oldest = [...queryCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) queryCache.delete(oldest[0]);
  }
}

// --- Query handler ---

async function handleQuery({ req_body, session, runCypher, callAnthropic, getEmbedding, embeddingsAvailable, isDaemonEnabled, getDaemonConfig, wonder, prowler, log, flashMode }) {
  const QUERY_MODEL = 'claude-haiku-4-5-20251001';
  const startTime = Date.now();

  const { prompt, session_id, cwd } = req_body;
  if (!prompt) return { responseJson: {} };

  // Namespace isolation: a client-declared namespace scopes every read below.
  // Sticky on the session so later turns without the field stay in-world.
  const ns = req_body.namespace ?? session.namespace ?? null;
  if (ns) session.namespace = ns;
  const cacheScope = `${cwd || ''}::${ns || ''}`;

  // Check cache first — same prompt within 60s gets the same response (handles retry storms)
  const cached = getCachedQuery(prompt, cacheScope);
  if (cached) {
    log('query', 'info', `cache hit (${Date.now() - startTime}ms)`);
    return { responseJson: cached };
  }

  log('turn', 'info', 'START', { detail: prompt.substring(0, 300), cwd: cwd || 'unknown' });

  // Set project context from working directory
  if (cwd && !session.currentProject) {
    session.currentProject = mapCwdToProject(cwd);
    if (session.currentProject) {
      log('query', 'info', `project detected: ${session.currentProject}`);
    }
  }

  // --- Flow-state detection ---
  const now = Date.now();
  session.promptTimestamps = session.promptTimestamps || [];
  session.promptTimestamps.push(now);
  session.promptTimestamps = session.promptTimestamps.slice(-5);

  const isFlowState = session.promptTimestamps.length >= 3 &&
    (session.promptTimestamps[session.promptTimestamps.length - 1] -
     session.promptTimestamps[session.promptTimestamps.length - 3]) < 30000;

  if (isFlowState && prompt.length < 100) {
    log('query', 'info', 'flow-state detected, suppressing flashes');
    return { responseJson: {}, session };
  }

  // Extract keywords from prompt
  const keywords = prompt.split(/\s+/).filter(w => w.length > 3).map(w => w.toLowerCase());

  // Get prompt embedding for vector search (if available)
  let promptEmbedding = null;
  if (embeddingsAvailable()) {
    try {
      promptEmbedding = await getEmbedding(prompt.substring(0, 500));
      if (promptEmbedding) log('query', 'info', 'vector search active');
    } catch { /* fall back to keyword */ }
  }
  if (!promptEmbedding) {
    log('query', 'info', `keyword fallback: ${keywords.slice(0, 8).join(', ')}`);
  }

  // Run Neo4j daemon queries in parallel (with live decay scoring)
  const [keywordResults, graphResults, temporalResults, contradictionResults] = await Promise.all([
    // Vector daemon (primary) or keyword daemon (fallback)
    promptEmbedding
      ? runCypher(`
          CALL db.index.vector.queryNodes('neuron_embedding', 25, $embedding)
          YIELD node, score
          WITH node AS n, score AS vectorScore
          WHERE ${livePredicate('n')}
          WITH n, vectorScore,
               // Topology-aware decay: bridge nodes decay slower
               (CASE n.tier
                 WHEN 'T1_index' THEN 0.005
                 WHEN 'T2_working' THEN 0.02
                 ELSE 0.05
               END) * (1.0 / (1.0 + coalesce(n.bridge_score, 0))) AS lambda,
               duration.between(n.last_surfaced, datetime()).days AS daysSince
          WITH n, vectorScore,
               n.base_score * exp(-lambda * daysSince) AS liveDecay
          WHERE liveDecay > 10
          RETURN n.uid AS uid, n.name AS name, n.flash_summary AS flash, n.node_type AS type,
                 vectorScore * (liveDecay / 100.0) AS score,
                 'vector' AS daemon, n.community_id AS community_id,
                 n.project AS project, toString(n.event_date) AS event_date
          ORDER BY score DESC LIMIT 8
        `, { embedding: promptEmbedding, ns }).catch(e => { log('query', 'warn', `vector search failed: ${e.message}`); return []; })
      : runCypher(`
        UNWIND $keywords AS keyword
        MATCH (n:Neuron)
        WHERE toLower(n.flash_summary) CONTAINS keyword
        AND ${livePredicate('n')}
        WITH n, count(DISTINCT keyword) AS hits
        WITH n, hits,
             CASE n.tier
               WHEN 'T1_index' THEN 0.005
               WHEN 'T2_working' THEN 0.02
               ELSE 0.05
             END AS lambda,
             duration.between(n.last_surfaced, datetime()).days AS daysSince
        WITH n, hits,
             n.base_score * exp(-lambda * daysSince) AS liveDecay
        WHERE liveDecay > 10
        RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
               toFloat(hits) / $keywordCount * (liveDecay / 100.0) AS score,
               'keyword' AS daemon
        ORDER BY score DESC LIMIT 5
      `, { keywords, keywordCount: neo4j.int(keywords.length), ns }).catch(e => { log('query', 'error', 'keyword search failed', { detail: e.message }); return []; }),

    // Graph daemon: 2-hop from active topics with decay
    session.activeTopics.length > 0
      ? runCypher(`
          UNWIND $topics AS topicName
          MATCH (start:Neuron {name: topicName})-[s:SYNAPSE*1..2]-(related:Neuron)
          WHERE related.name <> topicName
          AND ${livePredicate('start')}
          AND ${livePredicate('related')}
          AND ALL(r IN s WHERE r.weight > 0.3)
          WITH DISTINCT related,
               reduce(w = 1.0, r IN s | w * r.weight) AS pathWeight,
               CASE related.tier
                 WHEN 'T1_index' THEN 0.005
                 WHEN 'T2_working' THEN 0.02
                 ELSE 0.05
               END AS lambda,
               duration.between(related.last_surfaced, datetime()).days AS daysSince
          WITH related, pathWeight,
               related.base_score * exp(-lambda * daysSince) AS liveDecay
          WHERE liveDecay > 10
          RETURN related.name AS name, related.flash_summary AS flash,
                 related.node_type AS type,
                 pathWeight * (liveDecay / 100.0) AS score,
                 'graph' AS daemon
          ORDER BY score DESC LIMIT 5
        `, { topics: session.activeTopics.slice(0, 5), ns }).catch(() => [])
      : Promise.resolve([]),

    // Temporal daemon: recent episodes with decay
    runCypher(`
        MATCH (n:Neuron)
        WHERE n.node_type = 'episode' AND ${livePredicate('n')}
        WITH n,
             CASE n.tier
               WHEN 'T1_index' THEN 0.005
               WHEN 'T2_working' THEN 0.02
               ELSE 0.05
             END AS lambda,
             duration.between(n.last_surfaced, datetime()).days AS daysSince
        WITH n, n.base_score * exp(-lambda * daysSince) AS liveDecay
        WHERE liveDecay > 15
        RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
               liveDecay / 100.0 AS score, 'temporal' AS daemon,
               toString(n.event_date) AS event_date
        ORDER BY n.last_surfaced DESC LIMIT 3
      `, { ns }).catch(() => []),

    // Contradiction daemon: find facts that might conflict with the prompt
    keywords.length > 2
      ? runCypher(`
          UNWIND $keywords AS keyword
          MATCH (n:Neuron)
          WHERE n.node_type IN ['fact', 'insight', 'decision']
          AND ${livePredicate('n')}
          AND toLower(n.flash_summary) CONTAINS keyword
          WITH n, count(DISTINCT keyword) AS hits
          WHERE hits >= 1
          RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
                 0.5 AS score, 'contradiction' AS daemon
          ORDER BY hits DESC LIMIT 3
        `, { keywords, ns }).catch(() => [])
      : Promise.resolve([])
  ]);

  // Lexical daemon: BM25 over full neuron text — the hybrid half of retrieval
  // (eval 2026-09-01: lexical beat summary-only vectors on literal queries)
  let lexicalResults = [];
  try {
    lexicalResults = await lexicalSearch({ prompt, runCypher, ns });
    if (lexicalResults.length) log('query', 'info', `lexical hits: ${lexicalResults.length}`);
  } catch (e) {
    log('query', 'warn', `lexical daemon error: ${e.message}`);
  }

  // Query-seeded graph expansion (added 2026-09-01): expand one hop through
  // SYNAPSE edges from THIS turn's strongest vector/lexical hits, so chained
  // associations ride along with direct matches. (The existing graph daemon
  // expands from session.activeTopics — topic continuity; this one expands
  // from the current query — multi-hop association.)
  let expansionResults = [];
  const seedNames = [...keywordResults, ...lexicalResults].slice(0, 6).map((r) => r.name).filter(Boolean);
  if (seedNames.length) {
    expansionResults = await runCypher(`
      UNWIND $seeds AS s
      MATCH (seed:Neuron {name: s})-[e:SYNAPSE]-(related:Neuron)
      WHERE ${livePredicate('seed')} AND ${livePredicate('related')} AND e.weight > 0.3 AND NOT related.name IN $seeds
      WITH DISTINCT related, max(e.weight) AS w,
           CASE related.tier WHEN 'T1_index' THEN 0.005 WHEN 'T2_working' THEN 0.02 ELSE 0.05 END AS lambda,
           duration.between(related.last_surfaced, datetime()).days AS daysSince
      WITH related, w, related.base_score * exp(-lambda * daysSince) AS liveDecay
      WHERE liveDecay > 10
      RETURN related.name AS name, related.flash_summary AS flash, related.node_type AS type,
             w * 0.8 * (liveDecay / 100.0) AS score, 'graph-query' AS daemon,
             related.community_id AS community_id, related.project AS project
      ORDER BY score DESC LIMIT 5
    `, { seeds: seedNames, ns }).catch(() => []);
    if (expansionResults.length) log('query', 'info', `graph expansion: +${expansionResults.length} from ${seedNames.length} seeds`);
  }

  // Multi-hop query decomposition (Wave 1, 2026-09-01): compound prompts get
  // split into sub-queries so the retrieval union covers each hop separately.
  // Simple prompts skip the extra Haiku call entirely — zero added latency
  // for the common case.
  let subqueryResults = [];
  const impulseConfig = getDaemonConfig('impulse') || {};
  const looksCompound = prompt.length > 100 && prompt.split(/\s+/).length > 15 &&
    /\b(and|then|after|before|because|who|which|while)\b|,/i.test(prompt);
  if (impulseConfig.decomposeQueries !== false && looksCompound) {
    try {
      const d = await callAnthropic(QUERY_MODEL,
        'Split the user prompt into 1-3 short search queries, each targeting ONE distinct fact needed to answer it. Return ONLY JSON: {"queries": ["..."]}. If the prompt is a single simple question, return it alone.',
        prompt.substring(0, 600), 200);
      const dText = d?.response?.content?.[0]?.text || '{}';
      const dMatch = dText.match(/\{[\s\S]*\}/);
      const extras = ((dMatch ? JSON.parse(dMatch[0]) : {}).queries || [])
        .filter((q) => typeof q === 'string' && q.length > 3).slice(0, 3);
      if (extras.length > 1) {
        log('query', 'info', `decomposed into ${extras.length} sub-queries`);
        for (const sq of extras) {
          const sqEmb = embeddingsAvailable() ? await getEmbedding(sq.substring(0, 300)).catch(() => null) : null;
          if (sqEmb) {
            const rows = await runCypher(`
              CALL db.index.vector.queryNodes('neuron_embedding', 10, $embedding)
              YIELD node, score
              WITH node AS n, score AS vectorScore
              WHERE ${livePredicate('n')} AND vectorScore > 0.5
              RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
                     vectorScore * 0.7 AS score, 'subquery' AS daemon,
                     n.community_id AS community_id, n.project AS project
              ORDER BY score DESC LIMIT 4
            `, { embedding: sqEmb, ns }).catch(() => []);
            subqueryResults.push(...rows);
          }
          const lexRows = await lexicalSearch({ prompt: sq, runCypher, ns, k: 4 }).catch(() => []);
          subqueryResults.push(...lexRows.map((r) => ({ ...r, daemon: 'subquery', score: (r.score || 0) * 0.7 })));
        }
      }
    } catch (e) {
      log('query', 'warn', `decomposition failed: ${e.message}`);
    }
  }

  // Opus daemon: serve pre-warmed flashes (prepared between turns)
  // Wonder pre-warms from the live graph only — skip it for namespaced sessions.
  let wonderResults = [];
  if (!ns && isDaemonEnabled('wonder')) {
    try {
      wonderResults = await wonder.query({ prompt, session, sessionId: session_id, cwd, log });
    } catch (e) {
      log('query', 'warn', `wonder daemon error: ${e.message}`);
    }
  }

  // Research daemon: Brave web search on adjacent topics
  let researchResults = [];
  if (isDaemonEnabled('prowler')) {
    try {
      researchResults = await prowler.query({
        prompt, keywords, session,
        callAnthropic, config: getDaemonConfig('prowler'), log
      });
    } catch (e) {
      log('query', 'warn', `prowler daemon error: ${e.message}`);
    }
  }

  // Combine and deduplicate results — wonder first (pre-warmed), then reactive daemons
  const allResults = [...wonderResults, ...keywordResults, ...lexicalResults, ...subqueryResults, ...expansionResults, ...graphResults, ...temporalResults, ...contradictionResults, ...researchResults];
  const seen = new Set();
  const unique = allResults.filter(r => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });

  // Domain scoring: boost same-project neurons, mark cross-project ones
  if (session.currentProject) {
    for (const r of unique) {
      r.inProject = isNeuronInProject(r, session.currentProject);
      if (r.inProject) {
        r.score = (r.score || 0) * 1.5;
      } else {
        r.score = (r.score || 0) * 0.6;
      }
    }
  }

  // Diversity enforcement: if top candidates cluster in one community, boost outliers
  const communityCount = {};
  for (const r of unique) {
    const cid = r.community_id || 'unknown';
    communityCount[cid] = (communityCount[cid] || 0) + 1;
  }
  const dominantCommunity = Object.entries(communityCount).sort((a, b) => b[1] - a[1])[0];
  if (dominantCommunity && dominantCommunity[1] > unique.length * 0.6) {
    // One community dominates >60% of results — boost others
    for (const r of unique) {
      if ((r.community_id || 'unknown') !== dominantCommunity[0]) {
        r.score = (r.score || 0) * 1.3; // 30% diversity boost for minority communities
      }
    }
    log('query', 'info', `diversity boost: community ${dominantCommunity[0]} dominated ${dominantCommunity[1]}/${unique.length}`);
  }

  // Re-sort by adjusted score
  unique.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Track retrieval diversity for health monitoring
  session.retrievalCounts = session.retrievalCounts || {};
  for (const r of unique) {
    session.retrievalCounts[r.name] = (session.retrievalCounts[r.name] || 0) + 1;
  }

  // Log daemon hit counts
  const daemonCounts = {};
  allResults.forEach(r => { daemonCounts[r.daemon] = (daemonCounts[r.daemon] || 0) + 1; });
  log('query', 'info', 'daemon hits', { detail: JSON.stringify(daemonCounts) });

  // Log candidate neurons for flash monitor visibility
  if (unique.length > 0) {
    log('query', 'info', 'candidates', {
      detail: unique.map(r => `[${r.daemon}] ${r.name}: ${(r.flash || '').substring(0, 80)}`).join(' || ')
    });
  }

  if (unique.length === 0) {
    return { responseJson: {}, session };
  }

  // RAW MODE: skip Haiku entirely, just return neuron data
  if (flashMode === 'raw') {
    const rawNeurons = unique.slice(0, 8).map(r =>
      `  [${r.type}] ${r.name}: ${r.flash} (${r.daemon})` +
      `\n    -> Query: MATCH (n:Neuron {name: "${r.name.replace(/"/g, '\\"')}"})-[s:SYNAPSE]-(connected) RETURN n, s, connected`
    ).join('\n');

    const elapsed = Date.now() - startTime;
    const flashBlock = `[UNDERTOW-FLASH] (${unique.length} raw neurons, ${elapsed}ms, no Haiku)\nRaw neurons:\n${rawNeurons}`;

    log('query', 'info', `completed in ${elapsed}ms (raw mode)`, {
      detail: `${unique.length} neurons`,
      elapsed,
      flashCount: unique.length,
      candidateCount: unique.length,
      prompt: prompt.substring(0, 100),
      session_id: session_id || 'default'
    });

    // Still track for pursuit detection
    session.pendingFlashes.push({
      turn: Date.now(),
      flashes: unique.map(r => r.flash),
      sourceNeurons: unique.map(r => r.name),
      neuronDomains: unique.reduce((acc, r) => { acc[r.name] = r.inProject !== false; return acc; }, {}),
      neuronDaemons: unique.reduce((acc, r) => { acc[r.name] = r.daemon || 'impulse'; return acc; }, {})
    });

    const rawResult = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: flashBlock } };
    setCachedQuery(prompt, cacheScope, rawResult);
    return { responseJson: rawResult, session };
  }

  // HAIKU / BOTH MODE: Ask Haiku to judge and craft flashes
  const queryResult = await callAnthropic(QUERY_MODEL, QUERY_SYSTEM_PROMPT, `User prompt: "${prompt.substring(0, 500)}"

Working directory: ${cwd || 'unknown'}
Active topics: ${session.activeTopics.join(', ') || 'none'}

Candidate memories from graph search:
${unique.map(r => `- [${r.type}] ${r.name}: ${r.flash}${r.event_date ? ` (on ${r.event_date})` : ''}`).join('\n')}

Evaluate these candidates. Which are worth surfacing? Craft flash summaries for the relevant ones. Return JSON.`);
  if (!queryResult) return { responseJson: {}, session };
  const message = queryResult.response;

  const responseText = message.content[0]?.text || '{}';
  let parsed;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { flashes: [], topics_detected: [] };
  } catch {
    parsed = { flashes: [], topics_detected: [] };
  }

  // Update session state
  if (parsed.topics_detected?.length) {
    session.activeTopics = [...new Set([...parsed.topics_detected, ...session.activeTopics])].slice(0, 10);
  }

  // Store pending flashes for pursuit detection (with domain + daemon attribution)
  if (parsed.flashes?.length) {
    session.pendingFlashes.push({
      turn: Date.now(),
      flashes: parsed.flashes,
      sourceNeurons: unique.map(r => r.name),
      neuronDomains: unique.reduce((acc, r) => { acc[r.name] = r.inProject !== false; return acc; }, {}),
      neuronDaemons: unique.reduce((acc, r) => { acc[r.name] = r.daemon || 'impulse'; return acc; }, {})
    });
  }

  const elapsed = Date.now() - startTime;
  const flashCount = parsed.flashes?.length || 0;

  log('query', 'info', `completed in ${elapsed}ms`, {
    detail: `${flashCount} flashes, ${unique.length} candidates`,
    elapsed,
    flashCount,
    candidateCount: unique.length,
    prompt: prompt.substring(0, 100),
    session_id: session_id || 'default'
  });

  // Build the flash block based on mode — include neuron names as handles for graph exploration
  const rawNeurons = unique.slice(0, 8).map(r =>
    `  [${r.type}] ${r.name}: ${r.flash} (${r.daemon})`
  ).join('\n');
  const neuronHandles = `Neuron handles: ${unique.slice(0, 8).map(r => `"${r.name}"${r.uid ? ` [${r.uid.substring(0, 8)}]` : ''}`).join(', ')}`;

  if (flashCount > 0 || unique.length > 0) {
    let flashBlock = `[UNDERTOW-FLASH] (${flashCount} flashes from ${unique.length} candidates, ${elapsed}ms)`;

    // Haiku's interpreted flashes (haiku or both mode)
    if (flashCount > 0) {
      flashBlock += `\nHaiku interpretation:\n${parsed.flashes.join('\n')}`;
    }

    // Raw neuron data for Opus (both mode only) — includes handles for graph exploration
    if (flashMode === 'both' && unique.length > 0) {
      flashBlock += `\nRaw neurons:\n${rawNeurons}`;
      flashBlock += `\n${neuronHandles}`;
    }

    log('query', 'info', 'flashes injected', {
      detail: parsed.flashes.join(' | ')
    });
    log('injection', 'info', 'CONTEXT INJECTED', { detail: flashBlock });

    const haikuResult = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: flashBlock } };
    setCachedQuery(prompt, cacheScope, haikuResult);
    return { responseJson: haikuResult, session };
  }

  log('query', 'info', 'no flashes to inject');
  setCachedQuery(prompt, cacheScope, {}); // Cache empty results too — don't re-run for nothing
  return { responseJson: {}, session };
}

export { QUERY_SYSTEM_PROMPT, handleQuery, mapCwdToProject, isNeuronInProject };
