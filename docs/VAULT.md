# Vault Sync — markdown folders, Obsidian, and the two-way tapestry

Undertow can ingest markdown, keep watching it, and pull human edits back out
of its own Obsidian export. One shared importer (`service/vault.js`) powers
all of it. Changed notes always **supersede** their neuron (the old version is
archived and linked via `SUPERSEDES`) — nothing is silently overwritten.

## 1. Import a folder of .md files

```bash
curl -X POST http://localhost:3030/undertow/ingest-vault \
  -H "Content-Type: application/json" \
  -d '{"dir": "C:/notes", "namespace": "notes", "project": "notes"}'
```

- One neuron per note. Name = frontmatter `title` or the filename.
- Flash = frontmatter `summary`/`description`, else the first prose line.
- Idempotent: a content-hash ledger (`service/vault-ledger.json`) skips
  unchanged files; a changed file supersedes its neuron.
- Omit `namespace` to import into the live graph; set one to keep the
  import in its own isolated world.

## 2. Watch a folder (hot, ongoing)

`daemon-config.json`:

```json
"vaultwatch": {
  "enabled": true,
  "watches": [ { "dir": "C:/notes", "namespace": null, "project": "notes" } ],
  "debounceMs": 2000
}
```

The vaultwatch daemon starts with the service, watches recursively, debounces
rapid saves, and re-imports only what actually changed (hash check). Edits
supersede; new notes create; deletions are left alone (memory persists).

## 3. Obsidian vaults

Same endpoint — but Obsidian conventions are understood:

- Frontmatter: `title`, `type`/`node_type`, `tier`, `event_date` (or `date`),
  `summary`.
- `[[wikilinks]]` (including `[[Target|alias]]` and `[[Target#heading]]`)
  between imported notes become SYNAPSE edges (`source: 'vault-link'`,
  associative, weight 0.5) — pre-declared structure, zero LLM cost.
- `.obsidian/`, `.trash/`, and hidden directories are skipped.

## 4. Reverse-tapestry (two-way sync)

Tapestry exports the graph as an Obsidian vault and now writes
`meta/tapestry-manifest.json` (page → neuron + content hash). Edit pages in
Obsidian, then:

```bash
curl -X POST http://localhost:3030/undertow/tapestry-import \
  -H "Content-Type: application/json" -d '{}'   # vaultPath defaults to tapestry config
```

Pages whose hash differs from the manifest are parsed (the `> flash` line and
the body between the metadata separator and `## Connections`) and the neuron
is **superseded** with the human's edit. The manifest is updated so re-runs
are idempotent. Combined with a vaultwatch entry on the tapestry vault,
Obsidian becomes an editable UI for the graph.

Tapestry exports are live-graph only (no namespaced or superseded neurons),
so the round-trip is always against current memory.

## 5. Spider an imported vault

Spider is namespace-scoped, so an imported vault can be enriched in place:

```bash
# at import time:
curl -X POST http://localhost:3030/undertow/ingest-vault \
  -d '{"dir": "C:/notes", "namespace": "notes", "spider": true}'        # incremental
  # or "spider": "full" for the whole-namespace Haiku sweep

# or later:
curl -X POST http://localhost:3030/undertow/spider -d '{"namespace": "notes"}'
```

Edges and GDS scores stay inside the namespace — Spider cannot cross worlds.
