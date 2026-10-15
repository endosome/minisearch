# ADR 0005: Phase 6 research decisions, and the disposition of every inventory item

- Status: accepted, 2026-10-15
- Context: Phase 6 of the performance specification is research (remaining WP-11, WP-14, WP-15; SIMD and WAND only if justified), delivered as decision records. Section 12 of the spec lists every idea from the original audit "so earlier findings are not lost". This record gives each its final disposition, with the evidence and the commit or decision record behind it.

## WP-15: startup, responsiveness and high-water memory

Measured with `differential/startup_probe.mjs` (fresh Node process, 20,000-document corpus, three runs each, baseline `1514d7b` against `ded44ff`):

| | Baseline | Now |
|---|--:|--:|
| Wasm size | 825,947 B | 864,912 B (+4.7%) |
| Module import | 9.1–9.3 ms | 9.1–9.2 ms |
| Compile + instantiate | 3.8–4.2 ms | 4.0–4.4 ms |
| First 20k index | 497–621 ms | 483–528 ms |
| First query | 22.4–22.6 ms | 20.3–25.5 ms |
| Wasm memory after the first index | 16.4 MiB | 14.9 MiB |
| Longest event-loop stall during `addAllAsync` | 3.6–4.4 ms | 2.5–3.5 ms |

The binary grew 39 KB, mostly the global allocator declaration (+17 KB, `394e769`) and the WP-13 methods (+22 KB). Compile and instantiate times did not move measurably. **High-water memory:** linear memory now grows by an eighth of its size per step (`394e769`), so up to one step (at most 64 MiB) can sit unused at the top. Freed memory still never returns to the system, as the spec notes. No further startup work is justified: startup is about 1% of building a 20k index.

**Vacuum responsiveness at scale** (the same event-loop probe around `vacuum()` on the matrix corpus, 50% discarded, with each `vacuumStep` timed):

- 100k documents × 4 fields: longest pause 58 → 24 ms.
- 1M documents × 4 fields: longest pause 215 ms. It comes from two places:
  - The first step collects every term key: 210 ms for 1M terms.
  - The last two steps clean the most common terms, whose lists are longest: 192 and 254 ms.

No garbage collection over 20 ms runs during the vacuum. Lowering `batchSize` to 100 does not help: one batch of common terms is still that slow.

A posting-aware budget would split those batches, adding timer turns MiniSearch's vacuum does not take (it waits `batchWait` after every `batchSize` terms). It is therefore **deferred as an opt-in option** (for example `vacuum({ maxPostingsPerBatch })`), to build when an application at this scale needs it. Collecting the keys into one buffer instead of one `String` each would shorten the first step and changes nothing observable. It is the first thing to do if vacuum pauses matter.

## SIMD and full radix/posting redesign: not pursued

Posting traversal is the remaining engine cost (ADR 0002), but its work per posting is a scattered read-modify-write into per-document scratch slots. Vector lanes do not fit that, and BM25's floating-point order is fixed by the bit-for-bit score contract (ADR 0001, decision 2). Not pursued without a profile showing a vectorizable inner loop.

## Global permanent term ids: rejected

As the spec's anti-patterns say. Interning is per query: 508 terms per 39 default queries, against 1.17M postings visited (WP-00 stats profile).

## Inventory dispositions (spec section 12)

| Topic | Disposition | Where |
|---|---|---|
| Repeated sorted/unsorted `search()` for stored score | Done: one execution per call | `6b8d32e` (WP-01) |
| `searchRaw()`/`searchJoined()` repeated fallback | Done | `6b8d32e` |
| Dirty-index optimistic replay | Profiled (38 of 39 first queries rerun). Kept, as the spec says. Its cost was mostly allocator growth: first pass 13.2 s → 1.4 s | WP-00 report, `394e769` |
| Native-to-JS promotion and execution mode | Instrumented | `1cb9e85` |
| Unused match metadata / `includeMatch: false` | Done | `4d80bfb` (PR-006) |
| >64-field fused fallback | Removed for every result shape | `4d80bfb`, `e799598` |
| Unneeded transfer strings | Done | `527d135` (PR-002) |
| Duplicate `field_boosts()`, cloned options | Done | `5c0f430` (PR-003) |
| Recursive `termCount` | Done: O(1) | `deb0f2a` (PR-004) |
| Derived-term clone for document boosts | Done | `4aa5cab` (PR-005) |
| Repeated JS↔Wasm boost transfer; declarative boost table | Not done. The facade calls `boostDocument` per posting in MiniSearch's order, crossing the boundary once per posting list. A declarative table would be a new opt-in API without a target workload | — |
| JS query-term planning and Rust re-parsing | Not done. Planning is 0.15% of engine time (WP-00) | ADR 0004 |
| Double-owned strings in `Scratch::intern()` | Not done: 13 interned terms per query on average | this record |
| Owned fuzzy cache key on hits | Done | `4aa5cab` |
| Linear selected-field lookup | Rejected: about 650 lookups against 240k postings at 65 fields | ADR 0002 (WP-05) |
| Skip irrelevant expansions | Not done. The public term table must not change (ADR 0001, decision 3) | — |
| Tombstone-free posting iteration | Rejected after measurement: duplicated loop 4–20% slower, single loop within noise | ADR 0002 (WP-06) |
| BM25 `tf=1` reuse | Not attempted: no division bottleneck | ADR 0002 |
| Dense scratch, historical `next_id` | Done: per-document slots plus rows for touched documents only | `93d9450` (WP-07) |
| Thread-local scratch retention | Measured: retained scratch at 100k documents 12.1 → 7.0 MiB (1 field). Released at compaction. Kept across indexes, since a query reuses it | `93d9450` |
| Duplicated id maps in external mode | Done: none kept; snapshots unchanged | `16e7981` (WP-08) |
| Frequency aggregation at insertion | Rejected after measurement: 13–32% slower | ADR 0003 (WP-09) |
| Token buffers, batch cache invalidation | Not changed: no measured cost (expansion caches are cleared per added document; clearing an empty cache is cheap) | ADR 0003 |
| JSON at ingestion | Kept: ingestion is linear now (the superlinear cost was allocator growth); binary protocol optional later | ADR 0003, `394e769` |
| `addAllAsync` responsiveness | Measured: longest stall 2.5–3.5 ms at 20k; not rewritten | this record |
| Radix deletion clones, `keys()` handle clones, vacuum string copies | Done | `27b5e5a` (PR-008) |
| Vacuum budget by postings | Measured (215 ms pauses at 1M); deferred as an opt-in option | this record |
| Compaction id remap | Done: adaptive dense table or hash map, one tree walk | `1461dab` |
| Tombstones and stale document-frequency scans | Kept: amortized sweeps per list (tombstones above half) and lazy cleanup as MiniSearch does; vacuum and compaction faster (`16e7981`: 0.74–0.82) | ADR 0003 |
| Myers column-min scan, non-ASCII masks, longest-key walk, cache LRU, typed-prefix reuse, subtree field masks | Deferred: expansion is 1.3% of engine time; no multilingual or extreme-distance target workload | ADR 0002 (WP-11) |
| Field-presence bit-packing | Rejected: 0.4% of memory at 1M × 4 | ADR 0003 |
| Inline singleton postings | Deferred: under 2% after exact first allocations (`a4c1b7d`) | ADR 0003 |
| Field-major field lengths | Benchmark only, not attempted | ADR 0003 |
| Score-only, count-only, top-K | Done as opt-in methods defined by `search()` | `ded44ff`, ADR 0004 |
| Two-pass top-K metadata | Not needed: rows tracked in one pass, JS builds only K | ADR 0004 |
| AND short-circuit, intersection, AND_NOT membership, single-term executor, tree fusion | Not implemented: no opportunity in the target workload | ADR 0004 (WP-14) |
| Block-Max WAND/MaxScore | P3; now possible on top of `searchTopK` if a workload needs it | ADR 0004 |
| Startup and high-water memory | Measured above | this record |
| Historical-id snapshot limit | Verified; deferred (facade compacts; the 16M-slot limit needs a format version) | ADR 0003 (WP-16) |
| Global permanent term ids | Rejected | this record |
| SIMD BM25, full redesign | Not pursued | this record |

## Rollback

Every change is its own commit on `perf/wp-00`, with its measurements in the commit message and the reports under `differential/results/`. `git revert` of any one of them restores the earlier behavior. Two need care:

- **`394e769` (allocator):** reverting it brings back the quadratic indexing at scale.
- **`16e7981` (WP-08):** reverting it needs no data migration, because snapshot formats did not change.
