// WP-01 acceptance: how many times the engine scores a query per public
// call. One for every ordinary call, including indexes whose stored fields
// replace the result score; outputs and orders as MiniSearch's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Original from 'minisearch';
import MiniSearch from '../pkg/minisearch_wasm_node.js';
// The engine class the package's facade uses (the same module instance).
import { MiniSearchWasm as Core } from '../pkg/minisearch_wasm_core.js';

const EXECUTIONS = ['searchRows', 'searchJoined', 'searchJoinedOpts', 'searchRaw', 'autoSuggest', 'autoSuggestJoined'];
let executions = 0;
for (const name of EXECUTIONS) {
  const method = Core.prototype[name];
  Core.prototype[name] = function (...args) { executions++; return method.apply(this, args); };
}
const count = run => { executions = 0; const result = run(); return [executions, result]; };

const docs = [
  { id: 1, title: 'apple pie', text: 'baked apples and pears', score: 5 },
  { id: 2, title: 'apricot jam', text: 'sweet apricot', score: 1 },
  { id: 3, title: 'banana bread', text: 'apple banana loaf', score: 3 },
  { id: 4, title: 'pear tart', text: 'pears apples apricots' },
];
const options = { fields: ['title', 'text'], autoVacuum: false, searchOptions: { prefix: true } };
const rows = rows => rows.map(({ id, score, terms }) => ({ id, score, terms }));
const unjoin = joined => { const ids = JSON.parse(joined.ids); return ids.map((id, i) => ({ id, score: joined.scores[i] })); };

await test('one native execution per call, stored score or not', () => {
  for (const storeFields of [[], ['title'], ['score'], ['title', 'score']]) {
    for (const dirty of [false, true]) {
      const index = new MiniSearch({ ...options, storeFields }), original = new Original({ ...options, storeFields });
      index.addAll(docs); original.addAll(docs);
      if (dirty) { index.discard(2); original.discard(2); }
      const label = `storeFields ${JSON.stringify(storeFields)}, dirty=${dirty}`;
      for (const query of ['apple', 'ap', 'apple pear']) {
        const [searches, found] = count(() => index.search(query));
        assert.equal(searches, 1, `${label}: search(${query})`);
        assert.deepEqual(found, original.search(query), `${label}: search(${query}) rows`);
        assert.equal(count(() => index.search(query, { includeMatch: false }))[0], 1, `${label}: includeMatch false`);
        const expected = rows(original.search(query));
        const [joins, joined] = count(() => index.searchJoined(query));
        assert.equal(joins, 1, `${label}: searchJoined(${query})`);
        // The compact forms carry the result's own score, in search() order.
        assert.deepEqual(unjoin(joined).map(r => r.id), expected.map(r => r.id), `${label}: searchJoined order`);
        assert.equal(count(() => index.searchJoinedOpts(query, { fuzzy: 0.2 }))[0], 1, `${label}: searchJoinedOpts`);
        assert.equal(count(() => index.searchRaw(query))[0], 1, `${label}: searchRaw`);
        const [suggests, suggestions] = count(() => index.autoSuggest(query));
        assert.equal(suggests, 1, `${label}: autoSuggest`);
        assert.deepEqual(suggestions, original.autoSuggest(query), `${label}: autoSuggest rows`);
      }
      index.free();
    }
  }
});

await test('a score added to a live stored object: order as MiniSearch, getters read once', () => {
  for (const handOut of ['toJSON', 'getStoredFields']) {
    const index = new MiniSearch({ ...options, storeFields: ['title'] }), original = new Original({ ...options, storeFields: ['title'] });
    index.addAll(docs); original.addAll(docs);
    // Before any object is handed out, nothing is checked and nothing reruns.
    assert.equal(count(() => index.search('apple'))[0], 1);
    const reads = { wasm: 0, original: 0 };
    for (const [target, key] of [[index, 'wasm'], [original, 'original']]) {
      const fields = handOut === 'toJSON' ? target.toJSON().storedFields[2] : target.getStoredFields(3);
      Object.defineProperty(fields, 'score', { enumerable: true, get() { reads[key]++; return 100; } });
    }
    const [searches, found] = count(() => index.search('apple'));
    assert.deepEqual(found, original.search('apple'), handOut);
    assert.equal(reads.wasm, reads.original, `${handOut}: getter reads`);
    // The rows are built once; the engine is asked once more for the order.
    assert.equal(searches, 2, handOut);
    assert.deepEqual(rows(index.search('apple', { includeMatch: false })).map(r => r.id), rows(original.search('apple')).map(r => r.id));
    index.free();
  }
});

await test('a loaded snapshot whose stored objects carry a score', () => {
  const source = new Original({ ...options, storeFields: ['score'] });
  source.addAll(docs);
  // Loaded with storeFields that do not name it: the objects still have it.
  const loaded = MiniSearch.loadJSON(JSON.stringify(source), { ...options, storeFields: ['title'] });
  const original = Original.loadJSON(JSON.stringify(source), { ...options, storeFields: ['title'] });
  assert.equal(loaded.executionMode, 'wasm');
  const [searches, found] = count(() => loaded.search('apple'));
  assert.equal(searches, 1);
  assert.deepEqual(found, original.search('apple'));
  assert.deepEqual(loaded.autoSuggest('ap'), original.autoSuggest('ap'));
  loaded.free();
});
