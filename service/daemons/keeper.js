// keeper.js — The Keeper daemon (session attachment & memory formation gating)
//
// The lighthouse keeper of the subconscious: decides which sessions the
// involuntary layer attends to. See docs/KEEPER.md for the full design.
//
// Tiers:
//   conscious — human conversation: full involuntary in/out
//   observer  — automation whose outcome should be remembered: quarantined writes only
//   drone     — ordinary automation: nothing involuntary
//   off       — explicitly excluded
//   (candidate — probationary default; earns 'conscious' via turn-taking)
//
// Assignment priority: explicit tier in the hook body (future command-hooks)
// → cwd rule match → existing ledger entry → candidate.
// Promotion: Nth prose prompt with at least one human-plausible inter-prompt
// gap. Producer one-shots never reach N; paste-storms don't look human.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { lookupAgent } from '../agent-roster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(__dirname, '..', 'keeper-ledger.json');

const VALID_TIERS = new Set(['conscious', 'observer', 'drone', 'off']);

const defaults = {
  enabled: true,
  promoteAfterTurns: 3,
  minCadenceSeconds: 5,
  ledgerTTLHours: 48,
  // Habituation: a prompt near-identical to one recently seen in the same
  // session is a heartbeat/loop/long-poll tick, not a thought — the
  // subconscious stops reacting to a repeated stimulus. First occurrence
  // flashes normally; repeats within the window are fast-pathed.
  habituationHours: 6,
  habituationMaxPrompts: 30,
  // Agentic promotion: deep agentic work is one substantial prompt followed by
  // hours of tool use — it never accumulates proseTurns, so prompt-count alone
  // silently starves real humans (2026-09-08 downstream report: 6 days, 125
  // gated events, zero promotions). Sustained tool volume over a long-lived
  // session is corroborating evidence of a live human; producer one-shots and
  // heartbeat ticks are short-lived and never reach both thresholds.
  agenticToolEvents: 150,
  agenticMinHours: 1,
  // cwd substring rules for owned automation (checked case-insensitively).
  cwdRules: [
    { pattern: 'agentbox-worktrees', tier: 'drone' },
  ],
  // Agent sessions (see docs/KEEPER.md). A session is an agent session when a
  // launcher's roster lists its id, or its cwd contains one of the patterns
  // below (case-insensitive; for an agent that is on no roster). Never
  // inferred from behaviour.
  agentRosters: [],              // URLs, each returning the sessions a launcher runs
  agentRosterKinds: ['spawned'], // a roster entry with a `kind` counts only if it is one of these
  agentCwdPatterns: [],
  // false: what Dreamer writes from an agent session goes through the held
  // tier (durable kinds only, held until a human session uses it).
  // true: an agent session is summarized like a person's.
  agentInsights: false,
  // false: Gobble writes nothing from an agent session, nor from a session a
  // configured roster could not answer for. true: such sessions ingest like any other.
  agentIngest: false,
};

const VALID_KINDS = new Set(['agent', 'human']);
// The hook events a Claude Code session sends (the payload's hook_event_name).
const HOOK_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PostCompact']);

let config = { ...defaults };
let ledger = new Map(); // sessionId → entry
let dirty = false;
let logFn = () => {};
// Why each session's latest prompt was habituated: 'repeat' | 'plumbing'.
// In-memory only (turn-scoped; a stale flag surviving a restart would wrongly
// skip a later Stop). Absent key = the latest prompt was not habituated.
const turnReasons = new Map();
let stats = { fastPathed: 0, promoted: 0, registered: 0, habituated: 0, agentIngestsDropped: 0, unknownIngestsDropped: 0 };
// Sessions whose first dropped ingest has been logged (PostToolUse fires constantly: one line each).
const ingestDropLogged = new Set();

// A prompt that is harness plumbing rather than a human thought — task
// notifications, system reminders — never deserves the involuntary layer.
// (2026-09-01 audit: 74% of full pipeline runs were leaked loop ticks whose
// letter-only task ids slipped past digit-based normalization.)
function isSystemPlumbing(text) {
  const t = String(text || '');
  return t.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]') || t.includes('<task-notification>');
}

// Normalize away ids, numbers, and whitespace so "task b3dzfglw4 completed"
// and "task bqyh0yi1q completed" fingerprint identically. Structural rules
// first: task/tool ids and task output paths are ids even when they contain
// no digits (e.g. "bepwhfzgs"), so the digit rule alone misses them.
function fingerprint(text) {
  const norm = String(text || '').toLowerCase()
    .replace(/<task-id>[^<]*<\/task-id>/g, '<task-id>#</task-id>')
    .replace(/<tool-use-id>[^<]*<\/tool-use-id>/g, '<tool-use-id>#</tool-use-id>')
    .replace(/tasks[\\/][a-z0-9_-]+\.output/g, 'tasks/#.output')
    .replace(/[a-z0-9]*\d[a-z0-9]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  let h = 0;
  for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) | 0;
  return h.toString(36) + ':' + norm.length;
}

function now() { return Date.now(); }

// Promotion. Two independent paths, either suffices:
//   conversational — N prose prompts with a human-plausible gap (the original rule)
//   agentic        — at least one real prompt plus sustained tool volume over a
//                    long-lived session (one prompt + hundreds of tool calls is
//                    how deep agentic work looks; it is not how one-shots look)
function maybePromote(e, sessionId) {
  if (e.tier !== 'candidate' || e.declared) return false;
  const conversational = e.proseTurns >= config.promoteAfterTurns && e.humanGaps >= 1;
  const ageHours = (now() - (e.firstSeen || now())) / 3600_000;
  const agentic = e.proseTurns >= 1 &&
    (e.toolEvents || 0) >= (config.agenticToolEvents || 150) &&
    ageHours >= (config.agenticMinHours || 1);
  if (!conversational && !agentic) return false;
  e.tier = 'conscious';
  e.promotedAt = now();
  e.promotedVia = conversational ? 'turn-taking' : 'agentic';
  stats.promoted++;
  dirty = true;
  logFn('keeper', 'info', `session ${String(sessionId).slice(0, 8)} promoted to conscious via ${conversational ? 'turn-taking' : 'agentic volume'} (${e.proseTurns} turns, ${e.humanGaps} human gaps, ${e.toolEvents || 0} tool events)`);
  return true;
}

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    ledger = new Map(Object.entries(raw.sessions || {}));
  } catch { /* corrupt ledger: start fresh */ }
}

function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    writeFileSync(LEDGER_PATH, JSON.stringify({ saved_at: new Date().toISOString(), sessions: Object.fromEntries(ledger) }));
  } catch { /* non-fatal */ }
}

function expireOld() {
  const ttlMs = (config.ledgerTTLHours || 48) * 3600_000;
  const cutoff = now() - ttlMs;
  const consciousCutoff = now() - ttlMs * 4; // conscious sessions linger 4x longer
  for (const [id, e] of ledger) {
    if ((e.lastSeen || 0) < cutoff && e.tier !== 'conscious') { ledger.delete(id); dirty = true; }
    else if ((e.lastSeen || 0) < consciousCutoff) { ledger.delete(id); dirty = true; }
  }
}

// One log line the first time a session is classed agent (and again only if
// the rule changes), so an operator can see why their session is being held.
function noteKind(e, sessionId, result) {
  if (e && result.kind === 'agent' && e.kindLogged !== result.why) {
    e.kindLogged = result.why;
    dirty = true;
    logFn('keeper', 'info', `session ${String(sessionId).slice(0, 8)} is an agent session (${result.why}): its insights are held`);
  }
  return result;
}

function cwdRuleTier(cwd) {
  if (!cwd) return null;
  const lower = String(cwd).toLowerCase();
  for (const rule of config.cwdRules || []) {
    if (rule.pattern && lower.includes(String(rule.pattern).toLowerCase())) {
      return VALID_TIERS.has(rule.tier) ? rule.tier : 'drone';
    }
  }
  return null;
}

// A service-side default for sessions that declare nothing. Stock Claude Code
// hooks cannot put undertow_tier in the payload (that contract only exists for
// payload-constructing clients like the OpenClaw plugin), so hook-only users
// need an env knob. Applied at entry creation only — it must never override a
// ledger tier that behavioral promotion already earned.
function defaultTier() {
  const t = String(process.env.UNDERTOW_DEFAULT_TIER || '').toLowerCase();
  return VALID_TIERS.has(t) ? t : null;
}

function getEntry(sessionId, cwd, explicitTier) {
  let e = ledger.get(sessionId);
  if (!e) {
    const ruled = VALID_TIERS.has(explicitTier) ? explicitTier : (cwdRuleTier(cwd) || defaultTier());
    e = {
      tier: ruled || 'candidate',
      declared: !!ruled,
      proseTurns: 0,
      firstSeen: now(),
      lastSeen: now(),
      lastPrompt: 0,
      humanGaps: 0,
      toolEvents: 0,
      gated: 0,
      cwd: cwd || null,
    };
    ledger.set(sessionId, e);
    stats.registered++;
    dirty = true;
  } else {
    // An explicit declaration always wins, even mid-session
    if (VALID_TIERS.has(explicitTier) && e.tier !== explicitTier) { e.tier = explicitTier; e.declared = true; dirty = true; }
    e.lastSeen = now();
  }
  return e;
}

const keeper = {
  init({ log, daemonConfig } = {}) {
    if (log) logFn = log;
    if (daemonConfig) config = { ...defaults, ...daemonConfig, cwdRules: daemonConfig.cwdRules || defaults.cwdRules };
    loadLedger();
    expireOld();
    setInterval(() => { expireOld(); persist(); }, 60_000).unref?.();
    logFn('keeper', 'info', `Keeper active: ${ledger.size} sessions in ledger, promote after ${config.promoteAfterTurns} turns`);
  },

  /** Called on SessionStart. Returns the entry (tier may be 'candidate'). */
  register(sessionId, cwd, explicitTier) {
    if (!config.enabled) return { tier: 'conscious' };
    return getEntry(sessionId, cwd, explicitTier);
  },

  /**
   * Called on UserPromptSubmit. Counts the turn, applies habituation and the
   * promotion rule, and returns { tier, promoted, habituated }.
   */
  recordPrompt(sessionId, cwd, explicitTier, promptText) {
    if (!config.enabled) return { tier: 'conscious', promoted: false, habituated: false, reason: null };
    const e = getEntry(sessionId, cwd, explicitTier);
    const t = now();

    // System plumbing (task notifications, system reminders) is never a human
    // thought — suppress unconditionally, no fingerprint or window needed.
    if (promptText && isSystemPlumbing(promptText)) {
      stats.habituated++;
      turnReasons.set(sessionId, 'plumbing');
      return { tier: e.tier, promoted: false, habituated: true, reason: 'plumbing' };
    }

    // Habituation: repeated near-identical prompts are loop ticks. They keep
    // the session alive but earn no flashes and no promotion credit.
    if (promptText) {
      const fp = fingerprint(promptText);
      e.prompts = e.prompts || {};
      const lastSeen = e.prompts[fp];
      e.prompts[fp] = t;
      const keys = Object.keys(e.prompts);
      if (keys.length > (config.habituationMaxPrompts || 30)) {
        keys.sort((a, b) => e.prompts[a] - e.prompts[b]);
        for (const k of keys.slice(0, keys.length - (config.habituationMaxPrompts || 30))) delete e.prompts[k];
      }
      dirty = true;
      if (lastSeen && (t - lastSeen) < (config.habituationHours || 6) * 3600_000) {
        stats.habituated++;
        turnReasons.set(sessionId, 'repeat');
        return { tier: e.tier, promoted: false, habituated: true, reason: 'repeat' };
      }
    }

    turnReasons.delete(sessionId); // a real (non-habituated) prompt clears the flag

    if (e.lastPrompt && (t - e.lastPrompt) >= (config.minCadenceSeconds * 1000)) e.humanGaps++;
    e.lastPrompt = t;
    e.proseTurns++;
    dirty = true;

    const promoted = maybePromote(e, sessionId);
    return { tier: e.tier, promoted, habituated: false, reason: null };
  },

  /**
   * Why the session's latest prompt was habituated: 'repeat' | 'plumbing' | null.
   * A habituated turn is a heartbeat, so Stop/PostToolUse consult this to keep
   * daemons from taking a turn there. Stop fires after that turn's prompt hook,
   * so reading it at Stop is right; caveat: parallel turns in one session id
   * share a single flag (last prompt wins).
   */
  turnHabituation(sessionId) {
    return turnReasons.get(sessionId) || null;
  },

  /**
   * Called on PostToolUse ingest. Tool volume is corroborating evidence of a
   * live agentic session, and touching lastSeen keeps a multi-day session's
   * ledger entry (and its proseTurns progress) from expiring mid-flight.
   */
  recordToolEvent(sessionId) {
    if (!config.enabled) return;
    const e = ledger.get(sessionId);
    if (!e) return;
    e.toolEvents = (e.toolEvents || 0) + 1;
    e.lastSeen = now();
    dirty = true;
    maybePromote(e, sessionId);
  },

  /** Current tier without side effects (for Stop/PostToolUse/PostCompact gating). */
  tierOf(sessionId) {
    if (!config.enabled) return 'conscious';
    const e = ledger.get(sessionId);
    return e ? e.tier : 'candidate';
  },

  isConscious(sessionId) { return keeper.tierOf(sessionId) === 'conscious'; },

  /** True when a cwd rule puts this folder at tier 'off' (the place is excluded from Undertow). */
  cwdIsOff(cwd) { return config.enabled && cwdRuleTier(cwd) === 'off'; },

  /** True when the ledger knows this session and its tier is 'off'. Never creates an entry. */
  sessionIsOff(sessionId) { return config.enabled && !!sessionId && ledger.get(sessionId)?.tier === 'off'; },

  /** Record a fast-pathed (rejected) event for the stats panel. */
  countFastPath(sessionId) {
    stats.fastPathed++;
    // Silent correctness is indistinguishable from silent breakage: a candidate
    // gated dozens of times with zero promotions deserves one loud hint.
    const e = sessionId ? ledger.get(sessionId) : null;
    if (e && e.tier === 'candidate') {
      e.gated = (e.gated || 0) + 1;
      dirty = true;
      if (e.gated === 50) {
        logFn('keeper', 'warn', `session ${String(sessionId).slice(0, 8)} gated ${e.gated}x with no promotion (${e.proseTurns} prose turns, ${e.toolEvents || 0} tool events) — if this is a real human, see promoteAfterTurns/agenticToolEvents in daemon-config or set UNDERTOW_DEFAULT_TIER`);
      }
    }
  },

  /**
   * The gate for POST /undertow/query. A call from the undertow_query MCP tool
   * (via 'mcp') is a deliberate request, not a person's prompt: it earns no
   * turn-taking credit and no habituation, creates no ledger entry, and is
   * answered whatever the session's tier (unless that tier is 'off').
   */
  gateQuery(sessionId, cwd, explicitTier, promptText, via) {
    if (via !== 'mcp') return keeper.recordPrompt(sessionId, cwd, explicitTier, promptText);
    const off = config.enabled && ledger.get(sessionId)?.tier === 'off';
    return { tier: off ? 'off' : 'conscious', promoted: false, habituated: false, reason: null };
  },

  /**
   * Note that a real hook payload was seen for a session the ledger already
   * has (the payload of a Claude Code hook carries hook_event_name). Release
   * of a held neuron needs this: an entry made by a bare POST does not qualify.
   */
  noteHook(sessionId, hookEventName) {
    if (!config.enabled || !HOOK_EVENTS.has(hookEventName)) return;
    const e = ledger.get(sessionId);
    if (!e) return;
    e.hookEvents = e.hookEvents || {};
    if (!e.hookEvents[hookEventName]) { e.hookEvents[hookEventName] = now(); dirty = true; }
  },

  /** True when the session's ledger entry has seen real hook traffic (or the Keeper is disabled). */
  fromHooks(sessionId) {
    if (!config.enabled) return true;
    const e = ledger.get(sessionId);
    return !!(e && e.hookEvents && Object.keys(e.hookEvents).length);
  },

  /** Remember that a session is an agent session (sticky; survives a roster outage). */
  markAgent(sessionId, label) {
    const e = getEntry(sessionId, null, null);
    if (e.agentFlag) return;
    e.agentFlag = String(label || 'agent');
    dirty = true;
    persist();
    logFn('keeper', 'info', `session ${String(sessionId).slice(0, 8)} flagged as agent (${e.agentFlag})`);
  },

  /** Is this an agent session, and why. No side effects, no inference from behaviour. */
  isAgentSession(sessionId, cwd) {
    if (!config.enabled) return { agent: false, why: 'keeper disabled' };
    const e = ledger.get(sessionId);
    if (e && e.agentFlag) return { agent: true, why: `flagged (${e.agentFlag})` };
    const where = String(cwd || (e && e.cwd) || '').toLowerCase();
    for (const p of config.agentCwdPatterns || []) {
      if (p && where && where.includes(String(p).toLowerCase())) return { agent: true, why: `cwd matches "${p}"` };
    }
    return { agent: false, why: 'not flagged' };
  },

  /**
   * Ask the configured rosters about a session not yet flagged and remember a
   * hit. Returns 'flagged' (already known as an agent), 'none' (no roster
   * configured), or the lookup's 'agent', 'not-listed' or 'unknown' (a roster
   * did not answer). Waits at most the roster timeout.
   */
  async askRoster(sessionId, fetchImpl) {
    if (!config.enabled) return 'none';
    if (ledger.get(sessionId)?.agentFlag) return 'flagged';
    if (!(config.agentRosters || []).length) return 'none';
    const found = await lookupAgent(sessionId, { urls: config.agentRosters, kinds: config.agentRosterKinds, ...(fetchImpl ? { fetchImpl } : {}) });
    if (found.status === 'agent') keeper.markAgent(sessionId, found.label);
    return found.status;
  },

  /**
   * Ask the rosters (askRoster), then answer as isAgentSession does. Call it
   * only where the hook response has already been sent (Stop).
   */
  async resolveAgent(sessionId, cwd, fetchImpl) {
    if (!config.enabled) return { agent: false, why: 'keeper disabled' };
    await keeper.askRoster(sessionId, fetchImpl);
    return keeper.isAgentSession(sessionId, cwd);
  },

  /**
   * May Gobble write what this session's tool event produced? Not from an
   * agent session, and not from a session a configured roster could not answer
   * for: tool output can carry anything the agent read, and a lost tool-output
   * episode costs nothing. With no roster configured and no cwd match, or with
   * config agentIngest on, the answer is yes. Counts each refusal and logs the
   * first one per session. Call it only after the hook response has been sent.
   * Returns { write, why }.
   */
  async ingestDecision(sessionId, cwd, fetchImpl) {
    if (!config.enabled || config.agentIngest === true) return { write: true, why: 'not gated' };
    const roster = await keeper.askRoster(sessionId, fetchImpl);
    const { agent, why } = keeper.isAgentSession(sessionId, cwd);
    if (!agent && roster !== 'unknown') return { write: true, why: 'not an agent session' };
    if (agent) stats.agentIngestsDropped++; else stats.unknownIngestsDropped++;
    const reason = agent ? `agent session: ${why}` : 'a roster did not answer';
    if (!ingestDropLogged.has(sessionId)) {
      ingestDropLogged.add(sessionId);
      logFn('keeper', 'info', `session ${String(sessionId).slice(0, 8)}: ingest not written (${reason}); further drops for this session are counted, not logged`);
    }
    return { write: false, why: reason };
  },

  /** True when an agent session is to be summarized like a person's (config agentInsights); false sends it through the held tier. */
  agentInsightsEnabled() { return config.agentInsights === true; },

  /**
   * Who is on the other end of a session: 'agent' or 'human', and why.
   * Agent sessions keep their flashes; what Dreamer writes from them is held
   * apart (see docs/KEEPER.md, "Agent sessions"). It is a declared fact, never
   * inferred from behaviour. In order:
   *   1. declared with setKind (POST /undertow/keeper {kind}); except that a
   *      session a roster listed stays an agent even when declared human
   *   2. flagged as an agent: a launcher's roster listed its id (markAgent)
   *   3. cwd matches one of config.agentCwdPatterns
   * (2 and 3 are isAgentSession. The rosters are asked by resolveAgent, which
   * is async: call it first wherever the answer matters.)
   * Anything else is human, which is the behaviour without this feature.
   * The first time a session is classed agent, one log line says by which rule.
   */
  sessionKind(sessionId, cwd) {
    if (!config.enabled) return { kind: 'human', why: 'keeper disabled' };
    const e = ledger.get(sessionId);
    // A launcher's roster is a fact: it beats a declaration of human.
    if (e && e.agentFlag && e.declaredKind === 'human') return noteKind(e, sessionId, { kind: 'agent', why: `flagged (${e.agentFlag})` });
    // So is the directory list: a session working in a listed directory is an
    // agent session whatever an (old) declaration of human says.
    const a = keeper.isAgentSession(sessionId, cwd);
    if (a.agent && e?.declaredKind === 'human') return noteKind(e, sessionId, { kind: 'agent', why: a.why });
    if (e && VALID_KINDS.has(e.declaredKind)) return noteKind(e, sessionId, { kind: e.declaredKind, why: 'declared' });
    if (a.agent) return noteKind(e, sessionId, { kind: 'agent', why: a.why });
    return { kind: 'human', why: 'default' };
  },

  /** True when the Keeper has a ledger entry for this session (or is disabled). */
  knows(sessionId) {
    return !config.enabled || ledger.has(sessionId);
  },

  /**
   * Declare a session human, after asking the rosters: refused when a roster
   * lists the session (it is an agent) or did not answer (it cannot be told).
   * Returns { ok, reason }.
   */
  async declareHuman(sessionId, fetchImpl, cwd) {
    const listed = keeper.isAgentSession(sessionId, cwd);
    if (listed.agent) return { ok: false, reason: `this is an agent session (${listed.why}): it cannot be declared human` };
    const roster = await keeper.askRoster(sessionId, fetchImpl);
    if (roster === 'agent' || roster === 'flagged') return { ok: false, reason: 'a launcher roster lists this session: it is an agent session' };
    if (roster === 'unknown') return { ok: false, reason: 'a launcher roster did not answer, so this session cannot be confirmed as human: try again' };
    return { ok: keeper.setKind(sessionId, 'human'), reason: null };
  },

  /** Manual declaration of who a session is: 'agent' | 'human', or null to clear. (For 'human' over HTTP use declareHuman.) */
  setKind(sessionId, kind) {
    if (kind !== null && !VALID_KINDS.has(kind)) return false;
    const e = getEntry(sessionId, null, null);
    if (kind === null) delete e.declaredKind; else e.declaredKind = kind;
    dirty = true;
    persist();
    return true;
  },

  /** Manual tier override (POST /undertow/keeper). */
  setTier(sessionId, tier) {
    if (!VALID_TIERS.has(tier) && tier !== 'candidate') return false;
    const e = getEntry(sessionId, null, null);
    e.tier = tier;
    e.declared = tier !== 'candidate';
    dirty = true;
    persist();
    return true;
  },

  snapshot() {
    const byTier = {};
    const agentSessions = {};
    // Who each recent session is, and why (newest first; ids shortened).
    const byKind = { agent: 0, human: 0 };
    const sessions = [];
    for (const [id, e] of ledger) {
      byTier[e.tier] = (byTier[e.tier] || 0) + 1;
      if (e.agentFlag) agentSessions[id] = e.agentFlag;
      const k = keeper.sessionKind(id);
      byKind[k.kind] = (byKind[k.kind] || 0) + 1;
      sessions.push({ session: String(id).slice(0, 8), tier: e.tier, kind: k.kind, why: k.why, cwd: e.cwd || null, lastSeen: e.lastSeen || 0 });
    }
    sessions.sort((a, b) => b.lastSeen - a.lastSeen);
    return { enabled: config.enabled, ledgerSize: ledger.size, byTier, byKind, agentSessions, ...stats, sessions: sessions.slice(0, 50), config };
  },
};

// Hook routes answer an off session with an empty result themselves.
const OFF_GUARD_HOOK_ROUTES = ['/undertow/query', '/undertow/session-start', '/undertow/ingest', '/undertow/summarize', '/undertow/rehydrate'];

/**
 * Express middleware: tier 'off' excludes a place from Undertow entirely, the
 * MCP tools and the plain HTTP routes as well as the hooks. A request is refused
 * when the cwd it names (body or query) matches a cwd rule with tier 'off', or
 * the session_id it names belongs to a ledger entry at tier 'off'. Hook calls
 * are left to their routes, which already return nothing for an off session; a
 * tool call to a hook route (via 'mcp') is refused here like any other.
 * Mount after the JSON body parser. The cwd is whatever the caller sends: this
 * stops a session in an excluded folder from reading memory through the tools
 * it is given, not a process that calls the HTTP API and leaves the cwd out.
 */
export function offPlaceGuard({ log = () => {}, now = Date.now } = {}) {
  const lastLogged = new Map(); // route -> time of the last refusal logged (one line a minute per route)
  return function guard(req, res, next) {
    const via = req.body?.via ?? req.query?.via;
    if (OFF_GUARD_HOOK_ROUTES.includes(req.path) && via !== 'mcp') return next();
    const sessionId = [req.body?.session_id, req.query?.session_id].find(v => typeof v === 'string' && v);
    const byCwd = [req.body?.cwd, req.query?.cwd].some(v => typeof v === 'string' && keeper.cwdIsOff(v));
    const bySession = keeper.sessionIsOff(sessionId);
    if (!byCwd && !bySession) return next();
    const t = now();
    if (t - (lastLogged.get(req.path) ?? -Infinity) >= 60_000) {
      lastLogged.set(req.path, t);
      log('keeper', 'warn', `refused: ${req.method} ${req.path} from an excluded place`, {
        detail: `${byCwd ? 'a cwd rule with tier off matched' : 'session tier off'}${sessionId ? `, session ${String(sessionId).slice(0, 8)}` : ''}`
      });
    }
    return res.status(403).json({ error: 'this place is excluded from Undertow (Keeper tier off): no memory is read or written for it' });
  };
}

export default keeper;
