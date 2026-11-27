// dreamer.js — Dreamer daemon (turn processing, session start, rehydration)
// Extracted from server.js — no behavior changes

import { resolveModel } from '../llm.js';
import { readFile } from 'fs/promises';
import { nsPredicate, livePredicate } from '../namespaces.js';
import { supersedeNeuron } from '../supersede.js';
import { stripUndertowInjections } from '../strip-injections.js';
import { coerceNodeType } from './gobble.js';
import { verdictToOutcome, flagNeuronForReview, applyVerdictToNeuron } from './curated.js';
import { gateRun } from '../downstream-gate.js';
import { recordPursuitDay } from '../pursuit-day.js';
import { HELD_NAMESPACE, durableKind, nodeTypeForKind, countHeld, heldUpdateName, packConnections } from '../held.js';
import { tokenize } from './lexical.js';


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

CONNECTIONS:
- A connection links a new insight to a neuron that already exists. The only neurons you know exist are the ones named in the injected flashes.
- target_name must be that neuron's exact name. If you cannot give an exact name, leave connections empty. Never invent a name.
- Most insights have no connections. That is correct.

Return JSON:
{
  "insights": [
    {"name": "2-5 word label", "node_type": "fact|concept|decision|insight", "tier": "T2_working", "flash_summary": "one sentence <100 chars", "body": "2-5 sentences of real content", "event_date": "YYYY-MM-DD only when the remembered event has a clear date; omit otherwise", "connections": [{"target_name": "exact name of an existing neuron", "edge_type": "causal|temporal|elaborates|contradicts|contains|prerequisite|associative", "weight": 0.5, "context": "a few words on why they are linked"}]}
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

// The summarizer for an agent session (Keeper: sessionKind 'agent'). Same train
// of thought and pursuit detection; a much narrower rule for what may be kept,
// no updates to existing neurons, no connections, and no actor names.
const AGENT_SUMMARIZE_SYSTEM_PROMPT = `You are Undertow's turn summarizer for an AUTOMATED AGENT session: no person is typing, an agent is working through tasks. Almost nothing from such a session belongs in long-term memory.

WHAT MAY BE KEPT - only knowledge that will still be true and useful a month from now, of exactly three kinds:
- "lesson": a root cause, or a way something fails, and how to recognise or avoid it.
- "procedure": how to do something that will need doing again, with the steps or the command.
- "decision": a design or policy choice together with its reason.

NEVER KEEP:
- The state of work: pull requests, branches, commits, merges, deploys, restarts, queues, to-do lists, who is waiting on whom, what comes next.
- A review verdict on one commit or one pull request.
- Forecasts, plans, intentions, or anything that is only true "today", "now", "currently" or "pending".
- Counts and measurements that will be different next week, unless they are the evidence inside a lesson.
- Tool usage, git operations, file reads, hook events, status confirmations, conversation flow, or anything that is just "X happened".
- Private content the agent read: anything that quotes or restates the content of a message, text/SMS, e-mail, calendar item, voicemail or notification, and personal details of a third person taken from one (names with contact details, addresses, account, case or incident numbers). A lesson learned while handling such content may be kept only if it can be stated without any of it.
If you are not sure it will still be true in a month, do not keep it. Most turns produce ZERO insights. That is correct and expected.

ATTRIBUTION:
- Do not say who did, said, found or decided something: no agent names, no "the user", no "the operator". State the knowledge itself. The system records which session wrote it.

QUALITY:
- Only create an insight if you can write a meaningful body with 2-5 sentences of real content.

TRAIN OF THOUGHT:
- Use CONCEPTUAL topic names, not action labels.
- If the turn was routine (debugging, file edits, small fixes), return an EMPTY train.

PURSUIT DETECTION:
- "pursued" = the agent's response clearly referenced, built on, or asked about the flash content
- "dismissed" = the agent ignored the flash entirely
- If the agent used information from the flash without quoting it, that's still "pursued"

Return JSON:
{
  "insights": [
    {"name": "2-5 word label", "kind": "lesson|procedure|decision", "flash_summary": "one sentence <100 chars", "body": "2-5 sentences of real content", "event_date": "YYYY-MM-DD only when the remembered event has a clear date; omit otherwise"}
  ],
  "train_of_thought": ["conceptual topic 1", "conceptual topic 2"],
  "flash_results": [
    {"flash_text": "...", "status": "pursued" | "dismissed"}
  ]
}

Empty arrays are the right answer most of the time.`;

const SESSION_START_SYSTEM_PROMPT = `You are Undertow. A new session is starting. Given the working directory and the T1 index neurons from the memory graph, select the most relevant memories for this session context.

Return a concise context block (max 300 tokens) formatted as:
Undertow context:
- [memory 1]
- [memory 2]
...

Only include memories that are likely relevant to the working directory or recent activity. Skip generic/stale memories.`;

// Ouroboros guard (2026-09-02): lives in ../strip-injections.js so historical
// ingestion shares it — see that module for why.

// --- Transcript excerpt for the pursuit judge ---

const EXCERPT_MAX_CHARS = 6000;
const EXCERPT_PROMPT_MAX_CHARS = 1000;

// Build the judge's excerpt from a Claude Code JSONL transcript: everything since
// the last real user prompt — the prompt, the assistant's text, and one compact line
// per tool call. The raw tail of the file is envelope lines (attachments, api-request
// records, session metadata), so slicing it shows the judge none of the reply.
// Returns null when the text is not JSONL or holds no messages (caller falls back).
function buildTranscriptExcerpt(raw, maxChars = EXCERPT_MAX_CHARS) {
  let prompt = null;
  let reply = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    // Only real conversation lines; other envelopes can carry a message too.
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
    const content = entry.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (entry.type === 'user') {
      // A user line holding only tool_result blocks is not a prompt.
      const text = stripUndertowInjections(blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('\n')).trim();
      if (text) { prompt = text; reply = []; }
      continue;
    }
    for (const b of blocks) {
      if (b?.type === 'text') {
        const text = stripUndertowInjections(b.text || '').trim();
        if (text) reply.push(`Assistant: ${text}`);
      } else if (b?.type === 'tool_use') {
        const input = (JSON.stringify(b.input ?? {}) || '').replace(/\s+/g, ' ').substring(0, 120);
        reply.push(`[tool] ${b.name}: ${input}`);
      }
    }
  }
  if (prompt === null && reply.length === 0) return null;
  const head = prompt === null ? '' : `User: ${prompt.substring(0, EXCERPT_PROMPT_MAX_CHARS)}\n`;
  const body = reply.join('\n');
  const room = Math.max(0, maxChars - head.length);
  // When it must be cut, keep the END of the reply: that is where the answer is.
  return head + (body.length > room ? body.slice(-room) : body);
}

// --- Summarize handler (Stop hook) ---

// The judge is asked to echo each flash in flash_text, and sometimes trims or
// re-punctuates it. Two texts are the same flash when they are equal after
// normalising case, whitespace and edge punctuation, or when one contains the
// other and the shorter is long enough to be unambiguous.
const normFlash = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/^[\s~"'`*-]+|[\s"'`.!*]+$/g, '');
function sameFlash(a, b) {
  const x = normFlash(a);
  const y = normFlash(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 20 && long.includes(short);
}

// The summarize prompt asks for "connections" without spelling out an element
// shape, so the model picks one: an object with target_name (or target / name),
// or just the neuron's name as a string. Returns the target name, or null.
function connectionTarget(conn) {
  const t = typeof conn === 'string' ? conn : (conn?.target_name ?? conn?.target ?? conn?.name);
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

// The model sometimes returns an insight with a field missing. A missing
// parameter makes the write throw, so the insight is checked first: no name, or
// neither a summary nor a body, and there is nothing to write; a missing summary
// is taken from the first sentence of the body. Returns the insight to write, or
// null (and says why in the log, without quoting the insight).
function usableInsight(insight, log) {
  const name = typeof insight?.name === 'string' ? insight.name.trim() : '';
  if (!name) {
    log('summarize', 'warn', 'insight not written: it has no name');
    return null;
  }
  const body = typeof insight.body === 'string' ? insight.body : '';
  let flash = typeof insight.flash_summary === 'string' ? insight.flash_summary.trim() : '';
  if (!flash) {
    flash = firstSentence(body);
    if (!flash) {
      log('summarize', 'warn', 'insight not written: it has neither a summary nor a body');
      return null;
    }
    log('summarize', 'info', 'insight had no summary: taken from the first sentence of its body');
  }
  return { ...insight, name, body, flash_summary: flash };
}

// First sentence of a text, on one line, at most 100 characters.
function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  const s = m ? m[0] : t;
  return s.length > 100 ? `${s.slice(0, 97).trimEnd()}...` : s;
}

// Echo check (issue 38). A held insight is often the model restating a neuron
// Undertow injected into the same session a minute before. Before a held write,
// the insight is compared on content with the neurons injected into the session
// in the last ECHO_WINDOW_MS. Lexical only, so it works when embeddings do not:
// the share of distinct content words (lexical.js tokenize, over name + summary
// + body) the two have in common, out of the smaller set (overlap coefficient).
// Measured on 73 labelled held insights (2026-11-25/26 reviews): the 35 echoes
// scored 0.375-0.72, the 25 keep/rewrite insights at most 0.188. At 0.5 only
// 22 of 35 echoes were caught; 0.40 catches 34 with no false skip and leaves a
// wide gap above the highest new insight. At least ECHO_MIN_SHARED words in
// common so two short texts cannot match on a handful of words.
const ECHO_WINDOW_MS = 10 * 60 * 1000;
const ECHO_THRESHOLD = 0.4;
const ECHO_MIN_SHARED = 5;

function contentWords(n) {
  return new Set(tokenize(`${n?.name || ''} ${n?.flash_summary || ''} ${n?.body || ''}`));
}

// The neuron the insight restates, with its score, or null.
function echoOf(insight, neurons) {
  const a = contentWords(insight);
  let best = null;
  for (const n of neurons) {
    const b = contentWords(n);
    if (!a.size || !b.size) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    const score = shared / Math.min(a.size, b.size);
    if (shared >= ECHO_MIN_SHARED && score >= ECHO_THRESHOLD && (!best || score > best.score)) best = { neuron: n, score };
  }
  return best;
}

// Neurons injected into this session in the last ECHO_WINDOW_MS, read with their
// content. session.pendingFlashes is Impulse's record of each injection (judged
// or not). On a failed read the check is skipped: an insight is never lost to it.
async function recentlyInjected(session, runCypher, ns, log) {
  const since = Date.now() - ECHO_WINDOW_MS;
  const names = [...new Set((session.pendingFlashes || [])
    .filter(f => f.turn >= since)
    .flatMap(f => f.flashNeurons || f.sourceNeurons || []))];
  if (!names.length) return [];
  try {
    return await runCypher(
      `MATCH (n:Neuron) WHERE n.name IN $names AND ${livePredicate('n')}
       RETURN n.name AS name, n.uid AS uid, n.flash_summary AS flash_summary, n.body AS body`,
      { names, ns }
    ) || [];
  } catch (e) {
    log('summarize', 'warn', `echo check skipped: injected neurons could not be read: ${e.message}`);
    return [];
  }
}

// Output limit for the summarize call, and for the single retry after a reply
// that was cut off at it (stop_reason max_tokens).
const SUMMARIZE_MAX_TOKENS = 2000;
const SUMMARIZE_RETRY_MAX_TOKENS = 4000;

async function handleSummarize({ req_body, session, runCypher, callAnthropic, embedNeuron, randomUUID, isDaemonEnabled, getDaemonConfig, wonder, spider, janitor, prowler, log, skipWonder = false, agentSession = false, holdUnknown = false }) {
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
      transcript = buildTranscriptExcerpt(raw) ?? stripUndertowInjections(raw).slice(-2000);
    } catch {
      transcript = '[transcript unavailable]';
    }
  }

  // Get recent pending flashes for pursuit detection. An entry is judged at one
  // Stop only: once judged it stays in pendingFlashes (explicit feedback still looks
  // it up) but is not sent or counted again.
  const evaluated = session.pendingFlashes
    .filter(f => !f.judged && !f.judging && Date.now() - f.turn < 10 * 60 * 1000);
  const recentFlashes = evaluated.flatMap(f => f.flashes);

  // Claim the entries before the await: Stops for one session can overlap, and a
  // second Stop must not send the same entries to the judge while this one waits.
  for (const entry of evaluated) entry.judging = true;
  const release = () => { for (const entry of evaluated) entry.judging = false; };

  const SUMMARIZE_MODEL = resolveModel('summarize');
  let parsed;
  try {
  const summarizeSystem = agentSession ? AGENT_SUMMARIZE_SYSTEM_PROMPT : SUMMARIZE_SYSTEM_PROMPT;
  const summarizePrompt = `Transcript excerpt (end of turn):
${transcript}

Flashes that were injected this turn:
${recentFlashes.length > 0 ? recentFlashes.join('\n') : '[none]'}

Analyze this turn. Return JSON with insights, train_of_thought, and flash_results.`;
  let result = await callAnthropic(SUMMARIZE_MODEL, summarizeSystem, summarizePrompt, SUMMARIZE_MAX_TOKENS);

  // A reply cut off at the output limit is not bad JSON, it is half a reply. Say
  // so and ask once more with room to finish, rather than drop the turn at the
  // parse below. The turns that hit the limit are the ones with the most in them.
  if (result?.response?.stop_reason === 'max_tokens') {
    log('summarize', 'warn', `reply truncated at the ${SUMMARIZE_MAX_TOKENS}-token limit; retrying once with ${SUMMARIZE_RETRY_MAX_TOKENS}`);
    result = await callAnthropic(SUMMARIZE_MODEL, summarizeSystem, summarizePrompt, SUMMARIZE_RETRY_MAX_TOKENS);
    if (!result || result.response?.stop_reason === 'max_tokens') {
      log('summarize', 'error', result ? `reply truncated again at the ${SUMMARIZE_RETRY_MAX_TOKENS}-token limit: turn not summarized` : 'retry after a truncated reply failed: turn not summarized');
      return;
    }
  }

  if (!result) return;
  const message = result.response;
  if (result.model !== SUMMARIZE_MODEL) {
    log('summarize', 'warn', `used fallback model: ${result.model}`);
  }

  const responseText = message.content[0]?.text || '{}';
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    return;
  }
  } finally {
    // Whatever happened above (no result, a malformed reply, a throw), the claim
    // is released, so the entries are never left stuck in "judging".
    release();
  }

  // A parseable flash_results closes every entry it was asked about: a flash is
  // judged only against the reply it was shown in, never a later turn's. A failed
  // or malformed call leaves the entries for the next Stop. An entry whose flashes
  // the reply did not mention gets no outcome.
  if (Array.isArray(parsed.flash_results)) {
    for (const entry of evaluated) entry.judged = true;
  }

  // Process updates to existing neurons — supersession, not overwrite:
  // the old version is archived and linked via SUPERSEDES.
  // (An agent session rewrites nothing: an update would put its text straight
  // into the live graph, past the held tier.)
  // holdAll: a turn of unknown origin in the live graph. Nothing it offers is
  // dropped and nothing goes live: insights of every kind are held, and an
  // update is held too, as a carrier neuron that names its target and is
  // applied as the usual supersession when a person releases it (held.js).
  // A session in its own namespace is already apart.
  const holdAll = holdUnknown && !agentSession && !ns;
  if (holdAll && parsed.updates?.length) {
    for (const upd of parsed.updates) {
      if (!upd?.existing_name) continue;
      const uid = randomUUID();
      await runCypher(`
          CREATE (n:Neuron {
            uid: $uid, name: $name, node_type: 'fact', tier: 'T2_working',
            flash_summary: $flash, body: $body,
            source: 'conversation', decay_score: 50, base_score: 50,
            times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
            created_at: datetime(), last_surfaced: datetime(),
            namespace: $ns, origin_session: $originSession, origin_kind: 'unknown',
            held_update_of: $target, held_update_reason: $reason, held_update_event_date: $eventDate
          })
        `, {
        uid, name: heldUpdateName(upd.existing_name, uid), target: upd.existing_name,
        flash: upd.flash_summary || '', body: upd.body || '', ns: HELD_NAMESPACE,
        originSession: session_id || null,
        reason: String(upd.reason || 'updated at turn summarize').slice(0, 300),
        eventDate: typeof upd.event_date === 'string' ? upd.event_date : null
      }).then(() => {
        countHeld('heldWritten'); countHeld('heldUpdates');
        log('summarize', 'info', `held update ${String(uid).slice(0, 8)}`);
      }).catch(e => log('error', 'warn', e.message));
    }
  }
  if (!agentSession && !holdAll && parsed.updates?.length) {
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
        embedNeuron(upd.existing_name, upd.flash_summary || '', ns).catch(e => log('error', 'warn', e.message));
      }
    }
  }

  // Create insight neurons. From an agent session only a lesson, procedure or
  // decision is written, and it is held: it goes into the quarantine namespace,
  // which no recall path reads, until a chase or a used/useful verdict releases
  // it (held.js). A session that declared its own namespace is already apart
  // from the live graph, so its insights stay in that namespace.
  const held = (agentSession && !ns) || holdAll;
  const insightNs = held ? HELD_NAMESPACE : ns;
  if (agentSession) {
    // Counted, not only logged: a turn where the model offered nothing is
    // otherwise invisible (GET /undertow/keeper shows these).
    countHeld('agentTurns');
    countHeld('insightsOffered', parsed.insights?.length || 0);
    if (!parsed.insights?.length) countHeld('zeroInsightTurns');
  }
  if (parsed.insights?.length) {
    const injected = held ? await recentlyInjected(session, runCypher, ns, log) : [];
    for (const offered of parsed.insights) {
      // One unusable insight, or one failed write, must not cost the turn its
      // other insights: each is handled on its own.
      try {
      const insight = usableInsight(offered, log);
      if (!insight) continue;
      const kind = agentSession ? durableKind(insight) : null;
      if (agentSession && !kind) {
        countHeld('droppedNoKind');
        log('summarize', 'info', 'agent session: insight not written, no durable kind', { detail: `kind: ${insight?.kind ?? 'none'}` });
        continue;
      }
      // A held insight that restates a neuron just injected into this session is
      // an echo, not new knowledge: not written. The matched (live) neuron is
      // logged so the skip can be audited; the insight's own name is not.
      const echo = held ? echoOf(insight, injected) : null;
      if (echo) {
        countHeld('skippedEcho');
        log('summarize', 'info', `held insight skipped: echo of injected neuron ${echo.neuron.name} (${echo.neuron.uid ?? 'no uid'})`, { detail: `overlap ${echo.score.toFixed(2)}` });
        continue;
      }
      // A held insight must not take a name a live neuron has, or it could never be released.
      const existing = await runCypher(
        `MATCH (n:Neuron {name: $name}) WHERE ${nsPredicate('n')}${held ? ' OR n.namespace = $held' : ''} RETURN n.name LIMIT 1`,
        held ? { name: insight.name, ns, held: HELD_NAMESPACE } : { name: insight.name, ns }
      );
      if (existing.length > 0 && agentSession) countHeld('skippedNameTaken');
      if (existing.length === 0) {
        const uid = randomUUID();
        const eventDate = typeof insight.event_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(insight.event_date) ? insight.event_date : null;
        await runCypher(`
            CREATE (n:Neuron {
              uid: $uid, name: $name, node_type: $type, tier: $tier,
              flash_summary: $flash, body: $body,
              source: 'conversation', decay_score: 50, base_score: 50,
              times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
              created_at: datetime(), last_surfaced: datetime(),
              namespace: $ns,
              origin_session: $originSession, origin_kind: $originKind, durable_kind: $durableKind,
              event_date: CASE WHEN $eventDate IS NULL THEN NULL ELSE date($eventDate) END
            })
          `, {
          uid, name: insight.name,
          type: agentSession ? nodeTypeForKind(kind) : coerceNodeType(insight.node_type, 'insight'),
          tier: insight.tier || 'T2_working', flash: insight.flash_summary,
          body: insight.body || '', ns: insightNs, eventDate,
          originSession: session_id || null, originKind: agentSession ? 'agent' : (holdUnknown ? 'unknown' : 'human'), durableKind: kind
        });
        // A held insight of unknown origin keeps the connections it offered as
        // data: edges cannot cross into the live graph, so they are made when
        // the neuron is released (held.js). Nothing the turn offered is lost.
        if (holdAll) {
          const heldConns = packConnections(insight.connections, connectionTarget, insight.name);
          if (heldConns) {
            await runCypher(
              `MATCH (n:Neuron {uid: $uid}) WHERE n.namespace = $held SET n.held_connections = $conns`,
              { uid, held: HELD_NAMESPACE, conns: heldConns }
            ).catch(e => log('error', 'warn', e.message));
          }
        }

        // Create connections for insights (never for a held one: a held neuron
        // has no edges into the live graph; Spider links it once released)
        if (!agentSession && !held && insight.connections?.length) {
          for (const conn of insight.connections) {
            // No usable target: nothing to link. Sending the query anyway failed in
            // the driver ("Expected parameter(s): tgt") and logged a warning per edge.
            const tgt = connectionTarget(conn);
            if (!tgt) continue;
            // An insight never links to itself.
            if (tgt === insight.name) continue;
            const linked = await runCypher(`
                MATCH (src:Neuron {name: $src})
                WHERE ${nsPredicate('src')}
                MATCH (tgt:Neuron {name: $tgt})
                WHERE ${nsPredicate('tgt')}
                CREATE (src)-[:SYNAPSE {
                  weight: $weight, edge_type: $edgeType,
                  context: $context, created_at: datetime()
                }]->(tgt)
                RETURN tgt.name AS linked
              `, {
              src: insight.name, tgt, ns,
              weight: conn.weight || 0.5, edgeType: conn.edge_type || 'associative',
              context: conn.context || ''
            }).catch(e => { log('error', 'warn', e.message); return null; });
            // The model named a neuron that does not exist here: no edge was made.
            if (Array.isArray(linked) && linked.length === 0) {
              log('summarize', 'info', `connection target not found: "${tgt}" (from "${insight.name}")`);
            }
          }
        }
        // A held insight is logged by kind and uid, never by name, and gets no
        // embedding until it is released: it must not take a vector-search slot.
        if (held) {
          countHeld('heldWritten');
          if (holdAll) countHeld('heldOnUnknownInsights');
          log('summarize', 'info', `held insight (${kind || 'unknown origin'}) ${String(uid).slice(0, 8)}`);
        } else {
          log('summarize', 'info', `insight: ${insight.name}`);
          embedNeuron(insight.name, insight.flash_summary, insightNs).catch(e => log('error', 'warn', e.message));
        }
      }
      } catch (e) {
        log('summarize', 'error', `insight not written: ${e.message}`);
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
  // Which entry and which of its neurons a flash result speaks for. Sonnet's results
  // resolve only against the entries evaluated at this Stop; a synthetic (feedback)
  // result carries its own entry, which may already be judged. An entry with a
  // per-flash mapping (flashNeurons, parallel to flashes) attributes a flash to its
  // own neuron; without one (haiku/both) the flash speaks for the whole entry.
  const neuronsFor = (fr) => {
    if (fr.synthetic) {
      return { entry: fr.entry, neurons: fr.entry.sourceNeurons.filter(n => verdictToOutcome(session.explicitFeedback?.[n]?.verdict)) };
    }
    // Exact text first; a trimmed or re-punctuated echo second.
    const entry = evaluated.find(pf => pf.flashes.some(f => f === fr.flash_text))
      || evaluated.find(pf => pf.flashes.some(f => sameFlash(f, fr.flash_text)));
    if (!entry) return null;
    if (!Array.isArray(entry.flashNeurons)) return { entry, neurons: entry.sourceNeurons };
    const exact = entry.flashNeurons.filter((n, i) => entry.flashes[i] === fr.flash_text);
    return { entry, neurons: exact.length ? exact : entry.flashNeurons.filter((n, i) => sameFlash(entry.flashes[i], fr.flash_text)) };
  };
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
      const covered = parsed.flash_results.some(fr => neuronsFor(fr)?.neurons.includes(fbName));
      if (!covered) {
        parsed.flash_results.push({ flash_text: entry.flashes[0], status: outcome.status, synthetic: true, entry });
      }
    }
  }

  // Process pursuit/dismissal (with fair domain scoring)
  if (parsed.flash_results?.length) {
    // One outcome per neuron per entry per Stop, pursued winning over dismissed —
    // an entry with k flashes must not hand each of its neurons k outcomes.
    const outcomes = new Map(); // entry -> Map(neuron -> status)
    for (const fr of parsed.flash_results) {
      const hit = neuronsFor(fr);
      if (!hit) continue;
      if (!outcomes.has(hit.entry)) outcomes.set(hit.entry, new Map());
      const byNeuron = outcomes.get(hit.entry);
      for (const neuronName of hit.neurons) {
        if (fr.status === 'pursued' || !byNeuron.has(neuronName)) byNeuron.set(neuronName, fr.status);
      }
    }

    // What was actually applied, for the per-flash log below.
    const applied = new Map(); // entry -> Map(neuron -> 'pursued' | 'dismissed' | 'skipped')
    for (const [flashEntry, byNeuron] of outcomes) {
      applied.set(flashEntry, new Map());

      // Track which neurons have already been reinforced this session (consolidation window)
      session.pursuedThisSession = session.pursuedThisSession || new Set();

      for (const [neuronName, inferredStatus] of byNeuron) {
        const isInDomain = flashEntry.neuronDomains?.[neuronName] !== false;
        const contributingDaemon = flashEntry.neuronDaemons?.[neuronName] || 'impulse';

        // Explicit feedback wins over inference: used/useful => pursued,
        // irrelevant/wrong => dismissed (cross-project dismissal stays neutral below).
        // 'wrong' also flags the neuron for human review; nothing is auto-corrected.
        const fb = session.explicitFeedback?.[neuronName];
        const fbOutcome = fb ? verdictToOutcome(fb.verdict) : null;
        if (fbOutcome) {
          if (feedbackDone.has(neuronName)) continue; // applied once per summarize
          feedbackDone.add(neuronName);
          if (fbOutcome.flagReview) {
            await flagNeuronForReview({ runCypher, name: neuronName, ns, note: fb.note, log })
              .catch(e => log('error', 'warn', e.message));
          }
        }
        const status = fbOutcome ? fbOutcome.status : inferredStatus;
        applied.get(flashEntry).set(neuronName, status === 'pursued' ? 'pursued' : isInDomain ? 'dismissed' : 'skipped');

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

          // Per-day counter for the health window (live graph only)
          await recordPursuitDay({ runCypher, status: 'pursued', ns, log });

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

          // Per-day counter for the health window (live graph only)
          await recordPursuitDay({ runCypher, status: 'dismissed', ns, log });

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
        const hit = neuronsFor(fr);
        const did = hit ? hit.neurons.map(n => applied.get(hit.entry)?.get(n)) : [];
        const count = (what) => did.filter(d => d === what).length;
        const parts = [];
        if (count('dismissed')) parts.push(`same-domain dismissal — times_dismissed +1 on ${count('dismissed')} neuron(s)`);
        if (count('skipped')) parts.push(`${count('skipped')} cross-project neuron(s) skipped, no penalty`);
        if (count('pursued')) parts.push(`${count('pursued')} neuron(s) pursued via another flash or explicit feedback`);
        const detail = !hit ? 'no matching pending flash — nothing applied' : parts.join('; ') || 'nothing applied';
        log('summarize', 'info', `pursuit: ✗ "${flashPreview}"`, { detail });
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

  // Run downstream daemons. Stop fires after every turn, so each is gated:
  // one run at a time per namespace, and a pause between runs.
  const spiderConfig = getDaemonConfig('spider');
  if (isDaemonEnabled('spider') && spiderConfig.schedule === 'session-end') {
    const gated = gateRun(`spider:${ns ?? ''}`, (spiderConfig.minIntervalSeconds ?? 300) * 1000, () => {
      log('summarize', 'info', 'triggering spider daemon');
      return spider.run({ runCypher, callAnthropic, config: spiderConfig, log, namespace: ns });
    });
    gated.promise?.catch(e => {
      log('spider', 'error', `spider failed during summarize: ${e.message}`);
    });
  }

  // Janitor daemon — clean up garbage neurons
  if (isDaemonEnabled('janitor')) {
    const janitorConfig = getDaemonConfig('janitor');
    const gated = gateRun(`janitor:${ns ?? ''}`, (janitorConfig.minIntervalSeconds ?? 300) * 1000, () =>
      janitor.run({ runCypher, log, namespace: ns }));
    gated.promise?.catch(e => {
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

  const startResult = await callAnthropic(resolveModel('query'), SESSION_START_SYSTEM_PROMPT, `Working directory: ${cwd || 'unknown'}

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
  // Who is on the other end decides what Dreamer may write (see held.js). The
  // rosters are asked first (the Stop response is already sent), so a session a
  // launcher lists is known as an agent before it is classed. With the Keeper's
  // agentInsights on, an agent session is summarized like a person's.
  // When a roster did not answer and nothing else says who the session is, the
  // session may be a person's: the turn is summarized by the ordinary prompt and
  // EVERYTHING it offers is held, whatever its kind, marked origin 'unknown'.
  // A held insight can be released; one written live cannot be taken back. The
  // kind rule and the agent prompt apply only to a session known to be an agent.
  // The session is not flagged, so the next turn asks again.
  const roster = await keeper.askRoster(sid);
  const who = keeper.sessionKind(sid, deps.req_body.cwd);
  let agentSession = false;
  let holdUnknown = false;
  if (!keeper.agentInsightsEnabled()) {
    if (who.kind === 'agent') agentSession = true;
    else if (roster === 'unknown' && who.why !== 'declared') {
      holdUnknown = true;
      countHeld('heldOnUnknownTurns');
      deps.log('keeper', 'info', `a launcher roster did not answer: turn of ${String(sid).slice(0, 8)} is held as unknown`);
    }
  }
  await handleSummarize({ ...deps, skipWonder: reason === 'plumbing', agentSession, holdUnknown });
  return { skipped: false };
}

export { connectionTarget, echoOf, ECHO_THRESHOLD };
export { buildTranscriptExcerpt, summarizeForTurn, SUMMARIZE_SYSTEM_PROMPT, AGENT_SUMMARIZE_SYSTEM_PROMPT, SESSION_START_SYSTEM_PROMPT, handleSummarize, handleSessionStart, handleRehydrate };
