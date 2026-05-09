/**
 * Spider Daemon — Downstream graph enrichment
 *
 * Three jobs:
 * 1. Discover missing edges between semantically related neurons
 * 2. Prune forgotten nodes (configurable)
 * 3. Pre-compute GDS scores (PageRank, betweenness, community)
 */

import { getDaemonConfig } from './loader.js';

export default {
  name: 'spider',
  type: 'downstream',
  description: 'Retroactive edge discovery, graph pruning, and GDS score pre-computation',
  defaultEnabled: true,

  async run({ runCypher, callAnthropic, config, log }) {
    const daemonConfig = getDaemonConfig('spider');
    if (!daemonConfig.enabled) {
      log('spider', 'info', 'spider daemon disabled');
      return { processed: 0, created: 0, pruned: 0 };
    }

    const startTime = Date.now();
    let edgesCreated = 0;
    let neuronsPruned = 0;
    let neuronsProcessed = 0;

    // --- Phase 1: Edge Discovery ---
    log('spider', 'info', 'phase 1: edge discovery');

    // Find neurons that haven't been spidered yet, or were created since last run
    const unspidered = await runCypher(`
      MATCH (n:Neuron)
      WHERE n.spidered IS NULL OR n.spidered = false
      RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type
      ORDER BY n.created_at DESC
      LIMIT 20
    `).catch(err => {
      log('spider', 'error', `unspidered query failed: ${err.message}`);
      return [];
    });

    if (unspidered.length > 0) {
      // For each unspidered neuron, find potential connections
      for (const neuron of unspidered) {
        // Find neurons with overlapping keywords that aren't already connected
        const candidates = await runCypher(`
          MATCH (source:Neuron {name: $name})
          MATCH (candidate:Neuron)
          WHERE candidate.name <> source.name
          AND NOT (source)-[:SYNAPSE]-(candidate)
          // Keyword overlap: split flash summaries into words and find matches
          WITH source, candidate,
               [w IN split(toLower(source.flash_summary), ' ') WHERE size(w) > 4] AS sourceWords,
               [w IN split(toLower(candidate.flash_summary), ' ') WHERE size(w) > 4] AS candWords
          WITH source, candidate, sourceWords, candWords,
               size([w IN sourceWords WHERE w IN candWords]) AS overlap
          WHERE overlap >= 2
          RETURN candidate.name AS name, candidate.flash_summary AS flash,
                 candidate.node_type AS type, overlap
          ORDER BY overlap DESC
          LIMIT 5
        `, { name: neuron.name }).catch(err => {
          log('spider', 'error', `candidates query failed for ${neuron.name}: ${err.message}`);
          return [];
        });

        if (candidates.length > 0) {
          // Ask Haiku to evaluate which connections are meaningful
          const evalResult = await callAnthropic('claude-haiku-4-5-20251001',
            `You are Undertow's spider daemon. You evaluate potential connections between neurons in a knowledge graph.

For each candidate pair, decide if a meaningful connection exists. Return JSON:
{
  "connections": [
    { "target": "neuron name", "edge_type": "associative|causal|temporal|contradicts|contains", "weight": 0.3-0.8, "context": "why connected" }
  ]
}

Only include genuinely meaningful connections. Empty array is fine.`,
            `Source neuron: "${neuron.name}" (${neuron.type}): ${neuron.flash}

Candidates:
${candidates.map(c => `- "${c.name}" (${c.type}): ${c.flash} [overlap: ${c.overlap}]`).join('\n')}

Which of these candidates should be connected to the source? Only include meaningful relationships.`
          );

          if (evalResult) {
            try {
              const text = evalResult.response.content[0]?.text || '{}';
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { connections: [] };

              for (const conn of (parsed.connections || [])) {
                const maxEdges = daemonConfig.maxNewEdgesPerRun || 50;
                if (edgesCreated >= maxEdges) break;

                await runCypher(`
                  MATCH (src:Neuron {name: $src})
                  MATCH (tgt:Neuron {name: $tgt})
                  WHERE NOT (src)-[:SYNAPSE]-(tgt)
                  CREATE (src)-[:SYNAPSE {
                    weight: $weight, edge_type: $edgeType,
                    context: $context, created_at: datetime(),
                    source: 'spider'
                  }]->(tgt)
                `, {
                  src: neuron.name, tgt: conn.target,
                  weight: conn.weight || 0.5,
                  edgeType: conn.edge_type || 'associative',
                  context: conn.context || 'spider-discovered'
                }).catch(e => log('error', 'warn', e.message));
                edgesCreated++;
              }
            } catch {}
          }
        }

        // Mark as spidered
        await runCypher(
          'MATCH (n:Neuron {name: $name}) SET n.spidered = true, n.spidered_at = datetime()',
          { name: neuron.name }
        ).catch(e => log('error', 'warn', e.message));
        neuronsProcessed++;
      }
    }

    log('spider', 'info', `edge discovery: ${neuronsProcessed} neurons processed, ${edgesCreated} edges created`);

    // --- Phase 2: Pruning (hungry spider) ---
    if (daemonConfig.pruneEnabled) {
      log('spider', 'info', 'phase 2: pruning forgotten nodes');

      const threshold = daemonConfig.pruneThreshold || 5;
      const minAgeDays = daemonConfig.pruneMinAge || 30;

      // Find neurons that have completely decayed and were never useful
      const forgotten = await runCypher(`
        MATCH (n:Neuron)
        WHERE n.tier = 'T3_archive'
        AND n.times_pursued = 0
        AND n.times_surfaced > 0
        AND n.base_score < $threshold
        AND n.created_at < datetime() - duration({days: $minAge})
        // Don't prune neurons with many connections (they may be structurally important)
        WITH n, size([(n)-[:SYNAPSE]-() | 1]) AS connectionCount
        WHERE connectionCount < 3
        RETURN n.name AS name, n.flash_summary AS flash, n.base_score AS score,
               connectionCount, n.created_at AS created
        ORDER BY n.base_score ASC
        LIMIT 10
      `, { threshold, minAge: minAgeDays }).catch(err => {
        log('spider', 'error', `forgotten query failed: ${err.message}`);
        return [];
      });

      for (const node of forgotten) {
        // Delete the neuron and its synapses
        await runCypher(`
          MATCH (n:Neuron {name: $name})
          DETACH DELETE n
        `, { name: node.name }).catch(e => log('error', 'warn', e.message));

        log('spider', 'info', `pruned: ${node.name} (score: ${node.score}, connections: ${node.connectionCount})`);
        neuronsPruned++;
      }

      log('spider', 'info', `pruning: ${neuronsPruned} neurons removed`);
    }

    // --- Phase 3: GDS Score Pre-computation ---
    if (daemonConfig.precomputeGDS) {
      log('spider', 'info', 'phase 3: pre-computing GDS scores');

      // Check if we have enough nodes for GDS to be meaningful
      const countResult = await runCypher('MATCH (n:Neuron) RETURN count(n) AS count').catch(() => [{ count: 0 }]);
      const nodeCount = countResult[0]?.count?.low ?? countResult[0]?.count ?? 0;

      if (nodeCount >= 10) {
        try {
          // Drop existing projection if it exists
          await runCypher(`CALL gds.graph.drop('undertow-graph', false)`).catch(e => log('error', 'warn', e.message));

          // Create graph projection
          await runCypher(`
            CALL gds.graph.project(
              'undertow-graph',
              'Neuron',
              { SYNAPSE: { orientation: 'UNDIRECTED', properties: ['weight'] } }
            )
          `).catch(e => {
            log('spider', 'warn', `GDS projection failed: ${e.message}`);
          });

          // PageRank
          await runCypher(`
            CALL gds.pageRank.write('undertow-graph', {
              writeProperty: 'pagerank',
              maxIterations: 20
            })
          `).catch(e => log('spider', 'warn', `PageRank failed: ${e.message}`));

          // Betweenness centrality (bridge scores)
          await runCypher(`
            CALL gds.betweenness.write('undertow-graph', {
              writeProperty: 'bridge_score'
            })
          `).catch(e => log('spider', 'warn', `Betweenness failed: ${e.message}`));

          // Community detection (Louvain)
          await runCypher(`
            CALL gds.louvain.write('undertow-graph', {
              writeProperty: 'community_id'
            })
          `).catch(e => log('spider', 'warn', `Louvain failed: ${e.message}`));

          // Cleanup projection
          await runCypher(`CALL gds.graph.drop('undertow-graph', false)`).catch(e => log('error', 'warn', e.message));

          log('spider', 'info', 'GDS scores computed: pagerank, bridge_score, community_id');
        } catch (e) {
          log('spider', 'warn', `GDS computation failed: ${e.message}. GDS plugin may not be installed.`);
        }
      } else {
        log('spider', 'info', `skipping GDS: only ${nodeCount} neurons (need 10+)`);
      }
    }

    const elapsed = Date.now() - startTime;
    log('spider', 'info', `spider complete in ${elapsed}ms`, {
      detail: `processed: ${neuronsProcessed}, edges: ${edgesCreated}, pruned: ${neuronsPruned}`
    });

    return { processed: neuronsProcessed, created: edgesCreated, pruned: neuronsPruned, elapsed };
  }
};
