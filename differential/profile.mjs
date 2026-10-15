// Profiling runner: runs named workloads against a package under the facade
// instrumentation (differential/instrument.mjs) and writes per workload and
// public API what each call cost: native executions and why they repeated,
// boundary calls and bytes, JavaScript callbacks, execution modes and
// promotions, facade internals and, with a `stats` build, the engine's
// counters, phase times and memory.
//
//   npm run build:stats && node --expose-gc differential/profile.mjs \
//     [--pkg target/pkg-stats] [--corpus differential/bench_corpus.json] \
//     [--out differential/results/profile.json] [--md <summary.md>] [--only name,name]
//
// With --pkg pkg it profiles the release build: the same facade figures,
// without the engine's. Its timings include the instrumentation's own cost;
// differential/bench_public.mjs is where release timings come from.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { instrument } from './instrument.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argument = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const pkgDir = resolve(root, argument('--pkg', 'target/pkg-stats'));
const corpusPath = resolve(root, argument('--corpus', 'differential/bench_corpus.json'));
const outPath = resolve(root, argument('--out', 'differential/results/profile.json'));
const mdPath = argument('--md') && resolve(root, argument('--md'));
const only = argument('--only')?.split(',');
assert.equal(typeof global.gc, 'function', 'Run Node with --expose-gc');
assert.ok(existsSync(resolve(pkgDir, 'minisearch_wasm_bg.wasm')), `no package in ${pkgDir}; run npm run build:stats`);
if (!existsSync(corpusPath)) execFileSync(process.execPath, [resolve(root, 'differential/gen_corpus.mjs'), corpusPath, '20000'], { stdio: 'inherit' });

const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Startup: module import, then compiling and instantiating the Wasm module.
let start = performance.now();
const facadeModule = await import(pathToFileURL(resolve(pkgDir, 'minisearch_wasm.js')));
const coreModule = await import(pathToFileURL(resolve(pkgDir, 'minisearch_wasm_core.js')));
const importMs = performance.now() - start;
const wasmBytes = readFileSync(resolve(pkgDir, 'minisearch_wasm_bg.wasm'));
start = performance.now();
const exports = facadeModule.initSync({ module: wasmBytes });
const instantiateMs = performance.now() - start;
const MiniSearch = facadeModule.default, Facade = facadeModule.MiniSearchWasm, Core = coreModule.MiniSearchWasm;
const recorder = instrument({ Facade, Core, memory: exports.memory });
const statsBuild = recorder.engineStats !== null;

const corpusBytes = readFileSync(corpusPath);
const { docs, queries } = JSON.parse(corpusBytes);
const options = { fields: ['title', 'text'], autoVacuum: false, searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND' } };
const build = (settings = options, documents = docs) => { const index = new MiniSearch(settings); index.addAll(documents); return index; };
const discarded = docs.filter((_, i) => i % 4 === 0).map(doc => doc.id);
const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'for']);

// A workload: `setup` outside the recording, `run` inside it. Each returns
// a note for the report where useful.
const workloads = [
  { name: 'search: default (AND, prefix, fuzzy 0.2)', setup: () => build(), run: index => { for (const q of queries) index.search(q); } },
  { name: 'search: exact terms', setup: () => build(), run: index => { for (const q of queries) index.search(q, { prefix: false, fuzzy: false }); } },
  { name: 'search: OR', setup: () => build(), run: index => { for (const q of queries) index.search(q, { combineWith: 'OR' }); } },
  { name: 'search: includeMatch false', setup: () => build(), run: index => { for (const q of queries) index.search(q, { includeMatch: false }); } },
  { name: 'search: filter callback', setup: () => build(), run: index => { for (const q of queries) index.search(q, { filter: r => r.id % 2 === 0 }); } },
  { name: 'search: boostDocument', setup: () => build(), run: index => { for (const q of queries) index.search(q, { boostDocument: id => 1 + (id % 5) / 10 }); } },
  { name: 'search: wildcard', setup: () => build(), run: index => { index.search(MiniSearch.wildcard); } },
  { name: 'searchJoined', setup: () => build(), run: index => { for (const q of queries) index.searchJoined(q); } },
  { name: 'searchJoinedOpts: exact', setup: () => build(), run: index => { for (const q of queries) index.searchJoinedOpts(q, { prefix: false, fuzzy: false }); } },
  { name: 'searchRaw', setup: () => build(), run: index => { for (const q of queries) index.searchRaw(q); } },
  { name: 'autoSuggest', setup: () => build(), run: index => { for (const q of queries) index.autoSuggest(q); } },
  { name: 'autoSuggestJoined', setup: () => build(), run: index => { for (const q of queries) index.autoSuggestJoined(q); } },
  { name: 'stored fields: title (no shadow)', setup: () => build({ ...options, storeFields: ['title'] }),
    run: index => { for (const q of queries) { index.search(q); index.searchJoined(q); index.searchRaw(q); } } },
  // WP-01's case: a stored field named like a result property.
  { name: 'stored fields: score (shadows result score)',
    setup: () => build({ ...options, storeFields: ['score'] }, docs.map(doc => ({ ...doc, score: doc.id % 7 }))),
    run: index => { for (const q of queries) { index.search(q); index.searchJoined(q); index.searchRaw(q); } } },
  { name: 'processTerm callback (stop words)', setup: () => null,
    run: () => { const index = build({ ...options, processTerm: t => stopWords.has(t.toLowerCase()) ? null : t.toLowerCase() }); for (const q of queries) index.search(q); } },
  // A dirty index: the first pass meets stale postings and reruns exactly;
  // the second finds the lists already cleaned.
  { name: 'dirty index: first pass', setup: () => { const index = build(); index.discardAll(discarded); return index; },
    run: index => { for (const q of queries) index.search(q); } },
  { name: 'dirty index: second pass', setup: () => { const index = build(); index.discardAll(discarded); for (const q of queries) index.search(q); return index; },
    run: index => { for (const q of queries) index.search(q); } },
  // A query node with its own boostDocument promotes to the JavaScript
  // engine; the searches after it run there.
  { name: 'promotion: node boostDocument, then searches', setup: () => build(),
    run: index => { index.search({ queries: [queries[0]], boostDocument: () => 1 }); for (const q of queries) index.search(q); } },
  { name: 'indexing: addAll', setup: () => null, run: () => { build(); } },
  { name: 'indexing: add one by one (2000)', setup: () => new MiniSearch(options), run: index => { for (const doc of docs.slice(0, 2000)) index.add(doc); } },
  { name: 'removal: remove (2000)', setup: () => build(), run: index => { for (const doc of docs.slice(0, 2000)) index.remove(doc); } },
  { name: 'removal: discard (2000) and vacuum', setup: () => build(),
    run: async index => { for (const doc of docs.slice(0, 2000)) index.discard(doc.id); await index.vacuum(); } },
  { name: 'loading: loadJSON', setup: () => JSON.stringify(build()), run: json => { MiniSearch.loadJSON(json, options); } },
  { name: 'saving: toJSON', setup: () => build(), run: index => { JSON.stringify(index); } },
];

const report = {
  createdAt: new Date().toISOString(),
  gitHead: git(['rev-parse', 'HEAD']), workingTree: git(['status', '--porcelain']) ? 'uncommitted changes' : 'clean',
  package: relative(root, pkgDir), statsBuild,
  wasmSha256: sha256(wasmBytes), wasmBytes: wasmBytes.length,
  environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    cpu: cpus()[0].model.trim(), logicalCPUs: cpus().length, ramGiB: +(totalmem() / 2 ** 30).toFixed(1),
    rustc: (() => { try { return execFileSync('rustc', ['--version'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })() },
  corpus: { path: relative(root, corpusPath), documents: docs.length, queries: queries.length, sha256: sha256(corpusBytes) },
  options,
  startup: { importMs, instantiateMs },
  workloads: [],
  churn: [],
};

// The first index and query of the process, before anything is warm.
{
  recorder.reset();
  let t = performance.now();
  const index = build();
  const firstIndexMs = performance.now() - t;
  t = performance.now();
  index.search(queries[0]);
  report.startup.firstIndexMs = firstIndexMs;
  report.startup.firstQueryMs = performance.now() - t;
  report.startup.memoryAfterFirstIndex = recorder.memory();
  index.free();
}

for (const workload of workloads) {
  if (only && !only.some(name => workload.name.includes(name))) continue;
  const state = await workload.setup();
  global.gc();
  recorder.reset();
  const before = recorder.memory();
  const t = performance.now();
  await workload.run(state);
  const wallMs = performance.now() - t;
  const result = { name: workload.name, wallMs, ...recorder.report(), memoryBefore: before, memoryAfter: recorder.memory() };
  report.workloads.push(result);
  state?.free?.();
  console.log(`${workload.name.padEnd(48)} ${wallMs.toFixed(1).padStart(9)} ms`);
}

// Memory through churn: rounds of adding, discarding and vacuuming 2000
// documents on a 20,000-document index.
if (!only) {
  const index = build();
  recorder.reset();
  let next = docs.length;
  for (let round = 0; round < 10; round++) {
    const batch = docs.slice(0, 2000).map(doc => ({ ...doc, id: next++ }));
    index.addAll(batch);
    for (const doc of batch) index.discard(doc.id);
    await index.vacuum();
    for (const q of queries.slice(0, 10)) index.search(q);
    global.gc();
    report.churn.push({ round, documentCount: index.documentCount, ...recorder.memory() });
  }
  index.free();
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`wrote ${relative(root, outPath)}`);
if (mdPath) {
  writeFileSync(mdPath, summary(report));
  console.log(`wrote ${relative(root, mdPath)}`);
}

function summary(r) {
  const ms = x => x === undefined ? '' : x.toFixed(x < 10 ? 2 : 1);
  const kib = x => x === undefined ? '' : (x / 1024).toFixed(0);
  const lines = [];
  lines.push(`Package \`${r.package}\` (${r.statsBuild ? 'stats build' : 'release build'}, Wasm ${r.wasmBytes} bytes), commit \`${r.gitHead.slice(0, 7)}\` (${r.workingTree}).`);
  lines.push(`${r.environment.cpu}, ${r.environment.logicalCPUs} logical CPUs, ${r.environment.ramGiB} GiB; Node ${r.environment.node}; ${r.environment.rustc}.`);
  lines.push(`Corpus \`${r.corpus.path}\`: ${r.corpus.documents} documents, ${r.corpus.queries} queries, sha256 \`${r.corpus.sha256.slice(0, 12)}\`.`, '');
  lines.push(`Startup: import ${ms(r.startup.importMs)} ms, compile and instantiate ${ms(r.startup.instantiateMs)} ms, first index ${ms(r.startup.firstIndexMs)} ms, first query ${ms(r.startup.firstQueryMs)} ms; Wasm memory ${kib(r.startup.memoryAfterFirstIndex.wasmBytes)} KiB after the first index.`, '');
  lines.push('### Public calls', '');
  lines.push('| Workload | API | Calls | Native executions per call | Repeats | Boundary calls | Transfer KiB | Callbacks | Mode at call | ms total | ms in engine | ms in JS |');
  lines.push('|---|---|--:|---|---|--:|--:|--:|---|--:|--:|--:|');
  for (const w of r.workloads) {
    for (const [name, a] of Object.entries(w.apis)) {
      const executions = Object.entries(a.nativeExecutions).map(([n, c]) => `${n}×${c}`).join(', ');
      const repeats = Object.entries(a.repeats).map(([why, c]) => `${c}: ${why}`).join('; ');
      const modes = Object.entries(a.modeAtCall).map(([m, c]) => `${m} ${c}`).join(', ');
      lines.push(`| ${w.name} | ${name} | ${a.calls} | ${executions} | ${repeats} | ${a.boundaryCalls} | ${kib(a.transferBytes)} | ${a.callbacks} | ${modes} | ${ms(a.totalMs)} | ${ms(a.coreMs)} | ${ms(a.jsMs)} |`);
    }
  }
  const promoted = r.workloads.flatMap(w => w.promotions.map(p => ({ workload: w.name, ...p })));
  if (promoted.length) {
    lines.push('', '### Promotions to the JavaScript engine', '', '| Workload | During | Asked by | Documents | ms |', '|---|---|---|--:|--:|');
    for (const p of promoted) lines.push(`| ${p.workload} | ${p.api} | ${p.reason} | ${p.documents ?? ''} | ${ms(p.ms)} |`);
  }
  if (r.statsBuild) {
    const keys = ['fusedQueries', 'rawTextQueries', 'dirtyRetries', 'trieEdges', 'myersTransitions', 'expansionsFound', 'expansionsUsed', 'postingsVisited', 'postingsLive', 'tombstones', 'termsInterned', 'docsTouched', 'hitsKept', 'rowsMaterialized'];
    lines.push('', '### Engine counters (stats build)', '', `| Workload | API | ${keys.join(' | ')} |`, `|---|---|${keys.map(() => '--:').join('|')}|`);
    for (const w of r.workloads) for (const [name, a] of Object.entries(w.apis)) {
      if (!a.engine || !a.engine.counters.fusedQueries && !a.engine.counters.rawTextQueries) continue;
      lines.push(`| ${w.name} | ${name} | ${keys.map(k => a.engine.counters[k] ?? 0).join(' | ')} |`);
    }
    const phases = ['plan', 'expand', 'accumulate', 'rank', 'transfer'];
    lines.push('', '### Engine phases, ms (stats build; accumulate includes expand)', '', `| Workload | API | ${phases.join(' | ')} | facade internals, ms |`, `|---|---|${phases.map(() => '--:').join('|')}|---|`);
    for (const w of r.workloads) for (const [name, a] of Object.entries(w.apis)) {
      if (!a.engine || !a.engine.counters.fusedQueries && !a.engine.counters.rawTextQueries) continue;
      const internals = Object.entries(a.internalsMs).map(([k, v]) => `${k} ${ms(v)}`).join(', ');
      lines.push(`| ${w.name} | ${name} | ${phases.map(p => ms(a.engine.phases[p]?.ms ?? 0)).join(' | ')} | ${internals} |`);
    }
  }
  lines.push('', '### Memory', '', '| Workload | Wasm KiB after | Rust live KiB after | Rust peak KiB | Scratch KiB | RSS MiB after |', '|---|--:|--:|--:|--:|--:|');
  for (const w of r.workloads) {
    const m = w.memoryAfter;
    lines.push(`| ${w.name} | ${kib(m.wasmBytes)} | ${kib(m.allocLiveBytes)} | ${kib(m.allocPeakBytes)} | ${kib(m.scratchRetainedBytes)} | ${(m.rss / 2 ** 20).toFixed(0)} |`);
  }
  if (r.churn.length) {
    lines.push('', '### Memory through churn (add, discard and vacuum 2000 documents per round)', '', '| Round | Documents | Wasm KiB | Rust live KiB | Scratch KiB | RSS MiB |', '|--:|--:|--:|--:|--:|--:|');
    for (const c of r.churn) lines.push(`| ${c.round} | ${c.documentCount} | ${kib(c.wasmBytes)} | ${kib(c.allocLiveBytes)} | ${kib(c.scratchRetainedBytes)} | ${(c.rss / 2 ** 20).toFixed(0)} |`);
  }
  return lines.join('\n') + '\n';
}
