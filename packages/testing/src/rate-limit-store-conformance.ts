// The `RateLimitStore` contract of `@ultimat3/http` as shared examples, for a store of your own:
// `behavesLike(rateLimitStoreConformance, () => store)`. Asserted through the port only — the
// numbers every driver owes (`rateLimitDecision`'s maths), the read that writes nothing, the
// reset that touches one key, and the race a shared counter exists to win.

import { expect, test } from 'bun:test';
import type { Bucket, RateLimitStore } from '@ultimat3/http/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface RateLimitStoreCheck {
  readonly name: string;
  run(store: RateLimitStore): Promise<void>;
}

/** Far from zero and from the host clock, so a store reading `Date.now()` instead of `nowMs` shows. */
const NOW = 1_700_000_000_000;
const FOUR: Bucket = { capacity: 4, refillPerSecond: 1 };
const HALVES: Bucket = { capacity: 3, refillPerSecond: 0.5 };
const RACERS = 16;

/** A key no other check, run or process shares — a shared table holds every run's buckets. */
const keyOf = (label: string): string => `conformance:${label}:${crypto.randomUUID()}`;

const spend = async (store: RateLimitStore, key: string, bucket: Bucket, n: number) => {
  for (let index = 0; index < n; index += 1) await store.take(key, bucket, 1, NOW);
};

export const RATE_LIMIT_STORE_CHECKS: readonly RateLimitStoreCheck[] = [
  {
    name: 'declares where its counters live',
    async run(store) {
      expect(['process', 'shared']).toContain(store.scope);
    },
  },
  {
    name: 'a bucket of four admits four takes at one instant, then refuses and says when',
    async run(store) {
      const key = keyOf('burst');
      const remaining: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const decision = await store.take(key, FOUR, 1, NOW);
        expect([decision.allowed, decision.limit, decision.retryAfterSeconds]).toEqual([
          true,
          4,
          0,
        ]);
        remaining.push(decision.remaining);
      }
      expect(remaining).toEqual([3, 2, 1, 0]);
      expect(await store.take(key, FOUR, 1, NOW)).toEqual({
        allowed: false,
        limit: 4,
        remaining: 0,
        resetAtMs: NOW + 1_000,
        retryAfterSeconds: 1,
      });
    },
  },
  {
    name: 'tokens return at refillPerSecond and stop at capacity',
    async run(store) {
      const key = keyOf('refill');
      await spend(store, key, FOUR, 4);
      expect(await store.take(key, FOUR, 1, NOW + 1_000)).toMatchObject({
        allowed: true,
        remaining: 0,
      });
      // A minute is sixty tokens of refill against a bucket of four: capped, never banked.
      expect(await store.take(key, FOUR, 1, NOW + 61_000)).toMatchObject({
        allowed: true,
        remaining: 3,
      });
    },
  },
  {
    name: 'a cost above one spends that many, and a refused cost spends nothing',
    async run(store) {
      const key = keyOf('cost');
      expect(await store.take(key, FOUR, 3, NOW)).toMatchObject({ allowed: true, remaining: 1 });
      expect(await store.take(key, FOUR, 2, NOW)).toMatchObject({
        allowed: false,
        remaining: 1,
        retryAfterSeconds: 1,
      });
      expect(await store.take(key, FOUR, 1, NOW)).toMatchObject({ allowed: true, remaining: 0 });
    },
  },
  {
    name: 'a fractional token survives between takes — half a token left is not none',
    async run(store) {
      const key = keyOf('half');
      await spend(store, key, HALVES, 3);
      const refused = await store.take(key, HALVES, 1, NOW + 1_000);
      expect([refused.allowed, refused.retryAfterSeconds]).toEqual([false, 1]);
      expect((await store.take(key, HALVES, 1, NOW + 2_000)).allowed).toBe(true);
    },
  },
  {
    name: 'a clock behind the stored instant refills nothing',
    async run(store) {
      const key = keyOf('skew');
      for (let index = 0; index < 4; index += 1) await store.take(key, FOUR, 1, NOW + 10_000);
      expect((await store.take(key, FOUR, 1, NOW)).allowed).toBe(false);
    },
  },
  {
    name: 'a five-per-week bucket is still spent a day and a fifth later',
    async run(store) {
      const key = keyOf('weekly');
      const weekly: Bucket = { capacity: 5, refillPerSecond: 5 / (7 * 86_400) };
      await spend(store, key, weekly, 5);
      expect((await store.take(key, weekly, 1, NOW + 1.2 * 86_400_000)).allowed).toBe(false);
    },
  },
  {
    name: 'peek answers full for a key never taken, and refill-applied after a spend',
    async run(store) {
      const key = keyOf('peek');
      expect(await store.peek(key, FOUR, NOW)).toEqual({ remaining: 4, retryAfterSeconds: 0 });
      await spend(store, key, FOUR, 4);
      expect(await store.peek(key, FOUR, NOW)).toEqual({ remaining: 0, retryAfterSeconds: 1 });
      expect(await store.peek(key, FOUR, NOW + 2_500)).toEqual({
        remaining: 2,
        retryAfterSeconds: 0,
      });
    },
  },
  {
    name: 'peek spends nothing: a full allowance is still there after many peeks',
    async run(store) {
      const key = keyOf('peek-free');
      for (let index = 0; index < 6; index += 1) await store.peek(key, FOUR, NOW);
      await store.take(key, FOUR, 1, NOW);
      for (let index = 0; index < 6; index += 1) await store.peek(key, FOUR, NOW);
      expect(await store.take(key, FOUR, 3, NOW)).toMatchObject({ allowed: true, remaining: 0 });
    },
  },
  {
    name: 'reset empties one key and leaves every other key spent',
    async run(store) {
      const [target, other] = [keyOf('reset'), keyOf('untouched')];
      await spend(store, target, FOUR, 4);
      await spend(store, other, FOUR, 4);
      await store.reset(target);
      expect((await store.take(target, FOUR, 1, NOW)).remaining).toBe(3);
      // A reset that refilled a neighbour is one caller handing every other caller an allowance.
      expect((await store.take(other, FOUR, 1, NOW)).allowed).toBe(false);
    },
  },
  {
    name: 'one key spent is no other key spent',
    async run(store) {
      const [first, second] = [keyOf('one'), keyOf('two')];
      await spend(store, first, FOUR, 4);
      expect((await store.take(second, FOUR, 1, NOW)).remaining).toBe(3);
    },
  },
  {
    name: `${RACERS} concurrent takes against a bucket of four admit exactly four`,
    async run(store) {
      const key = keyOf('race');
      const decisions = await Promise.all(
        Array.from({ length: RACERS }, () => store.take(key, FOUR, 1, NOW)),
      );
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4);
    },
  },
];

export const rateLimitStoreConformance: SharedExamples<RateLimitStore | Promise<RateLimitStore>> =
  sharedExamples('a rate-limit store', (subject) => {
    for (const check of RATE_LIMIT_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
