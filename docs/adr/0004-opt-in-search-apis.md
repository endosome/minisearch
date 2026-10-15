# ADR 0004: Opt-in search APIs (WP-13) and restricted query specialization (WP-14)

- Status: accepted, 2026-10-15
- Context: Phase 5 of the performance specification: optional new APIs (WP-13) and a restricted WP-14. ADR 0001 left decision 5 open: what a score-only or count-only API means, and what happens with callbacks.

## Decision 5: contracts by definition

Each new method is **defined by `search()` with the same arguments**. That is the whole contract, and the differential test checks it literally against MiniSearch's `search()`:

| Method | Defined as |
|---|---|
| `searchTopK(query, { limit, ...options })` | `search(query, options).slice(0, limit)`; `limit` a non-negative integer, else `TypeError` |
| `searchScores(query, options)` | `search(query, options).map(({ id, score }) => ({ id, score }))` |
| `countMatches(query, options)` | `search(query, options).length` |

Consequences, all inherited from that definition:

- **Callbacks and side effects.** Callbacks (`filter`, `boostDocument`, `tokenize`, `processTerm`) run exactly as in `search()`, because the methods take `search()`'s own result whenever a callback sees rows. On an index with discarded documents, each call cleans up what it reaches, as one `search()` does.
- **Shadowing.** Where a stored field named `score` or `id` can replace a row's own value (configured, adopted from a loaded snapshot, or added to an object that `getStoredFields`/`toJSON` handed out), the methods take `search()`'s result. `countMatches` is exempt: stored fields change rows, never their number.
- **Ties, NaN, infinities.** Ties keep `search()`'s order. The engine's top-K selection orders by (score, traversal position), a total order that picks exactly the rows a stable sort puts first. If any score is NaN it falls back to the full stable sort, then cuts. Boosted searches, whose scores can be anything, take `search()`'s result.
- **No silent truncation of `search()`.** `search()` itself is unchanged.

`searchJoined`, `searchRaw` and the `searchCount*` probes stay as they were: narrower encodings with their own documented contracts.

## Implementation

- `searchTopK`: the engine ranks all hits as before, then keeps `limit` (`rank_by_score`: `select_nth_unstable_by` on the total order, then a sort of the kept rows) before row transfer. JavaScript builds only those rows. Scoring still visits every posting: WAND-style pruning stays P3, as the spec says.
- `searchScores`: the compact joined transfer (short ids and scores), mapped to `{ id, score }` with the facade's ids.
- `countMatches`: a new engine count (`searchCount`) that ranks nothing and transfers nothing, with the same exact rerun on dirty indexes as the joined path.

Measured with `differential/bench_opt_in.mjs` on the 20,000-document corpus (39 queries, 15 rounds, outputs asserted equal):

| Workload | `search()` expression ms | Method ms | Ratio |
|---|--:|--:|--:|
| top 10 | 312.0 | 125.7 | 0.403 |
| top 10, `includeMatch: false` | 156.0 | 101.0 | 0.648 |
| top 100 | 309.4 | 134.1 | 0.434 |
| scores | 295.0 | 131.6 | 0.446 |
| count | 291.8 | 99.1 | 0.340 |

What remains is mostly scoring: about 100 ms of engine time per batch. Existing calls are unchanged: A/B against `pkg-wp08`, all search workloads 0.91–1.05, an 11-round recheck of the highest 0.965–1.031.

The Wasm binary grows by 22 KB (842,678 → 864,912 bytes), within the size budget. The top-K selection runs on one `(score, position)` array for both hit types; a first version generic over the hit type cost 36 KB. A second, restricted posting pass to rebuild match data for K winners only (a spec option) is not needed: the engine already tracks rows during scoring, and JS row building, the cost the spec targets, now covers K rows.

## WP-14: restricted specialization: not implemented, by measurement

The spec allows each WP-14 path only where it saves measurable work without skipping observable side effects. Measured opportunity on the target workload (the bench corpus's 39 queries, AND with prefix and fuzzy):

- **AND short-circuit on a spec without matches.** 25 queries are single-term and 14 are multi-term. None of the 14 has a term without matches, so the short-circuit would never fire. It would also be allowed only on clean indexes: on a dirty index MiniSearch's search cleans up every list it reaches, which later scores reflect (the opt-in API test depends on that behavior).
- **Candidate intersection, smallest list first.** The fused path already keeps a document only if every spec touched it, iterating the last spec's touched documents. A merge would save scoring of rejected candidates, but for these queries most candidates of the rarest term pass. Unmeasured, because no target query is selective enough to justify a second scoring order that has to reproduce the same floating-point sums.
- **AND_NOT as membership.** Excluded clauses still accumulate BM25 terms that are never read. That arithmetic is a small share of the posting visit, and ADR 0002 showed a per-posting branch is invisible. No target workload uses AND_NOT.
- **Single exact term without generic setup.** Planning is 0.19–0.28 ms per 39 queries (WP-00 stats profile), 0.15% of engine time. The fixed cost of a short query is in the facade, not the engine's setup.
- **Query trees** take the map path and are not in the target workload. They were measured as a class in WP-00 (`execute_query_tree`); fusing simple trees stays open until a workload uses them.
- **WAND / MaxScore** remain P3, as the spec says: they need a heavily used top-K API (now available as `searchTopK`) and proven score upper bounds across boosts and callbacks.

Revisit with a workload of selective multi-term AND queries, AND_NOT-heavy filtering, or query trees.
