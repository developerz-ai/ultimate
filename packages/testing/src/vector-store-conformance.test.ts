// The vector-store suite over `memoryVectorStore()`, and the proof it can fail: a store whose
// `scoped()` hands back itself — every tenant reading and overwriting every other's rows.

import { describe, expect, test } from 'bun:test';
import type { VectorStore } from '@ultimat3/ai';
import { memoryVectorStore } from '@ultimat3/ai';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';
import { vectorStoreConformance } from './vector-store-conformance';
import {
  VECTOR_CONFORMANCE_DIMENSION,
  VECTOR_STORE_CHECKS,
} from './vector-store-conformance-checks';

describe(testName('unit', 'the memory vector store'), () => {
  behavesLike(vectorStoreConformance, () =>
    memoryVectorStore({ dimension: VECTOR_CONFORMANCE_DIMENSION }),
  );
});

/** Every method forwarded, and `scoped` a no-op: the leak a hand-written store compiles with. */
function scopeless(): VectorStore {
  const inner = memoryVectorStore({ dimension: VECTOR_CONFORMANCE_DIMENSION });
  const store: VectorStore = {
    name: 'scopeless',
    dimension: inner.dimension,
    scope: inner.scope,
    scoped: () => store,
    upsert: (records) => inner.upsert(records),
    search: (vector, k, filter) => inner.search(vector, k, filter),
    searchText: (query, k, filter) => inner.searchText(query, k, filter),
    hybrid: (input) => inner.hybrid(input),
    delete: (ids) => inner.delete(ids),
    prune: (filter, keep) => inner.prune(filter, keep),
  };
  return store;
}

const check = (prefix: string) => {
  const found = VECTOR_STORE_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no vector-store check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a store that breaks the contract fails conformance'), () => {
  test('a store that ignores its scope fails the tenant check, passes the ranking one', async () => {
    await check('search ranks the nearest').run(scopeless());
    await expect(check('two tenants hold the same id').run(scopeless())).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = VECTOR_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
