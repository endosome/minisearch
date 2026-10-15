# ADR 0001: Decisions for the performance project (spec section 10)

- Status: accepted, 2026-10-15
- Context: the performance specification of 2026-10-13 lists ten open decisions to record during Phase 0/1. This record answers them, from the maintainer or from the [WP-00 baseline](../../differential/results/2026-10-15-wp00-baseline.md), and names those still open.

| # | Question | Decision | Basis |
|---|---|---|---|
| 1 | Primary workload | **Ordinary compatible `search()`** (spec profile A: full result objects, ~20k documents, 1–4 fields, mixed exact/prefix/fuzzy). The spec's phase order stands; top-K (WP-13) and the memory work (WP-07/08/12) are not moved ahead. | Maintainer |
| 2 | Score contract | **Bit-for-bit** equality with MiniSearch for every existing API, as the repository enforces today (maximum relative score difference 0 on 934,016 rows). No arithmetic reordering, no tolerance. | Maintainer |
| 3 | `searchRaw`/`searchJoined` term tables | **Preserve everything** (the spec's default): table bytes and order, term ids, expansions that score nothing. A change needs its own decision. | Spec default |
| 4 | Getters, dynamic stored `score`, filters, mutation between native search and JS rows | **MiniSearch's behavior is the contract.** A stored-field getter runs once per row, in MiniSearch's order. A stored `score` decides the order of `search()` and `autoSuggest()` exactly as in MiniSearch. The two baseline divergences (getter read twice by `search()`; native `autoSuggest` ignoring a stored `score`) are fixed toward MiniSearch in WP-01, with a changelog entry. | Maintainer; `differential/callback_traces.mjs` |
| 5 | Score-only/count-only API and callbacks | Open, decided with WP-13 if it is scheduled. | — |
| 6 | >64-field fused fallback | **Removed.** At decision time it was still present (`fused_rows_supported`: fields ≤ 64), and above 64 fields every search took the map path. PR-006 lifted it for `includeMatch: false`. Phase 3 (`e799598`) then gave full rows field masks of any width and deleted the check. The differential suite covers 70 and 130 fields. | Source verification; Phase 3 |
| 7 | How often dirty replays and promotions occur | On the 20k corpus with 25% discarded, 38 of 39 first queries reran exactly inside the engine, and 25 of 39 second queries still did (the lazy cleanup only clears lists a query reaches). Promotion happened only for a query node with its own `boostDocument`, and cost 2.2 s for 20,000 documents. Real-application frequencies are unknown. | WP-00 profile |
| 8 | Break-even for dense vs sparse scratch and compaction remapping | Open, to be measured in WP-07/WP-10. Note: after a vacuum the facade compacts once at least half the ids (+1024) are free, so historical `next_id` above ~2× live persists only while discarded documents are not vacuumed. | WP-00 verification |
| 9 | Historical-id snapshot limit | **Still applies** (`MAX_SHORT_IDS = 2_000_000` on `next_id`, on save and load). Through the facade it is reached only without vacuuming (automatic compaction above), so WP-16 is low priority. | Source verification |
| 10 | Benchmarks and profilers in CI | Open. Candidates: `callback_traces.mjs` is already in `test:wasm`, and `test:native` builds and tests the `stats` feature. Timing runs need a quiet dedicated machine and stay manual for now. | — |

## Consequences

- Phase 1 (WP-03, WP-04, low-risk WP-10, WP-02 requirement flags) proceeds next. Each change is its own commit, with before/after numbers against the baseline on the same machine.
- WP-01 includes the two compatibility fixes above. Its acceptance tests are the callback trace suite with both known divergences removed.
- Any change to scores, term tables or callback order is a blocking failure, even when it is faster.
