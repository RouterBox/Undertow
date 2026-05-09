/**
 * Prowler Daemon — External knowledge hunting
 *
 * UPSTREAM: Brave Search — fast web search, augments flashes
 *   Only fires when the user is genuinely asking about something external.
 *   NOT on every prompt. NOT on internal project discussion.
 *
 * DOWNSTREAM: Perplexity — deep research, writes neurons to graph
 *   Only fires on genuine technical topics worth researching.
 *   NOT on conversation metadata or train-of-thought labels.
 */

import { getDaemonConfig } from './loader.js';

const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search';
const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';

async function braveSearch(query, apiKey) {
  const url = `${BRAVE_API}?q=${encodeURIComponent(query)}&count=5`;
  const response = await fetch(url, {
    headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) return null;
  const data = await response.json();
  const results = (data.web?.results || []).slice(0, 3);
  return results.map(r => `${r.title}: ${r.description} (${r.url})`).join('\n');
}

// Detect if a prompt is genuinely asking about something external/researchable
function isResearchWorthy(prompt) {
  // Must be long enough to contain a real question
  if (prompt.length < 100) return false;

  // Must NOT be a coding/operational command
  if (/^(fix|edit|update|delete|add|remove|change|run|test|build|deploy|commit|push|read|write|create|grep|find|check|review|list|show|turn|toggle|restart|stop|start|do |ok |yes|no |sure|go ahead)/i.test(prompt.trim())) return false;

  // Must contain signals of external curiosity
  const researchSignals = /\b(what|how|why|compare|versus|vs|alternative|best practice|latest|trend|research|explore|investigate|recommend|should we|is there|does anyone|state of the art)\b/i;
  if (!researchSignals.test(prompt)) return false;

  // Must NOT be about internal project state
  const internalSignals = /\b(commit|push|pull|merge|deploy|restart|toggle|endpoint|hook|daemon|neuron|synapse|flash|monitor|server\.js|package\.json|\.env|neo4j|docker|settings\.json)\b/i;
  if (internalSignals.test(prompt)) return false;

  return true;
}

// Detect if a topic string is a genuine researchable concept vs conversation metadata
function isResearchableTopic(topic) {
  if (!topic || topic.length < 5) return false;
  if (topic.length > 80) return false;

  // Reject conversation metadata patterns
  const metadataPatterns = /\b(confirmed|acknowledged|completed|detected|executed|logged|pushed|committed|restarted|toggled|verified|updated|created|deleted|fixed|built|shipped|processed|ingested)\b/i;
  if (metadataPatterns.test(topic)) return false;

  // Reject patterns that look like log entries or status updates
  if (/^\d|^[A-Z][0-9]|status|progress|milestone|commit|hook|endpoint|daemon|neuron|synapse/i.test(topic)) return false;

  // Reject very generic single-concept topics
  if (topic.split(/\s+/).length < 2) return false;

  // Must look like an actual technical concept
  const conceptSignals = /\b(architecture|pattern|algorithm|framework|protocol|design|system|model|strategy|technique|approach|principle|theory|implementation)\b/i;
  return conceptSignals.test(topic) || topic.split(/\s+/).length >= 3;
}

export default {
  name: 'prowler',
  type: 'upstream',
  description: 'Brave Search for external research, Perplexity for deep graph enrichment',
  defaultEnabled: true,

  /**
   * UPSTREAM: Brave Search — only fires on genuinely research-worthy prompts
   */
  async query({ prompt, keywords, session, config, log }) {
    const daemonConfig = getDaemonConfig('prowler');
    if (!daemonConfig.enabled) return [];

    const braveKey = process.env.BRAVE_API_KEY;
    if (!braveKey) return [];

    session.researchCount = session.researchCount || 0;
    const maxSearches = daemonConfig.maxSearchesPerSession || 5;
    if (session.researchCount >= maxSearches) return [];

    // Strict gate: only fire on genuinely research-worthy prompts
    if (!isResearchWorthy(prompt)) return [];

    const searchTerms = keywords.filter(w => w.length > 4).slice(0, 5).join(' ');
    if (searchTerms.length < 15) return [];

    session.researchCount++;
    log('research', 'info', `brave search: "${searchTerms}"`);

    try {
      const result = await braveSearch(searchTerms, braveKey);
      if (!result) return [];

      return [{
        name: `research: ${searchTerms.substring(0, 50)}`,
        flash: result.substring(0, 300),
        type: 'research',
        score: 0.4,
        daemon: 'research-brave'
      }];
    } catch (e) {
      if (e.name === 'TimeoutError') {
        log('research', 'info', 'brave timeout — skipped');
      } else {
        log('research', 'warn', `brave error: ${e.message}`);
      }
      return [];
    }
  },

  /**
   * DOWNSTREAM: Perplexity — only researches genuine technical topics
   */
  async deepResearch({ topics, runCypher, log }) {
    const daemonConfig = getDaemonConfig('prowler');
    const perplexityKey = process.env.PERPLEXITY_API_KEY;

    if (!perplexityKey) return { neurons: 0 };
    if (!topics || topics.length === 0) return { neurons: 0 };

    // Filter to genuinely researchable topics
    const researchable = topics.filter(isResearchableTopic);
    if (researchable.length === 0) {
      log('research', 'info', `deep research: 0 researchable topics from ${topics.length} candidates`);
      return { neurons: 0 };
    }

    let neuronsCreated = 0;
    const researchTopics = researchable.slice(0, 2); // Max 2 per session
    log('research', 'info', `deep research: ${researchTopics.length} topics (filtered from ${topics.length})`);

    for (const topic of researchTopics) {
      try {
        const response = await fetch(PERPLEXITY_API, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${perplexityKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: daemonConfig.perplexityModel || 'sonar',
            messages: [{
              role: 'user',
              content: `What are the latest developments, best practices, or important context about: ${topic}? Focus on practical, actionable information a developer would want to know. Keep it concise.`
            }],
            max_tokens: 500
          }),
          signal: AbortSignal.timeout(120000)
        });

        if (!response.ok) {
          log('research', 'warn', `perplexity ${response.status} for "${topic}"`);
          continue;
        }

        const result = await response.json();
        const answer = result.choices?.[0]?.message?.content;
        if (!answer || answer.length < 50) continue;

        const neuronName = `Research: ${topic.substring(0, 40)}`;
        const existing = await runCypher(
          'MATCH (n:Neuron {name: $name}) RETURN n.name LIMIT 1',
          { name: neuronName }
        );

        if (existing.length === 0) {
          const flash = answer.replace(/[{}[\]]/g, '').substring(0, 100);
          const body = answer.replace(/[{}[\]]/g, '').substring(0, 500);

          await runCypher(`
            CREATE (n:Neuron {
              name: $name, node_type: 'research', tier: 'T2_working',
              flash_summary: $flash, body: $body,
              source: 'perplexity', base_score: 40, decay_score: 40,
              times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
              created_at: datetime(), last_surfaced: datetime()
            })
          `, { name: neuronName, flash, body });

          neuronsCreated++;
          log('research', 'info', `created neuron: ${neuronName}`);
        }
      } catch (e) {
        log('research', 'warn', `deep research error for "${topic}": ${e.message}`);
      }
    }

    log('research', 'info', `deep research complete: ${neuronsCreated} neurons`);
    return { neurons: neuronsCreated };
  }
};
