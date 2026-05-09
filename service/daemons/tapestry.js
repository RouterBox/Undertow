/**
 * Tapestry Daemon — Projection daemon
 *
 * Materializes the Neo4j graph into an Obsidian-compatible markdown vault.
 * Neurons become pages. Synapses become [[wikilinks]]. Communities become cluster pages.
 */

import { mkdir, writeFile, readdir, unlink } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getDaemonConfig } from './loader.js';

// Project root = two levels up from this file (service/daemons/tapestry.js)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

function toFilename(name) {
  return sanitizeName(name) + '.md';
}

export default {
  name: 'tapestry',
  type: 'projection',
  description: 'Materialize Neo4j graph into an Obsidian vault',
  defaultEnabled: false,

  async project({ runCypher, config, log }) {
    const daemonConfig = getDaemonConfig('tapestry');
    if (!daemonConfig.enabled) {
      log('tapestry', 'info', 'wiki daemon disabled');
      return { files: 0 };
    }

    // Relative paths resolve against project root so the config can stay portable.
    // Absolute paths (and ~/foo) resolve as you'd expect.
    const configured = (daemonConfig.vaultPath || './obsidian-vault').replace('~', homedir());
    const vaultPath = resolve(PROJECT_ROOT, configured);
    const startTime = Date.now();
    let filesWritten = 0;

    // Ensure directories
    await mkdir(join(vaultPath, 'neurons'), { recursive: true });
    await mkdir(join(vaultPath, 'clusters'), { recursive: true });
    await mkdir(join(vaultPath, 'meta'), { recursive: true });

    const minScore = daemonConfig.minNeuronScore || 10;

    // --- Fetch all neurons ---
    const neurons = await runCypher(`
      MATCH (n:Neuron)
      WITH n,
           CASE n.tier WHEN 'T1_index' THEN 0.005 WHEN 'T2_working' THEN 0.02 ELSE 0.05 END AS lambda,
           duration.between(n.last_surfaced, datetime()).days AS daysSince
      WITH n, n.base_score * exp(-lambda * daysSince) AS liveScore
      WHERE liveScore >= $minScore OR n.tier = 'T1_index'
      RETURN n.name AS name, n.node_type AS type, n.tier AS tier,
             n.flash_summary AS flash, n.body AS body,
             n.base_score AS baseScore, liveScore,
             n.times_surfaced AS surfaced, n.times_pursued AS pursued,
             n.times_dismissed AS dismissed,
             n.created_at AS created, n.last_surfaced AS lastSurfaced,
             n.source AS source, n.community_id AS communityId,
             n.pagerank AS pagerank, n.bridge_score AS bridgeScore,
             n.source_url AS sourceUrl, n.source_path AS sourcePath
      ORDER BY liveScore DESC
    `, { minScore }).catch(() => []);

    log('tapestry', 'info', `generating vault for ${neurons.length} neurons`);

    // --- Fetch all synapses ---
    const synapses = await runCypher(`
      MATCH (a:Neuron)-[s:SYNAPSE]->(b:Neuron)
      RETURN a.name AS source, b.name AS target,
             s.edge_type AS edgeType, s.weight AS weight, s.context AS context
    `).catch(() => []);

    // Build connection maps
    const connectionsFrom = {};
    const connectionsTo = {};
    for (const s of synapses) {
      if (!connectionsFrom[s.source]) connectionsFrom[s.source] = [];
      if (!connectionsTo[s.target]) connectionsTo[s.target] = [];
      connectionsFrom[s.source].push(s);
      connectionsTo[s.target].push({ ...s, source: s.target, target: s.source });
    }

    // --- Generate neuron pages ---
    for (const n of neurons) {
      const connections = [
        ...(connectionsFrom[n.name] || []),
        ...(connectionsTo[n.name] || [])
      ];

      // Deduplicate connections
      const seen = new Set();
      const uniqueConns = connections.filter(c => {
        const other = c.target === n.name ? c.source : c.target;
        if (seen.has(other)) return false;
        seen.add(other);
        return true;
      });

      const score = typeof n.liveScore === 'object' ? n.liveScore.low : (n.liveScore || 0);
      const pr = n.pagerank ? (typeof n.pagerank === 'object' ? n.pagerank : n.pagerank).toFixed(3) : 'n/a';
      const bs = n.bridgeScore ? (typeof n.bridgeScore === 'object' ? n.bridgeScore : n.bridgeScore).toFixed(3) : 'n/a';
      const community = n.communityId != null ? `#${typeof n.communityId === 'object' ? n.communityId.low : n.communityId}` : 'unassigned';

      let page = `# ${n.name}\n\n`;
      page += `> ${n.flash || 'No summary'}\n\n`;
      page += `**Type:** ${n.type || 'unknown'} | **Tier:** ${n.tier || 'T2_working'} | **Score:** ${score.toFixed(1)}\n`;
      page += `**Created:** ${n.created ? n.created.toString().split('T')[0] : 'unknown'} | **Last surfaced:** ${n.lastSurfaced ? n.lastSurfaced.toString().split('T')[0] : 'never'}\n`;
      page += `**Pursued:** ${n.pursued || 0} | **Dismissed:** ${n.dismissed || 0} | **Surfaced:** ${n.surfaced || 0}\n`;
      page += `**PageRank:** ${pr} | **Bridge:** ${bs} | **Community:** ${community}\n`;

      if (n.source) page += `**Source:** ${n.source}`;
      if (n.sourceUrl) page += ` | [URL](${n.sourceUrl})`;
      if (n.sourcePath) page += ` | \`${n.sourcePath}\``;
      if (n.source) page += '\n';

      page += '\n---\n\n';

      if (n.body) {
        page += `${n.body}\n\n`;
      }

      if (uniqueConns.length > 0) {
        page += '## Connections\n\n';
        for (const c of uniqueConns) {
          const other = c.target === n.name ? c.source : c.target;
          const w = typeof c.weight === 'object' ? c.weight : (c.weight || 0);
          page += `- [[${sanitizeName(other)}]] — ${c.edgeType || 'associative'} (weight: ${typeof w === 'number' ? w.toFixed(2) : w})`;
          if (c.context) page += ` — "${c.context}"`;
          page += '\n';
        }
      }

      await writeFile(join(vaultPath, 'neurons', toFilename(n.name)), page);
      filesWritten++;
    }

    // --- Generate cluster pages ---
    let communities = {};
    if (daemonConfig.generateClusters) {
      for (const n of neurons) {
        const cid = n.communityId != null ? (typeof n.communityId === 'object' ? n.communityId.low : n.communityId) : -1;
        if (cid === -1) continue;
        if (!communities[cid]) communities[cid] = [];
        communities[cid].push(n);
      }

      for (const [cid, members] of Object.entries(communities)) {
        if (members.length < 2) continue;

        // Sort by pagerank
        members.sort((a, b) => ((b.pagerank || 0) - (a.pagerank || 0)));

        let page = `# Cluster ${cid}\n\n`;
        page += `**Neurons:** ${members.length}\n\n`;
        page += '## Members\n\n';
        for (const m of members) {
          const pr = m.pagerank ? (typeof m.pagerank === 'number' ? m.pagerank.toFixed(3) : 'n/a') : 'n/a';
          page += `- [[${sanitizeName(m.name)}]] (${m.type}, PR: ${pr})\n`;
        }

        // Find bridge nodes in this cluster
        const bridges = members.filter(m => m.bridgeScore && (typeof m.bridgeScore === 'number' ? m.bridgeScore : 0) > 0.5);
        if (bridges.length > 0) {
          page += '\n## Bridge Nodes\n\n';
          for (const b of bridges) {
            page += `- [[${sanitizeName(b.name)}]] — bridge score: ${typeof b.bridgeScore === 'number' ? b.bridgeScore.toFixed(3) : b.bridgeScore}\n`;
          }
        }

        await writeFile(join(vaultPath, 'clusters', `cluster-${cid}.md`), page);
        filesWritten++;
      }
    }

    // --- Generate index ---
    let index = '# Undertow Knowledge Graph\n\n';
    index += `*Generated: ${new Date().toISOString().split('T')[0]}*\n\n`;
    index += `**Neurons:** ${neurons.length} | **Synapses:** ${synapses.length}\n\n`;
    index += '## All Neurons\n\n';

    // Group by type
    const byType = {};
    for (const n of neurons) {
      const t = n.type || 'unknown';
      if (!byType[t]) byType[t] = [];
      byType[t].push(n);
    }

    for (const [type, members] of Object.entries(byType).sort()) {
      index += `### ${type} (${members.length})\n\n`;
      for (const m of members) {
        index += `- [[${sanitizeName(m.name)}]] — ${m.flash || 'no summary'}\n`;
      }
      index += '\n';
    }

    await writeFile(join(vaultPath, 'index.md'), index);
    filesWritten++;

    // --- Generate stats page ---
    let stats = '# Graph Statistics\n\n';
    stats += `*Updated: ${new Date().toISOString()}*\n\n`;
    stats += `| Metric | Value |\n|---|---|\n`;
    stats += `| Neurons | ${neurons.length} |\n`;
    stats += `| Synapses | ${synapses.length} |\n`;
    stats += `| Neuron types | ${Object.keys(byType).join(', ')} |\n`;
    stats += `| Communities | ${Object.keys(communities || {}).length} |\n`;

    await writeFile(join(vaultPath, 'meta', 'graph-stats.md'), stats);
    filesWritten++;

    const elapsed = Date.now() - startTime;
    log('tapestry', 'info', `vault generated: ${filesWritten} files in ${elapsed}ms at ${vaultPath}`);

    return { files: filesWritten, path: vaultPath, elapsed };
  }
};
