# Meet the Daemons

*Deep beneath the surface, where the currents of memory flow, eight daemons tend to the subconscious mind. Each has a role. Each has a personality. Together, they are Undertow.*

---

## Wonder

<img src="daemons/wonder.jpg" width="256" alt="Wonder — the deep thinker" />

**The Oracle of the Deep**

Wonder is the wisest daemon. While the others react to events, Wonder *anticipates*. Between turns, she reads the full conversation transcript, walks the memory graph with the patience of cosmic time, and pre-selects the memories that will matter next.

She doesn't rush. She doesn't need to. The agent waits for no one, but when the next prompt arrives, Wonder's pre-warmed flashes are already there -- served instantly, adjusted for the new context, offered as gifts from the deep.

**Type:** Upstream (proactive) | **Trigger:** Stop hook (between turns) | **Model:** Sonnet

---

## Impulse

<img src="daemons/impulse.jpg" width="256" alt="Impulse — the lightning spark" />

**The Electric Reflex**

Impulse fires the moment you speak. It's the reflex arc of the subconscious -- prompt in, flashes out, in under 5 seconds. Vector search, graph traversal, temporal matching, contradiction detection, all running in parallel like neural pathways lighting up.

Impulse doesn't think deeply. It reacts. It finds. It scores. Then it hands the candidates to Haiku, who decides what's worth saying out loud. Most of the time, Haiku says nothing. Silence is accuracy.

**Type:** Upstream (reactive) | **Trigger:** UserPromptSubmit hook | **Model:** Haiku (flash crafting)

---

## Gobble

<img src="daemons/gobble.jpg" width="256" alt="Gobble — the hungry memory eater" />

**The Hungry Collector**

Gobble watches every tool event with its enormous glowing mouth open wide. Most of what flows past is noise -- file reads, git commands, TTS calls. Gobble knows the difference. It swallows only the meaningful: decisions, insights, breakthroughs, turning points.

When something passes the taste test, Gobble creates a neuron -- a knowledge unit with substance, not a label. A name, a flash summary, and a body full of real content. Then it embeds the memory in vector space and connects it to the graph. Fed. Satisfied. Waiting for the next morsel.

**Type:** Input | **Trigger:** PostToolUse hook | **Model:** Haiku (evaluation)

---

## Dreamer

<img src="daemons/dreamer.jpg" width="256" alt="Dreamer — the sleeping cosmic whale" />

**The Sleeping Giant**

Dreamer floats through the aftermath of every conversation turn like a whale through stars. It reads the transcript, extracts what matters, traces the train of thought through conceptual space, and records the shape of the conversation as temporal synapses.

But Dreamer's most important job is judgment. For every flash that was injected, Dreamer determines: did the agent pursue it, or dismiss it? Pursued memories get stronger. Dismissed memories fade. This is how the subconscious learns what's useful.

Dreamer also orchestrates the other downstream daemons -- waking Spider, Janitor, and Prowler to do their work while the conversation sleeps.

**Type:** Downstream | **Trigger:** Stop hook | **Model:** Sonnet (turn analysis)

---

## Spider

<img src="daemons/spider.jpg" width="256" alt="Spider — the golden web weaver" />

**The Web Weaver**

Spider sees what nobody else can: the connections that should exist but don't. It crawls the graph after new memories arrive, comparing them to everything already known, and weaves golden threads between neurons that ingestion missed.

Spider also computes the graph's vital signs -- PageRank for importance, betweenness centrality for bridge nodes, community detection for topic clusters. These scores live on every neuron, making the whole graph smarter for every search that follows.

And when memories rot -- when a neuron has fully decayed, was never pursued, and connects to nothing important -- Spider eats it. The hungry spider prunes the dead wood so the living graph can grow.

**Type:** Downstream | **Trigger:** Session end | **Prunes:** Yes (configurable)

---

## Prowler

<img src="daemons/prowler.jpg" width="256" alt="Prowler — the scanning predator" />

**The Night Hunter**

Prowler leaves the graph entirely. It ventures into the open web, searching for knowledge that the conversation needs but doesn't have. Two modes: a fast Brave Search for quick facts during a turn, and a deep Perplexity dive between turns that writes research findings directly into the graph as new neurons.

Prowler is selective. It doesn't search every prompt -- only genuinely research-worthy questions. And even then, the gating is strict: no searching for conversation metadata.

**Type:** Upstream (Brave) + Downstream (Perplexity) | **APIs:** Brave Search, Perplexity

---

## Janitor

<img src="daemons/janitor.jpg" width="256" alt="Janitor — the determined cleaner" />

**The Tidy Crab**

Janitor is the most underappreciated daemon. It arrives after every turn, tiny broom-claws clicking, and inspects every neuron for quality. Self-referential tags where the name equals the summary? Swept away. Action labels like "PostToolUse hook fired"? Gone. Empty-body neurons with no substance? Cleaned.

Janitor is tougher than Spider. Spider prunes by decay scores -- neurons that faded naturally. Janitor prunes by *content quality* -- neurons that were born garbage regardless of their score. Together, they keep the graph honest.

**Type:** Downstream | **Trigger:** Session end | **Patterns:** Self-referential, action labels, metadata, garbage research

---

## Tapestry

<img src="daemons/tapestry.jpg" width="256" alt="Tapestry — the luminous weaver" />

**The Memory Weaver**

Tapestry is the only daemon that serves humans, not the agent. It reads the graph and weaves it into something you can see and touch: an Obsidian vault of markdown files. Every neuron becomes a page. Every synapse becomes a `[[wikilink]]`. Every community becomes a cluster.

Open Obsidian, and you see what Undertow knows. The graph view shows the topology. The pages show the content. The connections show the associations. Tapestry makes the invisible visible -- the subconscious, rendered for conscious inspection.

**Type:** Projection | **Trigger:** Manual or session end | **Output:** Obsidian vault (markdown)

---

## The Ecosystem

```
                    ┌─────────────────────────┐
                    │    Neo4j Graph (Lake)     │
                    └──┬──────┬──────┬──────┬──┘
                       │      │      │      │
              ┌────────┤      │      │      ├────────┐
              │        │      │      │      │        │
         ┌────▼───┐ ┌──▼──┐ ┌▼────┐ ▼   ┌──▼──┐ ┌───▼────┐
         │ Gobble │ │Dream│ │Spdr │     │Jntr │ │Prowler │
         │  (in)  │ │ (dn)│ │(dn) │     │(dn) │ │(in/up) │
         └────────┘ └─────┘ └─────┘     └─────┘ └────────┘
                                │
              ┌─────────────────┤
              │                 │
         ┌────▼───┐       ┌────▼────┐
         │Impulse │       │ Wonder  │
         │  (up)  │       │  (up)   │
         └────┬───┘       └────┬────┘
              │                │
              ▼                ▼
         ┌─────────────────────────┐
         │    Agent Context        │
         │    (Flashes injected)   │
         └─────────────────────────┘
              │
         ┌────▼────┐
         │Tapestry │
         │ (proj)  │──── Obsidian Vault
         └─────────┘
```

*The daemons don't know each other. They share a graph, a log, and a purpose: to make memory fire without being asked.*

---

*Portraits generated by Leonardo.ai Phoenix 1.0*
