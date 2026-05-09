# Undertow Daemon Plugin System

Daemons are pluggable actors that read from and/or write to the Neo4j graph.

## Daemon Interface

Every daemon exports an object with:

```javascript
export default {
  name: 'daemon-name',
  type: 'upstream' | 'downstream' | 'projection' | 'input',
  description: 'What this daemon does',
  defaultEnabled: true,

  // For upstream daemons (query-time): return candidate neurons
  async query({ prompt, keywords, session, runCypher, config }) → [{ name, flash, type, score, daemon }]

  // For downstream daemons (batch): enrich the graph
  async run({ runCypher, callAnthropic, config, log }) → { processed, created, pruned }

  // For projection daemons: generate output files
  async project({ runCypher, config, log }) → { files }

  // For input daemons: ingest external sources
  async ingest({ source, runCypher, callAnthropic, config, log }) → { neurons }
}
```

Not all methods are required — only implement what your daemon type needs.

## Configuration

Daemons are configured in `service/daemon-config.json`. Each daemon can be toggled on/off and has type-specific settings.
