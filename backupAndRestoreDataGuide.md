# Backup & Restore — Undertow Data Operations

A short field guide for the operations you'll inevitably want: capturing the
graph before you change something, restoring it after, swapping graphs for
experiments, and starting fresh without losing what you had.

The graph is the only state that matters. Everything else (the service code,
configs, daemon plugins) lives in the repo and is reproducible. Lose the
graph and you lose the memory.

---

## What gets backed up

A backup captures **the entire Neo4j state** — every neuron, every synapse,
every property, every index, every constraint. It does *not* capture
ephemeral runtime state: the in-memory `pendingFlashes` queue, Wonder's
pre-warmed payloads, the query cache, or session activity. Those are
reconstituted on the next prompt and don't need to persist.

The standard backup format is a **Cypher dump** — a `.cypher` text file
that, when fed to `cypher-shell`, recreates the graph from scratch.
Human-readable, version-control-friendly, restorable across Neo4j versions
within the same major series.

---

## The Undertow-Data convention

Personal graph data lives in a sibling repo named `Undertow-Data` (mirror of
the engine repo `Undertow`). Recommended layout:

```
Undertow-Data/
├── .env                      — NEO4J_PASS for export.sh (gitignored)
├── .gitignore
├── README.md                 — describes the structure
├── export.sh                 — manual or cron-driven export
├── exports/
│   ├── undertow-YYYY-MM-DD.cypher  — timestamped snapshots
│   └── undertow-latest.cypher       — copy of the most recent
├── ingestion/                — JSONL session files staged for M6
└── logs/                     — service log archive (optional)
```

Keeping data in a separate repo means you can version your graph history
independently of the engine, share or sync the data without leaking the
engine, and restore on any machine that has Docker + Neo4j.

---

## Backing up

### One-shot, online (no downtime)

The graph is exported via APOC's streaming Cypher exporter. The Neo4j
container keeps running; the service keeps serving.

```bash
# From Undertow-Data/, with NEO4J_PASS set in .env:
bash export.sh
```

The script runs:

```bash
docker exec neo4j cypher-shell -u neo4j -p "$NEO4J_PASS" "
CALL apoc.export.cypher.all(null, {format: 'cypher-shell', stream: true})
YIELD cypherStatements
RETURN cypherStatements
" | grep -v '^WARNING' | grep -v '^cypherStatements$' | sed 's/^"//;s/"$//' \
> exports/undertow-YYYY-MM-DD.cypher
```

It then copies the timestamped file to `undertow-latest.cypher` so the
restore command always has a known target.

### Verifying the dump

```bash
head -5 exports/undertow-latest.cypher  # should start with `:begin`
tail -3 exports/undertow-latest.cypher  # should end with `:commit`
du -h exports/undertow-latest.cypher    # size sanity-check
```

A good Cypher dump for a real graph is typically multi-megabyte (every
neuron's `body` and `embedding` adds up). If your dump is under a few KB,
something went wrong (wrong password, APOC missing, empty graph).

---

## Restoring

The dump is loaded by feeding it through `cypher-shell` against a running
Neo4j. The target Neo4j should be **empty** — restoring on top of an
existing graph will fail on duplicate-name constraints.

```bash
docker start neo4j  # if not running
cat exports/undertow-latest.cypher | \
  docker exec -i neo4j cypher-shell -u neo4j -p "$NEO4J_PASS"
```

After restore, sanity-check:

```bash
curl http://localhost:3030/undertow/stats | jq .neurons
# should match the count from the dump
```

If the restore aborts midway (network glitch, invalid Cypher), the graph is
in a partial state. Either resume by skipping already-created nodes (via
`MERGE` rewriting), or wipe and retry.

---

## Swapping graphs (experiments)

Sometimes you want a clean graph to test against without losing your real
one. Two paths.

### Path A — keep the old volume, use a new one (recommended)

Zero risk. The old graph stays put, untouched, on its original Docker
volume. The new container uses a fresh volume.

```bash
# Capture the current graph first if you haven't already:
bash ../Undertow-Data/export.sh

# Stop and remove the container (volume is NOT removed by `docker rm`):
docker stop neo4j
docker rm neo4j

# Recreate on a new volume name (e.g., neo4j_data_v2):
docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/$NEO4J_PASS \
  -e NEO4J_PLUGINS='["apoc","graph-data-science"]' \
  -v neo4j_data_v2:/data \
  neo4j:community

# Confirm both volumes exist side by side:
docker volume ls | grep neo4j
# local   neo4j_data       <- old, untouched
# local   neo4j_data_v2    <- new, empty
```

To switch back to the old graph later:

```bash
docker stop neo4j && docker rm neo4j
docker run -d --name neo4j ... -v neo4j_data:/data neo4j:community
# Service .env's NEO4J_PASS must match whatever the old volume's
# original NEO4J_AUTH was set to — Neo4j passwords live with the data,
# not the container.
```

### Path B — wipe and restart on the same volume

Destructive. Only do this if you have a verified backup and you're sure
the running graph isn't valuable.

```bash
docker stop neo4j && docker rm neo4j
docker volume rm neo4j_data            # this is the destructive line
docker run -d --name neo4j ... -v neo4j_data:/data neo4j:community
```

If you need the old graph back later, restore from the latest cypher dump
into the freshly-created volume.

---

## Starting fresh on the new container

After Path A or Path B you have an empty graph. Three things need to align
before the service comes up clean:

1. **`service/.env` `NEO4J_PASS`** must match the new container's
   `NEO4J_AUTH` value. Neo4j sets the password once, at first volume
   creation; it doesn't change when you recreate the container.
2. **Service must be restarted** to pick up the new `.env` and to drop
   its dead Neo4j driver connection. The connection won't auto-recover
   across container removal.
3. **First request will create the schema indexes** if they're absent.
   Subsequent requests run normally.

```bash
# After restart, smoke-check:
curl http://localhost:3030/health
# expected: {"status":"ok","neo4j":"connected","enabled":true,...}

curl http://localhost:3030/undertow/stats | jq .neurons
# expected: 0 (or whatever you've seeded)
```

---

## Common gotchas

**Password mismatch.** The most common failure. Neo4j stores the password
inside the volume's data files, not in the container env. Recreating a
container with `NEO4J_AUTH=neo4j/foo` against an existing volume that was
created with `NEO4J_AUTH=neo4j/bar` will silently keep the old `bar`
password. To change a password on an existing volume, use `cypher-shell`:

```bash
docker exec -it neo4j cypher-shell -u neo4j -p oldpass \
  "ALTER USER neo4j SET PASSWORD 'newpass'"
```

**Connection pooling on the service side.** The Node service holds a
long-lived `neo4j-driver` connection. Stopping the container kills all
in-flight queries with confusing errors. Restart the service after any
container swap.

**Restoring on a non-empty target.** Constraint violations. Wipe the
target first or use a fresh volume.

**Running export.sh against the wrong container.** If you've named the
new container something other than `neo4j`, update the `docker exec
neo4j ...` lines in `export.sh`.

**APOC missing.** If `apoc.export.cypher.all` errors with "no procedure",
the container wasn't started with `NEO4J_PLUGINS='["apoc"]'`. Recreate
the container with that env var.

---

## When to back up

- **Before any volume swap** (Path A or B) — non-negotiable.
- **Before upgrading** Neo4j or APOC versions.
- **Before running large bulk operations** (M6 historical ingestion, the
  Janitor in non-dryRun mode, manual Cypher you're not confident in).
- **On a regular cadence** if the graph is valuable. `export.sh` is
  cron-able.

---

## When restoring isn't enough

Cypher dumps capture data, not infrastructure. If you're moving to a new
machine, also reproduce:

- The Docker volume creation (`docker run ... -v neo4j_data:/data ...`).
- The service `.env` (API keys, NEO4J_PASS).
- The `daemon-config.json` toggles, if you've customized them.
- The hook configuration in `~/.claude/settings.json`.

The repo has all of these as code or example files. The graph is the only
piece that doesn't reproduce itself.
