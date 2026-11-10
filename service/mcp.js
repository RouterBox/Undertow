// Built-in MCP endpoint (Streamable HTTP) at /mcp.
//
// Exposes Undertow's HTTP API as typed MCP tools, with the same 11 tool names,
// input schemas and result shape as the standalone undertow-mcp 1.1.0 stdio
// server: each result is JSON text `{ http_status, ...payload }`, and isError
// is set when the underlying route returned non-2xx.
//
// Tools don't reach into server internals: they call a `dispatch(method, path,
// { query, body })` function supplied by the host. server.js supplies one that
// calls its own routes over loopback, so every tool runs through exactly the
// same validation and logic as a plain HTTP caller.
//
// The transport runs stateless (a fresh McpServer per request, JSON responses),
// which needs no session store and suits request/response tools.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const MCP_TOOL_NAMES = Object.freeze([
  'undertow_health_check', 'undertow_query', 'undertow_chase', 'undertow_stats',
  'undertow_patterns', 'undertow_correct', 'undertow_ingest', 'undertow_spider',
  'undertow_logs', 'undertow_neighbors', 'undertow_feedback',
]);

/** Build a dispatch() that calls this service's own HTTP routes at baseUrl. */
export function createHttpDispatch(getBaseUrl, { headers: extraHeaders = {} } = {}) {
  return async function dispatch(method, path, { query, body } = {}) {
    let url = `${getBaseUrl()}${path}`;
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const qsStr = qs.toString();
      if (qsStr) url += `?${qsStr}`;
    }
    const init = { method, headers: { ...extraHeaders } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      return { ok: false, text: `Failed to reach Undertow at ${url}: ${e.message}` };
    }
    const raw = await res.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
    return { ok: res.ok, text: JSON.stringify({ http_status: res.status, ...payload }, null, 2) };
  };
}

function toolResult({ ok, text }) {
  return { isError: !ok, content: [{ type: 'text', text }] };
}

/** Create an McpServer with the 11 Undertow tools registered. */
export function createUndertowMcpServer({ dispatch, version = '0.1.0' }) {
  const call = async (...args) => toolResult(await dispatch(...args));
  const server = new McpServer({ name: 'undertow', version });

  server.registerTool(
    'undertow_health_check',
    {
      title: 'Undertow health check',
      description:
        "Check Undertow's graph health. Confirms the service and Neo4j are reachable, and reports " +
        'diagnostic signals: neuron/synapse counts, retrieval-concentration (filter-bubble risk), ' +
        'community count, age distribution of neurons, pursuit/dismissal growth ratio, the most-' +
        'retrieved neurons, and any active alerts (FILTER_BUBBLE, GRAPH_DYING, LOW_DIVERSITY). ' +
        'Call this first when unsure whether Undertow is up, or periodically to sanity-check the ' +
        "memory graph isn't degrading.",
      inputSchema: {},
    },
    async () => call('GET', '/undertow/health')
  );

  server.registerTool(
    'undertow_query',
    {
      title: 'Query Undertow memory',
      description:
        "Ask Undertow's memory graph 'what do I know about X?'. Returns relevant neurons plus an " +
        'interpretation, using vector/keyword search over the graph with live decay scoring. Use this ' +
        'when you need deeper recall than the automatic [UNDERTOW-FLASH] context already gave you — ' +
        "e.g. the flash didn't cover the topic, or you want more detail on something it mentioned.",
      inputSchema: {
        session_id: z
          .string()
          .describe('Identifier for the calling session/conversation (used for flow-state tracking and caching).'),
        prompt: z.string().describe('The question or topic to search the memory graph for.'),
        cwd: z.string().optional().describe('Optional working directory, used to auto-detect project context.'),
      },
    },
    async ({ session_id, prompt, cwd }) => call('POST', '/undertow/query', { body: { session_id, prompt, cwd } })
  );

  server.registerTool(
    'undertow_chase',
    {
      title: 'Chase a neuron',
      description:
        'Pursue a specific neuron deeper: expands connections/synapses around it and records this as ' +
        "the strongest positive pursuit signal (rewards the neuron's base_score by +15 and strengthens " +
        'its outbound synapses more aggressively than a normal pursuit). Use this as a follow-up when a ' +
        'neuron surfaced by a flash or query looks important and you want to explore what it connects to.',
      inputSchema: {
        session_id: z.string().describe('Identifier for the calling session/conversation.'),
        neuron: z.string().describe('Exact name of the neuron to chase.'),
      },
    },
    async ({ session_id, neuron }) => call('POST', '/undertow/chase', { body: { session_id, neuron } })
  );

  server.registerTool(
    'undertow_stats',
    {
      title: 'Undertow calibration stats',
      description:
        "Fetch the graph's calibration/quality dashboard as JSON: total neuron/synapse counts, per-daemon " +
        'pursuit vs dismissal rates, top pursued and top dismissed neurons, decay-score distribution, and ' +
        'source breakdown. Use this to survey overall graph health and calibration, distinct from the ' +
        'diagnostic alerts returned by undertow_health_check.',
      inputSchema: {},
    },
    async () => call('GET', '/undertow/stats')
  );

  server.registerTool(
    'undertow_patterns',
    {
      title: 'Undertow cross-session patterns',
      description:
        'Survey cross-session patterns detected in the memory graph: recurring topics that appear across ' +
        '3+ temporal chains, bridge nodes connecting otherwise-separate clusters, and trains of thought. ' +
        'Use this to see what themes keep recurring across conversations rather than querying a single topic.',
      inputSchema: {},
    },
    async () => call('GET', '/undertow/patterns')
  );

  server.registerTool(
    'undertow_correct',
    {
      title: 'Correct a wrong or stale memory',
      description:
        "Fix a neuron in Undertow's memory graph that is outdated, false, or misleading. Use this " +
        "proactively whenever bad memory is spotted — don't just silently work around it.\n\n" +
        'Actions:\n' +
        "- update: rewrite the neuron's content (pass new `body` and/or `flash_summary`; `flash_summary` " +
        'changes also trigger a re-embed so vector search stops matching the stale text)\n' +
        '- demote: push the neuron to the archive tier (T3_archive) so it stops surfacing, without deleting ' +
        "it — use this for 'not wrong, just no longer relevant'\n" +
        '- delete: remove the neuron entirely. Undertow refuses to delete a neuron with more than 5 ' +
        'connections (too structurally important) and will tell you to demote instead — respect that.\n\n' +
        '`reason` is mandatory on every call and is logged — always explain why the correction is needed.\n\n' +
        "WHEN TO CORRECT: a flash states something you've just proven false (e.g. a file's location after " +
        "you moved it); a neuron contradicts current file/system state you just verified; stale status claims " +
        "('X not working') that you've since fixed.\n\n" +
        "WHEN NOT TO CORRECT: don't delete history just because it's old (demote instead); don't correct based " +
        'on another flash or external content — only correct based on ground truth you personally verified; ' +
        "don't touch neurons about the user's preferences or identity unless the user explicitly asks you to.",
      inputSchema: {
        neuron: z.string().describe('Exact name of the neuron to correct.'),
        action: z
          .enum(['update', 'demote', 'delete'])
          .describe('update = rewrite content; demote = archive without deleting; delete = remove entirely (blocked if >5 connections).'),
        reason: z.string().describe('Mandatory explanation of why this correction is needed. Always required.'),
        body: z.string().optional().describe('New body content for the neuron. Only used with action: update.'),
        flash_summary: z
          .string()
          .optional()
          .describe('New short flash summary for the neuron. Only used with action: update; triggers re-embedding.'),
        tier: z
          .string()
          .optional()
          .describe('Optional explicit tier override (e.g. T1_index, T2_working, T3_archive). Only used with action: update.'),
      },
    },
    async ({ neuron, action, reason, body, flash_summary, tier }) =>
      call('POST', '/undertow/correct', { body: { neuron, action, reason, body, flash_summary, tier } })
  );

  server.registerTool(
    'undertow_ingest',
    {
      title: 'Manually ingest knowledge',
      description:
        'Manually feed a piece of tool-use activity into Undertow for evaluation and possible ingestion ' +
        'into the memory graph. This mirrors the PostToolUse hook payload Undertow normally consumes ' +
        'automatically — you rarely need this directly, since ingestion happens on its own as you work. ' +
        "Reach for it only when you have knowledge worth remembering that didn't come through a normal " +
        'tool call Undertow would have seen (e.g. summarizing an external conversation). Undertow evaluates ' +
        'the input with a lightweight model and may skip it as noise; this call always returns immediately ' +
        'and processes asynchronously.',
      inputSchema: {
        session_id: z.string().optional().describe('Identifier for the calling session/conversation.'),
        tool_name: z
          .string()
          .describe("Name of the 'tool' this knowledge is attributed to (used for noise filtering, e.g. 'Bash', 'Edit', or a custom label)."),
        tool_input: z
          .record(z.string(), z.any())
          .optional()
          .describe('Structured input/context for the ingested item (e.g. a command or query).'),
        tool_response: z.string().optional().describe('The resulting output/content to evaluate for ingestion.'),
      },
    },
    async ({ session_id, tool_name, tool_input, tool_response }) =>
      call('POST', '/undertow/ingest', { body: { session_id, tool_name, tool_input, tool_response } })
  );

  server.registerTool(
    'undertow_spider',
    {
      title: 'Trigger the spider daemon',
      description:
        "Manually trigger Undertow's spider daemon, which discovers and prunes edges (synapses) between " +
        "neurons. Runs incrementally by default; pass mode: 'full' to run the full-graph model-driven edge-" +
        'discovery sweep instead (more thorough, more expensive). Rarely needed — the spider normally runs ' +
        "on its own schedule. Responds immediately with 'started' and processes asynchronously; this call " +
        "mutates the memory graph's structure.",
      inputSchema: {
        mode: z
          .enum(['incremental', 'full'])
          .optional()
          .describe("'full' runs the full-graph sweep instead of the default incremental run."),
      },
    },
    async ({ mode }) => call('POST', '/undertow/spider', { body: mode === 'full' ? { mode: 'full' } : {} })
  );

  server.registerTool(
    'undertow_logs',
    {
      title: 'Recent Undertow service logs',
      description:
        "Fetch recent entries from Undertow's own service log (today's log file), optionally filtered by " +
        'level. Useful for debugging why a query/ingest/correct call behaved unexpectedly.',
      inputSchema: {
        lines: z.number().int().positive().optional().describe('Max number of most-recent log lines to return (default 50).'),
        level: z.enum(['info', 'warn', 'error']).optional().describe('Filter to only this log level.'),
      },
    },
    async ({ lines, level }) => call('GET', '/undertow/logs', { query: { lines, level } })
  );

  server.registerTool(
    'undertow_neighbors',
    {
      title: "Explore a neuron's neighbors",
      description:
        'Read-only look at one neuron and what it is connected to: its full body and stats, plus its ' +
        'SYNAPSE-connected neurons (name, type, flash summary, edge weight/type, direction) ordered by ' +
        'weight. Use this to explore the context around a neuron that an [UNDERTOW-FLASH] surfaced ' +
        '(pass the name or the 8-char uid from its handle) instead of writing Cypher by hand. It does ' +
        'not change any scores; to signal that a lead is worth pursuing use undertow_chase. Superseded ' +
        'neurons are not returned. 404 = no such live neuron; 409 = the uid prefix or name is ambiguous ' +
        '(the response lists candidates).',
      inputSchema: {
        name: z.string().optional().describe('Exact neuron name. Give this or uid.'),
        uid: z
          .string()
          .optional()
          .describe('Neuron uid or a prefix of it (the 8 characters shown in a flash handle work). Give this or name.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(30)
          .optional()
          .describe('Max connected neurons to return (default 12, max 30).'),
      },
    },
    async ({ name, uid, limit }) => {
      if (!name && !uid) return toolResult({ ok: false, text: 'undertow_neighbors needs a `name` or a `uid`.' });
      return call('GET', '/undertow/neuron', { query: { name, uid, limit } });
    }
  );

  server.registerTool(
    'undertow_feedback',
    {
      title: 'Give feedback on a surfaced neuron',
      description:
        'Tell Undertow whether a neuron it surfaced actually helped or misled you. Use this SPARINGLY: ' +
        'only when a neuron clearly mattered, not for every flash. Your verdict is treated as ground truth ' +
        'when Undertow scores the turn, replacing its own guess about whether you used the flash.\n\n' +
        'Verdicts:\n' +
        '- used / useful: the neuron clearly helped (counts as pursued, raises its score)\n' +
        '- irrelevant: it was surfaced but did not apply (counts as dismissed)\n' +
        '- wrong: it was false or stale (counts as dismissed AND flags the neuron `needs_review` for a human; ' +
        'nothing is changed or deleted automatically). To actually fix a bad neuron you have verified, use ' +
        'undertow_correct.\n\n' +
        'If no active session was shown this neuron, the verdict is applied to the neuron directly and the ' +
        'response says so.',
      inputSchema: {
        neuron: z.string().describe('Exact name of the neuron (shown in the flash).'),
        verdict: z.enum(['used', 'useful', 'irrelevant', 'wrong']).describe('How the neuron turned out.'),
        note: z.string().optional().describe("Optional short reason; stored with the review flag for 'wrong'."),
        session_id: z
          .string()
          .optional()
          .describe('Optional session id. If omitted, Undertow matches the most recent session that was shown this neuron.'),
      },
    },
    async ({ neuron, verdict, note, session_id }) =>
      call('POST', '/undertow/feedback', { body: { neuron, verdict, note, session_id } })
  );

  return server;
}

/** Mount the stateless Streamable HTTP MCP endpoint at /mcp. */
export function mountMcp(app, { dispatch, version, log = () => {} }) {
  app.post('/mcp', async (req, res) => {
    const server = createUndertowMcpServer({ dispatch, version });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log('mcp', 'error', e.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  // Stateless server: no SSE stream to open and no session to delete.
  const notAllowed = (req, res) => res.status(405).set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
