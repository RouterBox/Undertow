# Undertow Installation Guide

This file is designed to be read by Claude Code. Point Claude at this file and it will walk through the setup.

## What Will Happen

Claude will:
1. Check that Docker and Node.js are installed
2. Start a Neo4j database in Docker (creates a persistent volume for your data)
3. Create a `.env` file with your Anthropic API key
4. Install Node.js dependencies
5. Configure Claude Code hooks in `~/.claude/settings.json`
6. Start the Undertow service
7. Verify everything is working

Your data stays local. The Neo4j database runs in Docker on your machine. The only external calls are to Anthropic's API for Haiku/Sonnet inference.

## Prerequisites

- **Claude Code** with hooks support
- **Docker** installed and running
- **Node.js 18+**
- **Anthropic API key** with access to Haiku and Sonnet models

## Instructions for Claude

If you are Claude Code reading this file, follow these steps:

### Step 1: Verify Prerequisites

Run these checks:
```bash
docker --version    # Need Docker 20+
node --version      # Need Node 18+
```

If either is missing, tell the user what to install and stop.

### Step 2: Configure .env

Copy the example file and fill in values:

```bash
cp service/.env.example service/.env
```

Edit `service/.env` and set, at minimum:
- `NEO4J_PASS` — pick any password; whatever you set here will be used to create the Neo4j container in the next step.
- `ANTHROPIC_API_KEY` — required for Impulse/Gobble/Dreamer/Wonder.
- `GEMINI_API_KEY` — required for vector search.

Optional: `BRAVE_API_KEY`, `PERPLEXITY_API_KEY` for Prowler. See comments in `.env.example`.

**Important:** never commit `.env`. It's already gitignored.

### Step 3: Start Neo4j

The password you put in `.env` must match the one you create the Neo4j container with. Source `.env` first so `$NEO4J_PASS` is set, then run docker:

```bash
set -a; source service/.env; set +a

docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/$NEO4J_PASS \
  -e NEO4J_PLUGINS='["apoc", "graph-data-science"]' \
  -v neo4j_data:/data \
  neo4j:community
```

Wait for Neo4j to be ready:
```bash
until curl -s http://localhost:7474 > /dev/null 2>&1; do sleep 2; done
```

If Neo4j is already running (`docker ps` shows it), skip this step. If you need to change the password later, you'll need to either reset it via cypher-shell or recreate the container.

### Step 4: Install Dependencies

```bash
cd <repo-root>/service
npm install
```

### Step 5: Configure Claude Code Hooks

Add these hooks to `~/.claude/settings.json`. If the file already has a `hooks` section, merge these entries. If not, create the hooks section.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3030/undertow/query",
            "timeout": 5000
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3030/undertow/session-start",
            "timeout": 5000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3030/undertow/ingest",
            "timeout": 3000
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3030/undertow/summarize",
            "timeout": 30000
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3030/undertow/rehydrate",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

**Important:** Do not overwrite existing hooks. Merge with any existing configuration.

### Step 6: Create Neo4j Indexes

Connect to Neo4j and create required indexes:

```bash
curl -X POST http://localhost:7474/db/neo4j/tx/commit \
  -H "Content-Type: application/json" \
  -u "neo4j:$NEO4J_PASS" \
  -d '{
    "statements": [
      {"statement": "CREATE INDEX neuron_name IF NOT EXISTS FOR (n:Neuron) ON (n.name)"},
      {"statement": "CREATE INDEX neuron_type IF NOT EXISTS FOR (n:Neuron) ON (n.node_type)"},
      {"statement": "CREATE INDEX neuron_tier IF NOT EXISTS FOR (n:Neuron) ON (n.tier)"},
      {"statement": "CREATE CONSTRAINT neuron_unique_name IF NOT EXISTS FOR (n:Neuron) REQUIRE n.name IS UNIQUE"}
    ]
  }'
```

### Step 7: Start Undertow

```bash
bash <repo-root>/start.sh
```

Or manually:
```bash
node <repo-root>/service/server.js &
```

### Step 8: Verify

```bash
curl http://localhost:3030/health
```

Expected response: `{"status":"ok","neo4j":"connected","enabled":true,...}`

### Step 9: Test Flash Injection

Start a new Claude Code session (the hooks activate on session start). Type any prompt. You should see `[UNDERTOW-FLASH]` in the hook output, or "no flashes" if the graph is empty.

To seed an initial neuron for testing:
```bash
curl -X POST http://localhost:7474/db/neo4j/tx/commit \
  -H "Content-Type: application/json" \
  -u "neo4j:$NEO4J_PASS" \
  -d '{
    "statements": [
      {"statement": "CREATE (n:Neuron {name: \"Undertow Installation\", node_type: \"episode\", tier: \"T2_working\", flash_summary: \"Undertow was installed and configured successfully\", base_score: 50, times_surfaced: 0, times_pursued: 0, times_dismissed: 0, created_at: datetime(), last_surfaced: datetime(), source: \"user_input\"}) RETURN n.name"}
    ]
  }'
```

### Step 10: Add Flash Hygiene Instructions to CLAUDE.md

If the user's project has a `CLAUDE.md` file, append these instructions. If not, create one. This teaches the agent how to handle Undertow flashes responsibly.

```markdown
## Undertow Flash Hygiene

When Undertow injects a flash (`[UNDERTOW-FLASH]`), evaluate it critically:

1. **If the flash contains stale or incorrect data** — investigate the neuron by querying Neo4j, then correct it:
   ```bash
   curl -X POST http://localhost:3030/undertow/correct -H "Content-Type: application/json" \
     -d '{"neuron": "name", "action": "update", "flash_summary": "corrected text", "reason": "why this was wrong"}'
   ```
   Actions: `update` (fix it), `delete` (remove it, refused if >5 connections), `demote` (archive it, fast decay).

2. **If a flash is irrelevant** (cross-project noise, wrong context) — note the dismissal in your response. The Stop hook will record it and weaken the neuron.

3. **If a flash is useful** — reference it in your response. The pursuit will strengthen the memory.

**Rules:** Always investigate before correcting. Don't silently ignore bad data — stale memories poison the graph. Every correction requires a reason.
```

**Why this matters:** Without these instructions, the agent will politely ignore bad flashes. Stale data accumulates. The graph becomes misleading. The correction endpoint exists specifically so the agent can fix bad memories on the fly.

---

## Troubleshooting

**Service won't start:** Check that `.env` exists in the `service/` directory with a valid Anthropic API key.

**Neo4j connection refused:** Make sure Docker is running and the neo4j container is up: `docker ps | grep neo4j`

**Hooks not firing:** Restart Claude Code after modifying `settings.json`. Hooks are loaded at session start.

**Flashes are slow (>5s):** This is usually Anthropic API latency. The hook timeout is 5 seconds. If Haiku is slow, flashes will be dropped silently and your session continues normally.

**"connection refused" on port 3030:** The Undertow service isn't running. Start it with `bash start.sh` or `node service/server.js`.

## Startup Script

For daily use, just run:
```bash
bash /path/to/Undertow/start.sh
```

This starts Neo4j (if not running) and the Undertow service. The service runs in the foreground — use a terminal tab or `&` for background.

## Flash Monitor

To see Undertow's activity in real-time, open another terminal:
```bash
node /path/to/Undertow/service/flash-monitor.js
```

This shows a live feed of flashes, ingestions, and pursuit tracking.
