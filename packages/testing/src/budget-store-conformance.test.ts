// The budget-store suite over `@ultimat3/ai`'s `memoryBudgetStore()`, and the proof it can fail: a
// store whose `take` reads, awaits, then writes — the overspend `take` exists to close.

import { describe, expect, test } from 'bun:test';
import { memoryBudgetStore } from '@ultimat3/ai';
import type { BudgetStoreLike } from './budget-store-conformance';
import { BUDGET_STORE_CHECKS, budgetStoreConformance } from './budget-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory budget store'), () => {
  behavesLike(budgetStoreConformance, () => memoryBudgetStore());
});

/** Read, await (a network round trip), write: correct alone, an overspend under concurrency. */
const readThenWrite = (): BudgetStoreLike => {
  const inner = memoryBudgetStore();
  return {
    spent: (key) => inner.spent(key),
    add: (key, tokens) => inner.add(key, tokens),
    reset: (key) => inner.reset(key),
    async take(key, tokens, limit) {
      const spent = inner.spent(key);
      await Promise.resolve();
      if (spent + tokens > limit) return { taken: false };
      inner.add(key, tokens);
      return { taken: true };
    },
  };
};

describe(testName('unit', 'a store that is not atomic fails conformance'), () => {
  test('read-await-write passes every sequential check and fails the race', async () => {
    const [race, ...sequential] = BUDGET_STORE_CHECKS;
    for (const each of sequential) await each.run(readThenWrite());
    await expect(
      (race as (typeof BUDGET_STORE_CHECKS)[number]).run(readThenWrite()),
    ).rejects.toThrow();
  });
});
