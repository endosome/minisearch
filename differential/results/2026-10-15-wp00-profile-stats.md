# WP-00 profile, stats build

Output of `node --expose-gc differential/profile.mjs` against `target/pkg-stats` (see [the baseline report](2026-10-15-wp00-baseline.md)). The engine's phase timers make this build slower; use it for counters and the split between phases. "Uncommitted changes" were the profiling scripts themselves; the measured code is `1514d7b`.

Package `target/pkg-stats` (stats build, Wasm 875820 bytes), commit `6e107a7` (uncommitted changes).
Intel(R) Xeon(R) CPU E5-2640 0 @ 2.50GHz, 12 logical CPUs, 31.3 GiB; Node v24.22.0; unknown.
Corpus `differential/bench_corpus.json`: 20000 documents, 39 queries, sha256 `f73e065eb0dd`.

Startup: import 8.99 ms, compile and instantiate 4.00 ms, first index 525.4 ms, first query 23.5 ms; Wasm memory 16768 KiB after the first index.

### Public calls

| Workload | API | Calls | Native executions per call | Repeats | Boundary calls | Transfer KiB | Callbacks | Mode at call | ms total | ms in engine | ms in JS |
|---|---|--:|---|---|--:|--:|--:|---|--:|--:|--:|
| search: default (AND, prefix, fuzzy 0.2) | search | 39 | 1×39 |  | 39 | 10188 | 0 | wasm 39 | 372.2 | 188.7 | 183.5 |
| search: exact terms | search | 39 | 1×39 |  | 39 | 959 | 0 | wasm 39 | 41.4 | 33.1 | 8.26 |
| search: OR | search | 39 | 1×39 |  | 39 | 18543 | 0 | wasm 39 | 492.8 | 208.5 | 284.3 |
| search: includeMatch false | search | 39 | 1×39 |  | 39 | 7064 | 0 | wasm 39 | 182.0 | 147.0 | 35.0 |
| search: filter callback | search | 39 | 1×39 |  | 39 | 10188 | 0 | wasm 39 | 321.7 | 158.1 | 163.6 |
| search: boostDocument | search | 39 | 1×39 |  | 195 | 14770 | 1668 | wasm 39 | 498.9 | 262.7 | 236.3 |
| search: wildcard | search | 1 | 1×1 |  | 1 | 391 | 0 | wasm 1 | 12.3 | 7.61 | 4.72 |
| searchJoined | searchJoined | 39 | 1×39 |  | 39 | 6023 | 0 | wasm 39 | 129.9 | 115.4 | 14.5 |
| searchJoinedOpts: exact | searchJoinedOpts | 39 | 1×39 |  | 39 | 532 | 0 | wasm 39 | 25.0 | 21.7 | 3.23 |
| searchRaw | searchRaw | 39 | 1×39 |  | 39 | 5043 | 0 | wasm 39 | 108.2 | 106.1 | 2.18 |
| autoSuggest | autoSuggest | 39 | 1×39 |  | 39 | 197 | 0 | wasm 39 | 130.5 | 127.1 | 3.40 |
| autoSuggestJoined | autoSuggestJoined | 39 | 1×39 |  | 39 | 258 | 0 | wasm 39 | 86.4 | 85.3 | 1.14 |
| stored fields: title (no shadow) | search | 39 | 1×39 |  | 39 | 10188 | 0 | wasm 39 | 328.4 | 161.5 | 166.9 |
| stored fields: title (no shadow) | searchJoined | 39 | 1×39 |  | 39 | 6023 | 0 | wasm 39 | 155.9 | 115.0 | 41.0 |
| stored fields: title (no shadow) | searchRaw | 39 | 1×39 |  | 39 | 5043 | 0 | wasm 39 | 126.2 | 102.9 | 23.2 |
| stored fields: score (shadows result score) | search | 39 | 1×2, 2×37 | 37: stored field shadows score: sorted rows discarded, rerun unsorted | 76 | 20376 | 0 | wasm 39 | 645.8 | 297.5 | 348.3 |
| stored fields: score (shadows result score) | searchJoined | 39 | 1×2, 3×37 | 37: stored score in joined results: joined and compact rerun as rows | 113 | 22234 | 0 | wasm 39 | 629.8 | 316.8 | 313.1 |
| stored fields: score (shadows result score) | searchRaw | 39 | 1×2, 2×37 | 37: stored score in raw results: rerun as rows | 76 | 15230 | 0 | wasm 39 | 518.1 | 226.4 | 291.7 |
| processTerm callback (stop words) | addAll | 1 | 0×1 |  | 20 | 8822 | 0 | wasm 1 | 912.0 | 342.9 | 569.1 |
| processTerm callback (stop words) | search | 39 | 1×39 |  | 39 | 10185 | 0 | wasm 39 | 286.5 | 161.1 | 125.4 |
| dirty index: first pass | search | 39 | 1×39 | 38: dirty index: engine reran the query exactly | 39 | 7637 | 0 | wasm 39 | 939.3 | 838.3 | 101.0 |
| dirty index: second pass | search | 39 | 1×39 | 25: dirty index: engine reran the query exactly | 39 | 7637 | 0 | wasm 39 | 486.6 | 392.0 | 94.7 |
| promotion: node boostDocument, then searches | search | 40 | 0×40 |  | 5 | 0 | 0 | wasm 1, javascript 39 | 3235.4 | 1640.3 | 1595.1 |
| indexing: addAll | addAll | 1 | 0×1 |  | 20 | 7029 | 0 | wasm 1 | 472.6 | 403.4 | 69.2 |
| indexing: add one by one (2000) | add | 2000 | 0×2000 |  | 2000 | 705 | 0 | wasm 2000 | 115.0 | 75.3 | 39.7 |
| removal: remove (2000) | remove | 2000 | 0×2000 |  | 2000 | 701 | 0 | wasm 2000 | 125.8 | 95.5 | 30.3 |
| removal: discard (2000) and vacuum | discard | 2000 | 0×2000 |  | 2000 | 0 | 0 | wasm 2000 | 21.9 | 9.65 | 12.3 |
| removal: discard (2000) and vacuum | vacuum | 1 | 0×1 |  | 1 | 0 | 0 | wasm 1 | 6.18 | 5.63 | 0.55 |
| loading: loadJSON | loadJSON | 1 | 0×1 |  | 6 | 8353 | 0 | static 1 | 288.7 | 270.9 | 17.8 |
| saving: toJSON | toJSON | 1 | 0×1 |  | 1 | 0 | 0 | wasm 1 | 363.2 | 356.5 | 6.66 |

### Promotions to the JavaScript engine

| Workload | During | Asked by | Documents | ms |
|---|---|---|--:|--:|
| promotion: node boostDocument, then searches | search | search | 20000 | 2127.0 |

### Engine counters (stats build)

| Workload | API | fusedQueries | rawTextQueries | dirtyRetries | trieEdges | myersTransitions | expansionsFound | expansionsUsed | postingsVisited | postingsLive | tombstones | termsInterned | docsTouched | hitsKept | rowsMaterialized |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| search: default (AND, prefix, fuzzy 0.2) | search | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| search: exact terms | search | 39 | 0 | 0 | 0 | 0 | 0 | 0 | 236936 | 236936 | 0 | 68 | 113892 | 25807 | 25807 |
| search: OR | search | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 391977 | 391977 |
| search: includeMatch false | search | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| search: filter callback | search | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| search: boostDocument | search | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| searchJoined | searchJoined | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| searchJoinedOpts: exact | searchJoinedOpts | 39 | 0 | 0 | 0 | 0 | 0 | 0 | 236936 | 236936 | 0 | 68 | 113892 | 25807 | 25807 |
| searchRaw | searchRaw | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| autoSuggest | autoSuggest | 39 | 0 | 0 | 8435 | 11162 | 357 | 415 | 806778 | 806778 | 0 | 363 | 356137 | 188285 | 0 |
| autoSuggestJoined | autoSuggestJoined | 39 | 0 | 0 | 8435 | 11162 | 357 | 415 | 806778 | 806778 | 0 | 363 | 356137 | 188285 | 0 |
| stored fields: title (no shadow) | search | 39 | 0 | 0 | 9404 | 11162 | 513 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| stored fields: title (no shadow) | searchJoined | 39 | 0 | 0 | 0 | 0 | 0 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| stored fields: title (no shadow) | searchRaw | 39 | 0 | 0 | 0 | 0 | 0 | 728 | 1172875 | 1172875 | 0 | 508 | 391977 | 222920 | 222920 |
| stored fields: score (shadows result score) | search | 76 | 0 | 0 | 9404 | 11162 | 513 | 1160 | 1839497 | 1839497 | 0 | 976 | 765438 | 445840 | 445840 |
| stored fields: score (shadows result score) | searchJoined | 113 | 0 | 0 | 0 | 0 | 0 | 1592 | 2506119 | 2506119 | 0 | 1444 | 1138899 | 668760 | 668760 |
| stored fields: score (shadows result score) | searchRaw | 76 | 0 | 0 | 0 | 0 | 0 | 1160 | 1839497 | 1839497 | 0 | 976 | 765438 | 445840 | 445840 |
| processTerm callback (stop words) | search | 39 | 0 | 0 | 8938 | 10763 | 503 | 718 | 1155410 | 1155410 | 0 | 495 | 380248 | 222877 | 222877 |
| dirty index: first pass | search | 39 | 0 | 38 | 24776 | 29553 | 568 | 728 | 2069005 | 880376 | 168235 | 508 | 293990 | 167107 | 334214 |
| dirty index: second pass | search | 39 | 0 | 25 | 14551 | 16359 | 568 | 728 | 1319657 | 880376 | 4063 | 508 | 293990 | 167107 | 281025 |

### Engine phases, ms (stats build; accumulate includes expand)

| Workload | API | plan | expand | accumulate | rank | transfer | facade internals, ms |
|---|---|--:|--:|--:|--:|--:|---|
| search: default (AND, prefix, fuzzy 0.2) | search | 0.28 | 2.43 | 132.6 | 18.2 | 26.8 | _leafText 0.27, _plan 1.91, _rows 189.6, _results 179.6 |
| search: exact terms | search | 0.19 | 0.00 | 22.8 | 1.75 | 2.65 | _leafText 0.17, _plan 0.96, _rows 33.7, _results 6.21 |
| search: OR | search | 0.25 | 1.95 | 121.5 | 27.8 | 46.7 | _leafText 0.19, _plan 1.37, _rows 209.3, _results 281.5 |
| search: includeMatch false | search | 0.19 | 1.75 | 107.9 | 16.1 | 16.9 | _leafText 0.13, _plan 0.85, _rows 147.6, _results 33.0 |
| search: filter callback | search | 0.23 | 1.94 | 124.1 | 2.87 | 23.7 | _leafText 0.17, _plan 1.46, _rows 158.7, _results 119.0 |
| search: boostDocument | search | 0.27 | 2.17 | 221.7 | 3.19 | 26.6 | _leafText 0.18, _plan 1.64, _rows 264.4, _results 125.4 |
| searchJoined | searchJoined | 0.17 | 1.70 | 75.3 | 16.2 | 17.4 | _leafText 0.13, _storedScore 0.18, _withIds 11.3 |
| searchJoinedOpts: exact | searchJoinedOpts | 0.16 | 0.00 | 15.0 | 1.44 | 1.70 | _leafText 0.11, _plan 0.63, _compactPlan 0.89, _storedScore 0.08, _withIds 1.19 |
| searchRaw | searchRaw | 0.17 | 1.61 | 73.5 | 16.2 | 10.2 | _leafText 0.12, _plan 0.63, _compactPlan 0.81, _storedScore 0.09 |
| autoSuggest | autoSuggest | 0.00 | 1.35 | 51.3 | 13.3 | 18.1 | _leafText 0.12 |
| autoSuggestJoined | autoSuggestJoined | 0.00 | 1.33 | 50.8 | 13.2 | 16.5 | _leafText 0.12 |
| stored fields: title (no shadow) | search | 0.17 | 1.84 | 114.7 | 16.0 | 24.7 | _leafText 0.12, _plan 0.66, _rows 162.0, _results 165.2 |
| stored fields: title (no shadow) | searchJoined | 0.21 | 0.57 | 75.9 | 16.2 | 16.7 | _leafText 0.17, _storedScore 24.5, _withIds 13.8 |
| stored fields: title (no shadow) | searchRaw | 0.16 | 0.53 | 71.9 | 16.1 | 9.91 | _leafText 0.11, _plan 0.83, _compactPlan 1.04, _storedScore 21.2 |
| stored fields: score (shadows result score) | search | 0.51 | 2.36 | 211.1 | 19.9 | 51.4 | _leafText 0.19, _plan 1.13, _rows 298.3, _results 285.4 |
| stored fields: score (shadows result score) | searchJoined | 0.49 | 1.05 | 198.4 | 37.1 | 60.7 | _leafText 0.29, _storedScore 0.45, _plan 0.85, _compactPlan 1.07, _rows 106.4, _results 110.4, _identifiedRows 286.7, _withIds 0.01 |
| stored fields: score (shadows result score) | searchRaw | 0.38 | 0.91 | 157.9 | 20.2 | 35.8 | _leafText 0.16, _plan 1.08, _compactPlan 1.32, _storedScore 0.22, _rows 108.1, _results 107.2, _identifiedRows 283.7 |
| processTerm callback (stop words) | search | 0.38 | 1.65 | 113.4 | 15.9 | 24.7 | _leafText 1.19, _plan 2.01, _rows 161.5, _results 122.4 |
| dirty index: first pass | search | 0.34 | 1.81 | 99.1 | 11.4 | 18.9 | _leafText 0.17, _plan 1.07, _rows 838.7, _results 98.8 |
| dirty index: second pass | search | 0.28 | 1.72 | 93.3 | 11.4 | 18.1 | _leafText 0.16, _plan 0.97, _rows 392.4, _results 92.7 |

### Memory

| Workload | Wasm KiB after | Rust live KiB after | Rust peak KiB | Scratch KiB | RSS MiB after |
|---|--:|--:|--:|--:|--:|
| search: default (AND, prefix, fuzzy 0.2) | 19072 | 16408 | 16431 | 5083 | 181 |
| search: exact terms | 21248 | 16375 | 16398 | 5083 | 184 |
| search: OR | 23808 | 16408 | 18984 | 5083 | 261 |
| search: includeMatch false | 23808 | 16408 | 16431 | 5083 | 262 |
| search: filter callback | 23808 | 16408 | 16431 | 5083 | 262 |
| search: boostDocument | 23808 | 16408 | 16521 | 5083 | 283 |
| search: wildcard | 23808 | 16375 | 19190 | 5083 | 285 |
| searchJoined | 23808 | 16408 | 16430 | 5083 | 286 |
| searchJoinedOpts: exact | 23808 | 16375 | 16397 | 5083 | 285 |
| searchRaw | 23808 | 16408 | 16430 | 5083 | 285 |
| autoSuggest | 23808 | 16399 | 16421 | 5083 | 286 |
| autoSuggestJoined | 23808 | 16399 | 16421 | 5083 | 286 |
| stored fields: title (no shadow) | 23808 | 16408 | 16430 | 5083 | 286 |
| stored fields: score (shadows result score) | 23808 | 16408 | 16430 | 5083 | 288 |
| processTerm callback (stop words) | 23808 | 16328 | 16352 | 5083 | 287 |
| dirty index: first pass | 119936 | 27581 | 101610 | 5083 | 377 |
| dirty index: second pass | 119936 | 27588 | 27607 | 5083 | 378 |
| promotion: node boostDocument, then searches | 119936 | 16328 | 16329 | 5083 | 548 |
| indexing: addAll | 119936 | 27618 | 28033 | 5083 | 530 |
| indexing: add one by one (2000) | 119936 | 28837 | 28837 | 5083 | 514 |
| removal: remove (2000) | 119936 | 38892 | 38892 | 5083 | 516 |
| removal: discard (2000) and vacuum | 119936 | 38892 | 38923 | 5083 | 516 |
| loading: loadJSON | 119936 | 47374 | 61191 | 5083 | 560 |
| saving: toJSON | 119936 | 58664 | 105168 | 5083 | 594 |

### Memory through churn (add, discard and vacuum 2000 documents per round)

| Round | Documents | Wasm KiB | Rust live KiB | Scratch KiB | RSS MiB |
|--:|--:|--:|--:|--:|--:|
| 0 | 20000 | 119936 | 63111 | 6802 | 520 |
| 1 | 20000 | 119936 | 63111 | 6802 | 520 |
| 2 | 20000 | 119936 | 63111 | 6802 | 520 |
| 3 | 20000 | 119936 | 63111 | 6802 | 520 |
| 4 | 20000 | 119936 | 63111 | 6802 | 520 |
| 5 | 20000 | 119936 | 63111 | 6802 | 520 |
| 6 | 20000 | 119936 | 63463 | 6802 | 521 |
| 7 | 20000 | 119936 | 63463 | 6802 | 521 |
| 8 | 20000 | 119936 | 63463 | 6802 | 521 |
| 9 | 20000 | 119936 | 63463 | 6802 | 522 |
