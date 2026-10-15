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

## WP-08: external numeric identity: merged, with the snapshot format unchanged

An externally identified index (the public facade's) kept two engine maps whose contents follow from liveness: every live short id mapped to the number equal to it, and back. They are now empty for such an index. `id_of`, `short_id_of`, `live_short_ids`, `insert_identity` and `remove_identity` answer from the liveness table. Indexes with their own ids keep the maps.

Persisted formats do not change. The native JSON snapshot is serialized by hand with the derived layout, writing each live short id mapped to itself. Loading such a snapshot checks that mapping and drops the maps. The binary format already omitted external ids (v5).

Measured (upper bound first established with a throwaway build that skipped the inserts): live memory at 300k documents 225.4 → 198.2 MiB (−12%). Against `pkg-exact`: `addAll` 0.960, discard 25% + vacuum 0.824, discard 60% + vacuum + compact 0.736. Searches did not move beyond noise; an 11-round recheck of the four highest put them at 0.978–1.041 with overlapping quartiles. The facade's full-row path transfers short ids and never reads identity.

## WP-12: the rest of persistent index memory

The 1M × 4-field matrix corpus has 58.0M postings (442 MiB of entries), 1.13M posting lists of which 1.08M hold one document, and 1.02M terms of which 0.87M occur in one field. Merged in `a4c1b7d`: new field and posting lists are allocated for one entry instead of four (−9.4% live memory at 300k documents). Measured in the same change and rejected: trimming every list's growth room at geometric `next_id` thresholds, which fragmented a growing heap (Wasm memory 497 against 276 MiB at 300k).

- **`field_present` bit-packing: rejected.** It is one byte per document-field slot: 4 MiB for 1M × 4 fields, 0.4% of that index. Bit-packing would also need a custom snapshot encoding (it is serialized as a JSON array of booleans) for no measurable gain on the target corpora.
- **Inline singleton postings: deferred.** After `a4c1b7d`, a singleton list costs one 8-byte allocation (16 bytes with allocator overhead) beyond its 16-byte header. Inlining it would save about 17 MiB at 1M documents (under 2%), but would change every `Postings` access, including the binary reader and compaction. Revisit if a vocabulary dominated by singletons becomes a target workload.
- **Field-major `field_length`:** research only, as the spec says; not attempted.

## WP-16: historical-id snapshot limit: deferred

The exact condition on this revision: `check_persistable` refuses to save when `next_id` exceeds 2,000,000 or `next_id × fields` exceeds 16,000,000 slots, with an error that says to vacuum and call `compact()`. Both readers enforce the same limits.

- Through the public facade, historical ids accumulate only while discarded documents are not vacuumed: after a vacuum the facade compacts once at least half the ids (+1024) are free.
- The slot limit also binds **live** documents: 16M slots allow 1M live documents with 16 fields, or 4M with 4 fields, whether or not the index is compacted. Snapshot-only remapping (the spec's WP-16 prototype) does not lift that. It is a format limit, to raise with a snapshot version if a target corpus needs it.

The snapshot-only remap is not implemented: the facade's automatic compaction covers the common path, and the error names the way out.
