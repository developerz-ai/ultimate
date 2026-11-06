// A budget a visitor TYPED, read in their own locale: `1.234,56` is twelve hundred euros in
// Spanish and `1,234.56` in English — never one read for every visitor — and an amount the
// currency cannot hold is refused, never rounded into a different number.

import { expect, test } from 'bun:test';
import { budgetText, typedBudget } from './budget';

test('each locale reads its own separators into the same minor units', () => {
  expect(typedBudget('1.234,56', 'EUR', 'es')).toEqual({ minor: 123456, currency: 'EUR' });
  expect(typedBudget('1,234.56', 'USD', 'en')).toEqual({ minor: 123456, currency: 'USD' });
  expect(typedBudget('$1,200', 'USD', 'en')).toEqual({ minor: 120000, currency: 'USD' });
});

test('a third decimal is refused, not rounded — the visitor is asked again', () => {
  let thrown: unknown;
  try {
    typedBudget('12,345', 'EUR', 'es');
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeUltimateError('X_MONEY_INPUT_INVALID');
});

test('the amount is written back in the reader’s own locale', () => {
  const amount = { minor: 123456, currency: 'EUR' };
  expect(budgetText(amount, 'es')).toContain('1234,56');
  expect(budgetText(amount, 'en')).toContain('1,234.56');
});
