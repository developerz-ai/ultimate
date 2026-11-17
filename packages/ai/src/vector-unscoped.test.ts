// Single responsibility: a vector store read with no tenant bound, inside ANY request, is refused —
// on both stores, on every read, for every actor (an org's, an org-less user's, anonymous). A store
// is unscoped until `.scoped({ tenant })`, and a forgotten call searched every tenant's rows. The
// backfill path and a single-tenant app opt in by name: `UNSCOPED`.

import { describe, expect, test } from 'bun:test';
import { type Actor, anonymousActor, ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { recordingClient } from '@ultimat3/db';
import { normalizeVector } from './embeddings';
import { postgresVectorStore } from './pg-vector';
import type { VectorStore } from './vector';
import { memoryVectorStore } from './vector';
import { narrowScope, UNSCOPED } from './vector-scope';

const vec = (...values: number[]): Float32Array => normalizeVector(Float32Array.from(values));

const inOrg = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u-1', orgId: 'acme' }) }), fn);
const as = <T>(actor: Actor, fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor }), fn);
/** The actors with no tenant to bind: the auditor's repro ran both and read every org's rows. */
const orgless = (): readonly (readonly [string, Actor])[] => [
  ['anonymous', anonymousActor()],
  ['an org-less user', userActor({ id: 'u-1' })],
];

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

describe('an unscoped read inside a request', () => {
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

    for (const [who, actor] of orgless()) {
      test(`${label}: every read by ${who} is X_VECTOR_UNSCOPED`, async () => {
        for (const read of reads(open())) {
          await expect(as(actor, read)).rejects.toMatchObject({ code: 'X_VECTOR_UNSCOPED' });
        }
      });

      test(`${label}: UNSCOPED still reads for ${who}`, async () => {
        for (const read of reads(open(UNSCOPED))) await as(actor, read);
      });
    }

    test(`${label}: outside any request (a script, a boot task) an unbound read runs`, async () => {
      for (const read of reads(open())) await read();
    });
  }
});

describe('the auditor’s repro: two orgs’ rows, an unbound searchText', () => {
  for (const [who, actor] of orgless()) {
    test(`${who} is refused, where it used to read both orgs`, async () => {
      const base = memoryVectorStore({ name: 'docs', dimension: 4 });
      await base
        .scoped({ tenant: 'org-a' })
        .upsert([{ id: 'a', vector: vec(1, 0, 0, 0), text: 'payroll A' }]);
      await base
        .scoped({ tenant: 'org-b' })
        .upsert([{ id: 'b', vector: vec(1, 0, 0, 0), text: 'payroll B' }]);
      await expect(as(actor, () => base.searchText('payroll', 5))).rejects.toMatchObject({
        code: 'X_VECTOR_UNSCOPED',
      });
      const own = await as(actor, () => base.scoped({ tenant: 'org-a' }).searchText('payroll', 5));
      expect(own.map((hit) => hit.text)).toEqual(['payroll A']);
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
