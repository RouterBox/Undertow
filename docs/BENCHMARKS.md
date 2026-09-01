# Undertow Benchmarks

## LoCoMo: 74.2%

Undertow scores **74.2%** on the LoCoMo long-conversational-memory benchmark
(Maharana et al. 2024 — 10 multi-session conversations, 1,986 QA pairs) under a
conservative, fully reproducible protocol. That places it in the
independently-credible band alongside Zep's corrected self-evaluation (75.1%)
and Letta's filesystem baseline (74.0%), and clearly above Mem0's independently
reproduced numbers (62.5–68.5%).

| Category | n | v1 (2026-09-01) | v3 (2026-09-01) | Δ |
|---|---:|---:|---:|---:|
| Single-hop | 841 | 72.8 | **75.3** | +2.5 |
| Multi-hop | 282 | 43.6 | **55.0** | +11.4 |
| Temporal | 321 | 70.7 | **77.0** | +6.3 |
| Open-domain | 96 | 33.3 | **40.6** | +7.3 |
| Adversarial (abstention) | 446 | 91.3 | **89.7** | −1.6 |
| **Overall** | **1,986** | **70.5** | **74.2** | **+3.7** |

### Protocol (v3)

- **Memory construction:** Sonnet (claude-sonnet-4-6) curates each conversation
  session-by-session into an isolated per-conversation namespace — the same
  quality-bar prompts production ingestion uses. ~2,000 memories total, zero
  contact with the live graph.
- **Retrieval:** hybrid Reciprocal Rank Fusion of BM25 (full memory text) and
  dense vectors (gemini-embedding-001, full-text embeddings — the production
  strategy), k=16, plus 1-hop expansion through SYNAPSE edges from the top-6
  hits (cap 26 memories) and one optional iterative re-search round.
  Mean retrieval latency: ~6ms.
- **Answering:** Sonnet with **grounding required** — every answer must cite
  the supporting memory by name or abstain; uncited or hallucinated-cite
  answers are demoted to UNKNOWN. 1,423/1,986 answers were grounded, 563 were
  clean abstentions, 0 errors.
- **Judging:** lenient LLM-as-judge (claude-haiku-4-5), binary correct/incorrect.

### What moved the score

- **v1 → v3 is same-protocol**, so the deltas are real: full-text production
  embeddings (+retrieval across the board), graph-edge expansion (+11.4
  multi-hop), and grounding-required answering, which fixed the abstention
  collapse an unconstrained strong answerer exhibits (a v2 experiment dropped
  adversarial accuracy from 91 to 66; grounding restored it to 89.7 while
  keeping the multi-hop gains).

### Honest caveats

Cross-system LoCoMo comparisons are approximate at best — the benchmark has no
standardized protocol, and published scores are extremely sensitive to the
judge model, answer model, and question subset:

- The same system spans wildly different published numbers depending on who
  ran the eval (Zep alone: 58.4% in a corrected third-party run, 75.1% in its
  own corrected run, 79.1% in Memori's standardized pipeline, 94.7% in
  marketing). Scores of 85–95% in the wild are vendor self-reports on
  unreproduced home-field protocols.
- An independent audit (Penfield Labs, 2025) found a large fraction of the
  LoCoMo answer key contains errors, capping what any score can mean.
- Our judge is deliberately lenient but consistent across v1/v2/v3, so the
  internal deltas are trustworthy even where the absolute number is soft.

## LongMemEval: planned

The LongMemEval-S dataset (Wu et al., ICLR 2025 — 500 questions, ~19,800
unique sessions, ~52M tokens of history; tests knowledge updates, temporal
reasoning, multi-session reasoning, and abstention) is staged and analyzed.
The run is deferred for cost reasons (~$50–135 of ingestion depending on
curation model). Undertow's Wave-1 features — fact supersession
(`SUPERSEDES` edges), `event_date` temporal anchoring, and multi-hop query
decomposition — target exactly the axes LongMemEval measures.
