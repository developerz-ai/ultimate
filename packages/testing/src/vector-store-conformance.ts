// `@ultimat3/ai`'s `VectorStore` contract as shared examples: `behavesLike(vectorStoreConformance,
// () => store)` runs every check in `vector-store-conformance-checks.ts` against a store of your
// own — empty or shared, UNBOUND (each check binds its own tenant), `VECTOR_CONFORMANCE_DIMENSION`
// wide.

import { test } from 'bun:test';
import type { VectorStore } from '@ultimat3/ai';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';
import { VECTOR_STORE_CHECKS } from './vector-store-conformance-checks';

export const vectorStoreConformance: SharedExamples<VectorStore> = sharedExamples(
  'a vector store',
  (subject) => {
    for (const check of VECTOR_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
