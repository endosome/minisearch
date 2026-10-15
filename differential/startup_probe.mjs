// WP-15: startup and responsiveness of a package build, in a fresh process:
// module import, Wasm compile + instantiate, first 20k-document index, first
// query, and the longest gap between event-loop turns during addAllAsync.
//
//   node differential/startup_probe.mjs [pkg]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = resolve(root, process.argv[2] ?? 'pkg');
const { docs, queries } = JSON.parse(readFileSync(resolve(root, 'differential/bench_corpus.json'), 'utf8'));
let t = performance.now();
const facade = await import(pathToFileURL(resolve(pkg, 'minisearch_wasm.js')));
const importMs = performance.now() - t;
const bytes = readFileSync(resolve(pkg, 'minisearch_wasm_bg.wasm'));
t = performance.now();
const exports = facade.initSync({ module: new WebAssembly.Module(bytes) });
const instantiateMs = performance.now() - t;
const MiniSearch = facade.default;
const options = { fields: ['title', 'text'], autoVacuum: false, searchOptions: { prefix: true, fuzzy: 0.2 } };
t = performance.now();
const index = new MiniSearch(options);
index.addAll(docs);
const firstIndexMs = performance.now() - t;
t = performance.now();
index.search(queries[0]);
const firstQueryMs = performance.now() - t;
const wasmMiB = exports.memory.buffer.byteLength / 2 ** 20;
// The longest stretch without an event-loop turn while addAllAsync runs.
const asyncIndex = new MiniSearch(options);
let last = performance.now(), longest = 0, ticking = true;
const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (ticking) setImmediate(tick); };
setImmediate(tick);
t = performance.now();
await asyncIndex.addAllAsync(docs);
const asyncMs = performance.now() - t;
ticking = false;
console.log(JSON.stringify({ wasmBytes: bytes.length, importMs: +importMs.toFixed(1), instantiateMs: +instantiateMs.toFixed(1), firstIndexMs: +firstIndexMs.toFixed(0),
  firstQueryMs: +firstQueryMs.toFixed(1), wasmMiBAfterIndex: +wasmMiB.toFixed(1), addAllAsyncMs: +asyncMs.toFixed(0), longestStallMs: +longest.toFixed(1) }));
