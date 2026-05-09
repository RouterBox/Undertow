// gobble.js — Gobble daemon (memory ingestion from tool events)
// Extracted from server.js — no behavior changes

const INGEST_SYSTEM_PROMPT = `You are Undertow's memory writer. You evaluate tool events from a Claude Code session and decide what's worth remembering in a persistent knowledge graph.

You receive: tool_name, tool_input (partial), tool_response (partial).

ALWAYS SKIP (these are noise — return {"action":"skip"} immediately):
- Read/Glob/Grep on any file (these are just lookups, not decisions)
- Bash commands: ls, cd, pwd, which, echo, cat, head, tail, sleep, curl health checks, docker ps, git status, git log, git diff, npm install, pip install
- TTS/speech commands (python claude_speak.py or similar)
- Any tool call that is the agent narrating, navigating, or gathering information
- File edits that are routine (fixing typos, import changes, formatting)
- Test runs and their output
- MCP tool calls that are just reading/listing data

ONLY REMEMBER (must meet ALL criteria):
1. A DECISION was made (choosing X over Y, with reasoning)
2. Or a NEW INSIGHT emerged (connection between topics, pattern recognition, realization)
3. Or a SIGNIFICANT EVENT occurred (project milestone, breakthrough, blocker discovered)
4. The content would be useful to recall in a FUTURE conversation weeks from now

NEVER create neurons for:
- Individual conversation turns or quips
- TTS deliveries or speech acts
- Routine tool usage mechanics
- News headlines unless they directly affect a project
- Anything that is just "the agent did X" without lasting significance

When something IS worth remembering (expect this to be <5% of events), return JSON with one of these actions:

NEURON QUALITY STANDARD:
A neuron is a knowledge unit with substance, NOT a tag or label.
- name: short descriptive label (2-5 words) — just the title
- flash_summary: one sentence that makes sense out of context (<100 chars)
- body: the MEAT — explanation, reasoning, context, details (2-5 sentences REQUIRED for create)

BAD neuron: {"name": "Git commit pushed", "flash_summary": "Git commit pushed", "body": ""}
GOOD neuron: {"name": "YourProject architecture", "flash_summary": "GUI, API, and MCP as three bidirectional interfaces to the same data", "body": "YourProject exposes every operation through three parallel doors. All three route through the same service layer and share authentication. The MCP layer is a thin protocol adapter translating JSON-RPC to REST calls."}

If you cannot write a meaningful body with real content, the event is NOT worth a neuron. Skip it.

CREATE — new memory that doesn't exist in the graph yet:
{
  "action": "create",
  "neuron": {
    "name": "short descriptive name (2-5 words)",
    "node_type": "fact" | "concept" | "decision" | "episode" | "insight" | "preference",
    "tier": "T1_index" | "T2_working" | "T3_archive",
    "flash_summary": "one sentence, <100 chars, useful out of context",
    "body": "2-5 sentences of actual content — the reasoning, context, and details that make this worth remembering"
  },
  "connections": [
    {"target_name": "existing neuron name", "edge_type": "associative|temporal|causal|contradicts|contains", "weight": 0.5, "context": "why connected"}
  ]
}

UPDATE — an existing fact/topic has CHANGED and the stored version is now wrong:
{
  "action": "update",
  "existing_name": "name of the neuron to update",
  "updates": {
    "flash_summary": "new one-sentence summary reflecting the change",
    "body": "optional updated body content"
  },
  "reason": "brief explanation of what changed and why the old version is wrong"
}

Use UPDATE when:
- A project status changed (milestone completed, blocker resolved)
- A fact is now outdated (tech stack changed, person changed role)
- A preference evolved (user changed their mind about something)
- A decision was reversed or superseded

Do NOT update episodes (they are historical — what happened, happened).
Do NOT update insights (they were true when realized, even if context changed — create a new insight instead).

SKIP — the vast majority of events:
{"action": "skip"}

If in doubt, SKIP. A graph with 50 high-quality neurons beats one with 500 noisy ones.`;

const QUERY_MODEL = 'claude-haiku-4-5-20251001';

async function handleIngest({ req_body, runCypher, callAnthropic, embedNeuron, getSession, randomUUID, log }) {
  const body = req_body;

  // Claude Code hook payload uses different field names — normalize
  const tool_name = body.tool_name || body.toolName || '';
  const tool_input = body.tool_input || body.toolInput || body.input || {};
  const tool_response = body.tool_response || body.toolResponse || body.output || '';
  const session_id = body.session_id || body.sessionId || 'default';

  // Log every ingest attempt for debugging
  log('ingest', 'info', `received: ${tool_name}`, {
    detail: JSON.stringify(tool_input).substring(0, 100)
  });

  // Fast filter: skip known noise before invoking Haiku (cost savings)
  const alwaysSkipTools = ['Read', 'Glob', 'Grep', 'ToolSearch', 'Skill'];
  if (alwaysSkipTools.includes(tool_name)) {
    log('ingest', 'info', `filtered (skip tool): ${tool_name}`);
    return;
  }

  const inputStr = JSON.stringify(tool_input || '').substring(0, 500);

  // Skip TTS/speech commands
  if (inputStr.includes('claude_speak.py') || inputStr.includes('Claude-to-Speech')) {
    log('ingest', 'info', `filtered (TTS): ${tool_name}`);
    return;
  }

  // Skip Bash noise
  if (tool_name === 'Bash') {
    const cmd = (tool_input?.command || '').trim();
    if (/^(ls|cd|pwd|which|echo|cat|head|tail|sleep|curl|docker\s+(ps|start|exec|logs)|git\s+(status|log|diff|branch)|npm\s+(install|run|test)|pip\s+install|wc|mkdir|mv|cp|rm|chmod|netstat|taskkill|pkill|pgrep)\b/.test(cmd)) {
      log('ingest', 'info', `filtered (Bash noise): ${cmd.substring(0, 50)}`);
      return;
    }
  }

  // Skip MCP reads/lists (just data gathering)
  if (tool_name.startsWith('mcp__') && /_(list|get|search|read|discover|help)/.test(tool_name)) {
    log('ingest', 'info', `filtered (MCP read): ${tool_name}`);
    return;
  }

  // Ask Haiku to evaluate
  const ingestResult = await callAnthropic(QUERY_MODEL, INGEST_SYSTEM_PROMPT, `Tool: ${tool_name}
Input: ${inputStr}
Response: ${JSON.stringify(tool_response || '').substring(0, 1000)}`);
  if (!ingestResult) return;

  const responseText = ingestResult.response.content[0]?.text || '{}';
  let parsed;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'skip' };
  } catch {
    return;
  }

  if (parsed.action === 'skip') return;

  // Handle UPDATE action
  if (parsed.action === 'update' && parsed.existing_name) {
    const updates = parsed.updates || {};
    const setClauses = [];
    const params = { name: parsed.existing_name };

    if (updates.flash_summary) {
      setClauses.push('n.flash_summary = $flash');
      params.flash = updates.flash_summary;
    }
    if (updates.body) {
      setClauses.push('n.body = $body');
      params.body = updates.body;
    }
    setClauses.push('n.last_surfaced = datetime()');
    setClauses.push('n.updated_at = datetime()');

    if (setClauses.length > 0) {
      await runCypher(
        `MATCH (n:Neuron {name: $name}) SET ${setClauses.join(', ')} RETURN n.name`,
        params
      ).catch(e => log('error', 'warn', e.message));
    }

    log('ingest', 'info', `UPDATED: ${parsed.existing_name}`, {
      detail: `reason: ${parsed.reason || 'not specified'}`
    });
    return;
  }

  if (!parsed.neuron) return;
  const n = parsed.neuron;

  if (parsed.action === 'create') {
    // Check for existing neuron with same name
    const existing = await runCypher(
      'MATCH (n:Neuron {name: $name}) RETURN n.name AS name LIMIT 1',
      { name: n.name }
    );

    if (existing.length > 0) {
      // Update existing
      await runCypher(`
          MATCH (n:Neuron {name: $name})
          SET n.flash_summary = $flash, n.body = coalesce($body, n.body),
              n.last_surfaced = datetime()
        `, { name: n.name, flash: n.flash_summary, body: n.body || '' });
    } else {
      // Create new (auto-tag with current project)
      const sessionForProject = getSession(body.session_id || body.sessionId || 'default');
      await runCypher(`
          CREATE (n:Neuron {
            uid: $uid, name: $name, node_type: $type, tier: $tier,
            flash_summary: $flash, body: $body,
            source: 'conversation', decay_score: 50, base_score: 50,
            times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
            created_at: datetime(), last_surfaced: datetime(),
            project: $project
          })
        `, {
        uid: randomUUID(), name: n.name, type: n.node_type || 'fact', tier: n.tier || 'T2_working',
        flash: n.flash_summary, body: n.body || '',
        project: sessionForProject.currentProject || 'general'
      });
    }

    // Create connections
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
        }).catch(e => log('error', 'warn', e.message)); // Skip if target doesn't exist
      }
    }

    log('ingest', 'info', `created/updated: ${n.name} (${n.node_type})`);
    embedNeuron(n.name, n.flash_summary).catch(e => log('error', 'warn', e.message));
  }
}

export { INGEST_SYSTEM_PROMPT, handleIngest };
