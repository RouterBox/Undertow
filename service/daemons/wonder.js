/**
 * Wonder Daemon — Proactive deep-thinking daemon
 *
 * Unlike Haiku (reactive, fires on each prompt, 5s budget), Wonder runs BETWEEN
 * turns with unlimited time. It reads the full transcript, walks the graph with
 * full conversation context, and pre-selects flashes for the next turn.
 *
 * Flow:
 * 1. Stop hook fires → Wonder daemon reads full JSONL transcript
 * 2. Walks graph with full conversation context (not just one prompt)
 * 3. Pre-selects neurons relevant to the conversation arc
 * 4. Stores prepared flashes in session memory
 * 5. Next UserPromptSubmit → serves pre-warmed flashes instantly
 * 6. Then adjusts/reconsiders based on the new prompt content
 *
 * Tagged as [OPUS] in flashes to distinguish from Haiku's reactive results.
 */

import { getDaemonConfig } from './loader.js';
import { getEmbedding } from '../embeddings.js';

export default {
  name: 'wonder',
  type: 'upstream',
  description: 'Proactive deep-thinking daemon — pre-warms flashes between turns using full conversation context',
  defaultEnabled: true,

  /**
   * PREPARE: Runs at session end (Stop hook) with full transcript.
   * Reads the conversation, walks the graph, pre-selects flashes.
   * Stores results in session.wonderPrepared for the next turn.
   */
  async prepare({ session, transcriptPath, cwd, sessionId, runCypher, callAnthropic, log }) {
    const daemonConfig = getDaemonConfig('wonder');
    if (!daemonConfig.enabled) return;

    // Don't prepare for unidentified sessions — prevents cross-instance contamination
    if (!sessionId || sessionId === 'default') {
      log('wonder', 'info', 'skipping prepare — no distinct session_id');
      return;
    }

    const startTime = Date.now();

    // Read recent transcript (last ~3000 chars for context)
    let transcript = '';
    if (transcriptPath) {
      try {
        const { readFile } = await import('fs/promises');
        const raw = await readFile(transcriptPath, 'utf8');
        // Get last ~3000 chars — enough for conversation context
        transcript = raw.slice(-3000);
      } catch {
        transcript = '';
      }
    }

    if (!transcript || transcript.length < 100) {
      log('wonder', 'info', 'insufficient transcript for preparation');
      return;
    }

    // Ask Sonnet model to analyze the conversation and identify what memories would help
    const analysisResult = await callAnthropic('claude-sonnet-4-6',
      `You are Undertow's deep-thinking daemon. You analyze a conversation transcript and decide what memories from a knowledge graph would be most valuable for the NEXT turn.

You are not crafting flashes — you are identifying TOPICS and QUESTIONS that the conversation is heading toward. Think about:
- What is the user working on right now?
- What decisions are being considered?
- What context from prior work would help?
- What might come up next based on the arc of conversation?

Return JSON:
{
  "conversation_summary": "2-3 sentence summary of what's being discussed",
  "search_queries": ["query 1 for graph search", "query 2", "query 3"],
  "anticipated_topics": ["topic the conversation might touch next"],
  "project": "detected project name or null"
}

Maximum 5 search queries. Focus on what would be USEFUL, not what was MENTIONED.`,
      `Recent conversation transcript:\n${transcript}`,
      500
    );

    if (!analysisResult) {
      log('wonder', 'info', 'analysis call failed');
      return;
    }

    let analysis;
    try {
      const text = analysisResult.response.content[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      log('wonder', 'warn', 'failed to parse analysis');
      return;
    }

    if (!analysis || !analysis.search_queries?.length) {
      log('wonder', 'info', 'no search queries from analysis');
      return;
    }

    log('wonder', 'info', `analysis: "${analysis.conversation_summary?.substring(0, 100)}"`);
    log('wonder', 'info', `queries: ${analysis.search_queries.join(', ')}`);

    // Run vector searches for each query
    const allCandidates = [];
    for (const query of analysis.search_queries.slice(0, 5)) {
      try {
        const embedding = await getEmbedding(query);
        if (!embedding) continue;

        const results = await runCypher(`
          CALL db.index.vector.queryNodes('neuron_embedding', 5, $embedding)
          YIELD node, score
          WITH node AS n, score AS vectorScore
          WHERE vectorScore > 0.3
          RETURN n.name AS name, n.flash_summary AS flash, n.node_type AS type,
                 n.body AS body, n.project AS project, vectorScore AS score
          ORDER BY score DESC LIMIT 5
        `, { embedding: Array.from(embedding) });

        for (const r of results) {
          // Deduplicate
          if (!allCandidates.find(c => c.name === r.name)) {
            allCandidates.push({ ...r, searchQuery: query });
          }
        }
      } catch (e) {
        log('wonder', 'warn', `search failed for "${query}": ${e.message}`);
      }
    }

    if (allCandidates.length === 0) {
      log('wonder', 'info', 'no candidates found');
      return;
    }

    // Store prepared flashes in session for next turn
    // Tagged with sessionId, cwd, and transcriptPath so we can detect cross-instance contamination
    session.wonderPrepared = {
      candidates: allCandidates,
      summary: analysis.conversation_summary,
      anticipatedTopics: analysis.anticipated_topics || [],
      preparedAt: Date.now(),
      sessionId,
      cwd,
      transcriptPath
    };

    const elapsed = Date.now() - startTime;
    log('wonder', 'info', `prepared ${allCandidates.length} candidates in ${elapsed}ms`);
  },

  /**
   * SERVE: Runs at query time (UserPromptSubmit).
   * Serves pre-warmed flashes instantly, then adjusts based on new prompt.
   * Returns candidates tagged as 'opus' daemon.
   */
  async query({ prompt, session, sessionId, cwd, log }) {
    const prepared = session.wonderPrepared;
    if (!prepared || !prepared.candidates?.length) {
      return [];
    }

    // Cross-instance safety: verify the prepared state belongs to THIS instance
    // If sessionId or cwd don't match, this is a different Claude Code instance
    if (prepared.sessionId && sessionId && prepared.sessionId !== sessionId) {
      log('wonder', 'info', `discarding prepared flashes — sessionId mismatch (prepared:${prepared.sessionId.substring(0,8)} current:${sessionId.substring(0,8)})`);
      session.wonderPrepared = null;
      return [];
    }
    if (prepared.cwd && cwd && prepared.cwd !== cwd) {
      log('wonder', 'info', `discarding prepared flashes — cwd mismatch`);
      session.wonderPrepared = null;
      return [];
    }

    // Check staleness — if prepared more than 10 minutes ago, discard
    if (Date.now() - prepared.preparedAt > 10 * 60 * 1000) {
      log('wonder', 'info', 'prepared flashes expired (>10min)');
      session.wonderPrepared = null;
      return [];
    }

    const promptLower = prompt.toLowerCase();

    // Score pre-warmed candidates against the new prompt
    const scored = prepared.candidates.map(c => {
      let relevance = c.score || 0.5;

      // Boost if the new prompt mentions related terms
      const flashWords = (c.flash || '').toLowerCase().split(/\s+/);
      const promptWords = promptLower.split(/\s+/).filter(w => w.length > 4);
      const overlap = promptWords.filter(w => flashWords.includes(w)).length;
      if (overlap > 0) relevance *= (1 + overlap * 0.2);

      // Boost if anticipated topic matches
      if (prepared.anticipatedTopics?.some(t =>
        promptLower.includes(t.toLowerCase())
      )) {
        relevance *= 1.3;
      }

      return {
        name: c.name,
        flash: c.flash,
        type: c.type,
        body: c.body,
        project: c.project,
        score: relevance,
        daemon: 'wonder'
      };
    });

    // Sort by adjusted relevance, take top results
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, 5);

    if (topResults.length > 0) {
      log('wonder', 'info', `serving ${topResults.length} pre-warmed flashes (context: "${prepared.summary?.substring(0, 60)}")`);
    }

    // Clear after serving (one-shot — will be reprepared after this turn's Stop hook)
    session.wonderPrepared = null;

    return topResults;
  }
};
