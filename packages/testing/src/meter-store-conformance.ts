// The `MeterStore` contract of `@ultimat3/action` as shared examples, for a store of your own:
// `behavesLike(meterStoreConformance, () => store)`. The race is the point: a draw is one atomic
// check-and-add, and a store that reads then writes admits past the limit under parallel calls.

import { expect, test } from 'bun:test';
import type { MeterKey, MeterStore } from '@ultimat3/action/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

export interface MeterStoreCheck {
  readonly name: string;
  run(store: MeterStore): Promise<void>;
}

const DAY = 86_400_000;
const START = Date.parse('2026-11-06T00:00:00.000Z');
const RACERS = 50;

let minted = 0;
/** A subject no other check, run or process shares — a shared database outlives one test file. */
const keyOf = (): MeterKey => {
  minted += 1;
  return {
    subject: `org:conformance-${process.pid.toString(36)}-${minted.toString(36)}`,
    meter: 'calls',
    period: 'day@UTC',
  };
};

const drawOf =
  (store: MeterStore, key: MeterKey) =>
  (limit: number, periodStartMs = START, over: Partial<MeterKey> = {}) =>
    store.draw({ ...key, ...over, periodStartMs, limit });

export const METER_STORE_CHECKS: readonly MeterStoreCheck[] = [
  {
    name: 'declares its scope',
    async run(store) {
      expect(['process', 'shared']).toContain(store.scope);
    },
  },
  {
    name: 'counts up to the limit and refuses the next draw without counting it',
    async run(store) {
      const draw = drawOf(store, keyOf());
      const seen = [];
      for (let i = 0; i < 4; i += 1) seen.push(await draw(3));
      expect(seen.map((result) => [result.allowed, result.used])).toEqual([
        [true, 1],
        [true, 2],
        [true, 3],
        [false, 3],
      ]);
    },
  },
  {
    name: `${RACERS} parallel draws at the edge admit exactly the limit`,
    async run(store) {
      const draw = drawOf(store, keyOf());
      const results = await Promise.all(Array.from({ length: RACERS }, () => draw(7)));
      expect(results.filter((result) => result.allowed)).toHaveLength(7);
      expect(results.filter((result) => !result.allowed).every((r) => r.used === 7)).toBe(true);
    },
  },
  {
    name: 'a limit of 0 refuses every draw',
    async run(store) {
      expect((await drawOf(store, keyOf())(0)).allowed).toBe(false);
    },
  },
  {
    name: 'a later period starts from zero; an earlier one adds to the current',
    async run(store) {
      const draw = drawOf(store, keyOf());
      await draw(2, START + DAY);
      await draw(2, START + DAY);
      expect((await draw(2, START + DAY)).allowed).toBe(false);
      // A replica a period behind cannot reset today's count by drawing against yesterday.
      expect((await draw(2, START)).allowed).toBe(false);
      expect(await draw(2, START + 2 * DAY)).toEqual({ allowed: true, used: 1, warned: false });
    },
  },
  {
    name: 'a raised limit applies at once, to the count already spent',
    async run(store) {
      const draw = drawOf(store, keyOf());
      await draw(1);
      expect((await draw(1)).allowed).toBe(false);
      expect(await draw(5)).toEqual({ allowed: true, used: 2, warned: false });
    },
  },
  {
    name: 'subjects, meters and period declarations are separate counters',
    async run(store) {
      const key = keyOf();
      const draw = drawOf(store, key);
      await draw(1);
      expect((await draw(1, START, { subject: `${key.subject}-2` })).allowed).toBe(true);
      expect((await draw(1, START, { meter: 'exports' })).allowed).toBe(true);
      expect((await draw(1, START, { period: 'month@UTC' })).allowed).toBe(true);
      expect((await draw(1)).allowed).toBe(false);
    },
  },
  {
    name: "a period's warning has one claimant, is released for a retry, and resets with the period",
    async run(store) {
      const key = keyOf();
      const draw = drawOf(store, key);
      await draw(9);
      const claims = await Promise.all(
        Array.from({ length: 6 }, () => store.claimWarning(key, START)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await draw(9)).warned).toBe(true);
      await store.releaseWarning(key, START);
      expect(await store.claimWarning(key, START)).toBe(true);
      // A claim for a period the counter is not in is no claim at all.
      expect(await store.claimWarning(key, START + DAY)).toBe(false);
      expect((await draw(9, START + DAY)).warned).toBe(false);
    },
  },
];

export const meterStoreConformance: SharedExamples<Maybe<MeterStore>> = sharedExamples(
  'a meter store',
  (subject) => {
    for (const check of METER_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  },
);
