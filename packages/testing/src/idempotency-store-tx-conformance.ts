// The transactional half of `idempotencyStoreConformance`: a store that settles outside the
// handler's transaction replays a success for a write that rolled back, and one that lets a
// straggler settle a reclaimed key answers one request with another's value.

import { expect } from 'bun:test';
import { outsideTransaction, withTransaction } from '@ultimat3/db';
import type { IdempotencyWorldCheck as TxCheck } from './idempotency-store-world-conformance';
import { codeOf, late, world } from './idempotency-store-world-conformance';

export const IDEMPOTENCY_TX_CHECKS: readonly TxCheck[] = [
  {
    name: 'in a transaction: a commit settles with the write, and the retry replays it',
    async run(subject) {
      const w = await world(subject);
      await w.charge('ch_1');
      expect(await w.statusOf()).toBe('settled');
      expect(await w.charge('ch_2')).toEqual({ value: { charged: 'ch_1' }, replayed: true });
      expect(await w.charges()).toEqual(['ch_1']);
    },
  },
  {
    name: 'in a transaction: a rollback after the settle leaves the record in flight',
    async run(subject) {
      const w = await world(subject);
      expect(
        await w.charge('ch_1', { after: late }).catch((error: unknown) => error),
      ).toBeInstanceOf(RangeError);
      expect(await w.charges()).toEqual([]);
      // `settled` is the defect: the retry would replay a success for a write that rolled back.
      expect(await w.statusOf()).toBe('in-flight');
      expect(codeOf(await w.charge('ch_2').catch((error: unknown) => error))).toBe(
        'X_IDEMPOTENCY_CONFLICT',
      );
    },
  },
  {
    name: 'in a transaction: past the deadline the rolled-back key runs again, one write stored',
    async run(subject) {
      const w = await world(subject);
      await w.charge('ch_1', { after: late }).catch(() => undefined);
      await w.age(subject.reclaimAfterMs + 1_000);
      expect(await w.charge('ch_2')).toEqual({ value: { charged: 'ch_2' }, replayed: false });
      expect(await w.charges()).toEqual(['ch_2']);
      expect(await w.statusOf()).toBe('settled');
    },
  },
  {
    name: 'in a transaction: a reservation never settled is freed by the deadline',
    async run(subject) {
      const w = await world(subject);
      await withTransaction(
        async () => {
          expect((await subject.store.reserve(w.key, 'hash')).created).toBe(true);
        },
        { client: subject.client },
      );
      await w.age(subject.reclaimAfterMs + 1_000);
      expect((await subject.store.reserve(w.key, 'hash')).created).toBe(true);
    },
  },
  {
    name: 'in a transaction: a takeover before the settle refuses the slow attempt and undoes its write',
    async run(subject) {
      const w = await world(subject);
      const slow = await w
        .charge('slow', {
          // Past the deadline with the record in flight: a retry, outside this transaction, takes it.
          during: () =>
            outsideTransaction(async () => {
              await w.age(subject.reclaimAfterMs + 1_000);
              expect((await subject.store.reserve(w.key, 'hash')).created).toBe(true);
            }),
        })
        .catch((error: unknown) => error);
      expect(codeOf(slow)).toBe('X_IDEMPOTENCY_RESERVATION_LOST');
      expect(await w.charges()).toEqual([]);
    },
  },
  {
    name: 'in a transaction: a settle waiting on its commit is nobody’s to reclaim',
    async run(subject) {
      const w = await world(subject);
      let retry: Promise<{ created: boolean }> | undefined;
      await w.charge('ch_1', {
        // Old before the settle: a row store's settle holds the row's lock until the commit.
        during: () => outsideTransaction(() => w.age(subject.reclaimAfterMs + 1_000)),
        // After the settle ran, before the commit. Not awaited: a row store blocks it on the lock.
        after: async () => {
          retry = outsideTransaction(() => subject.store.reserve(w.key, 'hash'));
        },
      });
      expect((await retry)?.created).toBe(false);
      expect(await w.statusOf()).toBe('settled');
    },
  },
  ...(['commit', 'rollback'] as const).map(
    (ending): TxCheck => ({
      name: `a straggler that outlives a ${ending} settles at once — its transaction is over`,
      async run(subject) {
        const w = await world(subject);
        const gate = Promise.withResolvers<void>();
        let straggler: Promise<unknown> = Promise.resolve();
        await withTransaction(
          () => {
            straggler = gate.promise.then(async () => {
              const { record } = await subject.store.reserve(w.key, 'hash');
              await subject.store.settle(w.key, { late: true }, record.id, false);
            });
            return ending === 'commit' ? Promise.resolve() : late();
          },
          { client: subject.client },
        ).catch(() => undefined);
        gate.resolve();
        await straggler;
        expect(await w.statusOf()).toBe('settled');
      },
    }),
  ),
  {
    name: 'autocommit: the settle is immediate and a retry replays',
    async run(subject) {
      const w = await world(subject);
      await w.chargeAutocommit('ch_1');
      expect(await w.statusOf()).toBe('settled');
      expect(await w.chargeAutocommit('ch_2')).toEqual({
        value: { charged: 'ch_1' },
        replayed: true,
      });
      expect(await w.charges()).toEqual(['ch_1']);
    },
  },
];
