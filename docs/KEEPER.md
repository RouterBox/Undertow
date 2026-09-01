# The Keeper — Session Attachment & Memory Formation Gating

**Status:** designed 2026-08-30; core built 2026-08-31 (`service/daemons/keeper.js` + server gating). Live behavior verified: one-shot sessions fast-pathed, `agentbox-worktrees` cwd rule → drone, human-cadence session promoted to conscious on prompt 3. Ledger persists to `service/keeper-ledger.json`; status at `GET /undertow/keeper`, manual override via `POST /undertow/keeper {session_id, tier}`. Observer writes quarantine via `namespace: 'quarantine'` (excluded from all recall paths). NOT yet done: retro-attach on promotion (Wonder catches up on the next Stop instead), and the machine-wide hooks remain **disabled** in `~/.claude/settings.json` — re-enabling them (from `settings.backupHooks.json`) is the deliberate final switch now that the Keeper makes it safe.

## The problem, measured

Undertow was built in the frame of one human talking to one Claude. Its hooks are
global in `~/.claude/settings.json`, so every Claude Code session on the machine
gets the full subconscious: Impulse's vector search + Haiku flash on every prompt,
Gobble on every tool call, Wonder and Dreamer on every stop.

The 2026-08-30 JSONL corpus audit (`Undertow-Data/ingestion/progress.json`) showed
what the machine's traffic actually is:

- 3,223 sessions total; **2,836 (88%) have ≤2 prose turns** — headless `claude -p`
  automation (737 from AgentBox's Producer alone, hundreds more from bolt
  worktrees and RouterClawLite).
- **39 sessions (1.2%) are real human conversations** (≥5 turns).

Globally hooked, the subconscious spends ~9/10 of its energy on robots. The cost
is not just tokens:

1. **Graph poisoning** — Gobble/Dreamer would ingest neurons from templated
   automation chatter. The involuntary *write* path is more dangerous than the
   involuntary read path: bad flashes waste a prompt, bad neurons persist.
2. **Wasted injection** — flashes into headless prompts have no human reader, and
   injected context perturbs agents that are supposed to be deterministic.
3. **Domain-score pollution** — dozens of ephemeral worktree cwds masquerade as
   projects.
4. **Latency tax** on every automated pipeline tick.

## The frame

**The Keeper** is the lighthouse keeper of the subconscious. A keeper does not
merely block: they hold a solitary watch over dark water, guide the real vessels
safely in, and warn the rest off the rocks. (The theoretical ancestor is Freud's
*censor* — the agency deciding what may reach consciousness — but the persona is
the lightkeeper, which is the watch Undertow actually needs.) That is precisely
the missing organ: Undertow has eight daemons that generate, surface, and groom
memory, and none that decides *whose experience deserves memory at all*.

The governing principle: **the subconscious attends to persons, not processes.**
A body does not attach consciousness to every reflex. Attachment must be earned
or declared — never assumed.

The corpus audit and the ingestion plan's 5-turn filter already discovered the
key signal: **sustained conversational turn-taking is the cheap, reliable tell
that a human is present.** The Keeper is the runtime twin of that ingest-time
filter.

## Design: three independent mechanisms

Defense in depth. Each mechanism works even when the others misfire.

### 1. Session tiers (identity)

Every session gets a tier in a lightweight **session ledger** kept by the service
(in-memory map + JSON persistence, like toggle state):

| Tier | Who | Involuntary in (flashes) | Involuntary out (ingestion) | Voluntary (MCP tools) |
|---|---|---|---|---|
| `conscious` | Human conversation | ✅ full | ✅ full | ✅ |
| `observer` | Automation whose *outcome* should be remembered (nightly research cron) | ❌ | ✅ quarantined summarize-on-stop only | ✅ |
| `drone` | Ordinary automation (Producer ticks, bolts, fan-out subagents) | ❌ | ❌ | ✅ read; write → quarantine |
| `off` | Explicitly excluded | ❌ | ❌ | ❌ |

**Tier assignment, in priority order:**

1. **Explicit contract** — `UNDERTOW_TIER=conscious|observer|drone|off` in the
   environment. Env vars inherit to child processes, so one line in each launcher
   we own (AgentBox producer/bolt spawns, RCL's claude subprocesses, cron
   definitions) declares its entire process tree. We own ~all of today's 88%, so
   the explicit contract alone covers nearly everything. This matches the
   AgentBox machineSafety-contract culture: automation declares itself.
2. **Behavioral promotion** (mechanism 2) for undeclared sessions.
3. **Default: `candidate`** — a probationary state, not a tier. Candidates get
   *nothing* involuntary while the Keeper watches.

### 2. Earned attachment (behavior)

Undeclared sessions start as candidates and **earn** `conscious`:

- SessionStart registers the session in the ledger. No LLM work, no injection.
- Each UserPromptSubmit increments a prose-turn counter — a fast path that
  touches the ledger and returns empty *before* any pipeline work.
- **Promotion rule:** on the Nth prose prompt (default N=3) with human-plausible
  cadence (inter-prompt gaps ≥ a few seconds — Producer one-shots never get
  there, paste-storms don't look human), the session is promoted to `conscious`.
- **Retro-attach on promotion:** the first flash-eligible turn triggers Wonder to
  read the transcript-so-far (it already knows how), so memory catches up
  mid-conversation. The human loses flashes for two prompts, then gets a
  better-informed subconscious than they would have had at turn one.
- **Expiry:** ledger entries expire on Stop-without-promotion or after a TTL, so
  the ledger stays tiny despite thousands of drone sessions.

Why earned rather than detected: signals like TTY-ness or print-mode flags in
hook payloads are fragile and platform-dependent. Turn-taking is observable from
the hooks we already have, needs no new inputs, and is exactly the signal the
corpus validated. (If a reliable interactive-mode marker exists in hook input,
use it as an *instant* promotion shortcut — verify at build time, don't depend
on it.)

### 3. Memory formation requires provenance (the graph defends itself)

Independent of tiering, the write path gets a constitutional rule: **only
`conscious` sessions form live memories directly.**

- Every neuron records `origin_session`, `origin_tier` (feeds the planned
  Source/`DERIVED_FROM` provenance model).
- Writes from `observer`/`drone` sessions land in **quarantine** — a namespace
  (or `tier: T4_quarantine`) that is excluded from flash recall. Quarantined
  neurons that later prove useful (pursued via voluntary queries, or promoted by
  Janitor review) graduate to the live graph; the rest decay and are swept.
- Consequence: a misclassified session **cannot poison recall**. Worst case it
  stages junk that dies quietly. This bounds the blast radius of every detection
  failure.

### 4. Habituation (turn-level gating inside conscious sessions)

Added 2026-08-31 after live observation: session tiers catch robot *sessions*,
but a conscious session running a babysit loop (long-poll re-arms, heartbeat
ticks, backstop wakeups) still emits machine-like *turns* — each one burning a
Haiku call and inflating surface counts on the same few neurons.

The fix is the neurological one: **habituation** — the subconscious stops
reacting to a repeated stimulus. The Keeper fingerprints each prompt
(lowercased, id/number tokens normalized away, hashed) and keeps a small
per-session cache. A prompt near-identical to one seen within
`habituationHours` (default 6) is fast-pathed: no embedding, no Haiku, no
promotion credit — but the session stays alive in the ledger. The first
occurrence of any prompt shape flashes normally; only the repeats go silent.
Verified live: "task b3dzfglw4 completed" flashed, "task bqyh0yi1q completed"
2 seconds later was habituated at zero cost.

### The voluntary path is how automation participates

The "we want future agents to know why we did what we did" use case is real —
but ambient ingestion of automation chatter is the wrong organ for it. The right
shape:

- Drones may **read** (`undertow_query` MCP tool) — a fan-out agent that wants
  context asks for it. Pull, not push; zero idle cost.
- A workflow that produces something worth remembering submits it
  **deliberately**: the bolt that closes a ticket writes its distilled
  "what/why" artifact and calls `undertow_ingest` (→ quarantine → review). The
  memory-worthy output of automation is a *curated artifact*, not a transcript.

This is the same insight as the ingestion plan: intelligence is ~3% of raw
substrate. Don't ambient-ingest the 97%.

## Economics of the fast path

Cost per excluded event must round to zero:

- Every endpoint checks the ledger **first** — before embeddings, before Haiku,
  before Neo4j. `drone`/`off`/unpromoted-candidate → immediate empty 200.
  (The 60s query cache already proves this pattern in the codebase.)
- Optional second stage: hooks short-circuit locally on `UNDERTOW_TIER=off|drone`
  and never make the HTTP call at all — worth doing for the Producer's tick
  cadence.
- `/undertow/stats` grows a tier panel: sessions seen by tier, events
  fast-pathed, estimated Haiku calls avoided. The Keeper should be able to show
  what it saved.

## Failure analysis

| Failure | Outcome | Why it's acceptable |
|---|---|---|
| Human session never promotes (types 2 prompts, leaves) | No flashes that session | A 2-prompt session is below the "worth remembering" bar by our own filter decision |
| Automation fakes conversational cadence | Gets flashes; its writes still quarantined until… it *is* behaving like a conversation | Mechanism 3 bounds the damage; explicit contract prevents it for owned automation |
| Launcher forgets to declare tier | Behavioral gate still holds (one-shots never reach turn 3) | Defense in depth |
| Service down | Hooks already fail open/cheap (curl timeout) | Unchanged from today |

## Implementation sketch (M9)

1. Session ledger in the service + `keeper.js` daemon (assignment, promotion,
   expiry, stats). Config in `daemon-config.json` (N, cadence floor, TTL,
   default tier).
2. Fast-path tier check at the top of query/ingest/summarize/session-start.
3. `UNDERTOW_TIER` plumbed through hook scripts; one-line declarations added to
   AgentBox producer/bolt spawn, RCL spawn, crons.
4. Quarantine namespace + provenance fields on ingest; Janitor learns to sweep
   expired quarantine; promotion path for pursued quarantined neurons.
5. Retro-attach: promotion event triggers Wonder on transcript-so-far.
6. Stats panel.

Order matters: **1–2 stop the bleeding** (robots go dark), 3 makes it explicit,
4–6 make it complete.

## Relationship to the wider roadmap

- The Keeper is the runtime half of the same insight as the JSONL ingestion
  plan's 5-turn filter (ingest-time half). One principle, two enforcement points.
- Quarantine + origin provenance is the first concrete piece of the
  Source/`DERIVED_FROM` metadata model planned for the knowledge-base
  generalization.
- Tiers are the mechanism that later lets *interesting* automation (an observer
  research cron) participate safely — the relaxed "agent memory" mission without
  giving every robot a subconscious.
