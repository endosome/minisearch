// The opt-in methods searchTopK, searchScores and countMatches against their
// definitions in terms of MiniSearch's search(): the first `limit` rows, the
// (id, score) pairs in order, the number of rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Original from 'minisearch';
import MiniSearch from '../pkg/minisearch_wasm_node.js';

const words = ['apple', 'apricot', 'banana', 'berry', 'cherry', 'citrus', 'date', 'elder', 'fig', 'grape', 'guava', 'kiwi'];
let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const text = n => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ');
const docs = Array.from({ length: 300 }, (_, i) => ({ id: i, title: text(2 + (i % 3)), text: text(6 + (i % 7)), category: i % 4 }));
// Identical documents: equal scores, whose order is traversal order.
for (let i = 300; i < 340; i++) docs.push({ id: i, title: 'apple fig', text: 'cherry date', category: i % 4 });

const queries = [
  ['apple', {}],
  ['ap', { prefix: true }],
  ['aple bery', { fuzzy: 0.3, combineWith: 'OR' }],
  ['apple cherry', { combineWith: 'AND' }],
  ['apple cherry', { combineWith: 'AND_NOT' }],
  ['fig', { fields: ['title'] }],
  ['fig date', { boost: { title: 2 }, combineWith: 'OR' }],
  ['cherry', { filter: row => row.id % 3 !== 0 }],
  ['cherry', { boostDocument: id => 1 + (id % 5) }],
  ['grape', { includeMatch: false }],
  [{ queries: ['apple', { queries: ['kiwi', 'guava'], combineWith: 'OR' }], combineWith: 'AND' }, {}],
  ['nothingmatches', {}],
  ['wildcard', {}],
];
const limits = [0, 1, 3, 10, 1000];

// MiniSearch always returns match; includeMatch is this package's option.
const expected = (index, query, options) => {
  const rows = index.search(query === 'wildcard' ? Original.wildcard : query, options);
  if (options.includeMatch === false) for (const row of rows) delete row.match;
  return rows;
};

// One MiniSearch search() per call: on an index with discarded documents
// each search cleans up what it reaches, which later scores reflect.
function check(label, setup) {
  const index = setup(MiniSearch), original = setup(Original);
  for (const [query, options] of queries) {
    const q = query === 'wildcard' ? MiniSearch.wildcard : query;
    const rows = () => expected(original, query, options);
    const name = `${label}: ${JSON.stringify(query)} ${JSON.stringify(Object.keys(options))}`;
    for (const limit of limits) {
      assert.deepEqual(index.searchTopK(q, { ...options, limit }), rows().slice(0, limit), `${name} limit ${limit}`);
    }
    assert.deepEqual(index.searchScores(q, options), rows().map(row => ({ id: row.id, score: row.score })), `${name} scores`);
    assert.equal(index.countMatches(q, options), rows().length, `${name} count`);
  }
  return index;
}

const options = { fields: ['title', 'text'], autoVacuum: false };

await test('clean index, no stored fields', () => {
  const index = check('clean', C => { const ix = new C(options); ix.addAll(docs); return ix; });
  assert.equal(index.executionMode, 'wasm');
});

await test('stored fields, including fields named like result properties', () => {
  for (const storeFields of [['title'], ['score'], ['id'], ['category', 'score', 'id']]) {
    check(`storeFields ${storeFields}`, C => {
      const ix = new C({ ...options, storeFields });
      // A stored score and id that differ from the result's own.
      ix.addAll(docs.map(d => ({ ...d, score: (d.id * 7) % 11, id: d.id })));
      return ix;
    });
  }
});

await test('dirty index (discarded documents, exact reruns)', () => {
  check('dirty', C => {
    const ix = new C(options);
    ix.addAll(docs);
    for (const d of docs) if (d.id % 5 === 0) ix.discard(d.id);
    return ix;
  });
});

await test('a live stored object handed out and given a score', () => {
  const run = C => {
    const ix = new C({ ...options, storeFields: ['title'] });
    ix.addAll(docs);
    Object.defineProperty(ix.getStoredFields(301), 'score', { enumerable: true, value: 1e9 });
    return ix;
  };
  check('exposed', run);
});

await test('an index promoted to the JavaScript engine', () => {
  // A query node with its own boostDocument moves the index to JavaScript.
  const index = check('promoted', C => {
    const ix = new C(options);
    ix.addAll(docs);
    ix.search({ queries: ['apple'], boostDocument: () => 1 });
    return ix;
  });
  assert.equal(index.executionMode, 'javascript');
});

await test('limit validation', () => {
  const index = new MiniSearch(options);
  index.addAll(docs);
  for (const limit of [undefined, -1, 1.5, '3', NaN]) {
    assert.throws(() => index.searchTopK('apple', { limit }), TypeError, String(limit));
  }
  assert.throws(() => index.searchTopK('apple'), TypeError);
});
