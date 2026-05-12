/**
 * Spider Daemon — Downstream graph enrichment
 *
 * Three jobs:
 * 1. Discover missing edges between semantically related neurons
 * 2. Prune forgotten nodes (configurable)
 * 3. Pre-compute GDS scores (PageRank, betweenness, community)
 */

import { getDaemonConfig } from './loader.js';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const SWEEP_EDGE_TYPES = ['causal', 'temporal', 'elaborates', 'contradicts', 'contains', 'prerequisite', 'associative'];

async function recomputeGDS(runCypher, log) {
  const countResult = await runCypher('MATCH (n:Neuron) RETURN count(n) AS count').catch(() => [{ count: 0 }]);
  const nodeCount = countResult[0]?.count?.low ?? countResult[0]?.count ?? 0;
  if (nodeCount < 10) {
    log('spider', 'info', `skipping GDS: only ${nodeCount} neurons`);
    return;
  }
  await runCypher(`CALL gds.graph.drop('undertow-graph', false)`).catch(() => {});
  await runCypher(`
    CALL gds.graph.project('undertow-graph', 'Neuron',
      { SYNAPSE: { orientation: 'UNDIRECTED', properties: ['weight'] } })
  `).catch(e => log('spider', 'warn', `GDS projection failed: ${e.message}`));
  await runCypher(`CALL gds.pageRank.write('undertow-graph', { writeProperty: 'pagerank', maxIterations: 20 })`)
    .catch(e => log('spider', 'warn', `PageRank failed: ${e.message}`));
  await runCypher(`CALL gds.betweenness.write('undertow-graph', { writeProperty: 'bridge_score' })`)
    .catch(e => log('spider', 'warn', `Betweenness failed: ${e.message}`));
  await runCypher(`CALL gds.louvain.write('undertow-graph', { writeProperty: 'community_id' })`)
    .catch(e => log('spider', 'warn', `Louvain failed: ${e.message}`));
  await runCypher(`CALL gds.graph.drop('undertow-graph', false)`).catch(() => {});
  log('spider', 'info', 'GDS recomputed: pagerank, bridge_score, community_id');
}

export default {
  name: 'spider',
  type: 'downstream',
  description: 'Retroactive edge discovery, graph pruning, and GDS score pre-computation',
  defaultEnabled: true,

  /**
   * Full-graph edge discovery sweep ("blunt mode").
   * Reads every neuron's body, batches them, and asks Haiku to find genuine
   * relationships within each batch — no keyword/vector pre-filter. Multiple
   * passes (one project-grouped, N random-shuffled) so cross-project bridges
   * get a chance too.
   */
  async runFullSweep({ runCypher, callAnthropic, config, log }) {
    const daemonConfig = getDaemonConfig('spider');
    const batchSize = daemonConfig.sweepBatchSize || 25;
    const randomPasses = daemonConfig.sweepRandomPasses ?? 2;
    const maxEdges = daemonConfig.maxSweepEdges || 800;
    const startTime = Date.now();

    const neurons = await runCypher(`
      MATCH (n:Neuron)
      RETURN elementId(n) AS eid, n.name AS name, n.node_type AS type,
             n.flash_summary AS flash, n.body AS body, n.project AS project
    `).catch(err => {
      log('spider', 'error', `sweep fetch failed: ${err.message}`);
      return [];
    });

    if (neurons.length < 2) {
      log('spider', 'info', `sweep skipped: only ${neurons.length} neurons`);
      return { mode: 'full', neurons: neurons.length, edgesCreated: 0 };
    }

    // Build the passes: one grouped by project, then `randomPasses` shuffled.
    const passes = [];
    const byProject = {};
    for (const n of neurons) {
      const p = n.project || '__untagged__';
      (byProject[p] = byProject[p] || []).push(n);
    }
    const projectPass = [];
    for (const group of Object.values(byProject)) {
      for (const b of chunk(shuffle(group), batchSize)) projectPass.push(b);
    }
    passes.push({ label: 'project', batches: projectPass });
    for (let i = 0; i < randomPasses; i++) {
      passes.push({ label: `random-${i + 1}`, batches: chunk(shuffle(neurons), batchSize) });
    }

    const totalBatches = passes.reduce((s, p) => s + p.batches.length, 0);
    log('spider', 'info', `full sweep: ${neurons.length} neurons, ${passes.length} passes, ${totalBatches} batches`);

    let edgesCreated = 0;
    let batchesDone = 0;
    let haikuCalls = 0;

    for (const pass of passes) {
      for (const batch of pass.batches) {
        if (edgesCreated >= maxEdges) {
          log('spider', 'info', `sweep hit maxSweepEdges (${maxEdges}), stopping early`);
          break;
        }
        batchesDone++;
        if (batch.length < 2) continue;

        const listing = batch.map((n, i) =>
          `[${i + 1}] (${n.type || 'note'}) "${n.name}"${n.project ? ` [project: ${n.project}]` : ''}\n` +
          `    summary: ${n.flash || '(none)'}\n` +
          `    body: ${truncate(n.body, 500)}`
        ).join('\n\n');

        let parsed = null;
        try {
          const result = await callAnthropic('claude-haiku-4-5-20251001',
            `You are Undertow's Spider daemon doing knowledge-graph edge discovery.

You receive a numbered list of memory neurons (knowledge units). Find pairs that share a GENUINE, SPECIFIC relationship. Ignore vague topical overlap — only connect neurons where one actually informs, causes, follows, contradicts, contains, or is required by another, or where they are tightly associated by a shared concrete subject.

Return ONLY JSON:
{ "edges": [ { "source": <number>, "target": <number>, "edge_type": "causal|temporal|elaborates|contradicts|contains|prerequisite|associative", "weight": <0.3-0.9>, "context": "<one sentence: how source relates to target>" } ] }

Be conservative. Most pairs are NOT related — an empty array is the correct answer for an unrelated batch. Never invent connections to fill the list. weight reflects confidence/strength.`,
            `Neurons in this batch:\n\n${listing}\n\nReturn the JSON now.`,
            3500
          );
          haikuCalls++;
          const text = result?.response?.content?.[0]?.text || '{}';
          const m = text.match(/\{[\s\S]*\}/);
          parsed = m ? JSON.parse(m[0]) : { edges: [] };
        } catch (e) {
          log('spider', 'warn', `sweep batch ${batchesDone} Haiku/parse failed: ${e.message}`);
          continue;
        }

        for (const edge of (parsed?.edges || [])) {
          if (edgesCreated >= maxEdges) break;
          const si = Number(edge.source), ti = Number(edge.target);
          if (!Number.isInteger(si) || !Number.isInteger(ti)) continue;
          if (si < 1 || ti < 1 || si > batch.length || ti > batch.length || si === ti) continue;
          const src = batch[si - 1], tgt = batch[ti - 1];
          if (src.eid === tgt.eid) continue;
          const edgeType = SWEEP_EDGE_TYPES.includes(edge.edge_type) ? edge.edge_type : 'associative';
          let weight = Number(edge.weight);
          if (!Number.isFinite(weight)) weight = 0.5;
          weight = Math.max(0.3, Math.min(0.9, weight));
          const context = truncate(typeof edge.context === 'string' ? edge.context : 'spider-sweep', 240);

          const res = await runCypher(`
            MATCH (a:Neuron), (b:Neuron)
            WHERE elementId(a) = $aid AND elementId(b) = $bid AND NOT (a)-[:SYNAPSE]-(b)
            CREATE (a)-[:SYNAPSE { weight: $weight, edge_type: $edgeType, context: $context,
                                   created_at: datetime(), source: 'spider-sweep' }]->(b)
            RETURN 1 AS created
          `, { aid: src.eid, bid: tgt.eid, weight, edgeType, context })
            .catch(e => { log('spider', 'warn', `sweep edge create failed: ${e.message}`); return []; });
          if (res && res.length > 0) edgesCreated++;
        }

        if (batchesDone % 10 === 0) {
          log('spider', 'info', `sweep progress: ${batchesDone}/${totalBatches} batches, ${edgesCreated} edges`);
        }
      }
      if (edgesCreated >= maxEdges) break;
    }

    log('spider', 'info', `sweep edge discovery done: ${edgesCreated} edges from ${haikuCalls} Haiku calls`);

    // Recompute GDS on the denser graph.
    if (daemonConfig.precomputeGDS) await recomputeGDS(runCypher, log);

    const elapsed = Date.now() - startTime;
    log('spider', 'info', `full sweep complete in ${elapsed}ms`, {
      detail: `neurons: ${neurons.length}, batches: ${batchesDone}, haikuCalls: ${haikuCalls}, edgesCreated: ${edgesCreated}`
    });
    return { mode: 'full', neurons: neurons.length, batches: batchesDone, haikuCalls, edgesCreated, elapsed };
  },

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
