// Single responsibility: a vector store WRITE with no tenant bound, inside any request, is refused —
// `upsert`, `prune` and `delete`, on both stores, for every actor, and `indexDocument` through one.
// Reads were already refused; a write compiled to `and true` and reached every tenant's rows.

import { describe, expect, test } from 'bun:test';
import { anonymousActor, ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { recordingClient } from '@ultimat3/db';
import { hashEmbedder, normalizeVector } from './embeddings';
import { postgresVectorStore } from './pg-vector';
import { indexDocument } from './rag';
import type { VectorStore } from './vector';
import { memoryVectorStore } from './vector';
import { UNSCOPED, type VectorScope } from './vector-scope';

const vec = (...values: number[]): Float32Array => normalizeVector(Float32Array.from(values));
const row = (id: string, text: string) => ({ id, vector: vec(1, 0, 0, 0), text });

const asOrg = <T>(orgId: string, fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: `u-${orgId}`, orgId }) }), fn);
const inNoOrg = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u-1' }) }), fn);
const asAnonymous = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: anonymousActor() }), fn);

const stores = (): readonly (readonly [string, (scope?: VectorScope) => VectorStore])[] => [
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

const writes = (store: VectorStore): readonly (readonly [string, () => Promise<unknown>])[] => [
  ['upsert', () => store.upsert([row('doc-1', 'alpha')])],
  ['prune', () => store.prune({ source: 'doc' }, [])],
  ['delete', () => store.delete(['doc-1'])],
];

describe('an unscoped write inside a request', () => {
  for (const [label, open] of stores()) {
    for (const [name, write] of writes(open())) {
      test(`${label}: ${name} is X_VECTOR_UNSCOPED`, async () => {
        await expect(asOrg('org-a', write)).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
      });
    }

    test(`${label}: an allow-list alone binds no tenant, so a write is refused too`, async () => {
      const store = open().scoped({ allow: { kind: ['guide'] } });
      await expect(asOrg('org-a', () => store.delete(['doc-1']))).rejects.toMatchObject({
        code: 'X_VECTOR_UNSCOPED',
      });
    });

    test(`${label}: indexDocument through an unscoped store is refused`, async () => {
      const store = open();
      const indexed = () =>
        indexDocument({
          store,
          embedder: hashEmbedder({ dimension: 4 }),
          document: { id: 'doc', text: 'alpha beta gamma' },
        });
      await expect(asOrg('org-a', indexed)).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
    });

    test(`${label}: tenant-bound and UNSCOPED writes run inside an org request`, async () => {
      for (const [, write] of writes(open().scoped({ tenant: 'org-a' })))
        await asOrg('org-a', write);
      for (const [, write] of writes(open(UNSCOPED))) await asOrg('org-a', write);
    });

    test(`${label}: an org-less or anonymous write is X_VECTOR_UNSCOPED too`, async () => {
      for (const [, write] of writes(open())) {
        await expect(inNoOrg(write)).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
        await expect(asAnonymous(write)).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
      }
      for (const [, write] of writes(open(UNSCOPED))) {
        await inNoOrg(write);
        await asAnonymous(write);
      }
    });

    test(`${label}: outside any request (a script, a boot task) writes run`, async () => {
      for (const [, write] of writes(open())) await write();
    });
  }
});

describe('a scoped write touches only its own tenant (the auditor’s repro)', () => {
  test('org-a deleting and pruning through its scope leaves org-b’s same ids alone', async () => {
    const base = memoryVectorStore({ name: 'docs', dimension: 4 });
    const orgB = base.scoped({ tenant: 'org-b' });
    await orgB.upsert([{ ...row('doc-1', 'B secret'), metadata: { source: 'x' } }]);
    await asOrg('org-a', async () => {
      await expect(base.search(vec(1, 0, 0, 0), 5)).rejects.toMatchObject({
        code: 'X_VECTOR_UNSCOPED',
      });
      await expect(base.delete(['doc-1'])).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
      await expect(base.prune({ source: 'x' }, [])).rejects.toMatchObject({
        code: 'X_VECTOR_UNSCOPED',
      });
      const orgA = base.scoped({ tenant: 'org-a' });
      await orgA.upsert([{ ...row('doc-1', 'A note'), metadata: { source: 'x' } }]);
      await orgA.delete(['doc-1']);
      await orgA.upsert([{ ...row('doc-1', 'A note'), metadata: { source: 'x' } }]);
      await orgA.prune({ source: 'x' }, []);
      expect(await orgA.search(vec(1, 0, 0, 0), 5)).toEqual([]);
    });
    const left = await orgB.search(vec(1, 0, 0, 0), 5);
    expect(left.map((hit) => hit.text)).toEqual(['B secret']);
  });
});
