// The `X_AI_BUDGET_EXCEEDED` fix opens with the `budget: { … }` that would have let the call through,
// under the key the app declares — never a config key that does not exist.

import { describe, expect, test } from 'bun:test';
import { budgetCeiling } from './budget-fix';
import { AiBudgetExceededError } from './errors';

describe('budgetCeiling', () => {
  test('a token scope: spent plus this request, under the declared key', () => {
    expect(
      budgetCeiling({ scope: 'actor:user:42', requested: 30, remaining: 10, limit: 100 }),
    ).toEqual({
      key: 'actor',
      value: '120',
      where: 'providerGateway({ budget }) — a ceiling over the whole window',
    });
  });

  test('a money scope is a Money literal, its scale kept when finer than the currency', () => {
    expect(
      budgetCeiling({
        scope: 'costPerCall',
        requested: 250,
        remaining: 200,
        limit: 200,
        unit: 'USD minor units',
      }).value,
    ).toBe("{ minor: 250, currency: 'USD' }");
    expect(
      budgetCeiling({
        scope: 'costPerRun',
        requested: 5,
        remaining: 1,
        limit: 9,
        unit: 'EUR at scale 6',
      }).value,
    ).toBe("{ minor: 13, currency: 'EUR', scale: 6 }");
  });

  test('an agent run ceiling reaches the ledger as request, and the fix says so', () => {
    expect(
      budgetCeiling({ scope: 'request', requested: 1, remaining: 0, limit: 500 }).where,
    ).toContain('tokensPerRun');
  });
});

describe('AiBudgetExceededError', () => {
  test('the fix opens with the budget to paste, and parses as TypeScript', () => {
    const { fix } = new AiBudgetExceededError({
      scope: 'tokensIn',
      requested: 900,
      remaining: 512,
      limit: 512,
    });
    expect(fix).toStartWith('budget: { tokensIn: 900 }   // on the llm()/agent() declaration');
    expect(fix).not.toContain('app.config.ts');
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    expect(() => transpiler.transformSync(`({ ${fix.replace('   //', ' }) //')}`)).not.toThrow();
  });
});
