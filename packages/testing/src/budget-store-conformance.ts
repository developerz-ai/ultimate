// The `BudgetStore` contract of `@ultimat3/ai` as shared examples, for a store of your own (Redis,
// SQL): `behavesLike(budgetStoreConformance, () => store)`. The race is the point — `take` is the
// one atomic step, and a store that awaits between its read and its write overspends under it.
// Structural, so this package takes no dependency on `ai`: a `BudgetStore` is assignable.

import { expect, test } from 'bun:test';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

/** The four members of `@ultimat3/ai`'s `BudgetStore`, structurally. */
export interface BudgetStoreLike {
  spent(key: string): Maybe<number>;
  add(key: string, tokens: number): Maybe<void>;
  take(key: string, tokens: number, limit: number): Maybe<{ readonly taken: boolean }>;
  reset(key?: string): Maybe<void>;
}

export interface BudgetStoreCheck {
  readonly name: string;
  run(store: BudgetStoreLike): Promise<void>;
}

/** Concurrent takers, and the ceiling only some of them fit under. */
const BUDGET_RACE_TAKERS = 24;
const RACE_LIMIT = 5;

let minted = 0;
const keyOf = (): string => {
  minted += 1;
  return `conformance:${process.pid.toString(36)}:${minted.toString(36)}`;
};

export const BUDGET_STORE_CHECKS: readonly BudgetStoreCheck[] = [
  {
    name: `${BUDGET_RACE_TAKERS} concurrent takes against one key never overspend the limit`,
    async run(store) {
      const key = keyOf();
      const takes = Array.from({ length: BUDGET_RACE_TAKERS }, async () =>
        store.take(key, 1, RACE_LIMIT),
      );
      const taken = (await Promise.all(takes)).filter((each) => each.taken).length;
      expect([taken, await store.spent(key)]).toEqual([RACE_LIMIT, RACE_LIMIT]);
    },
  },
  {
    name: 'a refused take spends nothing, and a take that fits exactly is taken',
    async run(store) {
      const key = keyOf();
      expect((await store.take(key, 3, 4)).taken).toBe(true);
      expect((await store.take(key, 2, 4)).taken).toBe(false);
      expect(await store.spent(key)).toBe(3);
      expect((await store.take(key, 1, 4)).taken).toBe(true);
      expect(await store.spent(key)).toBe(4);
    },
  },
  {
    name: 'add takes a negative credit, and reset(key) clears that key alone',
    async run(store) {
      const [key, other] = [keyOf(), keyOf()];
      await store.add(key, 5);
      await store.add(key, -2);
      await store.add(other, 1);
      expect(await store.spent(key)).toBe(3);
      await store.reset(key);
      expect([await store.spent(key), await store.spent(other)]).toEqual([0, 1]);
    },
  },
];

export const budgetStoreConformance: SharedExamples<Maybe<BudgetStoreLike>> = sharedExamples(
  'a budget store',
  (subject) => {
    for (const check of BUDGET_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  },
);
