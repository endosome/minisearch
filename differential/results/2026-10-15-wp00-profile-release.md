# WP-00 profile, release build

Output of `node --expose-gc differential/profile.mjs --pkg pkg` (see [the baseline report](2026-10-15-wp00-baseline.md)). Timings include the instrumentation's own cost. "Uncommitted changes" were the profiling scripts themselves; the measured code is `1514d7b`.

Package `pkg` (release build, Wasm 825947 bytes), commit `6e107a7` (uncommitted changes).
Intel(R) Xeon(R) CPU E5-2640 0 @ 2.50GHz, 12 logical CPUs, 31.3 GiB; Node v24.22.0; unknown.
Corpus `differential/bench_corpus.json`: 20000 documents, 39 queries, sha256 `f73e065eb0dd`.

Startup: import 7.99 ms, compile and instantiate 3.33 ms, first index 455.4 ms, first query 20.1 ms; Wasm memory 16768 KiB after the first index.

### Public calls

| Workload | API | Calls | Native executions per call | Repeats | Boundary calls | Transfer KiB | Callbacks | Mode at call | ms total | ms in engine | ms in JS |
|---|---|--:|---|---|--:|--:|--:|---|--:|--:|--:|
| search: default (AND, prefix, fuzzy 0.2) | search | 39 | 1×39 |  | 39 | 10188 | 0 | wasm 39 | 327.8 | 165.1 | 162.7 |
| search: exact terms | search | 39 | 1×39 |  | 39 | 959 | 0 | wasm 39 | 40.0 | 32.0 | 7.96 |
| search: OR | search | 39 | 1×39 |  | 39 | 18543 | 0 | wasm 39 | 481.5 | 208.0 | 273.4 |
| search: includeMatch false | search | 39 | 1×39 |  | 39 | 7064 | 0 | wasm 39 | 177.8 | 143.2 | 34.6 |
| search: filter callback | search | 39 | 1×39 |  | 39 | 10188 | 0 | wasm 39 | 310.0 | 146.8 | 163.2 |
| search: boostDocument | search | 39 | 1×39 |  | 195 | 14770 | 1668 | wasm 39 | 441.5 | 230.2 | 211.3 |
| search: wildcard | search | 1 | 1×1 |  | 1 | 391 | 0 | wasm 1 | 13.2 | 7.97 | 5.25 |
| searchJoined | searchJoined | 39 | 1×39 |  | 39 | 6023 | 0 | wasm 39 | 125.7 | 111.5 | 14.2 |
| searchJoinedOpts: exact | searchJoinedOpts | 39 | 1×39 |  | 39 | 532 | 0 | wasm 39 | 24.0 | 20.9 | 3.11 |
| searchRaw | searchRaw | 39 | 1×39 |  | 39 | 5043 | 0 | wasm 39 | 106.1 | 104.0 | 2.11 |
| autoSuggest | autoSuggest | 39 | 1×39 |  | 39 | 197 | 0 | wasm 39 | 127.6 | 124.2 | 3.39 |
| autoSuggestJoined | autoSuggestJoined | 39 | 1×39 |  | 39 | 258 | 0 | wasm 39 | 84.5 | 83.3 | 1.13 |
| stored fields: title (no shadow) | search | 39 | 1×39 |  | 39 | 10188 | 0 | wasm 39 | 320.2 | 159.0 | 161.2 |
| stored fields: title (no shadow) | searchJoined | 39 | 1×39 |  | 39 | 6023 | 0 | wasm 39 | 150.9 | 113.7 | 37.2 |
| stored fields: title (no shadow) | searchRaw | 39 | 1×39 |  | 39 | 5043 | 0 | wasm 39 | 120.5 | 101.1 | 19.5 |
| stored fields: score (shadows result score) | search | 39 | 1×2, 2×37 | 37: stored field shadows score: sorted rows discarded, rerun unsorted | 76 | 20376 | 0 | wasm 39 | 583.0 | 268.2 | 314.8 |
| stored fields: score (shadows result score) | searchJoined | 39 | 1×2, 3×37 | 37: stored score in joined results: joined and compact rerun as rows | 113 | 22234 | 0 | wasm 39 | 584.1 | 286.3 | 297.9 |
| stored fields: score (shadows result score) | searchRaw | 39 | 1×2, 2×37 | 37: stored score in raw results: rerun as rows | 76 | 15230 | 0 | wasm 39 | 480.4 | 207.5 | 272.9 |
| processTerm callback (stop words) | addAll | 1 | 0×1 |  | 20 | 8822 | 0 | wasm 1 | 848.8 | 313.6 | 535.2 |
| processTerm callback (stop words) | search | 39 | 1×39 |  | 39 | 10185 | 0 | wasm 39 | 283.9 | 158.4 | 125.5 |
| dirty index: first pass | search | 39 | 1×39 |  | 39 | 7637 | 0 | wasm 39 | 919.1 | 818.0 | 101.1 |
| dirty index: second pass | search | 39 | 1×39 |  | 39 | 7637 | 0 | wasm 39 | 491.3 | 396.1 | 95.2 |
| promotion: node boostDocument, then searches | search | 40 | 0×40 |  | 5 | 0 | 0 | wasm 1, javascript 39 | 3313.1 | 1695.7 | 1617.5 |
| indexing: addAll | addAll | 1 | 0×1 |  | 20 | 7029 | 0 | wasm 1 | 470.3 | 401.0 | 69.3 |
| indexing: add one by one (2000) | add | 2000 | 0×2000 |  | 2000 | 705 | 0 | wasm 2000 | 105.9 | 70.2 | 35.7 |
| removal: remove (2000) | remove | 2000 | 0×2000 |  | 2000 | 701 | 0 | wasm 2000 | 103.9 | 79.5 | 24.5 |
| removal: discard (2000) and vacuum | discard | 2000 | 0×2000 |  | 2000 | 0 | 0 | wasm 2000 | 13.1 | 5.77 | 7.32 |
| removal: discard (2000) and vacuum | vacuum | 1 | 0×1 |  | 1 | 0 | 0 | wasm 1 | 5.50 | 5.08 | 0.42 |
| loading: loadJSON | loadJSON | 1 | 0×1 |  | 6 | 8353 | 0 | static 1 | 245.7 | 229.2 | 16.5 |
| saving: toJSON | toJSON | 1 | 0×1 |  | 1 | 0 | 0 | wasm 1 | 326.0 | 320.2 | 5.88 |

### Promotions to the JavaScript engine

| Workload | During | Asked by | Documents | ms |
|---|---|---|--:|--:|
| promotion: node boostDocument, then searches | search | search | 20000 | 2157.4 |

### Memory

| Workload | Wasm KiB after | Rust live KiB after | Rust peak KiB | Scratch KiB | RSS MiB after |
|---|--:|--:|--:|--:|--:|
| search: default (AND, prefix, fuzzy 0.2) | 19072 |  |  |  | 181 |
| search: exact terms | 21248 |  |  |  | 184 |
| search: OR | 23808 |  |  |  | 261 |
| search: includeMatch false | 23808 |  |  |  | 261 |
| search: filter callback | 23808 |  |  |  | 262 |
| search: boostDocument | 23808 |  |  |  | 283 |
| search: wildcard | 23808 |  |  |  | 285 |
| searchJoined | 23808 |  |  |  | 286 |
| searchJoinedOpts: exact | 23808 |  |  |  | 286 |
| searchRaw | 23808 |  |  |  | 286 |
| autoSuggest | 23808 |  |  |  | 286 |
| autoSuggestJoined | 23808 |  |  |  | 286 |
| stored fields: title (no shadow) | 23808 |  |  |  | 285 |
| stored fields: score (shadows result score) | 23808 |  |  |  | 287 |
| processTerm callback (stop words) | 23808 |  |  |  | 286 |
| dirty index: first pass | 119936 |  |  |  | 377 |
| dirty index: second pass | 119936 |  |  |  | 377 |
| promotion: node boostDocument, then searches | 119936 |  |  |  | 547 |
| indexing: addAll | 119936 |  |  |  | 529 |
| indexing: add one by one (2000) | 119936 |  |  |  | 514 |
| removal: remove (2000) | 119936 |  |  |  | 515 |
| removal: discard (2000) and vacuum | 119936 |  |  |  | 515 |
| loading: loadJSON | 119936 |  |  |  | 560 |
| saving: toJSON | 119936 |  |  |  | 594 |

### Memory through churn (add, discard and vacuum 2000 documents per round)

| Round | Documents | Wasm KiB | Rust live KiB | Scratch KiB | RSS MiB |
|--:|--:|--:|--:|--:|--:|
| 0 | 20000 | 119936 |  |  | 520 |
| 1 | 20000 | 119936 |  |  | 520 |
| 2 | 20000 | 119936 |  |  | 520 |
| 3 | 20000 | 119936 |  |  | 520 |
| 4 | 20000 | 119936 |  |  | 520 |
| 5 | 20000 | 119936 |  |  | 520 |
| 6 | 20000 | 119936 |  |  | 521 |
| 7 | 20000 | 119936 |  |  | 521 |
| 8 | 20000 | 119936 |  |  | 521 |
| 9 | 20000 | 119936 |  |  | 521 |
