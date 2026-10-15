// The opt-in methods against the search() expressions that define them, in
// the same package, on the bench corpus's 39 queries (default search options
// of differential/ab.mjs). Outputs must match; medians of 15 rounds.
//
//   node --expose-gc differential/bench_opt_in.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import MiniSearch from '../pkg/minisearch_wasm_node.js';

const { docs, queries } = JSON.parse(readFileSync(new URL('bench_corpus.json', import.meta.url), 'utf8'));
const index = new MiniSearch({ fields: ['title', 'text'], autoVacuum: false, searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND' } });
index.addAll(docs);
const pairs = {
  'top 10': [qs => qs.map(q => index.search(q).slice(0, 10)), qs => qs.map(q => index.searchTopK(q, { limit: 10 }))],
  'top 10, includeMatch: false': [qs => qs.map(q => index.search(q, { includeMatch: false }).slice(0, 10)), qs => qs.map(q => index.searchTopK(q, { limit: 10, includeMatch: false }))],
  'top 100': [qs => qs.map(q => index.search(q).slice(0, 100)), qs => qs.map(q => index.searchTopK(q, { limit: 100 }))],
  'scores': [qs => qs.map(q => index.search(q).map(r => ({ id: r.id, score: r.score }))), qs => qs.map(q => index.searchScores(q))],
  'count': [qs => qs.map(q => index.search(q).length), qs => qs.map(q => index.countMatches(q))],
};
const time = f => { global.gc?.(); const t = performance.now(); f(queries); return performance.now() - t; };
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
console.log('| Workload | search() expression ms | opt-in method ms | ratio |\n|---|--:|--:|--:|');
for (const [name, [viaSearch, optIn]] of Object.entries(pairs)) {
  assert.deepEqual(optIn(queries), viaSearch(queries), name);
  const a = [], b = [];
  for (let round = 0; round < 15; round++) { if (round % 2) { b.push(time(optIn)); a.push(time(viaSearch)); } else { a.push(time(viaSearch)); b.push(time(optIn)); } }
  console.log(`| ${name} | ${median(a).toFixed(1)} | ${median(b).toFixed(1)} | ${(median(b) / median(a)).toFixed(3)} |`);
}
