# ADR 0002: Rejected and deferred Phase 3 items (WP-05, WP-06, WP-11)

- Status: accepted, 2026-10-15
- Context: Phase 3 of the performance specification covers WP-05 (field lookup), WP-06 (scoring loop and posting traversal), WP-07 (scratch memory) and WP-11 (cold fuzzy/prefix traversal and caches). WP-07 was implemented; see the [Phase 3 report](../../differential/results/2026-10-15-phase3.md). This record gives the measurements behind the other three.

All timings: `differential/ab.mjs` on the 20,000-document bench corpus, against the package frozen after WP-07 and the JS row work (`target/pkg-phase3`, commit `e799598`). Noise on this machine is about ±5% per 39-query batch.

## WP-05: indexed field lookup: rejected

`FieldTermData::get` is a linear `iter().find` over a term's (field, postings) pairs. It runs once per field boost per derived term, not per posting. On the bench corpus (2 fields) that is at most two comparisons per list. At 65 fields, the widest case in the matrix, a 39-query batch makes about 650 lookups against 240,000 postings visited, so even a free lookup cannot move the batch time. An index per term would add memory to every term in the vocabulary for no measurable gain.

Revisit only if a profile on a real index with many fields and many short posting lists shows `get` itself.

## WP-06: posting traversal: rejected after measurement

`Postings::iter` filters zero-frequency tombstones on every entry, even when the list's tombstone count is zero (confirmed in the baseline source verification). Two variants were built and timed against `pkg-phase3`:

| Variant | Effect (B/A) |
|---|---|
| v1: `as_live_slice()` returns the raw entries when the list has no tombstones; `accumulate_dense` walks them directly, otherwise through `iter`. The loop body became a closure inlined twice. | **Slower everywhere**, 9 rounds with tight quartiles: default `search` 1.058, `includeMatch: false` 1.105, exact 1.103, `searchRaw` 1.178, `searchJoined` 1.153, `searchJoinedOpts` exact 1.183, `autoSuggest` 1.109, dirty first pass 1.048 |
| v2: one loop; the filter predicate becomes `all_live \|\| frequency > 0`, with `all_live` computed once per list | Within noise, 7 rounds: 0.979–1.020 on every non-stored workload |

So the frequency test costs nothing measurable: the entry is already loaded, and the branch is always taken the same way on a clean list. Duplicating the body made the release build slower, most likely through code layout and inlining decisions in the hot loop. Neither change is kept.

The other WP-06 items:

- **Liveness and boost checks.** Already hoisted: `clean` (no discarded documents) is computed once per accumulated term, `idf` once per list, and the document-boost iterator exists only while a `boostDocument` callback is active.
- **BM25 normalization reuse** for repeated `(tf, field length)` pairs: not attempted. The spec allows it only for a measured division bottleneck. The profile attributes accumulate time to posting traversal and per-document scratch updates (1,172,875 postings and 391,977 touched documents per default batch). v2 shows that removing a per-posting branch is invisible. A lookup per posting would cost at least as much as one division.
- **No arithmetic reordering.** Required by ADR 0001 (bit-for-bit scores), and respected by both variants (the A/B compares output checksums).

## WP-11: cold traversal and caches: deferred

- **Cost share.** In the baseline stats profile, expansion (radix walk, Myers automaton, pruning) takes 2.4 ms of a 180 ms engine batch for the default prefix-and-fuzzy search, 1.3%. Accumulation is 132.6 ms.
- **Cold against warm.** The baseline's GC probe at 100k documents × 4 fields found a query's first call as fast as its warm calls (61 against 59 ms) once the process had run other searches. The only real cold cost is the first search after building, about 4× a warm call: JIT warm-up and the scratch's first growth, not traversal.
- **Caches.** `EXPANSION_CACHE_CAP` (4,096, cleared when full) and invalidation on every mutation are confirmed. The bench queries never fill the cache. Alternating add/search loads invalidate on every add, so admission policy (LRU against clear) cannot help those.
- **Not measured, and why.** Non-ASCII Peq lookup, the `longest_key_units` walk (only for a fuzzy distance above query length + 64), and subtree field masks. None appears in the target workload (ADR 0001: English-like 1–4-field `search()`). They need a multilingual or extreme-distance corpus first.

Revisit WP-11 if a target workload shows expansion above about 10% of engine time, for example with multilingual text, very short prefixes on a large vocabulary, or a mutation-heavy load with per-query cache misses.

## Consequences

- Phase 3 ends with WP-07 and the JS row work (WP-02's row-tracking requirements were done in Phase 1).
- Phase 4 proceeds with WP-08, WP-09, the rest of WP-10, WP-12 and WP-16, in the spec's order.
