# The Keeper — Session Attachment & Memory Formation Gating

**Status:** designed 2026-08-30; core built 2026-08-31 (`service/daemons/keeper.js` + server gating). Live behavior verified: one-shot sessions fast-pathed, `agentbox-worktrees` cwd rule → drone, human-cadence session promoted to conscious on prompt 3. Ledger persists to `service/keeper-ledger.json`; status at `GET /undertow/keeper`, manual override via `POST /undertow/keeper {session_id, tier}`. Observer writes quarantine via `namespace: 'quarantine'` (excluded from all recall paths). Agent sessions (built 2026-11-22, see "Agent sessions: held insights" below): Dreamer writes only durable kinds from them, into the same quarantine namespace, released on use. NOT yet done: retro-attach on promotion (Wonder catches up on the next Stop instead), and the machine-wide hooks remain **disabled** in `~/.claude/settings.json` — re-enabling them (from `settings.backupHooks.json`) is the deliberate final switch now that the Keeper makes it safe.

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

1. **Explicit contract** — `undertow_tier` in the hook payload, declared as
   `UNDERTOW_TIER=conscious|observer|drone|off` in the *client's* environment.
   Env vars inherit to child processes, so one line in each launcher we own
   (AgentBox producer/bolt spawns, RCL's claude subprocesses, cron definitions)
   declares its entire process tree. We own ~all of today's 88%, so the explicit
   contract alone covers nearly everything. This matches the AgentBox
   machineSafety-contract culture: automation declares itself.

   **Scope caveat:** the tier travels in the request body, and the service is a
   separate process — a client-side env var only reaches it if the client puts
   it in the payload. The OpenClaw plugin does; **stock Claude Code hooks
   cannot**, so for hook-only users this mechanism is unreachable. For them the
   service reads `UNDERTOW_DEFAULT_TIER` from *its own* environment as the tier
   for sessions that declare nothing (applied at ledger-entry creation only —
   it never overrides an earned or declared tier).
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
- **Agentic promotion (second path):** deep agentic work is one substantial
  prompt followed by hours of tool use — it never accumulates prose turns, so
  prompt count alone silently starves real humans (2026-09-08 downstream
  report: 6 days, 125 gated events, zero promotions). A candidate with ≥1 real
  prompt, sustained tool volume (default 150 PostToolUse events), and a
  long-lived session (default ≥1 h) is promoted too. One-shots and heartbeat
  ticks are short-lived and never reach both thresholds; tool events also
  refresh the ledger TTL so multi-day sessions don't lose their progress.
- **Starvation diagnostic:** a candidate gated 50 times with zero promotions
  logs one loud hint pointing at `promoteAfterTurns`/`agenticToolEvents`/
  `UNDERTOW_DEFAULT_TIER` — silent correctness must not look like silent
  breakage.
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
  Source/`DERIVED_FROM` provenance model). *Built so far:* the insights Dreamer
  writes record `origin_session` and `origin_kind` (`agent` or `human`);
  Gobble's neurons do not yet.
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

**A habituated turn is a heartbeat, so no daemon takes a turn there.** The Keeper
also remembers *why* a session's latest prompt was habituated (`repeat` for a
near-identical fingerprint, `plumbing` for harness notifications) until the next
real prompt clears it. At Stop, a `repeat` turn skips every daemon (Wonder, Dreamer,
Spider, Janitor, Prowler); at PostToolUse it skips Gobble. A `plumbing` turn skips
only Wonder's pre-warm, because task notifications often carry real work that
Dreamer should still process. The flag is per session id and in memory only, so
parallel turns in one session share it (last prompt wins).

### 5. Agent sessions: held insights

Added 2026-11-22 after an audit of 53 insights Dreamer wrote in one day: all 53
came from agent sessions (long-running agents promoted to `conscious` by tool
volume), none from a person. About half were status or chatter, ten were
already false within a day, two credited the wrong actor, and one of the 53 was
ever flashed. Tiers decide whether a session is attended to at all; this
mechanism decides what a *conscious* session may write when the one on the
other end is an agent.

**Who is an agent session** (`keeper.sessionKind`, first match wins). It is a
fact someone states, never inferred from how the session behaves: three varied
prompts a few seconds apart look like a conversation whoever sends them.

1. **Declared:** `POST /undertow/keeper {"session_id": "...", "kind": "agent"}`
   (or `"human"`; `null` clears it). A declaration beats the directory list,
   so a person working in a listed directory can declare their session
   `human`. It does not beat a roster: declaring `human` asks the rosters
   first and is refused (HTTP 409) when a roster lists the session or does not
   answer, and a session a roster has listed stays an agent whatever was
   declared.
2. **A launcher's roster lists the session id.** A launcher that starts agent
   sessions publishes a URL returning JSON with the sessions it runs:
   `{"contexts": [...]}`, `{"sessions": [...]}` or a bare array, each entry
   with a string `sessionId` (or `session_id`) and optionally `name` and
   `kind`. An entry that has a `kind` counts only when it is one of
   `agentRosterKinds`. The Keeper asks at Stop, after the hook response has
   been sent, and before deciding a release; each roster gets 1.5 seconds and
   the combined answer is cached for 60 (5 when a roster did not answer). A
   hit is remembered in the ledger (`keeper.markAgent` sets `agentFlag`), so a
   later roster outage does not un-flag the session. A roster that does not
   answer keeps counting with the last list it gave, so a session it listed a
   minute ago is still an agent while the launcher restarts.
3. **Its cwd contains an entry of `agentCwdPatterns`** (case-insensitive
   substrings). This is for an agent that is on no roster.

**When a roster does not answer** and the session is on its last good list
neither, nobody can say who the session is. Its turn is then **held as
unknown**: summarized by the agent rule below and written to the held tier with
`origin_kind: 'unknown'`. A held insight can be released; one written live
cannot be taken back. The session is not flagged, so its next turn asks again,
and a session declared `human` is not affected. With no roster configured at
all, nothing is unknown: declaration and the directory list decide.

Everything else is a human session and behaves exactly as before. A person's
own session is on no roster, so they can work in any directory without being
treated as an agent, unless that directory is listed.

**Config** (`daemons.keeper` in `service/daemon-config.json`; read at service
start, so a change needs a restart):

```json
{
  "agentRosters": ["http://127.0.0.1:8080/sessions"],
  "agentRosterKinds": ["spawned"],
  "agentCwdPatterns": [],
  "agentInsights": false
}
```

The lists ship empty: **a deployment that runs agents must configure a roster,
list a directory, or declare the sessions, or every session is treated as
human.** `agentInsights` is the off switch for this whole mechanism: `false`
(the default) sends what an agent session writes through the held tier
described below; `true` summarizes an agent session like a person's, as
before this mechanism existed.

**Known gap.** A session that has not yet registered with its launcher is not
on the roster for its first moments; a turn that ends in that window, while
the roster answers, is summarized as a person's would be.

A call from the `undertow_query` MCP tool is a deliberate request, not a
person prompting: the Keeper does not count it as a prompt (no turn-taking
credit, no habituation, no ledger entry), and it is answered whatever the
session's tier, unless that tier is `off`.

**Seeing it.** The service logs one line when a roster flags a session, and
one the first time a session is classed agent, saying by which rule.
`GET /undertow/keeper` lists flagged sessions under `agentSessions`, recent
sessions with their `kind` and `why`, and a `held` block of counters since
the last restart: agent turns summarized, turns where the model offered no
insight, insights offered, dropped for no durable kind, skipped because the
name was taken, written to the held tier, turns held as unknown, released,
and releases refused.

**What does not change for an agent session:** its tier, its flashes, pursuit
detection, train of thought, and Gobble's ingest.

**What changes, at Stop (Dreamer):**

- **The rule.** An insight is written only if it is one of three kinds and will
  still be true and useful a month from now: a `lesson` (a root cause or a way
  something fails, and how to recognise or avoid it), a `procedure` (how to do
  something that will need doing again), or a `decision` (a design or policy
  choice with its reason). Never written: the state of work (pull requests,
  branches, commits, merges, deploys, restarts, queues, to-do lists), a review
  verdict on one commit, forecasts and plans, anything only true "now". Also
  never written: private content the agent read, meaning anything that quotes
  or restates a message, text/SMS, e-mail, calendar item, voicemail or
  notification, or personal details of a third person taken from one (names
  with contact details, addresses, account, case or incident numbers). That
  exclusion is stated in the prompt only; no code detects such content. The
  prompt states this, and the code drops any insight that does not declare one
  of the three kinds. The kind is stored as `durable_kind`.
- **Held, not live.** The insight is written into the `quarantine` namespace,
  which no recall path reads, so it is never flashed. It has no edges: edges do
  not cross a namespace boundary. It has no embedding either until it is
  released, so it cannot take a vector-search slot from a live neuron (the same
  now holds for observer ingest into quarantine). Its name is not printed in
  the service log.
- **No rewrites.** An agent session does not update (supersede) existing
  neurons; that would put its text into the live graph past the hold.
- **No actor names.** The prompt tells the model not to say who did, said or
  decided something. Who wrote it is recorded by the system instead:
  `origin_session` (the session id) and `origin_kind: 'agent'` (or
  `'unknown'` for a turn held because a roster did not answer). A person's
  words relayed inside an agent session are therefore marked as coming from an
  agent session, and are held like the rest.

**Finding what is held.** `GET /undertow/held` (MCP: `undertow_held`) lists
held neurons newest first: name, uid, kind, flash summary, the session that
wrote it, when, and `name_taken` when a live neuron now has the same name.
Read one in full with `GET /undertow/neuron?name=...&namespace=quarantine`
(MCP: `undertow_neighbors` with `held: true`). Listing and reading are open
to any caller. `/undertow/stats`, `/undertow/health` and the boot-time
embedding check count the live graph only; stats reports `held` separately.
`POST /undertow/correct` acts on the live graph unless given a `namespace`.

**Release.** A held neuron joins the live graph when a **human session** uses
it: `POST /undertow/chase {neuron, session_id}`, or `POST /undertow/feedback`
with verdict `used` or `useful` and a `session_id`. All of these must hold:

- the session id has a ledger entry that **real hook traffic** made: the
  Keeper has seen a hook payload (one carrying `hook_event_name`) for it. An id
  made known by a bare POST does not qualify, and an `undertow_query` MCP call
  creates no entry at all;
- **a launcher roster is configured, answers, and does not list the session.**
  The rosters are asked on every release, also for a session declared human:
  an agent a roster lists cannot release even before its first Stop, and when
  a roster does not answer every session is refused (try again);
- the session is not an agent by declaration or by cwd (the request's `cwd`
  when it sends one, otherwise the one in the ledger).

**With no roster configured, nothing is released through these endpoints:**
nobody can vouch that the caller is not an agent. On such a deployment a held
neuron reaches the live graph only when an operator changes its `namespace` in
the database directly.

A chase or verdict that fails any of this releases nothing: the response says
the neuron is held and why (`status: "held"`), nothing is rewarded and a
`used`/`useful` verdict is not applied. Release sets `namespace` to live,
records `released_at` and `released_by`, embeds the neuron, and marks it
un-spidered so Spider links it on its next run.

A chase lands in one namespace: the live graph by default, or the caller's own
(`namespace` in the request, or the session's). A client in its own namespace
chases its own neurons; holding and release exist only on the live graph.

If a live neuron has taken the name since, a chase by name means the live one.
Release the held one by uid (`POST /undertow/chase {uid, session_id}`, the uid
from the listing): it joins the live graph as `<name> (held <first 8 of uid>)`,
and the response gives the new name.

The limit of this: `session_id` is whatever the caller sends over loopback
HTTP, and so is a hook payload. The checks above raise the bar: they stop an
agent releasing its own insight through ordinary tool use, an invented id, and
a self-declaration. They do not stop a caller on the loopback interface that
deliberately sends a real human session's id, or that forges hook payloads for
an id of its own while the roster does not list it.

**Not built:** nothing surfaces held neurons on its own, so one that nobody
looks up stays held; there is no expiry or sweep of old held neurons yet; two
insights about the same event are not detected as duplicates; and train of
thought is unchanged, so an agent session's topics and temporal edges still go
to the live graph with no origin recorded (issues #20 and #21).

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
