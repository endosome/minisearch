// Facade-side instrumentation for profiling runs. It wraps, at runtime and
// only when asked to, the public methods of the facade, the methods and
// getters of the engine (the Wasm boundary) and a few facade internals, and
// records per public API call:
//
// - the native executions it caused (engine search calls) and, when there
//   was more than one, why: the call sequence names the known repeats
// - every boundary call, the bytes that crossed it and the callbacks the
//   engine made into JavaScript
// - the execution mode at the call, and promotions to the JavaScript engine
//   with their reason (the facade method that asked) and duration
// - with a `stats` build (scripts/build-stats.mjs), the engine's counters and
//   phase times for the call
//
// Nothing here ships: the package code is unchanged and a release build runs
// at full speed unless a profiling run wraps it. Timings taken while wrapped
// include the wrappers' own cost, so they are for attributing time, not for
// quoting; differential/bench_public.mjs measures the release build.
//
//   import { instrument } from './instrument.mjs';
//   const recorder = instrument({ Facade: MiniSearchWasm, Core, memory });
//   ... run a workload ...
//   recorder.report(); recorder.reset(); recorder.restore();

import { Buffer } from 'node:buffer';

// Engine methods that run a query; each call is one native execution.
const EXECUTIONS = new Set(['searchRows', 'searchJoined', 'searchJoinedOpts', 'searchRaw', 'autoSuggest',
  'autoSuggestJoined', 'search', 'searchUnsorted', 'searchCountDefault', 'searchCountOpts']);
// Facade internals timed inside a public call (inclusive, outermost only).
const INTERNALS = ['_plan', '_compactPlan', '_leafText', '_rows', '_results', '_identifiedRows', '_withIds',
  '_storedScore', '_flush', '_promote', '_adopt', '_compact'];
// Repeated executions the facade is known to make, by call sequence.
const REPEATS = new Map([
  ['searchRows:sorted>searchRows:unsorted', 'stored field shadows score: sorted rows discarded, rerun unsorted'],
  ['searchJoined>searchJoinedOpts>searchRows:unsorted', 'stored score in joined results: joined and compact rerun as rows'],
  ['searchJoinedOpts>searchRows:unsorted', 'stored score in compact results: rerun as rows'],
  ['searchRaw>searchRows:unsorted', 'stored score in raw results: rerun as rows'],
]);

const now = () => performance.now();
const utf8 = value => Buffer.byteLength(value, 'utf8');

// Bytes a value carries across the boundary: strings as UTF-8, typed arrays
// by length, plain objects and arrays one level deep (the engine's results).
function bytesOf(value, depth = 0) {
  if (typeof value === 'string') return utf8(value);
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value === null || typeof value !== 'object' || depth > 1) return 0;
  let total = 0;
  for (const key of Object.keys(value)) total += bytesOf(value[key], depth + 1);
  return total;
}

function caller(stack) {
  // The first frame in the package's facade above _promote, e.g. "at
  // MiniSearchWasm2.search (…/minisearch_wasm.js:…)"; bundlers may rename the
  // class, so only the method name is kept.
  for (const line of stack.split('\n').slice(1)) {
    if (!/minisearch_wasm(?:\.umd)?\.c?js/.test(line)) continue;
    const match = /at (?:[\w$]+\.)?([A-Za-z_$][\w$]*)(?: \[as [\w$]+\])? \(/.exec(line);
    if (match && match[1] !== '_promote') return match[1];
  }
  return 'unknown';
}

const add = (target, key, n = 1) => { target[key] = (target[key] ?? 0) + n; };
function addAll(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') add(target, key, value);
    else if (value && typeof value === 'object') addAll(target[key] ??= {}, value);
  }
}

export function instrument({ Facade, Core, memory }) {
  const restores = [];
  const engineStats = typeof Core.engineStats === 'function' ? Core.engineStats : null;
  const resetEngine = typeof Core.resetEngineStats === 'function' ? Core.resetEngineStats : null;
  let frame = null, depth = 0, apis = new Map(), promotions = [];

  const api = name => {
    let entry = apis.get(name);
    if (!entry) {
      entry = { calls: 0, totalMs: 0, coreMs: 0, nativeExecutions: {}, repeats: {}, sequences: {},
        boundaryCalls: 0, boundaryByMethod: {}, transferBytes: 0, callbacks: 0, modeAtCall: {}, modeAfter: {},
        nested: {}, internalsMs: {}, engine: null, errors: 0 };
      apis.set(name, entry);
    }
    return entry;
  };

  const patch = (target, key, wrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) return;
    const replaced = { ...descriptor };
    if (typeof descriptor.value === 'function') replaced.value = wrap(descriptor.value, key, 'method');
    else if (descriptor.get) replaced.get = wrap(descriptor.get, key, 'getter');
    else return;
    Object.defineProperty(target, key, replaced);
    restores.push(() => Object.defineProperty(target, key, descriptor));
  };

  const modeOf = self => { try { return self?.executionMode ?? 'n/a'; } catch { return 'freed'; } };

  // Public methods: the outermost call opens a frame; nested public calls
  // (searchJoined calling searchJoinedOpts) are noted in it.
  const wrapPublic = (fn, name) => function (...args) {
    if (frame) {
      add(frame.nested, name);
      return fn.apply(this, args);
    }
    const entry = api(name);
    const mode = typeof this === 'function' ? 'static' : modeOf(this);
    resetEngine?.();
    frame = { name, executions: [], boundaryCalls: 0, boundaryByMethod: {}, transferBytes: 0, callbacks: 0,
      coreMs: 0, nested: {}, internalsMs: {}, internalDepth: {} };
    const start = now();
    let failed = false, result;
    try {
      result = fn.apply(this, args);
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const elapsed = now() - start;
      const done = frame;
      frame = null;
      entry.calls++;
      entry.totalMs += elapsed;
      entry.coreMs += done.coreMs;
      if (failed) entry.errors++;
      add(entry.nativeExecutions, String(done.executions.length));
      if (done.executions.length > 0) add(entry.sequences, done.executions.join('>'));
      if (done.executions.length > 1) {
        const sequence = done.executions.join('>');
        add(entry.repeats, REPEATS.get(sequence) ?? `unclassified: ${sequence}`);
      }
      entry.boundaryCalls += done.boundaryCalls;
      addAll(entry.boundaryByMethod, done.boundaryByMethod);
      entry.transferBytes += done.transferBytes;
      entry.callbacks += done.callbacks;
      add(entry.modeAtCall, mode);
      add(entry.modeAfter, typeof this === 'function' ? modeOf(result) : modeOf(this));
      addAll(entry.nested, done.nested);
      addAll(entry.internalsMs, done.internalsMs);
      if (engineStats) {
        const stats = JSON.parse(engineStats());
        const delta = { counters: stats.counters, phases: stats.phases };
        if (stats.counters.dirtyRetries > 0) add(entry.repeats, 'dirty index: engine reran the query exactly', stats.counters.dirtyRetries);
        entry.engine ??= { counters: {}, phases: {} };
        addAll(entry.engine, delta);
      }
    }
  };

  // Engine methods and getters: every call crosses the boundary.
  const wrapCore = (fn, name, kind) => function (...args) {
    if (!frame) return fn.apply(this, args);
    frame.boundaryCalls++;
    add(frame.boundaryByMethod, kind === 'getter' ? `get ${name}` : name);
    if (EXECUTIONS.has(name)) frame.executions.push(name === 'searchRows' ? `searchRows:${args[2] ? 'sorted' : 'unsorted'}` : name);
    let bytes = 0;
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === 'function') {
        // A callback the engine calls back into JavaScript (boostDocument).
        const callback = args[i], owner = frame;
        args[i] = function (...inner) {
          owner.callbacks++;
          owner.transferBytes += bytesOf(inner[1]);
          return callback.apply(this, inner);
        };
      } else bytes += bytesOf(args[i]);
    }
    const start = now();
    const result = fn.apply(this, args);
    frame.coreMs += now() - start;
    frame.transferBytes += bytes + bytesOf(result);
    return result;
  };

  const wrapInternal = (fn, name) => function (...args) {
    if (!frame) return fn.apply(this, args);
    const owner = frame;
    const outer = !owner.internalDepth[name];
    owner.internalDepth[name] = (owner.internalDepth[name] ?? 0) + 1;
    const start = now();
    try {
      return fn.apply(this, args);
    } finally {
      owner.internalDepth[name]--;
      if (outer) add(owner.internalsMs, name, now() - start);
    }
  };

  for (const key of Object.getOwnPropertyNames(Core.prototype)) {
    if (key !== 'constructor') patch(Core.prototype, key, wrapCore);
  }
  for (const key of ['loadJSON', 'loadJSONAsync', 'loadNativeJSON', 'new']) patch(Core, key, wrapCore);

  for (const key of Object.getOwnPropertyNames(Facade.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(Facade.prototype, key);
    if (key === 'constructor' || key.startsWith('_') || typeof descriptor.value !== 'function') continue;
    patch(Facade.prototype, key, wrapPublic);
  }
  for (const key of Object.getOwnPropertyNames(Facade)) {
    const descriptor = Object.getOwnPropertyDescriptor(Facade, key);
    if (typeof descriptor.value === 'function' && /^load/.test(key)) patch(Facade, key, wrapPublic);
  }
  for (const key of INTERNALS) patch(Facade.prototype, key, wrapInternal);

  // Promotions, with the facade method that asked and how long it took.
  const promoteDescriptor = Object.getOwnPropertyDescriptor(Facade.prototype, '_promote');
  const wrappedPromote = promoteDescriptor.value;
  Object.defineProperty(Facade.prototype, '_promote', { ...promoteDescriptor, value: function (...args) {
    if (this._js) return wrappedPromote.apply(this, args);
    const reason = caller(new Error().stack), documents = this._wasm?.documentCount;
    const start = now();
    const result = wrappedPromote.apply(this, args);
    promotions.push({ api: frame?.name ?? 'outside a public call', reason, documents, ms: now() - start });
    return result;
  } });
  restores.push(() => Object.defineProperty(Facade.prototype, '_promote', promoteDescriptor));

  return {
    reset() { apis = new Map(); promotions = []; },
    restore() { for (const undo of restores.reverse()) undo(); restores.length = 0; },
    report() {
      // A copy: calls after this (a later workload's setup) must not change it.
      return structuredClone({ apis: Object.fromEntries([...apis].map(([name, entry]) => [name,
        { ...entry, jsMs: entry.totalMs - entry.coreMs }])), promotions });
    },
    // Memory figures at this moment: Wasm linear memory, the engine's
    // allocator and scratch (stats builds), and the process.
    memory() {
      const usage = process.memoryUsage(), stats = engineStats ? JSON.parse(engineStats()) : null;
      return {
        wasmBytes: memory?.buffer.byteLength, wasmPages: memory ? memory.buffer.byteLength / 65536 : undefined,
        allocLiveBytes: stats?.allocLiveBytes, allocPeakBytes: stats?.allocPeakBytes,
        scratchDocSlots: stats?.scratchDocSlots, scratchRetainedBytes: stats?.scratchRetainedBytes,
        rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers,
        maxRssKiB: process.resourceUsage().maxRSS,
      };
    },
    engineStats: engineStats ? () => JSON.parse(engineStats()) : null,
    resetEngineStats: resetEngine,
  };
}
