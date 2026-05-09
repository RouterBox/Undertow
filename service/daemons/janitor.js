/**
 * Janitor Daemon — Content-quality cleanup
 *
 * Tougher than the hungry spider. The spider prunes by decay/score.
 * The janitor prunes by CONTENT QUALITY — identifies neurons that are
 * junk regardless of their score: self-referential tags, action labels,
 * empty-body topics, conversation metadata that got promoted to neurons.
 */

import { getDaemonConfig } from './loader.js';

// Patterns that identify garbage neurons
const GARBAGE_PATTERNS = {
  // Self-referential: name === flash_summary (lazy topic neurons)
  selfReferential: true,

  // Action/status labels that aren't real memories
  actionLabels: /^(PostToolUse|SessionStart|UserPromptSubmit|hook|toggle|restart|commit|push|pull|merge|deploy|confirmed|acknowledged|completed|detected|executed|logged|verified|updated|created|deleted|fixed|built|shipped|processed|ingested)\b/i,

  // Conversation metadata that got promoted
  metadataPatterns: /\b(hook (fired|triggered|success)|tool result|status (check|confirmation|update)|git (commit|push|pull|status|log)|file (read|write|edit|modified)|server (restart|confirmation|online)|daemon (config|status)|neo4j (connection|verified)|TTS (delivery|narration|announcement|output|confirmation))\b/i,

  // Very short flash_summary (under 20 chars = probably not real content)
  minFlashLength: 20,

  // Empty or near-empty body on non-topic neurons
  requireBody: true,

  // Research neurons with garbage web results
  garbageResearch: /\b(no (direct |relevant )?match|not found|unable to|I don't have|insufficient|Reddit|Stack Exchange|Medium\.com)\b/i,
};

export default {
  name: 'janitor',
  type: 'downstream',
  description: 'Content-quality cleanup — removes junk neurons based on content patterns, not scores',
  defaultEnabled: true,

  async run({ runCypher, log }) {
    const daemonConfig = getDaemonConfig('janitor');
    if (!daemonConfig.enabled) {
      log('janitor', 'info', 'janitor disabled');
      return { cleaned: 0 };
    }

    const startTime = Date.now();
    let cleaned = 0;
    const dryRun = daemonConfig.dryRun || false;

    // --- Pattern 1: Self-referential neurons (name === flash_summary) ---
    const selfRef = await runCypher(`
      MATCH (n:Neuron)
      WHERE n.name = n.flash_summary
      AND (n.body IS NULL OR n.body = '')
      RETURN n.name AS name, n.node_type AS type, n.base_score AS score,
             size([(n)-[:SYNAPSE]-() | 1]) AS connections
    `).catch(() => []);

    for (const n of selfRef) {
      const conns = typeof n.connections === 'object' ? n.connections.low : n.connections;
      if (conns > 5) continue; // Structurally important, skip
      if (dryRun) {
        log('janitor', 'info', `[DRY RUN] would clean self-referential: ${n.name}`);
      } else {
        await runCypher('MATCH (n:Neuron {name: $name}) DETACH DELETE n', { name: n.name }).catch(e => log('error', 'warn', e.message));
        log('janitor', 'info', `cleaned self-referential: ${n.name}`);
      }
      cleaned++;
    }

    // --- Pattern 2: Action/status label neurons ---
    const allNeurons = await runCypher(`
      MATCH (n:Neuron)
      WHERE (n.body IS NULL OR n.body = '')
      RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
             size([(n)-[:SYNAPSE]-() | 1]) AS connections
    `).catch(() => []);

    for (const n of allNeurons) {
      const conns = typeof n.connections === 'object' ? n.connections.low : n.connections;
      if (conns > 5) continue;

      const name = n.name || '';
      const flash = n.flash || '';

      // Check against garbage patterns
      const isActionLabel = GARBAGE_PATTERNS.actionLabels.test(name);
      const isMetadata = GARBAGE_PATTERNS.metadataPatterns.test(name) || GARBAGE_PATTERNS.metadataPatterns.test(flash);
      const isTooShort = flash.length < GARBAGE_PATTERNS.minFlashLength && flash === name;
      const isGarbageResearch = n.type === 'research' && GARBAGE_PATTERNS.garbageResearch.test(flash);

      if (isActionLabel || isMetadata || isTooShort || isGarbageResearch) {
        if (dryRun) {
          const reason = isActionLabel ? 'action label' : isMetadata ? 'metadata' : isTooShort ? 'too short' : 'garbage research';
          log('janitor', 'info', `[DRY RUN] would clean ${reason}: ${name}`);
        } else {
          await runCypher('MATCH (n:Neuron {name: $name}) DETACH DELETE n', { name: n.name }).catch(e => log('error', 'warn', e.message));
          const reason = isActionLabel ? 'action label' : isMetadata ? 'metadata' : isTooShort ? 'too short' : 'garbage research';
          log('janitor', 'info', `cleaned ${reason}: ${name}`);
        }
        cleaned++;
      }
    }

    const elapsed = Date.now() - startTime;
    log('janitor', 'info', `janitor complete: ${cleaned} neurons ${dryRun ? 'identified' : 'cleaned'} in ${elapsed}ms`);

    return { cleaned, elapsed, dryRun };
  }
};
