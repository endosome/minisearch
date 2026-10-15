// Regressions from the review of every commit since 0.7. Test observable
// callback results and scheduling against MiniSearch, including native residency.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Original from 'minisearch';
import MiniSearch from '../pkg/minisearch_wasm_node.js';
import { readFileSync } from 'node:fs';
// The engine's own API, from the test build that has it (see scripts/build-core.mjs).
import { initSync as initCore, MiniSearchWasm as Core } from '../target/pkg-core/minisearch_wasm_core.js';
initCore({ module: readFileSync(new URL('../target/pkg-core/minisearch_wasm_bg.wasm', import.meta.url)) });

const options = { fields: ['text'], autoVacuum: false };
const documents = [{ id: 1, text: 'apple pear pear pear pear pear' }, { id: 2, text: 'apple' }];

await test('native filters observe traversal order and sort mutated scores afterwards', () => {
  for (const dirty of [false, true]) for (const kind of ['first', 'mutate', 'ties']) {
    for (const query of ['apple', { queries: ['apple', 'pear'], combineWith: 'OR' }, 'wildcard']) {
      const run = C => {
        const index = new C(options); index.addAll(documents);
        if (dirty) { index.add({ id: 3, text: 'apple' }); index.discard(3); }
        const seen = [];
        const rows = index.search(query === 'wildcard' ? C.wildcard : query, { filter: row => {
          assert.ok(row.match); seen.push(row.id);
          if (kind === 'first') return seen.length === 1;
          row.score = kind === 'ties' ? 1 : row.id === 1 ? 100 : 0;
          return true;
        } });
        if (C === MiniSearch) { assert.equal(index.executionMode, 'wasm'); index.free(); }
        return { seen, rows };
      };
      assert.deepEqual(run(MiniSearch), run(Original), `${kind}, dirty=${dirty}, query=${String(query)}`);
    }
  }
  // Constructor defaults and includeMatch:false must still give the callback
  // a full row, then omit the match data only from the returned results.
  const run = C => {
    let calls = 0;
    const index = new C({ ...options, searchOptions: { filter: row => {
      assert.ok(row.match); return ++calls === 1;
    } } });
    index.addAll(documents);
    const rows = index.search('apple', { includeMatch: false });
    if (C === Original) for (const row of rows) delete row.match;
    if (C === MiniSearch) { assert.equal(index.executionMode, 'wasm'); index.free(); }
    return rows;
  };
  assert.deepEqual(run(MiniSearch), run(Original));
});

await test('compact queries evaluate shadowed-field callbacks and dirty cleanup once', () => {
  for (const method of ['searchJoinedOpts', 'searchRaw']) {
    for (const shadow of ['score', 'terms', 'match']) for (const dirty of [false, true]) {
      const settings = { ...options, storeFields: [shadow] };
      const docs = documents.map(doc => ({ ...doc, [shadow]: shadow === 'score' ? doc.id * 10 : `stored-${doc.id}` }));
      const original = new Original(settings), index = new MiniSearch(settings);
      original.addAll(docs); index.addAll(docs);
      if (dirty) for (const target of [original, index]) { target.add({ id: 3, text: 'apple' }); target.discard(3); }
      let expectedCalls = 0, actualCalls = 0;
      const expected = original.search('apple', { filter: () => ++expectedCalls === 1 });
      const actual = index[method]('apple', { filter: () => ++actualCalls === 1 });
      const table = JSON.parse(index.docIdTable());
      const ids = method === 'searchRaw' ? Array.from(actual.docIds, id => table[id]) : JSON.parse(actual.ids);
      assert.deepEqual(ids, expected.map(row => row.id));
      assert.equal(actualCalls, expectedCalls);
      assert.deepEqual(index.search('apple'), original.search('apple'), 'same lazy-cleanup state after one query');
      index.free();
    }
    // A native filter or boostDocument also must not cause speculative
    // per-term evaluation.
    const index = new MiniSearch(options); index.addAll(documents);
    for (const rowCallback of [{ filter: () => true }, { boostDocument: () => 1 }]) {
      let calls = 0;
      const actual = index[method]('apple', { prefix: () => { calls++; return true; }, ...rowCallback });
      assert.equal(actual.count, 2); assert.equal(calls, 1, Object.keys(rowCallback)[0]);
    }
    assert.equal(index.executionMode, 'wasm'); index.free();
  }
});

await test('async indexing preserves original microtask and timer scheduling', async () => {
  for (const count of [0, 1, 9, 10, 11, 21]) for (const chunkSize of [undefined, 3]) {
    const run = async C => {
      const reads = [];
      const index = new C({ ...options, extractField: (doc, field) => { reads.push([doc.id, field]); return doc[field]; } });
      const docs = Array.from({ length: count }, (_, id) => ({ id, text: 'apple' }));
      const promise = index.addAllAsync(docs, chunkSize === undefined ? undefined : { chunkSize });
      const snapshots = [[index.documentCount, reads.length]];
      for (let i = 0; i < 4; i++) { await Promise.resolve(); snapshots.push([index.documentCount, reads.length]); }
      await new Promise(resolve => setTimeout(resolve, 0));
      snapshots.push([index.documentCount, reads.length]);
      await promise;
      const rows = index.search('apple');
      if (C === MiniSearch) { assert.equal(index.executionMode, 'wasm'); index.free(); }
      return { snapshots, reads, rows };
    };
    assert.deepEqual(await run(MiniSearch), await run(Original), `count=${count}, chunkSize=${chunkSize}`);
  }
});

await test('async JSON reconstruction yields repeatedly and remains native', async () => {
  for (const vocabulary of ['common', 'distinct', 'stale-common']) for (const version of [1, 2]) {
    const settings = { ...options, storeFields: ['category'] };
    const source = new Original(settings);
    source.addAll(Array.from({ length: 3500 }, (_, id) => ({ id, text: vocabulary === 'distinct' ? `apple term${id}` : 'apple', category: id % 2 })));
    // Only two live documents and one term: timer yields must happen within
    // its stale posting list, not just while rebuilding document maps.
    source.discardAll(vocabulary === 'stale-common' ? Array.from({ length: 3498 }, (_, id) => id + 2) : [2, 900, 2400]);
    const serialized = source.toJSON();
    if (version === 1) {
      serialized.serializationVersion = 1;
      for (const [, data] of serialized.index) for (const field of Object.keys(data)) data[field] = { ds: data[field] };
    }
    const json = JSON.stringify(serialized);
    let ticks = 0;
    const interval = setInterval(() => ticks++, 0);
    let index;
    try { index = await MiniSearch.loadJSONAsync(json, settings); } finally { clearInterval(interval); }
    assert.ok(ticks >= 3, `${vocabulary}, version ${version}: ${ticks} timer ticks`);
    assert.equal(index.executionMode, 'wasm');
    const original = await Original.loadJSONAsync(json, settings);
    for (const query of ['apple', 'term', 'missing']) {
      assert.deepEqual(index.search(query, { prefix: true }), original.search(query, { prefix: true }));
    }
    assert.deepEqual([index.documentCount, index.dirtCount], [original.documentCount, original.dirtCount]);
    index.free();
  }
  // Malformed input still rejects; errors after several batches never expose
  // a partial index or damage another instance in the same Wasm module.
  await assert.rejects(MiniSearch.loadJSONAsync('{', options), SyntaxError);
  await assert.rejects(MiniSearch.loadJSONAsync('{"serializationVersion":99}', options), /incompatible version/);
  const source = new Original(options);
  source.addAll(Array.from({ length: 3500 }, (_, id) => ({ id, text: 'apple' })));
  const bad = source.toJSON(); bad.index[0][1][0][0] = 0;
  await assert.rejects(Core.loadJSONAsync(JSON.stringify(bad), options), /invalid term frequency/);
  const good = await Core.loadJSONAsync(JSON.stringify(source), options);
  assert.equal(good.search('apple').length, 3500); good.free();
  // Ids are read with JSON.parse, as upstream: an object id stays native.
  const objectIndex = new Original(options); objectIndex.add({ id: { key: 1 }, text: 'apple' });
  const loaded = await MiniSearch.loadJSONAsync(JSON.stringify(objectIndex), options);
  assert.equal(loaded.executionMode, 'wasm');
  assert.deepEqual(loaded.search('apple'), objectIndex.search('apple'));
  const [{ id }] = loaded.search('apple');
  assert.equal(loaded.search('apple')[0].id, id); assert.equal(loaded.has(id), true); loaded.free();
});

await test('more than 64 fields: the fused path, with and without match, rows unchanged', () => {
  // Field ids past 63 (and past 127) carry matches: field sets take one
  // 64-bit word per 64 fields.
  for (const fieldCount of [70, 130]) {
  const fields = Array.from({ length: fieldCount }, (_, i) => `f${i}`);
  const words = ['apple', 'apples', 'apricot', 'pear', 'peach', 'plum', 'banana'];
  const docs = Array.from({ length: 60 }, (_, id) => {
    const doc = { id };
    for (let f = 0; f < fields.length; f++) if ((id * 7 + f * 3) % 11 < 3) doc[fields[f]] = `${words[(id + f) % words.length]} ${words[(id * f) % words.length]}`;
    doc[fields[fieldCount - 1]] = `${words[id % words.length]} tail`;
    return doc;
  });
  const queries = ['apple', 'ap', 'aple pea', 'tail', { combineWith: 'OR', queries: ['plum', 'peach'] }];
  for (const dirty of [false, true]) {
    const run = C => {
      const index = new C({ fields, autoVacuum: false, storeFields: ['f0'] });
      index.addAll(docs);
      if (dirty) for (const id of [3, 17, 40]) index.discard(id);
      const out = [];
      for (const query of queries) for (const options of [{ includeMatch: false, prefix: true, fuzzy: 0.2 }, { prefix: true }, { prefix: true, fuzzy: 0.2, fields: [fields[fieldCount - 1], 'f64', 'f1'] }, { includeMatch: false, fields: [fields[fieldCount - 1], 'f1'] },
        { includeMatch: false, combineWith: 'AND', prefix: true }, { includeMatch: false, filter: row => row.id % 2 === 0 }]) {
        // includeMatch is this package's option: MiniSearch always returns
        // match, so its rows are compared without it.
        const rows = index.search(query, options);
        if (C === Original && options.includeMatch === false) for (const row of rows) delete row.match;
        out.push(rows);
      }
      if (C === MiniSearch) { assert.equal(index.executionMode, 'wasm'); index.free(); }
      return out;
    };
    assert.deepEqual(run(MiniSearch), run(Original), `${fieldCount} fields, dirty=${dirty}`);
  }
  }
});

await test('long repetitive fields index as MiniSearch does', () => {
  // Fields longer than the bench corpus's, with repeated terms: the index,
  // its snapshot, scores and removal must not differ.
  const words = ['Apple', 'apple', 'pear', 'PEAR', 'plum', 'zürich', 'Zürich', 'kiwi', 'fig', 'date', 'lime'];
  const text = (n, seed) => Array.from({ length: n }, (_, i) => (i % 5 ? ' ' : ', ') + words[(i * i + seed * 7 + (i % 3)) % words.length]).join('');
  const docs = Array.from({ length: 30 }, (_, id) => ({ id, title: text(3 + (id % 4), id), text: text(id % 2 ? 31 + id * 3 : 32 + id, id + 1) }));
  const variants = [
    {},
    // Callbacks move tokenizing to JavaScript: the term-batch path, with empty
    // and multiple terms per token.
    { processTerm: (term, field) => term.length === 3 ? '' : term.startsWith('p') ? [term.toLowerCase(), 'p'] : term.toLowerCase() },
    { tokenize: text => text.split(' ') },
  ];
  for (const extra of variants) {
    const run = C => {
      const index = new C({ fields: ['title', 'text'], autoVacuum: false, ...extra });
      index.addAll(docs);
      const snapshot = JSON.parse(JSON.stringify(index));
      const found = ['apple', 'pear zür', 'p'].map(q => index.search(q, { prefix: true, fuzzy: 0.2 }));
      for (const doc of docs.slice(0, 10)) index.remove(doc);
      const after = [JSON.parse(JSON.stringify(index)), index.search('apple pear', { combineWith: 'OR' })];
      if (C === MiniSearch) { assert.equal(index.executionMode, 'wasm'); index.free(); }
      return { snapshot, found, after };
    };
    assert.deepEqual(run(MiniSearch), run(Original), JSON.stringify(Object.keys(extra)));
  }
  // The engine's own add (documents with their ids, native tokenizer).
  const core = new Core({ fields: ['title', 'text'], autoVacuum: false }), upstream = new Original({ fields: ['title', 'text'], autoVacuum: false });
  core.addAll(docs); upstream.addAll(docs);
  assert.deepEqual(core.toJSON(), JSON.parse(JSON.stringify(upstream)));
  for (const doc of docs.slice(0, 10)) { core.remove(doc); upstream.remove(doc); }
  assert.deepEqual(core.toJSON(), JSON.parse(JSON.stringify(upstream)));
  core.free();
});

await test('compaction renumbers dense and sparse id spaces as MiniSearch keeps them', async () => {
  // Few live documents among many historical ids take the hash-map remap;
  // most ids live take the table.
  for (const [count, keep] of [[6000, id => id % 5 === 0], [70000, id => id % 997 === 5]]) {
    const docs = Array.from({ length: count }, (_, id) => ({ id, text: `w${id % 13} v${id % 101} common${id % 2 ? ' odd' : ''}` }));
    const run = async C => {
      const index = new C({ fields: ['text'], autoVacuum: false });
      index.addAll(docs);
      for (const doc of docs) if (!keep(doc.id)) index.discard(doc.id);
      await index.vacuum();
      index.add({ id: 'new', text: 'common odd w1' });
      const out = [index.documentCount, index.termCount, ...['common', 'odd w1', 'v5'].map(q => index.search(q, { prefix: true }))];
      if (C === MiniSearch) {
        assert.equal(index.executionMode, 'wasm');
        // The facade compacted: ids are dense again.
        assert.ok(index._wasm.nextId <= index.documentCount + 1, `nextId ${index._wasm.nextId}`);
        index.free();
      }
      return out;
    };
    assert.deepEqual(await run(MiniSearch), await run(Original), `${count} documents`);
  }
});
