# ADR 0003: Phase 4 decisions (ingestion, deletion, persistent memory)

- Status: accepted, 2026-10-15; extended as Phase 4 items are measured
- Context: Phase 4 of the performance specification covers WP-08 (external numeric identity), WP-09 (ingestion), the rest of WP-10 (deletion, vacuum, compaction), WP-12 (persistent index memory) and WP-16 (historical-id snapshots). This record holds the items that were measured and not merged, and the reasons. Merged items are described in their commits and the Phase 4 report.

Timings: `differential/ab.mjs` on the 20,000-document bench corpus, plus the long-text workloads added for WP-09: 2,000 articles of 600–1,000 words from a 5,000-word vocabulary with a steep frequency curve, so terms repeat within a document. Noise is about ±5%.

## WP-09: per-document term aggregation: rejected

**Tried.** For a field of 32 processed terms or more, count each distinct term in an `FxHashMap<&str, _>` in first-occurrence order, then make one radix update per distinct term (`increment_by(count)`). The order in which new keys reach the tree is unchanged, so the index is identical. The differential test `long repetitive fields index as MiniSearch does` compares snapshots, searches and removal against MiniSearch for the native tokenizer, JavaScript callbacks and the engine's own `add`. Shorter fields kept the term-by-term loop.

**Measured** against `pkg-phase3`, `addAll` workloads alone, 7–9 rounds:

| Workload | B/A |
|---|--:|
| `addAll`, bench corpus (21 terms per field on average, some above 32) | 1.22–1.32 |
| `addAll`, long articles | 1.13–1.23 |

A fresh build of the unchanged source measured 1.000 and 0.997 in the same setup, so the loss is the change itself.

**Why it loses.** A radix lookup for a short, already-present key is a few node comparisons over a small child list, about the cost of the hash lookup that replaces it. The aggregation adds that hash lookup per occurrence, plus a vector of processed terms per field. Repetition saves only the second lookup, and on the long-text corpus that does not pay for the first.

**Kept.** The long-text `ab.mjs` workloads (`addAll long text`, `search long text`) and the differential test, which covers long fields with repeated, mixed-case and Unicode terms on every indexing path.

The other WP-09 items:

- **Original-token counting and callback order:** unchanged; no candidate change.
- **JSON transfer (`addAllJSON` → field JSON → Rust parse):** not profiled separately yet; see the `addAll` scaling investigation in the Phase 4 report. A binary format stays an optional later experiment, as the spec allows.
- **`addAllAsync`:** already chunked; not rewritten.
