// The retry token ratio per breaker key: a call earns a fifth of a retry, a retry spends a whole
// one, so retries stay at most 20% of calls once the starting burst is spent.

import { describe, expect, test } from 'bun:test';
import { breaker } from './breaker';
import { RETRY_BURST, retryBudgetOf } from './breaker-retry-budget';

const gate = (name = 'vendor') => breaker({ name, failures: 1_000, cooldownMs: 30_000 });

/** How many of `retries` asked for after `calls` calls were admitted. */
function admitted(budget: ReturnType<typeof retryBudgetOf>, retries: number): number {
  let yes = 0;
  for (let i = 0; i < retries; i += 1) if (budget.spend()) yes += 1;
  return yes;
}

describe('unit · breaker retry budget', () => {
  test('a fresh key may retry a burst, then nothing until calls earn it back', () => {
    const budget = retryBudgetOf(gate());
    expect(admitted(budget, RETRY_BURST + 5)).toBe(RETRY_BURST);
  });

  test('once the burst is spent, retries are at most 20% of calls', () => {
    const budget = retryBudgetOf(gate());
    admitted(budget, RETRY_BURST);
    let retries = 0;
    for (let call = 0; call < 1_000; call += 1) {
      budget.called();
      if (budget.spend()) retries += 1;
    }
    expect(retries).toBe(200);
  });

  test('the bank never grows past the burst, however quiet the key was', () => {
    const budget = retryBudgetOf(gate());
    for (let call = 0; call < 10_000; call += 1) budget.called();
    expect(admitted(budget, RETRY_BURST * 2)).toBe(RETRY_BURST);
  });

  test('one budget per breaker: one key draining leaves another whole', () => {
    const drained = gate('a');
    const whole = gate('b');
    admitted(retryBudgetOf(drained), RETRY_BURST);
    expect(retryBudgetOf(drained)).toBe(retryBudgetOf(drained));
    expect(admitted(retryBudgetOf(drained), 1)).toBe(0);
    expect(admitted(retryBudgetOf(whole), RETRY_BURST)).toBe(RETRY_BURST);
  });
});
