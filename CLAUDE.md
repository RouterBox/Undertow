# Undertow — Agentic Subconscious

## Quick Context

Undertow is an ambient memory system that sits beneath an AI agent's context window. It uses Claude Code hooks to intercept conversation events, queries a Neo4j graph database for relevant memories, and injects "flashes" (compact memory nudges) into the agent's context via `additionalContext` — all without the agent explicitly deciding to search memory.

**The Freudian frame:** Opus (the main agent) is the ego. Undertow's daemons are the Id.

## The Daemons

Undertow is a swarm of 8 named daemons that each play a role in the subconscious ecosystem. See [docs/MEET_THE_DAEMONS.md](docs/MEET_THE_DAEMONS.md) for portraits and lore.

| Daemon | Type | Role | When |
|---|---|---|---|
| **Wonder** | Upstream (proactive) | Deep-thinking between turns — reads transcript, pre-warms flashes | Stop hook |
| **Impulse** | Upstream (reactive) | Flash-crafting pipeline — vector search, scoring, Haiku judgment | UserPromptSubmit |
| **Gobble** | Input | Memory ingestion from tool events | PostToolUse |
| **Dreamer** | Downstream | Turn processing, pursuit detection, train-of-thought | Stop hook |
| **Spider** | Downstream | Edge discovery, pruning, GDS score pre-computation | Session end |
| **Prowler** | Upstream + Downstream | Brave Search (fast) + Perplexity (deep research) | Query / Stop |
| **Janitor** | Downstream | Content-quality cleanup of garbage neurons | Session end |
| **Tapestry** | Projection | Materializes graph to Obsidian vault | Manual / session end |

## Architecture

```
Hooks (settings.json) → Undertow Service (localhost:3030) → Haiku/Sonnet → Neo4j (localhost:7687)
                                  ↕                              ↕
                          Daemon Plugin System           Gemini Embeddings
                    (8 daemons in service/daemons/)       (vector search)
```

- **Neo4j** runs in Docker with APOC + GDS plugins. Data persists in `neo4j_data` volume.
- **Undertow service** is a Node.js/Express HTTP server at `C:/github/Undertow/service/`.
- **Hooks** in `~/.claude/settings.json` — UserPromptSubmit, SessionStart, PostToolUse, Stop, PostCompact.
- **Daemons** are pluggable modules in `service/daemons/`, configured via `service/daemon-config.json`.
- **Vector search** via Gemini `gemini-embedding-001` (3072 dims, cosine similarity).
- **TTS** via Claude-to-Speech (`python C:/github/Claude-to-Speech/scripts/claude_speak.py --voice Daniel`).

## Flash Modes

Undertow has three flash modes controlled via `POST /undertow/mode/:mode`:

- **`haiku`** (recommended) — Only Haiku's crafted flash text is injected. Clean context.
- **`both`** — Haiku interpretation + raw neuron data. Richer but more verbose.
- **`raw`** — Raw neurons only, no Haiku. Fast, zero LLM cost, no interpretation.

Current default is `haiku` — keeps the context window clean.

## Search Pipeline (Impulse Daemon)

When a prompt arrives, these searches run in parallel:

1. **Vector search** (primary) — embeds prompt via Gemini, cosine similarity against all neurons
2. **Graph traversal** — walks SYNAPSE edges 1-2 hops from active topics (weight > 0.3 only)
3. **Temporal** — recent episodes by last_surfaced date
4. **Contradiction** — keyword search on facts/insights, Haiku judges conflicts
5. **Wonder** pre-warmed candidates (if session has them from previous turn)
6. **Prowler (Brave)** — web search on adjacent topics for genuinely research-worthy prompts

Results are combined, deduplicated, domain-scored (CWD project detection), diversity-enforced, then Haiku crafts flashes (max 2 per prompt).

## Domain Scoring

The hook sends `cwd` (working directory). Undertow walks up to find `.git` and tags neurons by repo. Then:
- **Same-project neurons** get 1.5x score boost
- **Cross-project neurons** get 0.6x penalty
- **Cross-project dismissals** are neutral — no penalty for being in the wrong domain

New neurons created during a session are auto-tagged with the session's project.

## Starting Undertow

```bash
# 1. Start Docker Desktop (manually, Windows)
# 2. Start Neo4j
docker start neo4j

# 3. Start the service
bash C:/github/Undertow/start.sh

# OR
node C:/github/Undertow/service/server.js
```

Health check: `curl http://localhost:3030/health`

## Key Files

| File | Purpose |
|---|---|
| `service/server.js` | Thin router (~1000 lines) |
| `service/daemons/wonder.js` | Proactive deep-thinking daemon |
| `service/daemons/impulse.js` | Flash-crafting pipeline |
| `service/daemons/gobble.js` | Memory ingestion |
| `service/daemons/dreamer.js` | Turn processing |
| `service/daemons/spider.js` | Graph enrichment |
| `service/daemons/prowler.js` | Web research |
| `service/daemons/janitor.js` | Content cleanup |
| `service/daemons/tapestry.js` | Obsidian vault projection |
| `service/daemon-config.json` | Daemon toggles + config |
| `service/embeddings.js` | Gemini embedding helper |
| `service/backfill-embeddings.js` | Embedding backfill script |
| `service/ingest-history.js` | Historical JSONL ingestion |
| `service/flash-monitor.js` | Live terminal monitor |
| `service/.env` | API keys (not committed) |
| `context/projectPlan.md` | Full architecture |
| `context/currentStatus.md` | Operational status |
| `context/GRAPH_THEORY.md` | Academic research applied |
| `context/milestones/` | M0-M8 milestone specs |
| `docs/MEET_THE_DAEMONS.md` | Daemon portraits + lore |
| `INSTALL.md` | Claude-guided installation |
| `README.md` | Public-facing docs |

## Neo4j Access

- **Browser:** http://localhost:7474
- **Bolt:** bolt://localhost:7687
- **Auth:** neo4j / `$NEO4J_PASS` (the value you set in `service/.env`)
- **Vector index:** `neuron_embedding`, 3072 dims, cosine similarity

## Endpoints

### Core (Hook-driven)
| Endpoint | Hook | Daemon |
|---|---|---|
| POST /undertow/query | UserPromptSubmit | Impulse + Wonder + Prowler |
| POST /undertow/session-start | SessionStart | Dreamer |
| POST /undertow/ingest | PostToolUse | Gobble |
| POST /undertow/summarize | Stop | Dreamer → Wonder, Spider, Janitor, Prowler |
| POST /undertow/rehydrate | PostCompact | Dreamer |

### Daemon Triggers
| Endpoint | Purpose |
|---|---|
| POST /undertow/spider | Run spider manually |
| POST /undertow/janitor | Run janitor manually |
| POST /undertow/wiki-sync | Generate/refresh Obsidian vault |
| POST /undertow/ingest-url | Ingest a web page |
| POST /undertow/ingest-file | Ingest a local file |
| POST /undertow/correct | Agent-initiated memory correction |
| POST /undertow/chase | Agent-initiated follow-up pursuit |
| GET/POST /undertow/daemon-config | View/update daemon settings |

### Utility
| Endpoint | Purpose |
|---|---|
| GET /undertow/stats | Calibration dashboard |
| GET /undertow/patterns | Bridge nodes, recurring topics |
| GET /undertow/health | Graph health metrics + alerts |
| GET /undertow/logs | Log viewer with filtering |
| GET/POST /undertow/toggle | Enable/disable Undertow |
| POST /undertow/mode/:mode | Set flash mode (haiku/both/raw) |
| POST /undertow/external-ingest | Cross-agent memory intake |

## Flash Hygiene

When Undertow injects a flash, **evaluate it critically**:

1. **If the flash contains stale or incorrect data** — investigate the neuron by querying Neo4j, then correct it via `POST /undertow/correct`. Don't silently ignore bad data — it poisons the graph.
2. **If a flash is irrelevant** (cross-project bleed, noise) — note the dismissal. Cross-project dismissals don't penalize the neuron.
3. **If a flash is useful** — reference it in your response. The pursuit will strengthen it.

Correction endpoint:
```bash
curl -X POST http://localhost:3030/undertow/correct -H "Content-Type: application/json" \
  -d '{"neuron": "name", "action": "update|delete|demote", "flash_summary": "corrected text", "reason": "why"}'
```

**Rules:** Always investigate before correcting. Don't delete neurons with >5 connections (use demote). Every correction requires a reason.

## Chasing Flashes (Graph Exploration)

When a flash contains an interesting lead, **chase it through the graph**. Each flash injection includes neuron handles — exact names you can use to query Neo4j for more context.

**How to chase:**
```bash
curl -s -X POST http://localhost:7474/db/neo4j/tx/commit \
  -H "Content-Type: application/json" -u "neo4j:$NEO4J_PASS" \
  -d '{"statements": [{"statement": "MATCH (n:Neuron {name: \"NEURON_NAME\"})-[s:SYNAPSE]-(connected) RETURN n.flash_summary, n.body, type(s), s.weight, s.edge_type, connected.name, connected.flash_summary"}]}'
```

Or signal a chase explicitly: `POST /undertow/chase {"neuron": "NEURON_NAME"}`

**Chasing is the strongest pursuit signal.** +15 base_score, +0.08 edge weight (stronger than normal pursuit). Don't chase everything — only when a flash genuinely adds to your current task.

## Neuron Quality Standard

A neuron is a **knowledge unit with substance**, not a tag.

- `name` — short label (2-5 words)
- `flash_summary` — one sentence that makes sense out of context (<100 chars)
- `body` — 2-5 sentences of real content: reasoning, context, details

Ingestion and summarize prompts enforce this. Neurons without substantive bodies are rejected. The Janitor cleans up any that slip through.

## Voice (TTS)

Claude Code sessions narrate actions through Claude-to-Speech using the Daniel voice:

```bash
python C:/github/Claude-to-Speech/scripts/claude_speak.py --voice Daniel "message here"
```

Use mid-response for narration, end-of-response for summary. TTS server runs on localhost:5001.

## Current Status

- **M0-M3:** COMPLETE — Infrastructure, service, flash injection, ingestion
- **M4:** COMPLETE — Decay, flow-state, stats, vector search, domain scoring, fair dismissals, edge saturation, consolidation windows, topology-aware decay, diversity enforcement, interference suppression, directional reinforcement, health metrics
- **M5:** COMPLETE — Spider daemon, two-tier research (Brave + Perplexity), correction endpoint, contradiction detection, chase endpoint. Cross-agent: OpenClaw integration live via OpenClaw plugin.
- **M6:** BUILT — Historical ingestion script + cross-project file ingestion. JSONL session ingestion not yet run.
- **M7:** COMPLETE — Tapestry generates Obsidian vault (388 pages, 11 clusters)
- **M8:** PARTIALLY BUILT — URL/file ingestors live. Scheduled crawler not yet built.

**Architecture milestones:**
- Daemon plugin system with 8 named daemons (Wonder, Impulse, Gobble, Dreamer, Spider, Prowler, Janitor, Tapestry)
- Refactor: query/ingest/summarize extracted from server.js into daemon modules
- Neuron quality standard enforced in prompts
- UUID on every neuron
- Git-based project tagging + bare project name support (OpenClaw sends "openclaw")
- Flash threshold raised (silence is accuracy)
- Graph theory research applied (9 stability improvements)
- Toggle persistence across restarts
- Query cache (60s TTL) — deduplicates OpenClaw retry storms
- Wonder cross-instance isolation (sessionId/cwd validation)
- Flash monitor midnight rotation bug fixed
- Meet the Daemons character portraits via Leonardo.ai
- OpenClaw integration: OpenClaw plugin with 5 hooks + 4 tools + skill file
