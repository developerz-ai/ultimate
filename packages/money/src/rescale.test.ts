import { describe, expect, test } from 'bun:test';
import { money } from './money';
import { rescale } from './rescale';

describe('rescale', () => {
  test('refuses to drop digits unless a rounding mode says so', () => {
    const micros = money(1_234_567, 'USD', 6);
    expect(codeOf(() => rescale(micros, 2))).toBe('X_MONEY_NOT_INTEGER');
    expect(causeOf(() => rescale(micros, 2))).toContain('6');
  });

  test('widening is exact and needs no mode', () => {
    expect(rescale(money(1299, 'EUR'), 6)).toEqual({
      minor: 12_990_000,
      currency: 'EUR',
      scale: 6,
    });
    expect(rescale(money(1200, 'JPY'), 3)).toEqual({ minor: 1_200_000, currency: 'JPY', scale: 3 });
  });

  test('narrowing with an explicit mode rounds the way the mode says', () => {
    const micros = money(1_234_567, 'USD', 6);
    expect(rescale(micros, 2, 'down').minor).toBe(123);
    expect(rescale(micros, 2, 'up').minor).toBe(124);
    expect(rescale(money(1_235_000, 'USD', 6), 2, 'half-up').minor).toBe(124);
    expect(rescale(money(1_225_000, 'USD', 6), 2, 'half-even').minor).toBe(122);
    expect(rescale(money(1_235_000, 'USD', 6), 2, 'half-even').minor).toBe(124);
  });

  test('a narrowing that loses nothing is exact, mode or no mode', () => {
    expect(rescale(money(1_200_000, 'USD', 6), 2)).toEqual({ minor: 120, currency: 'USD' });
  });

  test('back at the currency’s own scale the key is gone, so the value serializes as it always did', () => {
    const there = rescale(money(1299, 'EUR'), 6);
    expect(JSON.stringify(rescale(there, 2))).toBe('{"minor":1299,"currency":"EUR"}');
  });

  test('refuses a scale that names no decimal place', () => {
    expect(codeOf(() => rescale(money(100, 'USD'), 99))).toBe('X_MONEY_SCALE_INVALID');
  });

  test('the sub-cent value the AI cost path could not hold: $0.80/Mtok over 200 tokens', () => {
    // Truly $0.00016. Whole cents rounded it up to 1¢ — ~50x — and the budget ledger built on
    // that number was fiction.
    const perMillion = rescale(money(80, 'USD'), 8);
    expect(perMillion.minor).toBe(80_000_000);
    expect(rescale(perMillion, 2, 'half-up')).toEqual({ minor: 80, currency: 'USD' });
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
  return 'no-throw';
}
