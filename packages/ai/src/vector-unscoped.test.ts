// Single responsibility: a vector store read with no tenant bound, inside a request acting for an
// org, is refused — on both stores, on every read. A store is unscoped until `.scoped({ tenant })`,
// and a forgotten call searched every tenant's rows. The backfill path opts in by name: `UNSCOPED`.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { recordingClient } from '@ultimat3/db';
import { normalizeVector } from './embeddings';
import { postgresVectorStore } from './pg-vector';
import type { VectorStore } from './vector';
import { memoryVectorStore } from './vector';
import { narrowScope, UNSCOPED } from './vector-scope';

const vec = (...values: number[]): Float32Array => normalizeVector(Float32Array.from(values));

const inOrg = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u-1', orgId: 'acme' }) }), fn);
const inNoOrg = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u-1' }) }), fn);

const stores = (): readonly (readonly [string, (scope?: typeof UNSCOPED) => VectorStore])[] => [
  [
    'memory',
    (scope) => memoryVectorStore({ dimension: 4, ...(scope === undefined ? {} : { scope }) }),
  ],
  [
    'pg',
    (scope) =>
      postgresVectorStore({
        name: 'docs',
        dimension: 4,
        client: recordingClient(),
        ...(scope === undefined ? {} : { scope }),
      }),
  ],
];

const reads = (store: VectorStore): readonly (() => Promise<unknown>)[] => [
  () => store.search(vec(1, 0, 0, 0), 3),
  () => store.searchText('alpha', 3),
  () => store.hybrid({ query: 'alpha', vector: vec(1, 0, 0, 0), k: 3 }),
];

describe('an unscoped read inside an org request', () => {
  for (const [label, open] of stores()) {
    test(`${label}: every read is X_VECTOR_UNSCOPED`, async () => {
      for (const read of reads(open())) {
        await expect(inOrg(read)).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
      }
    });

    test(`${label}: an allow-list alone binds no tenant, and is refused too`, async () => {
      const store = open().scoped({ allow: { kind: ['guide'] } });
      await expect(inOrg(() => store.search(vec(1, 0, 0, 0), 3))).rejects.toMatchObject({
        code: 'X_VECTOR_UNSCOPED',
      });
    });

    test(`${label}: a tenant-bound read runs`, async () => {
      const store = open().scoped({ tenant: 'acme' });
      for (const read of reads(store)) await inOrg(read);
    });

    test(`${label}: UNSCOPED, named on purpose, runs — the backfill path`, async () => {
      for (const read of reads(open(UNSCOPED))) await inOrg(read);
      for (const read of reads(open().scoped(UNSCOPED))) await inOrg(read);
    });

    test(`${label}: outside a request, or for an actor with no org, nothing changes`, async () => {
      for (const read of reads(open())) {
        await read();
        await inNoOrg(read);
      }
    });
  }
});

describe('narrowScope carries the opt-in only while no tenant is bound', () => {
  test('a tenant drops it; an allow-list keeps it', () => {
    expect(narrowScope('docs', UNSCOPED, { tenant: 'acme' })).toEqual({ tenant: 'acme' });
    expect(narrowScope('docs', UNSCOPED, { allow: { kind: ['a'] } })).toEqual({
      allow: { kind: ['a'] },
      crossTenant: true,
    });
    expect(narrowScope('docs', {}, { allow: { kind: ['a'] } })).toEqual({ allow: { kind: ['a'] } });
  });
});
