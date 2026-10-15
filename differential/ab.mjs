// A/B timing of two builds of the package on the same workloads: the quick
// before/after for one change. Each round runs every workload once in a
// fresh process per package, alternating which package goes first; the
// report gives medians, quartiles and the candidate/baseline ratio.
//
//   node differential/ab.mjs [--a target/pkg-baseline] [--b pkg] [--rounds 7]
//     [--only name,name] [--out ab.json]
//
// Freeze a baseline once with `cp -r pkg target/pkg-baseline` (before the
// change), rebuild, then run. Outputs are compared too: a workload whose
// checksum differs between the two packages fails the run.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const argument = (name, fallback) => { const at = process.argv.indexOf(name); return at === -1 ? fallback : process.argv[at + 1]; };

// Each workload builds what it needs once (untimed), warms up, then times
// `repeat` passes over the corpus queries and returns a checksum of what the
// public API returned.
const WORKLOADS = {
  'search default': { run: (ix, qs) => sumRows(qs.map(q => ix.search(q))) },
  'search includeMatch:false': { run: (ix, qs) => sumRows(qs.map(q => ix.search(q, { includeMatch: false }))) },
  'search exact': { run: (ix, qs) => sumRows(qs.map(q => ix.search(q, { prefix: false, fuzzy: false }))) },
  'search OR': { run: (ix, qs) => sumRows(qs.map(q => ix.search(q, { combineWith: 'OR' }))) },
  'search filter': { run: (ix, qs) => sumRows(qs.map(q => ix.search(q, { filter: r => r.id % 2 === 0 }))) },
  'search boostDocument': { run: (ix, qs) => sumRows(qs.map(q => ix.search(q, { boostDocument: id => 1 + (id % 5) / 10 }))) },
  'search fields:[title]': { run: (ix, qs) => sumRows(qs.map(q => ix.search(q, { fields: ['title'] }))) },
  'searchRaw': { run: (ix, qs) => qs.reduce((s, q) => { const r = ix.searchRaw(q); return s + r.count + r.scores.reduce((a, b) => a + b, 0) + r.termTable.length; }, 0) },
  'searchJoined': { run: (ix, qs) => qs.reduce((s, q) => { const r = ix.searchJoined(q); return s + r.count + r.scores.reduce((a, b) => a + b, 0) + r.terms.length + r.ids.length; }, 0) },
  'searchJoinedOpts exact': { run: (ix, qs) => qs.reduce((s, q) => { const r = ix.searchJoinedOpts(q, { prefix: false, fuzzy: false }); return s + r.count + r.scores.reduce((a, b) => a + b, 0); }, 0) },
  'autoSuggest': { run: (ix, qs) => qs.reduce((s, q) => s + ix.autoSuggest(q).reduce((a, r) => a + r.score + r.suggestion.length, 0), 0) },
  'stored score search': { setup: 'storedScore', run: (ix, qs) => sumRows(qs.map(q => ix.search(q))) },
  'stored score searchJoined': { setup: 'storedScore', run: (ix, qs) => qs.reduce((s, q) => { const r = ix.searchJoined(q); return s + r.count + r.scores.reduce((a, b) => a + b, 0) + r.ids.length; }, 0) },
  'stored score searchRaw': { setup: 'storedScore', run: (ix, qs) => qs.reduce((s, q) => { const r = ix.searchRaw(q); return s + r.count + r.scores.reduce((a, b) => a + b, 0); }, 0) },
  'stored score autoSuggest': { setup: 'storedScore', run: (ix, qs) => qs.reduce((s, q) => s + ix.autoSuggest(q).reduce((a, r) => a + r.score + r.suggestion.length, 0), 0) },
  'stored title searchJoined': { setup: 'storedTitle', run: (ix, qs) => qs.reduce((s, q) => { const r = ix.searchJoined(q); return s + r.count + r.scores.reduce((a, b) => a + b, 0) + r.ids.length; }, 0) },
  'stored title searchRaw': { setup: 'storedTitle', run: (ix, qs) => qs.reduce((s, q) => { const r = ix.searchRaw(q); return s + r.count + r.scores.reduce((a, b) => a + b, 0); }, 0) },
  'dirty search (first pass)': { setup: 'dirty', fresh: true, repeat: 1, run: (ix, qs) => sumRows(qs.map(q => ix.search(q))) },
  'termCount': { run: ix => { let s = 0; for (let i = 0; i < 200; i++) s += ix.termCount; return s; } },
  'addAll': { setup: 'empty', fresh: true, repeat: 1, run: (ix, qs, docs) => { ix.addAll(docs); return ix.documentCount + ix.termCount; } },
  // Long articles (WP-09): ~800 words per document from a Zipf-like vocabulary.
  'addAll long text': { setup: 'empty', corpus: 'long', fresh: true, repeat: 1, run: (ix, qs, docs) => { ix.addAll(docs); return ix.documentCount + ix.termCount; } },
  'search long text': { corpus: 'long', run: (ix, qs) => sumRows(qs.map(q => ix.search(q, { prefix: true }))) },
  // 60% free ids: the facade compacts after the vacuum.
  'discard 60% + vacuum + compact': { fresh: true, repeat: 1, run: async (ix, qs, docs) => { for (const d of docs) if (d.id % 5 < 3) ix.discard(d.id); await ix.vacuum(); return ix.documentCount + ix.termCount + ix.search('engine').length; } },
  'discard 25% + vacuum': { fresh: true, repeat: 1, run: async (ix, qs, docs) => { for (const d of docs) if (d.id % 4 === 0) ix.discard(d.id); await ix.vacuum(); return ix.documentCount + ix.termCount; } },
};
function sumRows(batches) {
  let s = 0;
  for (const rows of batches) for (const r of rows) { s += r.score + Number(r.id); for (const t of r.terms) s += t.length; if (r.match) s += Object.keys(r.match).length; }
  return s;
}

if (process.argv.includes('--child')) {
  const pkg = resolve(root, argument('--child'));
  const names = argument('--names').split('|');
  const facade = await import(pathToFileURL(resolve(pkg, 'minisearch_wasm.js')));
  facade.initSync({ module: readFileSync(resolve(pkg, 'minisearch_wasm_bg.wasm')) });
  const MiniSearch = facade.default;
  const { docs, queries } = JSON.parse(readFileSync(resolve(root, 'differential/bench_corpus.json'), 'utf8'));
  const options = { fields: ['title', 'text'], autoVacuum: false, searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND' } };
  const make = (kind, docs) => {
    const ix = new MiniSearch(kind === 'storedScore' ? { ...options, storeFields: ['score'] } : kind === 'storedTitle' ? { ...options, storeFields: ['title'] } : options);
    if (kind === 'empty') return ix;
    ix.addAll(kind === 'storedScore' ? docs.map(d => ({ ...d, score: d.id % 7 })) : docs);
    if (kind === 'dirty') for (const d of docs) if (d.id % 4 === 0) ix.discard(d.id);
    return ix;
  };
  // A deterministic long-text corpus, and queries drawn from its vocabulary.
  let longCorpus;
  const long = () => longCorpus ??= (() => {
    let seed = 0x5eed1;
    const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x100000000; };
    const syllables = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'to', 'vi', 'den', 'mar', 'qu', 'zel', 'or', 'ti', 'ber'];
    const vocab = Array.from({ length: 5000 }, (_, i) => { let w = '', n = i + 7; do { w += syllables[n % syllables.length]; n = Math.floor(n / syllables.length); } while (n > 0); return i % 9 ? w : w[0].toUpperCase() + w.slice(1); });
    const word = () => vocab[Math.floor(vocab.length * rand() ** 3)];
    const words = n => Array.from({ length: n }, word).join(' ');
    const docs = Array.from({ length: 2000 }, (_, id) => ({ id, title: words(6), text: words(600 + Math.floor(rand() * 400)) }));
    const queries = Array.from({ length: 39 }, () => `${word()} ${word().slice(0, 3)}`);
    return { docs, queries };
  })();
  const shared = {};
  const out = {};
  for (const name of names) {
    const w = WORKLOADS[name];
    const repeat = w.repeat ?? 3;
    const [corpusDocs, corpusQueries] = w.corpus === 'long' ? [long().docs, long().queries] : [docs, queries];
    let ix = w.fresh ? null : (shared[`${w.setup ?? 'plain'} ${w.corpus ?? ''}`] ??= make(w.setup, corpusDocs));
    if (!w.fresh) await w.run(ix, corpusQueries, corpusDocs); // warm-up
    const times = [];
    let checksum;
    for (let i = 0; i < repeat; i++) {
      if (w.fresh) ix = make(w.setup, corpusDocs);
      global.gc?.();
      const t = performance.now();
      checksum = await w.run(ix, corpusQueries, corpusDocs);
      times.push(performance.now() - t);
      if (w.fresh) ix.free();
    }
    out[name] = { ms: Math.min(...times), checksum };
  }
  process.stdout.write(JSON.stringify(out));
} else {
  const a = argument('--a', 'target/pkg-baseline'), b = argument('--b', 'pkg');
  const rounds = Number(argument('--rounds', 7));
  const only = argument('--only')?.split(',');
  const names = Object.keys(WORKLOADS).filter(n => !only || only.some(o => n.includes(o)));
  const child = pkg => JSON.parse(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child', pkg, '--names', names.join('|')],
    { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }));
  const samples = { a: {}, b: {} };
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? ['b', 'a'] : ['a', 'b'];
    const results = {};
    for (const side of order) results[side] = child(side === 'a' ? a : b);
    for (const name of names) {
      const ca = results.a[name].checksum, cb = results.b[name].checksum;
      assert.ok(ca === cb || Math.abs(ca - cb) <= 1e-9 * Math.max(1, Math.abs(ca)), `${name}: outputs differ (${ca} vs ${cb})`);
      (samples.a[name] ??= []).push(results.a[name].ms);
      (samples.b[name] ??= []).push(results.b[name].ms);
    }
    process.stderr.write(`round ${round + 1}/${rounds}\n`);
  }
  const q = (v, p) => { const s = [...v].sort((x, y) => x - y); const at = (s.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at); return s[lo] + (s[hi] - s[lo]) * (at - lo); };
  const rows = names.map(name => {
    const A = samples.a[name], B = samples.b[name];
    return { name, a: q(A, 0.5), aIqr: [q(A, 0.25), q(A, 0.75)], b: q(B, 0.5), bIqr: [q(B, 0.25), q(B, 0.75)], ratio: q(B, 0.5) / q(A, 0.5) };
  });
  const f = x => x.toFixed(x < 10 ? 2 : 1);
  console.log(`A = ${a}, B = ${b}, ${rounds} rounds, best of 3 passes per round (1 for fresh-index workloads), medians`);
  console.log('| Workload | A ms (p25–p75) | B ms (p25–p75) | B/A |');
  console.log('|---|--:|--:|--:|');
  for (const r of rows) console.log(`| ${r.name} | ${f(r.a)} (${f(r.aIqr[0])}–${f(r.aIqr[1])}) | ${f(r.b)} (${f(r.bIqr[0])}–${f(r.bIqr[1])}) | ${r.ratio.toFixed(3)} |`);
  const out = argument('--out');
  if (out) writeFileSync(resolve(root, out), JSON.stringify({ a, b, rounds, rows, samples }, null, 1) + '\n');
}
