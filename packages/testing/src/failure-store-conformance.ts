// The `FailureStore` contract of `@ultimat3/core` as shared examples, for a store of your own:
// `behavesLike(failureStoreConformance, () => subject)`. A bundle is saved by the request that
// FAILED — its transaction is rolling back — so the save must land outside it, whole, and once.

import { expect, test } from 'bun:test';
import { uuidV7 } from '@ultimat3/core';
import type { FailureBundle, FailureStore } from '@ultimat3/core/adapter';
import type { DbClient } from '@ultimat3/db';
import { raw, withTransaction } from '@ultimat3/db';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

export interface FailureStoreSubject {
  readonly store: FailureStore;
  /** The bundle saved under `id`, read back from wherever the store put it. */
  find(id: string): Promise<FailureBundle | undefined>;
  /** The database a failing request's transaction runs on. */
  readonly client: DbClient;
}

export interface FailureStoreCheck {
  readonly name: string;
  run(subject: FailureStoreSubject): Promise<void>;
}

/** A bundle with every field populated and nested — a store that flattens one is caught. */
export const failureBundle = (over: Partial<FailureBundle> = {}): FailureBundle => {
  const requestId = uuidV7();
  return {
    id: uuidV7(),
    fingerprint: `fp-${requestId}`,
    code: 'X_INTERNAL',
    operation: 'POST /api/orders',
    primitive: 'action',
    name: 'placeOrder',
    at: Date.parse('2026-11-06T10:00:00.000Z'),
    requestId,
    traceId: `trace-${requestId}`,
    build: 'build-7',
    input: { sku: 'a-1', quantity: 2, note: null, lines: [{ minor: 1250, currency: 'EUR' }] },
    masked: ['input.card'],
    actor: {
      kind: 'user',
      id: 'u1',
      orgId: 'org-1',
      roles: ['buyer'],
      scopes: [],
      permissions: ['orders:write'],
    },
    flags: { checkoutV2: true, tier: 'gold' },
    reads: [{ entity: 'order', row: { id: 'o1', total: 2500 }, masked: ['token'] }],
    truncated: false,
    ...over,
  };
};

const PARALLEL = 12;

// A foreign failure the request body raises: test input handed to the subject, never a verdict.
const REQUEST_FAILED = new RangeError('the request failed');

export const FAILURE_STORE_CHECKS: readonly FailureStoreCheck[] = [
  {
    name: 'a saved bundle reads back whole',
    async run({ store, find }) {
      const bundle = failureBundle();
      await store.save(bundle);
      expect(await find(bundle.id)).toEqual(bundle);
    },
  },
  {
    name: 'a bundle with nothing optional reads back whole',
    async run({ store, find }) {
      const bundle = failureBundle({
        operation: null,
        requestId: null,
        traceId: null,
        build: null,
        input: undefined,
        actor: null,
        flags: {},
        reads: [],
        masked: [],
        truncated: true,
      });
      await store.save(bundle);
      const { input: _input, ...rest } = bundle;
      expect(await find(bundle.id)).toMatchObject(rest);
    },
  },
  {
    name: 'saving one id twice keeps the first bundle, and does not throw',
    async run({ store, find }) {
      const bundle = failureBundle();
      await store.save(bundle);
      await store.save({ ...bundle, code: 'X_FORBIDDEN' });
      expect((await find(bundle.id))?.code).toBe('X_INTERNAL');
    },
  },
  {
    name: `${PARALLEL} bundles saved at once are ${PARALLEL} bundles`,
    async run({ store, find }) {
      const bundles = Array.from({ length: PARALLEL }, () => failureBundle());
      await Promise.all(bundles.map((bundle) => store.save(bundle)));
      for (const bundle of bundles) expect((await find(bundle.id))?.id).toBe(bundle.id);
    },
  },
  {
    name: 'a bundle saved inside a transaction that rolls back survives it',
    async run({ store, find, client }) {
      const bundle = failureBundle();
      const failed = withTransaction(
        async (tx) => {
          await tx.execute(raw('select 1'));
          await store.save(bundle);
          throw REQUEST_FAILED;
        },
        { client },
      );
      await expect(failed).rejects.toThrow('the request failed');
      expect(await find(bundle.id)).toEqual(bundle);
    },
  },
];

export const failureStoreConformance: SharedExamples<Maybe<FailureStoreSubject>> = sharedExamples(
  'a failure store',
  (subject) => {
    for (const check of FAILURE_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  },
);
