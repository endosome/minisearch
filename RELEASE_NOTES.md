# @endosome/minisearch 0.13.0

This release makes the drop-in `search()` about 4× faster than MiniSearch
7.2.0, keeps indexing linear on large corpora, and adds three opt-in methods
for when you need only part of a search's result. Results stay MiniSearch's
down to the last bit of the score, and snapshots saved by 0.12.0 load
unchanged.

The package is now published as **`@endosome/minisearch`** (previously
`minisearch-wasm`):

```sh
npm install @endosome/minisearch
# or keep every import of "minisearch" as it is:
npm install minisearch@npm:@endosome/minisearch
```

The second form is npm's package alias: existing code that imports
`minisearch` (values, `minisearch/SearchableMap` and TypeScript types) runs on
this package without edits.

## Changes

- **Faster `search()`.** On the benchmark corpus (20,000 documents, Linux,
  Node 24), full result objects are 4.1× MiniSearch's speed (0.12.0: 2.8× on
  the same machine). With a `filter` callback 3.1× (was 2.4×), with
  `boostDocument` 2.8× (was 2.3×), on an index with discarded documents 3.7×
  (was 3.0×). All 934,016 result rows of the benchmark were checked identical to
  MiniSearch's.
- **Linear indexing at scale.** Indexing 1M documents takes 38 s (0.12.0:
  200–357 s). Every small step of Wasm memory growth made Node run a full
  garbage collection; memory now grows in larger steps. The first searches on
  an index with discarded documents are about 8× faster for the same reason.
- **New opt-in methods**, each defined by `search()` with the same arguments:
  - `searchTopK(query, { limit, ...options })` is `search(...).slice(0, limit)`;
  - `searchScores(query, options)` gives `{ id, score }` pairs in `search()` order;
  - `countMatches(query, options)` is `search(...).length`.

  They take 0.34–0.45× the time of the `search()` expression, and fall back
  to `search()` itself where callbacks or stored `id`/`score` fields shape the
  rows. See "Top results, scores and counts" in the README.
- **Less memory, faster maintenance.** 14% less live memory for a
  300k-document index. Compaction takes 0.6× and vacuum 0.8× of 0.12.0's time,
  and `termCount` is O(1).
- **Fixed toward MiniSearch:** a stored-field getter is read once per result,
  not twice; `autoSuggest()` follows a stored `score` field, as MiniSearch
  does.

The full list is in [CHANGELOG.md](https://github.com/endosome/minisearch/blob/main/CHANGELOG.md).
The measurements, and the experiments that were rejected, are in the
[final report](https://github.com/endosome/minisearch/blob/main/differential/results/2026-10-15-final.md)
and the decision records under `docs/adr/`.

## Upgrading from 0.12.0

Install under the new name, either as `@endosome/minisearch` (and change the
imports) or aliased as `minisearch` (and change nothing). The API, results,
snapshot formats and TypeScript types are otherwise compatible.
