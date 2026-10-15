import MiniSearch, { MiniSearchWasm, type Options, type BM25Params, type CombinationOperator } from '../pkg/minisearch_wasm.js';
type Document = { id: number; title: string; category: string };
const options: Options<Document> = { fields: ['title'], extractField: (document, field) => document[field as keyof Document] };
const index = new MiniSearch<Document>(options);
const annotated: MiniSearch<Document> = index;
annotated.add({ id: 1, title: 'apple', category: 'fruit' });
const named = new MiniSearchWasm<Document>(options);
const operator: CombinationOperator = 'And';
index.search('apple', { combineWith: operator, filter: row => row.score > 0, prefix: (term, i, terms) => i === terms.length - 1 });
index.search('apple', { boostDocument: (id, term, fields) => id === 1 && term === 'apple' ? 2 : 1, tokenize: text => text.split(' '), processTerm: term => [term, term + 's'] });
MiniSearch.getDefault('tokenize')('a b');
MiniSearchWasm.getDefault('tokenize')('a b');
const bm25: BM25Params = { k: 1.2, b: 0.7, d: 0.5 };
named.search('apple', { bm25 });
const top: import('minisearch').SearchResult[] = index.searchTopK('apple', { limit: 10, prefix: true });
const pairs: Array<{ id: any; score: number }> = index.searchScores('apple', { fuzzy: 0.2 });
const count: number = index.countMatches(MiniSearch.wildcard);
// @ts-expect-error searchTopK needs a limit.
index.searchTopK('apple', { prefix: true });
void top; void pairs; void count;
// @ts-expect-error The document generic is enforced.
index.add({ id: 'wrong', title: 'x', category: 'y' });
