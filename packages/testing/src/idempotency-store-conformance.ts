// The `IdempotencyStore` contract of `@ultimat3/action` as shared examples, for a store of your own:
// `behavesLike(idempotencyStoreConformance, () => subject)`. Two halves: the port alone (atomic
// reserve, the reservation-id fence, the window, the redaction flag), and the store behind
// `withIdempotency` inside a real transaction (`idempotency-store-{tx,replay}-conformance.ts`).

import { expect, test } from 'bun:test';
import type { IdempotencyStore } from '@ultimat3/action/adapter';
import { finiteCount } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { IDEMPOTENCY_REPLAY_CHECKS } from './idempotency-store-replay-conformance';
import { IDEMPOTENCY_TX_CHECKS } from './idempotency-store-tx-conformance';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

/** What a store's author hands the suite: the store, and the two things only they can do to it. */
export interface IdempotencyStoreSubject {
  readonly store: IdempotencyStore;
  /** The database a handler's transaction runs on — the one the store settles inside. */
  readonly client: DbClient;
  /** The request deadline the store was built with (`reclaimAfterMs`), in ms. Above zero. */
  readonly reclaimAfterMs: number;
  /** Make the record under `key` `ms` older, as the store's own clock sees it. */
  age(key: string, ms: number): Promise<void>;
  /** Forget every record. Run before each check. */
  reset(): Promise<void>;
}

export interface IdempotencyStoreCheck {
  readonly name: string;
  run(subject: IdempotencyStoreSubject): Promise<void>;
}

/** The window every store defaults to: a day. A store built with another one ages past its own. */
const DAY_MS = 24 * 60 * 60 * 1000;

let minted = 0;
/** A key no other check, run or process shares — a shared database outlives one test file. */
export const idempotencyKeyOf = (): string => {
  minted += 1;
  return `["conformance","${process.pid.toString(36)}","${Date.now().toString(36)}",${minted}]`;
};

const RACERS = 16;

/** The store's own window, screened: `NaN + 1_000` ages nothing, and the check would pass vacuously. */
const windowOf = (windowMs: number | undefined): number =>
  finiteCount('idempotencyStoreConformance', 'windowMs', windowMs ?? DAY_MS, 1);

const PORT_CHECKS: readonly IdempotencyStoreCheck[] = [
  {
    name: 'declares its scope, and that it keeps the redaction flag',
    async run({ store }) {
      expect(['process', 'shared']).toContain(store.scope ?? 'undeclared');
      expect(store.keepsRedaction).toBe(true);
    },
  },
  {
    name: `${RACERS} concurrent reserves of one fresh key create exactly one record`,
    async run({ store }) {
      const key = idempotencyKeyOf();
      const all = await Promise.all(
        Array.from({ length: RACERS }, () => store.reserve(key, 'hash')),
      );
      expect(all.filter((each) => each.created)).toHaveLength(1);
      expect(new Set(all.map((each) => each.record.id)).size).toBe(1);
      expect(all.every((each) => each.record.status === 'in-flight')).toBe(true);
    },
  },
  {
    name: 'a settled record is what get answers and what the next reserve replays',
    async run({ store }) {
      const key = idempotencyKeyOf();
      const { record } = await store.reserve(key, 'hash-1');
      expect(record).toMatchObject({ key, requestHash: 'hash-1', status: 'in-flight' });
      const value = { charged: 'ch_1', amount: { minor: 1250, currency: 'EUR' }, tags: ['a'] };
      await store.settle(key, value, record.id, false);
      const held = await store.get(key);
      expect(held).toMatchObject({ id: record.id, status: 'settled', value });
      expect(held?.redacted).not.toBe(true);
      const again = await store.reserve(key, 'hash-1');
      expect(again.created).toBe(false);
      expect(again.record).toMatchObject({ id: record.id, status: 'settled', value });
    },
  },
  {
    name: 'settle keeps the redaction flag and hands it back',
    async run({ store }) {
      const key = idempotencyKeyOf();
      const { record } = await store.reserve(key, 'hash');
      await store.settle(key, { apiKey: '[redacted]' }, record.id, true);
      expect((await store.get(key))?.redacted).toBe(true);
    },
  },
  {
    name: 'a failure settles as failed, with the four fields a replay re-throws',
    async run({ store }) {
      if (store.fail === undefined) return expect.unreachable('this store has no fail()');
      const key = idempotencyKeyOf();
      const { record } = await store.reserve(key, 'hash');
      const failure = {
        code: 'X_FORBIDDEN',
        cause: 'declined',
        fix: 'x verify --only unit --json',
      };
      await store.fail(key, failure, record.id);
      const held = await store.get(key);
      expect(held?.status).toBe('failed');
      expect(held?.failure).toMatchObject(failure);
    },
  },
  {
    name: 'settle, fail and release are fenced on the reservation id',
    async run({ store }) {
      const key = idempotencyKeyOf();
      const { record } = await store.reserve(key, 'hash');
      const stranger = '00000000-0000-7000-8000-000000000000';
      await store.settle(key, { stolen: true }, stranger, false);
      await store.fail?.(
        key,
        { code: 'X_INTERNAL', cause: 'c', fix: 'x verify --only unit --json' },
        stranger,
      );
      await store.release(key, stranger);
      expect(await store.get(key)).toMatchObject({ id: record.id, status: 'in-flight' });
    },
  },
  {
    name: 'release drops the reservation it owns, and the key is free again',
    async run({ store }) {
      const key = idempotencyKeyOf();
      const { record } = await store.reserve(key, 'hash');
      await store.release(key, record.id);
      expect(await store.get(key)).toBeUndefined();
      expect((await store.reserve(key, 'hash')).created).toBe(true);
    },
  },
  {
    name: 'past the window a record answers as a missing one, its redaction forgotten',
    async run(subject) {
      const { store } = subject;
      const key = idempotencyKeyOf();
      const first = await store.reserve(key, 'hash');
      await store.settle(key, { apiKey: '[redacted]' }, first.record.id, true);
      await subject.age(key, windowOf(store.windowMs) + 1_000);
      expect(await store.get(key)).toBeUndefined();
      const reclaimed = await store.reserve(key, 'hash');
      expect(reclaimed.created).toBe(true);
      expect(reclaimed.record.id).not.toBe(first.record.id);
      expect(reclaimed.record.redacted).not.toBe(true);
      await store.settle(key, { charged: 'ch_2' }, reclaimed.record.id, false);
      expect((await store.get(key))?.redacted).not.toBe(true);
    },
  },
  {
    name: 'an autocommit reservation that never settled is not reclaimed by the deadline',
    async run(subject) {
      // No transaction: the handler may have committed before the process died.
      const key = idempotencyKeyOf();
      expect((await subject.store.reserve(key, 'hash')).created).toBe(true);
      await subject.age(key, subject.reclaimAfterMs + 1_000);
      const second = await subject.store.reserve(key, 'hash');
      expect(second.created).toBe(false);
      expect(second.record.status).toBe('in-flight');
    },
  },
];

/** Every check, port first. Each runs against a `reset()` subject. */
export const IDEMPOTENCY_STORE_CHECKS: readonly IdempotencyStoreCheck[] = [
  ...PORT_CHECKS,
  ...IDEMPOTENCY_TX_CHECKS,
  ...IDEMPOTENCY_REPLAY_CHECKS,
];

export const idempotencyStoreConformance: SharedExamples<Maybe<IdempotencyStoreSubject>> =
  sharedExamples('an idempotency store', (subject) => {
    for (const check of IDEMPOTENCY_STORE_CHECKS) {
      test(check.name, async () => {
        const current = await subject();
        await current.reset();
        await check.run(current);
      });
    }
  });
