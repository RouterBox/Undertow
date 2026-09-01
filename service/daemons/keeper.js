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
  // cwd substring rules for owned automation (checked case-insensitively).
  cwdRules: [
    { pattern: 'agentbox-worktrees', tier: 'drone' },
  ],
};

let config = { ...defaults };
let ledger = new Map(); // sessionId → entry
let dirty = false;
let logFn = () => {};
let stats = { fastPathed: 0, promoted: 0, registered: 0, habituated: 0 };

// Normalize away ids, numbers, and whitespace so "task b3dzfglw4 completed"
// and "task bqyh0yi1q completed" fingerprint identically.
function fingerprint(text) {
  const norm = String(text || '').toLowerCase()
    .replace(/[a-z0-9]*\d[a-z0-9]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  let h = 0;
  for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) | 0;
  return h.toString(36) + ':' + norm.length;
}

function now() { return Date.now(); }

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

function getEntry(sessionId, cwd, explicitTier) {
  let e = ledger.get(sessionId);
  if (!e) {
    const ruled = VALID_TIERS.has(explicitTier) ? explicitTier : cwdRuleTier(cwd);
    e = {
      tier: ruled || 'candidate',
      declared: !!ruled,
      proseTurns: 0,
      firstSeen: now(),
      lastSeen: now(),
      lastPrompt: 0,
      humanGaps: 0,
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
    if (!config.enabled) return { tier: 'conscious', promoted: false, habituated: false };
    const e = getEntry(sessionId, cwd, explicitTier);
    const t = now();

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
        return { tier: e.tier, promoted: false, habituated: true };
      }
    }

    if (e.lastPrompt && (t - e.lastPrompt) >= (config.minCadenceSeconds * 1000)) e.humanGaps++;
    e.lastPrompt = t;
    e.proseTurns++;
    dirty = true;

    let promoted = false;
    if (e.tier === 'candidate' && !e.declared &&
        e.proseTurns >= config.promoteAfterTurns && e.humanGaps >= 1) {
      e.tier = 'conscious';
      e.promotedAt = t;
      promoted = true;
      stats.promoted++;
      logFn('keeper', 'info', `session ${String(sessionId).slice(0, 8)} promoted to conscious (${e.proseTurns} turns, ${e.humanGaps} human gaps)`);
    }
    return { tier: e.tier, promoted, habituated: false };
  },

  /** Current tier without side effects (for Stop/PostToolUse/PostCompact gating). */
  tierOf(sessionId) {
    if (!config.enabled) return 'conscious';
    const e = ledger.get(sessionId);
    return e ? e.tier : 'candidate';
  },

  isConscious(sessionId) { return keeper.tierOf(sessionId) === 'conscious'; },

  /** Record a fast-pathed (rejected) event for the stats panel. */
  countFastPath() { stats.fastPathed++; },

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
    for (const e of ledger.values()) byTier[e.tier] = (byTier[e.tier] || 0) + 1;
    return { enabled: config.enabled, ledgerSize: ledger.size, byTier, ...stats, config };
  },
};

export default keeper;
