// Single responsibility: pins the one asymmetry in rescaling — widening is exact and free,
// narrowing destroys digits and so must name a rounding mode. A silent narrowing is the sub-cent
// bug this whole file exists to make impossible, so the refusal is the contract under test.

import { describe, expect, test } from 'bun:test';
import { multiply } from './arithmetic';
import { money, toDecimalString } from './money';
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
    // $0.80 per million tokens is $0.0000008 per token — 80 units at scale 8, a rate cents
    // cannot express at all.
    const perToken = money(80, 'USD', 8);
    expect(toDecimalString(perToken)).toBe('0.00000080');

    const cost = multiply(perToken, 200);
    expect(cost).toEqual({ minor: 16_000, currency: 'USD', scale: 8 });
    expect(toDecimalString(cost)).toBe('0.00016000');

    // The bug, reproduced: rounding that up to whole cents bills 1¢ for $0.00016 — 62x. The
    // point of the scale is that the exact figure above survives to the ledger instead.
    expect(rescale(cost, 2, 'up')).toEqual({ minor: 1, currency: 'USD' });
    expect(rescale(cost, 2, 'half-up')).toEqual({ minor: 0, currency: 'USD' });
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
