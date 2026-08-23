// What is left of the graph-based budget API: the budget GRAMMAR. The rest — `graphFor`,
// `routeJsBytes`, `checkBudget`, `checkBudgets`, `assertBudget` and their types — was deleted in
// 2026-08-23 because nothing outside this file ever called it; the gate that runs is
// `@ultimat3/cli`'s `checkBudgets`, over the emitted document.

import { describe, expect, test } from 'bun:test';
import { parseByteBudget } from './islands';

describe('parseByteBudget', () => {
  test('parses the three units the budget grammar admits', () => {
    expect(parseByteBudget('40kb')).toBe(40_960);
    expect(parseByteBudget('512b')).toBe(512);
    expect(parseByteBudget('1mb')).toBe(1_048_576);
  });

  test('is case- and space-insensitive, and rounds a fractional amount', () => {
    expect(parseByteBudget(' 40KB ')).toBe(40_960);
    expect(parseByteBudget('1.5kb')).toBe(1_536);
  });

  test('an unparseable budget is null, never a throw and never a guess', () => {
    // The caller skips the comparison rather than failing the build on a typo it cannot read —
    // `X_BUDGET_UNMEASURED` is the finding for that, and it belongs to the CLI.
    expect(parseByteBudget('lots')).toBe(null);
    expect(parseByteBudget(undefined)).toBe(null);
    expect(parseByteBudget('40')).toBe(null);
    expect(parseByteBudget('40gb')).toBe(null);
    expect(parseByteBudget('')).toBe(null);
  });

  test('a unit spelled like an Object.prototype member is not a unit', () => {
    // The table is indexed with the caller's own string, so `constructor` off the prototype chain
    // would be a truthy factor and `NaN` bytes.
    expect(parseByteBudget('40constructor')).toBe(null);
    expect(parseByteBudget('40toString')).toBe(null);
  });
});
