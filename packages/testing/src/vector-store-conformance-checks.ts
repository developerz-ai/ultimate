// The checks behind `vectorStoreConformance`, one behaviour each, asserted through `VectorStore`
// alone. Every check binds its own fresh tenant with `scoped()`, so one table shared by the whole
// suite (pgvector) and one map (memory) both answer as if each check had a store of its own.

import { expect } from 'bun:test';
import type { SearchHit, VectorRecord, VectorStore } from '@ultimat3/ai';
import { isUltimateError } from '@ultimat3/core';

export interface VectorStoreCheck {
  readonly name: string;
  run(store: VectorStore): Promise<void>;
}

/** Every subject is built at this width: a pg table's column type is fixed by its DDL. */
export const VECTOR_CONFORMANCE_DIMENSION = 3;

const unit = (...values: number[]): Float32Array => {
  const norm = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / norm));
};

const NORTH = unit(1, 0, 0);
const CORPUS: readonly VectorRecord[] = [
  { id: 'a', vector: NORTH, text: 'alpha zirconium manual', metadata: { kind: 'guide' } },
  {
    id: 'b',
    vector: unit(0.9, 0.1, 0),
    text: 'beta guide about vectors',
    metadata: { kind: 'guide' },
  },
  { id: 'c', vector: unit(0, 1, 0), text: 'gamma error report', metadata: { kind: 'error' } },
  { id: 'd', vector: unit(0, 0, 1), text: 'delta billing summary' },
];

let minted = 0;
const tenantOf = (): string => {
  minted += 1;
  return `conformance-${Bun.randomUUIDv7()}-${minted.toString(36)}`;
};

/** A fresh tenant's view of `store`, holding `CORPUS`. */
const seeded = async (store: VectorStore): Promise<VectorStore> => {
  const view = store.scoped({ tenant: tenantOf() });
  await view.upsert(CORPUS);
  return view;
};

const ids = (hits: readonly SearchHit[]): readonly string[] => hits.map((hit) => hit.id);
const sortedIds = (hits: readonly SearchHit[]): readonly string[] => [...ids(hits)].sort();

const codeOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
    return 'answered';
  } catch (error) {
    return isUltimateError(error) ? error.code : `not an UltimateError: ${String(error)}`;
  }
};

export const VECTOR_STORE_CHECKS: readonly VectorStoreCheck[] = [
  {
    name: 'search ranks the nearest vector first, stops at k, and carries text and metadata',
    async run(store) {
      expect(store.dimension).toBe(VECTOR_CONFORMANCE_DIMENSION);
      const hits = await (await seeded(store)).search(NORTH, 2);
      expect(ids(hits)).toEqual(['a', 'b']);
      expect(hits[0]).toMatchObject({
        text: 'alpha zirconium manual',
        metadata: { kind: 'guide' },
      });
      expect(hits[0]?.score ?? 0).toBeGreaterThan(hits[1]?.score ?? 1);
    },
  },
  {
    name: 'a row with no metadata answers {}, and an upsert of a known id replaces it',
    async run(store) {
      const view = await seeded(store);
      await view.upsert([{ id: 'd', vector: unit(0, 0, 1), text: 'delta rewritten' }]);
      const hits = await view.search(unit(0, 0, 1), 1);
      expect(hits).toMatchObject([{ id: 'd', text: 'delta rewritten', metadata: {} }]);
      expect(await view.search(NORTH, 10)).toHaveLength(CORPUS.length);
    },
  },
  {
    name: 'a vector of the wrong width is X_VECTOR_DIM_MISMATCH on upsert, search and hybrid',
    async run(store) {
      const view = store.scoped({ tenant: tenantOf() });
      const wide = new Float32Array(VECTOR_CONFORMANCE_DIMENSION + 1);
      const record = { id: 'x', vector: wide, text: 'x' };
      expect([
        await codeOf(() => view.upsert([record])),
        await codeOf(() => view.search(wide, 1)),
        await codeOf(() => view.hybrid({ query: 'x', vector: wide, k: 1 })),
      ]).toEqual(['X_VECTOR_DIM_MISMATCH', 'X_VECTOR_DIM_MISMATCH', 'X_VECTOR_DIM_MISMATCH']);
    },
  },
  {
    name: 'a batch holding one wrong-width record is refused whole: none of it is written',
    async run(store) {
      const view = store.scoped({ tenant: tenantOf() });
      const wide = new Float32Array(VECTOR_CONFORMANCE_DIMENSION + 1);
      const batch = [...CORPUS, { id: 'x', vector: wide, text: 'x' }];
      expect(await codeOf(() => view.upsert(batch))).toBe('X_VECTOR_DIM_MISMATCH');
      expect(await view.search(NORTH, 10)).toEqual([]);
    },
  },
  {
    name: 'a metadata filter is an exact match, and a row missing the key is not a match',
    async run(store) {
      const view = await seeded(store);
      expect(sortedIds(await view.search(NORTH, 10, { kind: 'guide' }))).toEqual(['a', 'b']);
      expect(await view.search(NORTH, 10, { kind: 'guid' })).toEqual([]);
    },
  },
  {
    name: 'two tenants hold the same id as two rows, and neither sees nor deletes the other',
    async run(store) {
      const [one, two] = [await seeded(store), store.scoped({ tenant: tenantOf() })];
      await two.upsert([{ id: 'a', vector: NORTH, text: 'the other tenant' }]);
      await two.delete(['b']);
      expect(ids(await two.search(NORTH, 10))).toEqual(['a']);
      expect((await one.search(NORTH, 1))[0]?.text).toBe('alpha zirconium manual');
      expect(await one.search(NORTH, 10)).toHaveLength(CORPUS.length);
    },
  },
  {
    name: 'a scope only tightens: another tenant is X_VECTOR_SCOPE_WIDENED, an allow-list hides',
    async run(store) {
      const view = await seeded(store);
      expect(await codeOf(() => view.scoped({ tenant: tenantOf() }))).toBe(
        'X_VECTOR_SCOPE_WIDENED',
      );
      const guides = view.scoped({ allow: { kind: ['guide', 'error'] } }).scoped({
        allow: { kind: ['guide'] },
      });
      expect(sortedIds(await guides.search(NORTH, 10))).toEqual(['a', 'b']);
      await guides.delete(['c', 'd']);
      expect(await view.search(NORTH, 10)).toHaveLength(CORPUS.length);
    },
  },
  {
    name: 'prune deletes what the filter matches except the kept ids, and nothing else',
    async run(store) {
      const view = await seeded(store);
      await view.prune({ kind: 'guide' }, ['b']);
      expect(sortedIds(await view.search(NORTH, 10))).toEqual(['b', 'c', 'd']);
    },
  },
  {
    name: 'searchText ranks the document holding a rare exact term first; no match is []',
    async run(store) {
      const view = await seeded(store);
      expect(ids(await view.searchText('zirconium', 3))[0]).toBe('a');
      expect(await view.searchText('xylophonist', 3)).toEqual([]);
    },
  },
  {
    name: 'hybrid puts the row both rankings lead with first, and stops at k',
    async run(store) {
      const view = await seeded(store);
      const hits = await view.hybrid({ query: 'zirconium', vector: NORTH, k: 2 });
      expect(hits).toHaveLength(2);
      expect(hits[0]?.id).toBe('a');
    },
  },
  {
    name: 'a k that is not a whole number is refused, never answered with []',
    async run(store) {
      const view = await seeded(store);
      expect(await codeOf(() => view.search(NORTH, Number.NaN))).toBe('X_INVARIANT');
      expect(await codeOf(() => view.searchText('zirconium', 1.5))).toBe('X_INVARIANT');
    },
  },
];
