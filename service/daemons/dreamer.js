// dreamer.js — Dreamer daemon (turn processing, session start, rehydration)
// Extracted from server.js — no behavior changes

import { readFile } from 'fs/promises';

const QUERY_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARIZE_MODEL = 'claude-sonnet-4-6';

const SUMMARIZE_SYSTEM_PROMPT = `You are Undertow's turn summarizer. Review what happened and extract ONLY what matters for long-term memory.

CRITICAL RULES:
- Most turns produce ZERO neurons. That is correct and expected.
- Only create a neuron if you can write a meaningful body with 2-5 sentences of real content.
- NEVER create neurons for: tool usage, git operations, file reads, hook events, status confirmations, conversation flow ("user agreed", "agent proceeded"), or anything that is just "X happened".
- A neuron is a KNOWLEDGE UNIT — a fact, concept, decision, or insight with substance.

TRAIN OF THOUGHT:
- Use CONCEPTUAL topic names, not action labels.
- BAD: "Git commit pushed", "PostToolUse hook fired", "Tool result confirmation"
- GOOD: "YourProject auth architecture", "Neo4j scaling strategy", "Daemon plugin design"
- If the turn was routine (debugging, file edits, small fixes), return an EMPTY train.

PURSUIT DETECTION:
- "pursued" = the agent's response clearly referenced, built on, or asked about the flash content
- "dismissed" = the agent ignored the flash entirely
- If the agent used information from the flash without quoting it, that's still "pursued"

Return JSON:
{
  "insights": [
    {"name": "2-5 word label", "node_type": "fact|concept|decision|insight", "tier": "T2_working", "flash_summary": "one sentence <100 chars", "body": "2-5 sentences of real content", "connections": []}
  ],
  "updates": [
    {"existing_name": "neuron to update", "flash_summary": "new summary", "body": "new body", "reason": "what changed"}
  ],
  "train_of_thought": ["conceptual topic 1", "conceptual topic 2"],
  "flash_results": [
    {"flash_text": "...", "status": "pursued" | "dismissed"}
  ]
}

Empty arrays are the right answer most of the time. Zero insights, empty train, zero updates = a routine turn correctly assessed.`;

const SESSION_START_SYSTEM_PROMPT = `You are Undertow. A new session is starting. Given the working directory and the T1 index neurons from the memory graph, select the most relevant memories for this session context.

Return a concise context block (max 300 tokens) formatted as:
Undertow context:
- [memory 1]
- [memory 2]
...

Only include memories that are likely relevant to the working directory or recent activity. Skip generic/stale memories.`;

// --- Summarize handler (Stop hook) ---

async function handleSummarize({ req_body, session, runCypher, callAnthropic, embedNeuron, randomUUID, isDaemonEnabled, getDaemonConfig, wonder, spider, janitor, prowler, log }) {
  const { session_id, transcript_path, cwd } = req_body;

  // Read transcript if available
  let transcript = '';
  if (transcript_path) {
    try {
      const raw = await readFile(transcript_path, 'utf8');
      transcript = raw.slice(-2000);
    } catch {
      transcript = '[transcript unavailable]';
    }
  }

  // Get recent pending flashes for pursuit detection
  const recentFlashes = session.pendingFlashes
    .filter(f => Date.now() - f.turn < 10 * 60 * 1000)
    .flatMap(f => f.flashes);

  const result = await callAnthropic(SUMMARIZE_MODEL, SUMMARIZE_SYSTEM_PROMPT, `Transcript excerpt (end of turn):
${transcript}

Flashes that were injected this turn:
${recentFlashes.length > 0 ? recentFlashes.join('\n') : '[none]'}

Analyze this turn. Return JSON with insights, train_of_thought, and flash_results.`, 1000);

  if (!result) return;
  const message = result.response;
  if (result.model !== SUMMARIZE_MODEL) {
    log('summarize', 'warn', `used fallback model: ${result.model}`);
  }

  const responseText = message.content[0]?.text || '{}';
  let parsed;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    return;
  }

  // Process updates to existing neurons
  if (parsed.updates?.length) {
    for (const upd of parsed.updates) {
      const setClauses = ['n.last_surfaced = datetime()', 'n.updated_at = datetime()'];
      const params = { name: upd.existing_name };

      if (upd.flash_summary) {
        setClauses.push('n.flash_summary = $flash');
        params.flash = upd.flash_summary;
      }
      if (upd.body) {
        setClauses.push('n.body = $body');
        params.body = upd.body;
      }

      await runCypher(
        `MATCH (n:Neuron {name: $name}) SET ${setClauses.join(', ')} RETURN n.name`,
        params
      ).catch(e => log('error', 'warn', e.message));

      log('summarize', 'info', `UPDATED: ${upd.existing_name}`, {
        detail: `reason: ${upd.reason || 'not specified'}`
      });
    }
  }

  // Create insight neurons
  if (parsed.insights?.length) {
    for (const insight of parsed.insights) {
      const existing = await runCypher(
        'MATCH (n:Neuron {name: $name}) RETURN n.name LIMIT 1',
        { name: insight.name }
      );
      if (existing.length === 0) {
        await runCypher(`
            CREATE (n:Neuron {
              uid: $uid, name: $name, node_type: $type, tier: $tier,
              flash_summary: $flash, body: $body,
              source: 'conversation', decay_score: 50, base_score: 50,
              times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
              created_at: datetime(), last_surfaced: datetime()
            })
          `, {
          uid: randomUUID(), name: insight.name, type: insight.node_type || 'insight',
          tier: insight.tier || 'T2_working', flash: insight.flash_summary,
          body: insight.body || ''
        });

        // Create connections for insights
        if (insight.connections?.length) {
          for (const conn of insight.connections) {
            await runCypher(`
                MATCH (src:Neuron {name: $src})
                MATCH (tgt:Neuron {name: $tgt})
                CREATE (src)-[:SYNAPSE {
                  weight: $weight, edge_type: $edgeType,
                  context: $context, created_at: datetime()
                }]->(tgt)
              `, {
              src: insight.name, tgt: conn.target_name,
              weight: conn.weight || 0.5, edgeType: conn.edge_type || 'associative',
              context: conn.context || ''
            }).catch(e => log('error', 'warn', e.message));
          }
        }
        log('summarize', 'info', `insight: ${insight.name}`);
        embedNeuron(insight.name, insight.flash_summary).catch(e => log('error', 'warn', e.message));
      }
    }
  }

  // Record train of thought
  if (parsed.train_of_thought?.length > 1) {
    const topics = parsed.train_of_thought;
    for (let i = 0; i < topics.length - 1; i++) {
      // Ensure topic neurons exist
      for (const topic of [topics[i], topics[i + 1]]) {
        const exists = await runCypher(
          'MATCH (n:Neuron {name: $name}) RETURN n.name LIMIT 1',
          { name: topic }
        );
        if (exists.length === 0) {
          await runCypher(`
              CREATE (n:Neuron {
                uid: $uid, name: $name, node_type: 'topic', tier: 'T1_index',
                flash_summary: $name, body: '',
                source: 'conversation', decay_score: 50, base_score: 50,
                times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
                created_at: datetime(), last_surfaced: datetime()
              })
            `, { name: topic, uid: randomUUID() });
        }
      }

      // Create temporal synapse
      await runCypher(`
          MATCH (a:Neuron {name: $src})
          MATCH (b:Neuron {name: $tgt})
          CREATE (a)-[:SYNAPSE {
            weight: 0.5, edge_type: 'temporal',
            context: 'Train of thought progression', created_at: datetime()
          }]->(b)
        `, { src: topics[i], tgt: topics[i + 1] }).catch(e => log('error', 'warn', e.message));
    }
    log('summarize', 'info', `train: ${topics.join(' → ')}`);
  }

  // Process pursuit/dismissal (with fair domain scoring)
  if (parsed.flash_results?.length) {
    for (const fr of parsed.flash_results) {
      // Find which neurons were associated with this flash
      const flashEntry = session.pendingFlashes.find(
        pf => pf.flashes.some(f => f === fr.flash_text)
      );
      if (!flashEntry) continue;

      // Track which neurons have already been reinforced this session (consolidation window)
      session.pursuedThisSession = session.pursuedThisSession || new Set();

      for (const neuronName of flashEntry.sourceNeurons) {
        const isInDomain = flashEntry.neuronDomains?.[neuronName] !== false;
        const contributingDaemon = flashEntry.neuronDaemons?.[neuronName] || 'impulse';

        if (fr.status === 'pursued') {
          // Consolidation window: only reinforce score/weights once per session per neuron
          const alreadyReinforced = session.pursuedThisSession.has(neuronName);

          await runCypher(`
              MATCH (n:Neuron {name: $name})
              SET n.times_pursued = n.times_pursued + 1,
                  n.base_score = CASE WHEN $reinforce THEN n.base_score + 10 ELSE n.base_score END,
                  n.last_surfaced = datetime()
            `, { name: neuronName, reinforce: !alreadyReinforced }).catch(e => log('error', 'warn', e.message));

          // Per-daemon pursuit counter
          await runCypher(`
              MERGE (d:DaemonStat {name: $daemon})
              ON CREATE SET d.pursued = 1, d.dismissed = 0
              ON MATCH SET d.pursued = coalesce(d.pursued, 0) + 1
            `, { daemon: contributingDaemon }).catch(e => log('error', 'warn', e.message));

          if (!alreadyReinforced) {
            // Strengthen outbound synapses only (directional reinforcement)
            await runCypher(`
                MATCH (n:Neuron {name: $name})-[s:SYNAPSE]->()
                SET s.weight = CASE WHEN s.weight + 0.05 > 0.95 THEN 0.95 ELSE s.weight + 0.05 END
              `, { name: neuronName }).catch(e => log('error', 'warn', e.message));
            session.pursuedThisSession.add(neuronName);

            // Interference suppression: neurons in the same community
            await runCypher(`
                MATCH (pursued:Neuron {name: $name})
                WHERE pursued.community_id IS NOT NULL
                MATCH (similar:Neuron)
                WHERE similar.community_id = pursued.community_id
                AND similar.name <> pursued.name
                AND similar.name IN $otherNeurons
                SET similar.base_score = CASE WHEN similar.base_score > 5 THEN similar.base_score - 2 ELSE similar.base_score END
              `, { name: neuronName, otherNeurons: flashEntry.sourceNeurons }).catch(e => log('error', 'warn', e.message));
          }
        } else if (isInDomain) {
          // FAIR DISMISSAL: Only penalize if neuron is from the same project
          await runCypher(`
              MATCH (n:Neuron {name: $name})
              SET n.times_dismissed = n.times_dismissed + 1,
                  n.last_surfaced = datetime()
            `, { name: neuronName }).catch(e => log('error', 'warn', e.message));

          // Per-daemon dismissal counter (same-domain only — cross-project skips
          // are intentionally not counted against the daemon)
          await runCypher(`
              MERGE (d:DaemonStat {name: $daemon})
              ON CREATE SET d.pursued = 0, d.dismissed = 1
              ON MATCH SET d.dismissed = coalesce(d.dismissed, 0) + 1
            `, { daemon: contributingDaemon }).catch(e => log('error', 'warn', e.message));

          // Weaken related synapses (same-project dismissal only)
          await runCypher(`
              MATCH (n:Neuron {name: $name})-[s:SYNAPSE]-()
              SET s.weight = CASE WHEN s.weight - 0.02 < 0.0 THEN 0.0 ELSE s.weight - 0.02 END
            `, { name: neuronName }).catch(e => log('error', 'warn', e.message));
        } else {
          // Cross-project dismissal — neutral skip, no penalty
          log('summarize', 'info', `pursuit: ○ skip (cross-project) "${neuronName.substring(0, 50)}"`, { detail: 'no penalty — wrong domain' });
        }
      }
    }
    // Log each flash result individually so the monitor shows what happened
    for (const fr of parsed.flash_results) {
      const flashPreview = (fr.flash_text || '').substring(0, 80);
      if (fr.status === 'pursued') {
        log('summarize', 'info', `pursuit: ✓ "${flashPreview}"`, { detail: 'base_score +10, synapses strengthened' });
      } else {
        log('summarize', 'info', `pursuit: ✗ "${flashPreview}"`, { detail: 'same-domain dismissal — times_dismissed +1' });
      }
    }
    log('summarize', 'info', `pursuit detection: ${parsed.flash_results.length} flashes evaluated`);
  }

  // Update active topics
  if (parsed.train_of_thought?.length) {
    session.activeTopics = [...new Set([...parsed.train_of_thought, ...session.activeTopics])].slice(0, 10);
  }

  // Opus daemon: prepare flashes for next turn using full transcript context
  if (isDaemonEnabled('wonder')) {
    log('summarize', 'info', 'triggering wonder daemon');
    wonder.prepare({
      session, transcriptPath: transcript_path, cwd, sessionId: session_id,
      runCypher, callAnthropic, log
    }).catch(e => {
      log('wonder', 'error', `wonder prepare failed: ${e.message}`);
    });
  }

  // Run downstream daemons at session end
  const spiderConfig = getDaemonConfig('spider');
  if (isDaemonEnabled('spider') && spiderConfig.schedule === 'session-end') {
    log('summarize', 'info', 'triggering spider daemon');
    spider.run({ runCypher, callAnthropic, config: spiderConfig, log }).catch(e => {
      log('spider', 'error', `spider failed during summarize: ${e.message}`);
    });
  }

  // Janitor daemon — clean up garbage neurons
  if (isDaemonEnabled('janitor')) {
    janitor.run({ runCypher, log }).catch(e => {
      log('janitor', 'error', `janitor failed: ${e.message}`);
    });
  }

  // Perplexity deep research — feeds the graph with research on session topics
  if (isDaemonEnabled('prowler') && session.activeTopics.length > 0) {
    log('summarize', 'info', 'triggering prowler daemon');
    prowler.deepResearch({ topics: session.activeTopics, runCypher, log }).catch(e => {
      log('prowler', 'error', `prowler failed: ${e.message}`);
    });
  }
}

// --- Session-start handler (SessionStart hook) ---

async function handleSessionStart({ req_body, session, runCypher, callAnthropic, log }) {
  const { cwd } = req_body;

  // Load T1 neurons
  const t1Neurons = await runCypher(`
      MATCH (n:Neuron)
      WHERE n.tier = 'T1_index' AND n.decay_score > 20
      RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type
      ORDER BY n.decay_score DESC LIMIT 20
    `);

  if (t1Neurons.length === 0) {
    return { responseJson: {} };
  }

  const startResult = await callAnthropic(QUERY_MODEL, SESSION_START_SYSTEM_PROMPT, `Working directory: ${cwd || 'unknown'}

T1 index neurons:
${t1Neurons.map(n => `- [${n.type}] ${n.name}: ${n.flash}`).join('\n')}

Select the most relevant memories for this session.`, 400);
  if (!startResult) return { responseJson: {} };

  const responseText = startResult.response.content[0]?.text || '';
  if (responseText.trim()) {
    log('session-start', 'info', 'T1 context injected', { detail: responseText.substring(0, 200) });
    return {
      responseJson: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[UNDERTOW-SESSION-START]\n${responseText}` } }
    };
  } else {
    log('session-start', 'info', 'no relevant T1 context');
    return { responseJson: {} };
  }
}

// --- Rehydrate handler (PostCompact hook) ---

async function handleRehydrate({ req_body, session, runCypher, log }) {
  if (session.activeTopics.length === 0) {
    return { responseJson: {} };
  }

  const relevant = await runCypher(`
      UNWIND $topics AS topicName
      MATCH (n:Neuron)
      WHERE n.name = topicName OR n.flash_summary CONTAINS topicName
      RETURN DISTINCT n.name AS name, n.flash_summary AS flash, n.decay_score AS score
      ORDER BY score DESC LIMIT 10
    `, { topics: session.activeTopics });

  if (relevant.length === 0) {
    return { responseJson: {} };
  }

  const context = `[UNDERTOW-REHYDRATE] Re-injecting ${relevant.length} memories after compaction:\n${relevant.map(r => `- ${r.name}: ${r.flash}`).join('\n')}`;
  log('rehydrate', 'info', `re-injected ${relevant.length} memories`);
  return {
    responseJson: { hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: context } }
  };
}

export { SUMMARIZE_SYSTEM_PROMPT, SESSION_START_SYSTEM_PROMPT, handleSummarize, handleSessionStart, handleRehydrate };
