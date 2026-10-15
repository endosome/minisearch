// Benchmark matrix: per-call latency (p50/p95) of the public search APIs
// across corpus size, field count, index state, query shape and result
// shape, plus memory per cell. The same cells run once per package, in a
// process of their own:
//
// - the release build (pkg/) gives the timings, uninstrumented;
// - the stats build (target/pkg-stats, npm run build:stats) gives the engine
//   counters per call and the Wasm/Rust memory figures.
//
//   node --expose-gc differential/profile_matrix.mjs [--sizes 10000,100000] [--fields 1,4,16,65]
//     [--out differential/results/matrix.json] [--md summary.md] [--quick]
//
// Internally it re-runs itself with --cell-runner <pkg> for each package.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const argument = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const quick = process.argv.includes('--quick');
const sizes = argument('--sizes', quick ? '10000' : '10000,100000,1000000').split(',').map(Number);
const fieldCounts = argument('--fields', quick ? '1,4' : '1,4,16,65').split(',').map(Number);

// --- Deterministic corpus -------------------------------------------------
// The vocabulary of differential/gen_corpus.mjs (roots × suffixes, Unicode
// roots included) plus a long tail of rare identifier-like terms, so that
// hit counts span from none to most of the corpus.
function corpus(documentCount, fields) {
  let seed = 0x2f6e2b1;
  const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x100000000; };
  const roots = ['engine', 'develop', 'manage', 'search', 'index', 'query', 'token', 'parse', 'cloud', 'data', 'python', 'java',
    'react', 'rust', 'wasm', 'kernel', 'net', 'work', 'soft', 'hard', 'ware', 'test', 'bench', 'mark', 'score', 'field', 'term',
    'match', 'fuzz', 'prefix', 'suggest', 'auto', 'complete', 'zürich', 'münchen', 'café', 'naïve', 'straße', 'москва', 'tokyo',
    'graph', 'node', 'edge', 'tree', 'radix', 'trie', 'hash', 'map', 'vector', 'stream', 'batch', 'shard', 'merge', 'split'];
  const suffixes = ['', '', '', 's', 'ing', 'ed', 'er', 'ers', 'ation', 'ment', 'ity', 'ify'];
  const vocab = [];
  for (const root of roots) for (const suffix of suffixes) vocab.push(root + suffix);
  const pick = list => list[Math.floor(rand() * list.length)];
  const words = count => {
    const out = [];
    for (let i = 0; i < count; i++) out.push(rand() < 0.02 ? `id${Math.floor(rand() * documentCount * 4).toString(36)}` : pick(vocab));
    return out.join(' ');
  };
  const names = Array.from({ length: fields }, (_, i) => i === 0 ? 'title' : i === 1 ? 'text' : `f${i}`);
  const docs = new Array(documentCount);
  for (let i = 0; i < documentCount; i++) {
    const doc = { id: i };
    // ~60 words per document, spread over the fields; the first is short.
    for (let f = 0; f < fields; f++) doc[names[f]] = words(f === 0 ? 3 + Math.floor(rand() * 5) : Math.max(2, Math.floor(55 / Math.max(1, fields - 1))));
    // A rare term: one document in 5000.
    if (i % 5000 === 7) doc.title += ' zyxrare';
    docs[i] = doc;
  }
  return { docs, names };
}

// Query shapes; `hits` is filled in by the runner from the first answer.
const QUERIES = [
  { shape: 'exact one term (common)', q: 'engine', o: { prefix: false, fuzzy: false } },
  { shape: 'exact one term (rare)', q: 'zyxrare', o: { prefix: false, fuzzy: false } },
  { shape: 'exact no hits', q: 'nonexistentterm', o: { prefix: false, fuzzy: false } },
  { shape: 'AND two terms', q: 'search index', o: { prefix: false, fuzzy: false, combineWith: 'AND' } },
  { shape: 'OR three terms', q: 'rust wasm engine', o: { prefix: false, fuzzy: false, combineWith: 'OR' } },
  { shape: 'AND_NOT', q: 'data cloud', o: { prefix: false, fuzzy: false, combineWith: 'AND_NOT' } },
  { shape: 'prefix short', q: 'en', o: { prefix: true, fuzzy: false } },
  { shape: 'prefix long', q: 'develo', o: { prefix: true, fuzzy: false } },
  { shape: 'fuzzy 0.2', q: 'managment', o: { prefix: false, fuzzy: 0.2 } },
  { shape: 'prefix + fuzzy, AND', q: 'serch inde', o: { prefix: true, fuzzy: 0.2, combineWith: 'AND' } },
  { shape: 'Unicode prefix + fuzzy', q: 'zuric münch', o: { prefix: true, fuzzy: 0.2, combineWith: 'OR' } },
  { shape: 'one field of many', q: 'engine', o: { prefix: true, fuzzy: false, fields: ['title'] } },
];
const RESULT_SHAPES = ['search', 'search includeMatch:false', 'searchRaw', 'searchJoinedOpts'];

if (process.argv.includes('--cell-runner')) {
  await runCells(resolve(root, argument('--cell-runner')), JSON.parse(argument('--plan')));
} else {
  await main();
}

async function main() {
  assert.equal(typeof global.gc, 'function', 'Run Node with --expose-gc');
  const outPath = resolve(root, argument('--out', 'differential/results/matrix.json'));
  const mdPath = argument('--md') && resolve(root, argument('--md'));
  const plan = [];
  for (const documents of sizes) {
    for (const fields of fieldCounts) {
      // 1M documents: four fields, clean only (memory and time).
      if (documents >= 1_000_000 && fields !== 4) continue;
      const states = documents >= 1_000_000 ? ['clean'] : ['clean', 'deleted 50%, vacuumed', 'discarded 90%, not vacuumed'];
      for (const state of states) plan.push({ documents, fields, state });
    }
  }
  const run = (pkg, label) => {
    const results = [];
    for (const cell of plan) {
      const out = execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=16384', fileURLToPath(import.meta.url),
        '--cell-runner', pkg, '--plan', JSON.stringify(cell)], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
      const result = JSON.parse(out.slice(out.lastIndexOf('\n§') + 2));
      results.push(result);
      console.log(`${label} ${cell.documents} docs × ${cell.fields} fields, ${cell.state}: build ${result.buildMs.toFixed(0)} ms`);
    }
    return results;
  };
  const release = run('pkg', 'release');
  const stats = run('target/pkg-stats', 'stats');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const report = {
    createdAt: new Date().toISOString(), gitHead: git(['rev-parse', 'HEAD']), workingTree: git(['status', '--porcelain']) ? 'uncommitted changes' : 'clean',
    environment: { node: process.version, cpu: cpus()[0].model.trim(), logicalCPUs: cpus().length, ramGiB: +(totalmem() / 2 ** 30).toFixed(1) },
    queries: QUERIES, resultShapes: RESULT_SHAPES,
    cells: release.map((r, i) => ({ ...r, stats: stats[i] })),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 1) + '\n');
  console.log(`wrote ${relative(root, outPath)}`);
  if (mdPath) { writeFileSync(mdPath, summary(report)); console.log(`wrote ${relative(root, mdPath)}`); }
}

async function runCells(pkgDir, cell) {
  const facade = await import(pathToFileURL(resolve(pkgDir, 'minisearch_wasm.js')));
  const core = await import(pathToFileURL(resolve(pkgDir, 'minisearch_wasm_core.js')));
  const exports = facade.initSync({ module: readFileSync(resolve(pkgDir, 'minisearch_wasm_bg.wasm')) });
  const MiniSearch = facade.default, Core = core.MiniSearchWasm;
  const engineStats = typeof Core.engineStats === 'function' ? () => JSON.parse(Core.engineStats()) : null;
  const { docs, names } = corpus(cell.documents, cell.fields);
  const options = { fields: names, autoVacuum: false };

  let t = performance.now();
  const index = new MiniSearch(options);
  index.addAll(docs);
  if (cell.state === 'deleted 50%, vacuumed') {
    // next_id stays twice the live count: the facade compacts after a
    // vacuum only once at least half the ids (+1024) are free.
    for (const doc of docs) if (doc.id % 2 === 0) index.discard(doc.id);
    await index.vacuum();
  } else if (cell.state === 'discarded 90%, not vacuumed') {
    // Tombstones in place and next_id ten times the live count; the first
    // query of each term cleans its lists (MiniSearch's lazy cleanup), so
    // the warm samples see them partly cleaned.
    for (const doc of docs) if (doc.id % 10 !== 0) index.discard(doc.id);
  }
  const buildMs = performance.now() - t;
  assert.equal(index.executionMode, 'wasm');

  const run = (shape, q) => {
    const o = q.o;
    switch (shape) {
      case 'search': return index.search(q.q, o).length;
      case 'search includeMatch:false': return index.search(q.q, { ...o, includeMatch: false }).length;
      case 'searchRaw': return index.searchRaw(q.q, o).count;
      case 'searchJoinedOpts': return index.searchJoinedOpts(q.q, o).count;
    }
  };
  const rows = [];
  const quantile = (values, p) => { const s = [...values].sort((a, b) => a - b); const at = (s.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at); return s[lo] + (s[hi] - s[lo]) * (at - lo); };
  for (const q of QUERIES) {
    if (q.o.fields && cell.fields < 2) continue;
    for (const shape of RESULT_SHAPES) {
      // The first call: for the first result shape, the query's first
      // execution in this process (expansion caches cold); then warm samples.
      Core.resetEngineStats?.();
      t = performance.now();
      const hits = run(shape, q);
      const firstMs = performance.now() - t;
      const counters = engineStats?.().counters;
      const samples = [];
      const budget = performance.now() + (cell.documents >= 1_000_000 ? 4000 : 1500);
      while (samples.length < 7 || (samples.length < 200 && performance.now() < budget)) {
        t = performance.now();
        run(shape, q);
        samples.push(performance.now() - t);
      }
      rows.push({ shape: q.shape, resultShape: shape, hits, firstMs, p50Ms: quantile(samples, 0.5), p95Ms: quantile(samples, 0.95), samples: samples.length, counters });
    }
  }
  global.gc();
  const usage = process.memoryUsage();
  const stats = engineStats?.();
  const result = { ...cell, buildMs, nextId: index._wasm?.nextId, dirtCount: index.dirtCount, documentCount: index.documentCount, termCount: index.termCount,
    memory: { wasmBytes: exports.memory.buffer.byteLength, allocLiveBytes: stats?.allocLiveBytes, allocPeakBytes: stats?.allocPeakBytes,
      scratchDocSlots: stats?.scratchDocSlots, scratchRetainedBytes: stats?.scratchRetainedBytes, rss: usage.rss, maxRssKiB: process.resourceUsage().maxRSS },
    rows };
  process.stdout.write(`\n§${JSON.stringify(result)}`);
}

function summary(report) {
  const f = x => x === undefined || x === null ? '' : x < 1 ? x.toFixed(3) : x < 10 ? x.toFixed(2) : x.toFixed(1);
  const mib = x => x === undefined ? '' : (x / 2 ** 20).toFixed(1);
  const lines = [`Release timings from \`pkg/\`, counters and memory from \`target/pkg-stats\`; commit \`${report.gitHead.slice(0, 7)}\` (${report.workingTree}); ${report.environment.cpu}, Node ${report.environment.node}.`, ''];
  lines.push('### Cells', '', '| Documents | Fields | State | next_id | Dirt after queries | Terms | Build ms | Wasm MiB | Rust live MiB | Scratch MiB | RSS MiB |', '|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const c of report.cells) {
    const m = c.stats.memory;
    lines.push(`| ${c.documents} | ${c.fields} | ${c.state} | ${c.nextId ?? ''} | ${c.dirtCount} | ${c.termCount} | ${c.buildMs.toFixed(0)} | ${mib(m.wasmBytes)} | ${mib(m.allocLiveBytes)} | ${mib(m.scratchRetainedBytes)} | ${mib(c.memory.rss)} |`);
  }
  for (const c of report.cells) {
    lines.push('', `### ${c.documents} documents × ${c.fields} fields, ${c.state}`, '');
    lines.push('| Query | Hits | search p50/p95 ms | includeMatch:false p50/p95 | searchRaw p50/p95 | searchJoinedOpts p50/p95 | first search ms | postings visited | expansions used | rows |', '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    const shapes = [...new Set(c.rows.map(r => r.shape))];
    for (const shape of shapes) {
      const by = Object.fromEntries(c.rows.filter(r => r.shape === shape).map(r => [r.resultShape, r]));
      const counters = c.stats.rows.find(r => r.shape === shape && r.resultShape === 'search')?.counters ?? {};
      const cell = r => r ? `${f(r.p50Ms)} / ${f(r.p95Ms)}` : '';
      lines.push(`| ${shape} | ${by.search?.hits ?? ''} | ${cell(by.search)} | ${cell(by['search includeMatch:false'])} | ${cell(by.searchRaw)} | ${cell(by.searchJoinedOpts)} | ${f(by.search?.firstMs)} | ${counters.postingsVisited ?? ''} | ${counters.expansionsUsed ?? ''} | ${counters.rowsMaterialized ?? ''} |`);
    }
  }
  return lines.join('\n') + '\n';
}
