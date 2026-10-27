// dreamer.js — Dreamer daemon (turn processing, session start, rehydration)
// Extracted from server.js — no behavior changes

import { readFile } from 'fs/promises';
import { nsPredicate, livePredicate } from '../namespaces.js';
import { supersedeNeuron } from '../supersede.js';
import { stripUndertowInjections } from '../strip-injections.js';
import { coerceNodeType } from './gobble.js';
import { verdictToOutcome, flagNeuronForReview, applyVerdictToNeuron } from './curated.js';

const QUERY_MODEL = 'claude-haiku-5-5';
const SUMMARIZE_MODEL = 'claude-sonnet-5';

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
    {"name": "2-5 word label", "node_type": "fact|concept|decision|insight", "tier": "T2_working", "flash_summary": "one sentence <100 chars", "body": "2-5 sentences of real content", "event_date": "YYYY-MM-DD only when the remembered event has a clear date; omit otherwise", "connections": []}
  ],
  "updates": [
    {"existing_name": "neuron to update", "flash_summary": "new summary", "body": "new body", "reason": "what changed", "event_date": "YYYY-MM-DD optional"}
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

// Ouroboros guard (2026-09-02): lives in ../strip-injections.js so historical
// ingestion shares it — see that module for why.

// --- Summarize handler (Stop hook) ---

async function handleSummarize({ req_body, session, runCypher, callAnthropic, embedNeuron, randomUUID, isDaemonEnabled, getDaemonConfig, wonder, spider, janitor, prowler, log, skipWonder = false }) {
  const { session_id, transcript_path, cwd } = req_body;

  // Namespace isolation: writes and reinforcement stay inside the session's
  // declared namespace (null = live graph).
  const ns = req_body.namespace ?? session.namespace ?? null;
  if (ns) session.namespace = ns;

  // Read transcript if available
  let transcript = '';
  if (transcript_path) {
    try {
      const raw = await readFile(transcript_path, 'utf8');
      transcript = stripUndertowInjections(raw).slice(-2000);
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

  // Process updates to existing neurons — supersession, not overwrite:
  // the old version is archived and linked via SUPERSEDES.
  if (parsed.updates?.length) {
    for (const upd of parsed.updates) {
      const superseded = await supersedeNeuron({
        runCypher, callAnthropic, randomUUID, log,
        name: upd.existing_name, ns,
        flash: upd.flash_summary, body: upd.body,
        eventDate: upd.event_date || null,
        reason: upd.reason || 'updated at turn summarize'
      });
      if (superseded) {
        log('summarize', 'info', `SUPERSEDED: ${upd.existing_name}`, {
          detail: `reason: ${upd.reason || 'not specified'}`
        });
        embedNeuron(upd.existing_name, upd.flash_summary || '').catch(e => log('error', 'warn', e.message));
      }
    }
  }

  // Create insight neurons
  if (parsed.insights?.length) {
    for (const insight of parsed.insights) {
      const existing = await runCypher(
        `MATCH (n:Neuron {name: $name}) WHERE ${nsPredicate('n')} RETURN n.name LIMIT 1`,
        { name: insight.name, ns }
      );
      if (existing.length === 0) {
        const eventDate = typeof insight.event_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(insight.event_date) ? insight.event_date : null;
        await runCypher(`
            CREATE (n:Neuron {
              uid: $uid, name: $name, node_type: $type, tier: $tier,
              flash_summary: $flash, body: $body,
              source: 'conversation', decay_score: 50, base_score: 50,
              times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
              created_at: datetime(), last_surfaced: datetime(),
              namespace: $ns,
              event_date: CASE WHEN $eventDate IS NULL THEN NULL ELSE date($eventDate) END
            })
          `, {
          uid: randomUUID(), name: insight.name, type: coerceNodeType(insight.node_type, 'insight'),
          tier: insight.tier || 'T2_working', flash: insight.flash_summary,
          body: insight.body || '', ns, eventDate
        });

        // Create connections for insights
        if (insight.connections?.length) {
          for (const conn of insight.connections) {
            await runCypher(`
                MATCH (src:Neuron {name: $src})
                WHERE ${nsPredicate('src')}
                MATCH (tgt:Neuron {name: $tgt})
                WHERE ${nsPredicate('tgt')}
                CREATE (src)-[:SYNAPSE {
                  weight: $weight, edge_type: $edgeType,
                  context: $context, created_at: datetime()
                }]->(tgt)
              `, {
              src: insight.name, tgt: conn.target_name, ns,
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
          `MATCH (n:Neuron {name: $name}) WHERE ${nsPredicate('n')} RETURN n.name LIMIT 1`,
          { name: topic, ns }
        );
        if (exists.length === 0) {
          await runCypher(`
              CREATE (n:Neuron {
                uid: $uid, name: $name, node_type: 'topic', tier: 'T1_index',
                flash_summary: $name, body: '',
                source: 'conversation', decay_score: 50, base_score: 50,
                times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
                created_at: datetime(), last_surfaced: datetime(),
                namespace: $ns
              })
            `, { name: topic, uid: randomUUID(), ns });
        }
      }

      // Create temporal synapse
      await runCypher(`
          MATCH (a:Neuron {name: $src})
          WHERE ${nsPredicate('a')}
          MATCH (b:Neuron {name: $tgt})
          WHERE ${nsPredicate('b')}
          CREATE (a)-[:SYNAPSE {
            weight: 0.5, edge_type: 'temporal',
            context: 'Train of thought progression', created_at: datetime()
          }]->(b)
        `, { src: topics[i], tgt: topics[i + 1], ns }).catch(e => log('error', 'warn', e.message));
    }
    log('summarize', 'info', `train: ${topics.join(' → ')}`);
  }

  // Explicit feedback (POST /undertow/feedback) is ground truth and overrides Sonnet's
  // inference for the neurons it names. If Sonnet returned no flash_result covering a
  // fed-back neuron, add a synthetic one so the normal pursuit/dismissal path below
  // still applies it (synthetic results touch ONLY the fed-back neurons).
  const feedbackDone = new Set();
  const fbEntries = Object.entries(session.explicitFeedback || {});
  if (fbEntries.length) {
    parsed.flash_results = Array.isArray(parsed.flash_results) ? parsed.flash_results : [];
    for (const [fbName, fb] of fbEntries) {
      const outcome = verdictToOutcome(fb.verdict);
      if (!outcome) { delete session.explicitFeedback[fbName]; continue; }
      const entry = [...session.pendingFlashes].reverse().find(pf => pf.sourceNeurons.includes(fbName));
      if (!entry) {
        // Nothing to route through the pursuit path (flash entry gone): apply directly.
        await applyVerdictToNeuron({ runCypher, name: fbName, ns, verdict: fb.verdict, note: fb.note, log })
          .catch(e => log('error', 'warn', e.message));
        delete session.explicitFeedback[fbName];
        continue;
      }
      const covered = parsed.flash_results.some(fr =>
        session.pendingFlashes.find(pf => pf.flashes.some(f => f === fr.flash_text))?.sourceNeurons.includes(fbName));
      if (!covered) {
        parsed.flash_results.push({ flash_text: entry.flashes[0], status: outcome.status, synthetic: true });
      }
    }
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

        // Explicit feedback wins over inference: used/useful => pursued,
        // irrelevant/wrong => dismissed (cross-project dismissal stays neutral below).
        // 'wrong' also flags the neuron for human review; nothing is auto-corrected.
        const fb = session.explicitFeedback?.[neuronName];
        const fbOutcome = fb ? verdictToOutcome(fb.verdict) : null;
        if (fr.synthetic && !fbOutcome) continue;
        if (fbOutcome) {
          if (feedbackDone.has(neuronName)) continue; // applied once per summarize
          feedbackDone.add(neuronName);
          if (fbOutcome.flagReview) {
            await flagNeuronForReview({ runCypher, name: neuronName, ns, note: fb.note, log })
              .catch(e => log('error', 'warn', e.message));
          }
        }
        const status = fbOutcome ? fbOutcome.status : fr.status;

        if (status === 'pursued') {
          // Consolidation window: only reinforce score/weights once per session per neuron
          const alreadyReinforced = session.pursuedThisSession.has(neuronName);

          await runCypher(`
              MATCH (n:Neuron {name: $name})
              WHERE ${nsPredicate('n')}
              SET n.times_pursued = n.times_pursued + 1,
                  n.base_score = CASE WHEN $reinforce THEN n.base_score + 10 ELSE n.base_score END,
                  n.last_surfaced = datetime()
            `, { name: neuronName, reinforce: !alreadyReinforced, ns }).catch(e => log('error', 'warn', e.message));

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
                WHERE ${nsPredicate('n')}
                SET s.weight = CASE WHEN s.weight + 0.05 > 0.95 THEN 0.95 ELSE s.weight + 0.05 END
              `, { name: neuronName, ns }).catch(e => log('error', 'warn', e.message));
            session.pursuedThisSession.add(neuronName);

            // Interference suppression: neurons in the same community
            await runCypher(`
                MATCH (pursued:Neuron {name: $name})
                WHERE pursued.community_id IS NOT NULL
                AND ${nsPredicate('pursued')}
                MATCH (similar:Neuron)
                WHERE similar.community_id = pursued.community_id
                AND ${nsPredicate('similar')}
                AND similar.name <> pursued.name
                AND similar.name IN $otherNeurons
                SET similar.base_score = CASE WHEN similar.base_score > 5 THEN similar.base_score - 2 ELSE similar.base_score END
              `, { name: neuronName, otherNeurons: flashEntry.sourceNeurons, ns }).catch(e => log('error', 'warn', e.message));
          }
        } else if (isInDomain) {
          // FAIR DISMISSAL: Only penalize if neuron is from the same project
          await runCypher(`
              MATCH (n:Neuron {name: $name})
              WHERE ${nsPredicate('n')}
              SET n.times_dismissed = n.times_dismissed + 1,
                  n.last_surfaced = datetime()
            `, { name: neuronName, ns }).catch(e => log('error', 'warn', e.message));

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
              WHERE ${nsPredicate('n')}
              SET s.weight = CASE WHEN s.weight - 0.02 < 0.0 THEN 0.0 ELSE s.weight - 0.02 END
            `, { name: neuronName, ns }).catch(e => log('error', 'warn', e.message));
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
  // Consume the explicit feedback that was applied above.
  for (const name of feedbackDone) delete session.explicitFeedback[name];
  if (feedbackDone.size) log('summarize', 'info', `explicit feedback applied: ${[...feedbackDone].join(', ').substring(0, 200)}`);

  // Update active topics
  if (parsed.train_of_thought?.length) {
    session.activeTopics = [...new Set([...parsed.train_of_thought, ...session.activeTopics])].slice(0, 10);
  }

  // Opus daemon: prepare flashes for next turn using full transcript context
  // (live graph only — skip for namespaced sessions)
  if (!ns && !skipWonder && isDaemonEnabled('wonder')) {
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
    spider.run({ runCypher, callAnthropic, config: spiderConfig, log, namespace: ns }).catch(e => {
      log('spider', 'error', `spider failed during summarize: ${e.message}`);
    });
  }

  // Janitor daemon — clean up garbage neurons
  if (isDaemonEnabled('janitor')) {
    janitor.run({ runCypher, log, namespace: ns }).catch(e => {
      log('janitor', 'error', `janitor failed: ${e.message}`);
    });
  }

  // Perplexity deep research — feeds the graph with research on session topics
  // (writes to the live graph — skip for namespaced sessions)
  if (!ns && isDaemonEnabled('prowler') && session.activeTopics.length > 0) {
    log('summarize', 'info', 'triggering prowler daemon');
    prowler.deepResearch({ topics: session.activeTopics, runCypher, log }).catch(e => {
      log('prowler', 'error', `prowler failed: ${e.message}`);
    });
  }
}

// --- Session-start handler (SessionStart hook) ---

async function handleSessionStart({ req_body, session, runCypher, callAnthropic, log }) {
  const { cwd } = req_body;
  const ns = req_body.namespace ?? session.namespace ?? null;
  if (ns) session.namespace = ns;

  // Load T1 neurons
  const t1Neurons = await runCypher(`
      MATCH (n:Neuron)
      WHERE n.tier = 'T1_index' AND n.decay_score > 20
      AND ${livePredicate('n')}
      RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type
      ORDER BY n.decay_score DESC LIMIT 20
    `, { ns });

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
  const ns = req_body.namespace ?? session.namespace ?? null;

  const relevant = await runCypher(`
      UNWIND $topics AS topicName
      MATCH (n:Neuron)
      WHERE (n.name = topicName OR n.flash_summary CONTAINS topicName)
      AND ${livePredicate('n')}
      RETURN DISTINCT n.name AS name, n.flash_summary AS flash, n.decay_score AS score
      ORDER BY score DESC LIMIT 10
    `, { topics: session.activeTopics, ns });

  if (relevant.length === 0) {
    return { responseJson: {} };
  }

  const context = `[UNDERTOW-REHYDRATE] Re-injecting ${relevant.length} memories after compaction:\n${relevant.map(r => `- ${r.name}: ${r.flash}`).join('\n')}`;
  log('rehydrate', 'info', `re-injected ${relevant.length} memories`);
  return {
    responseJson: { hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: context } }
  };
}

// Stop-hook entry that applies turn habituation: a habituated turn is a
// heartbeat, so no daemon takes a turn there. 'repeat' skips everything;
// 'plumbing' skips only Wonder's prepare (task notifications often carry real
// work, so Dreamer/Spider/Janitor/Prowler still run - deliberate carve-out).
async function summarizeForTurn(deps, keeper) {
  const sid = deps.req_body.session_id || 'default';
  const reason = keeper.turnHabituation(sid);
  if (reason === 'repeat') {
    keeper.countFastPath(sid);
    deps.log('keeper', 'info', `habituated turn (repeat) - skipped (${String(sid).slice(0, 8)})`);
    return { skipped: true };
  }
  await handleSummarize({ ...deps, skipWonder: reason === 'plumbing' });
  return { skipped: false };
}

export { summarizeForTurn, SUMMARIZE_SYSTEM_PROMPT, SESSION_START_SYSTEM_PROMPT, handleSummarize, handleSessionStart, handleRehydrate };
