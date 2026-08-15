import { describe, expect, test } from 'bun:test';
import { factorFraction } from './factor';

describe('factorFraction', () => {
  test('expands the decimal that was written, not the double that holds it', () => {
    // 1.005 is stored as 1.00499999999999989…; the fraction is what the caller typed.
    expect(factorFraction(1.005)).toEqual({ numerator: 1005n, denominator: 1000n });
    expect(factorFraction(0.1)).toEqual({ numerator: 1n, denominator: 10n });
    expect(factorFraction(3)).toEqual({ numerator: 3n, denominator: 1n });
    expect(factorFraction(0)).toEqual({ numerator: 0n, denominator: 1n });
  });

  test('carries the sign on the numerator so the denominator stays positive', () => {
    expect(factorFraction(-2.5)).toEqual({ numerator: -25n, denominator: 10n });
  });

  test('reads exponent notation, which is how a double under 1e-6 spells itself', () => {
    expect(String(1e-7)).toBe('1e-7');
    expect(factorFraction(1e-7)).toEqual({ numerator: 1n, denominator: 10_000_000n });
    expect(factorFraction(2.5e3)).toEqual({ numerator: 2500n, denominator: 1n });
    expect(factorFraction(1.5e-3)).toEqual({ numerator: 15n, denominator: 10_000n });
  });

  test('a non-finite factor is refused rather than expanded into a guess', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(codeOf(() => factorFraction(bad))).toBe('X_MONEY_NOT_INTEGER');
    }
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'no-throw';
}
