// Callback trace parity: which JavaScript callbacks and getters run, how
// often, with what arguments and in what order, for every public search API,
// on clean and dirty indexes, with stored fields that shadow result
// properties (static, live getters, mutated between calls) and callbacks
// that mutate rows or throw.
//
// Each scenario's trace and outputs are checked two ways:
// - against MiniSearch, for the calls it has (search, autoSuggest, indexing);
// - against differential/fixtures/callback-traces.json, recorded from the
//   baseline, for every call, including searchRaw/searchJoined that MiniSearch
//   does not have. A change to how often or in what order a callback runs, or
//   to any output, fails here.
//
//   node differential/callback_traces.mjs            # check
//   node differential/callback_traces.mjs --update   # rewrite the fixture
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import Original from 'minisearch';
import MiniSearch from '../pkg/minisearch_wasm_node.js';

const fixturePath = new URL('./fixtures/callback-traces.json', import.meta.url);
const update = process.argv.includes('--update');

const docs = [
  { id: 1, title: 'apple pie', text: 'baked apples and pears', score: 5 },
  { id: 2, title: 'apricot jam', text: 'sweet apricot', score: 1 },
  { id: 3, title: 'banana bread', text: 'apple banana loaf', score: 3 },
  { id: 4, title: 'pear tart', text: 'pears apples apricots', score: 3 },
  { id: 5, title: 'cherry', text: 'no fruit named here', score: 9 },
  { id: 6, title: 'apple apple', text: 'apple', score: Number.NaN },
];

// Values that survive JSON and keep NaN, infinities and -0 apart.
function plain(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '§NaN';
    if (value === Infinity) return '§Infinity';
    if (value === -Infinity) return '§-Infinity';
    if (Object.is(value, -0)) return '§-0';
    return value;
  }
  if (typeof value === 'bigint') return `§${value}n`;
  if (typeof value === 'symbol') return `§${String(value)}`;
  if (typeof value === 'function') return '§function';
  if (ArrayBuffer.isView(value)) return Array.from(value, plain);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plain(value[key]);
    return out;
  }
  return value === undefined ? '§undefined' : value;
}

// A scenario builds an index with logging callbacks and runs calls on it.
// `log` collects every callback/getter invocation; each call's output (or
// thrown message) goes in `outputs`.
function scenario(C, { config = () => ({}), stored, dirty = false, getters = false, calls }) {
  const log = [];
  const options = { fields: ['title', 'text'], autoVacuum: false, ...config(log) };
  if (stored) options.storeFields = stored;
  const index = new C(options);
  index.addAll(docs);
  if (dirty) { index.discard(2); index.discard(5); }
  if (getters) {
    // Live stored objects (toJSON hands them out, as MiniSearch does): a
    // `score` getter that logs and changes value on every read.
    const live = index.toJSON().storedFields;
    for (const [shortId, fields] of Object.entries(live)) {
      let reads = 0;
      const base = fields.score;
      Object.defineProperty(fields, 'score', { enumerable: true, configurable: true,
        get() { reads++; log.push(['get score', shortId, reads]); return typeof base === 'number' ? base + reads / 8 : base; } });
    }
  }
  const outputs = [];
  for (const [name, run] of calls) {
    log.push(['call', name]);
    try { outputs.push([name, plain(run(index, C, log))]); } catch (error) { outputs.push([name, `throws: ${error.message}`]); }
  }
  const mode = index.executionMode;
  index.free?.();
  return { log: plain(log), outputs, mode };
}

const searchCalls = (queries, options) => queries.map(q => [`search ${JSON.stringify(q)}`,
  (index, C) => index.search(q === 'WILDCARD' ? C.wildcard : q, options)]);
const STRING_QUERIES = ['apple', 'ap', 'apple pear', 'aple'];
const TREE = { combineWith: 'OR', queries: ['apple', { combineWith: 'AND', queries: ['pear', 'tart'] }] };
const compactCalls = query => [
  [`searchJoined ${query}`, index => index.searchJoined(query)],
  [`searchJoined OR ${query}`, index => index.searchJoined(query, true)],
  [`searchJoinedOpts ${query}`, index => index.searchJoinedOpts(query, { prefix: true })],
  [`searchRaw ${query}`, index => { const raw = index.searchRaw(query); delete raw.idTableVersion; return raw; }],
  [`autoSuggestJoined ${query}`, index => index.autoSuggestJoined(query)],
];

const logging = (log, name, result) => (...args) => { log.push([name, ...args.map(arg => Array.isArray(arg) ? [...arg] : arg)]); return result(...args); };

const scenarios = {
  // Shadowing stored fields: WP-01's case.
  'stored score, static': { stored: ['title', 'score'], calls: [...searchCalls(STRING_QUERIES, { prefix: true, fuzzy: 0.2 }), ...compactCalls('apple')] },
  'stored score, live getter': { stored: ['score'], getters: true,
    // includeMatch is this package's option (MiniSearch always returns
    // match): that call is checked against the fixture only.
    calls: [...searchCalls(['apple', 'apple'], { prefix: true }), ...compactCalls('ap'),
      ['includeMatch:false search "apple"', index => index.search('apple', { includeMatch: false })]] },
  'stored score, mutated between calls': { stored: ['score'],
    calls: [...searchCalls(['apple']), ['mutate', index => { index.toJSON().storedFields[0].score = -1; return null; }], ...searchCalls(['apple']), ...compactCalls('apple')] },
  'stored id/terms/match shadow': { stored: ['title', 'terms', 'match'], config: () => ({ idField: 'id' }),
    calls: [...searchCalls(['apple', 'ap'], { prefix: true }), ...compactCalls('apple')] },
  'stored score, dirty index': { stored: ['score'], dirty: true, calls: [...searchCalls(['apple', 'apple', 'ap'], { prefix: true }), ...compactCalls('apple')] },
  // Search callbacks.
  'filter mutating scores': { stored: ['score'], calls: [
    ...[['apple', 'apple'], ['tree', TREE], ['wildcard', 'WILDCARD']].map(([label, q]) => [`search ${label} filter`, (index, C, log) =>
      index.search(q === 'WILDCARD' ? C.wildcard : q, { filter: logging(log, 'filter', row => { row.score = row.id % 3; return row.id !== 4; }) })]),
    ['searchJoinedOpts filter', (index, C, log) => index.searchJoinedOpts('apple', { filter: logging(log, 'filter', row => row.id !== 1) })],
    ['searchRaw filter', (index, C, log) => { const raw = index.searchRaw('apple', { filter: logging(log, 'filter', row => row.id !== 1) }); delete raw.idTableVersion; return raw; }],
  ] },
  'boostDocument and boostTerm': { stored: ['title'], calls: [
    ['search boostDocument', (index, C, log) => index.search('apple ap', { prefix: true, boostDocument: logging(log, 'boostDocument', (id, term) => id === 3 ? 0 : 1 + id / 10) })],
    ['search boostTerm', (index, C, log) => index.search('apple pear', { boostTerm: logging(log, 'boostTerm', (term, i) => i + 1) })],
    ['search wildcard boostDocument', (index, C, log) => index.search(C.wildcard, { boostDocument: logging(log, 'boostDocument', id => id % 2 ? 2 : 1) })],
    ['autoSuggest boostDocument', (index, C, log) => index.autoSuggest('ap', { boostDocument: logging(log, 'boostDocument', () => 1) })],
  ] },
  'prefix/fuzzy callbacks': { calls: [
    ['search prefix fn', (index, C, log) => index.search('ap pea', { prefix: logging(log, 'prefix', (term, i) => i === 0), fuzzy: logging(log, 'fuzzy', term => term.length > 3 ? 1 : false) })],
    ['searchJoinedOpts fn', (index, C, log) => index.searchJoinedOpts('ap pea', { prefix: logging(log, 'prefix', () => true) })],
  ] },
  'throwing callbacks': { stored: ['score'], calls: [
    ['filter throws', (index, C, log) => { let n = 0; return index.search('apple', { filter: logging(log, 'filter', () => { if (++n === 2) throw new Error('filter stop'); return true; }) }); }],
    ['boostDocument throws', (index, C, log) => { let n = 0; return index.search('apple', { boostDocument: logging(log, 'boostDocument', () => { if (++n === 2) throw new Error('boost stop'); return 1; }) }); }],
    ['after throws', index => index.search('apple')],
  ] },
  // Query and index callbacks.
  'tokenize/processTerm': { stored: ['score'],
    config: log => ({ tokenize: logging(log, 'tokenize', text => text.split(' ')), processTerm: logging(log, 'processTerm', term => term === 'and' ? null : term.toLowerCase()),
      searchOptions: { processTerm: logging(log, 'searchProcessTerm', term => term.toLowerCase()) } }),
    calls: [...searchCalls(['Apple AND pear'], { prefix: true }), ...compactCalls('apple'),
      ['add', index => { index.add({ id: 7, title: 'Apple Kiwi', text: 'kiwi and apple', score: 2 }); return index.documentCount; }],
      ['remove', index => { index.remove({ id: 7, title: 'Apple Kiwi', text: 'kiwi and apple', score: 2 }); return index.documentCount; }]] },
  'autoSuggest': { stored: ['score'], calls: [
    ['autoSuggest ap', index => index.autoSuggest('ap')], ['autoSuggest fuzzy', index => index.autoSuggest('aple pe', { fuzzy: 0.3 })]] },
};

// Calls MiniSearch has, for the cross-check.
const upstreamCall = name => /^(search |search\b|autoSuggest |autoSuggest\b|add|remove|mutate|after|filter throws|boostDocument throws)/.test(name) && !/^searchJoined|^searchRaw|^autoSuggestJoined/.test(name);

// Divergences from MiniSearch present at the baseline, each with why. The
// check asserts they still differ, so a fix shows up here: remove the entry.
const KNOWN_DIVERGENCES = new Map([
  // None. At the baseline: a stored score getter read twice per row by
  // search(), and the native autoSuggest ignoring a stored score; both
  // fixed in WP-01.
]);

const results = {}, divergences = [];
let compared = 0;
for (const [name, spec] of Object.entries(scenarios)) {
  const actual = scenario(MiniSearch, spec);
  results[name] = actual;
  // MiniSearch runs the scenario's calls it has, in the same sequence.
  const upstreamSpec = { ...spec, calls: spec.calls.filter(([call]) => upstreamCall(call)) };
  const mine = upstreamSpec.calls.length === spec.calls.length ? actual : scenario(MiniSearch, upstreamSpec);
  const expected = scenario(Original, upstreamSpec);
  const differs = [];
  try { assert.deepEqual(mine.outputs, expected.outputs); } catch { differs.push('outputs'); }
  try { assert.deepEqual(mine.log, expected.log); } catch { differs.push('trace'); }
  compared++;
  if (KNOWN_DIVERGENCES.has(name)) {
    assert.ok(differs.length, `${name}: now matches MiniSearch; remove it from KNOWN_DIVERGENCES`);
  } else if (differs.length) divergences.push(`${name}: ${differs.join(' and ')} differ from MiniSearch`);
}
assert.deepEqual(divergences, [], 'unexpected divergences from MiniSearch');

if (update || !existsSync(fixturePath)) {
  mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(results, null, 1) + '\n');
  console.log(`CALLBACK TRACES: wrote ${Object.keys(results).length} scenarios to the fixture`);
} else {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.deepEqual(Object.keys(results), Object.keys(fixture), 'scenario list changed: run with --update after review');
  for (const name of Object.keys(fixture)) {
    assert.deepEqual(results[name].outputs, fixture[name].outputs, `${name}: outputs differ from the recorded baseline`);
    assert.deepEqual(results[name].log, fixture[name].log, `${name}: callback trace differs from the recorded baseline`);
    assert.equal(results[name].mode, fixture[name].mode, `${name}: execution mode differs from the recorded baseline`);
  }
  console.log(`CALLBACK TRACES: ${Object.keys(fixture).length} scenarios match the baseline; ${compared} cross-checked against MiniSearch`);
}
