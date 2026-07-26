import { describe, expect, test } from 'bun:test';
import { convert, convertWith, type ExchangeRate, fixedRateProvider } from './convert';
import { money } from './money';

const at = new Date('2026-03-14T00:00:00.000Z');
const usdToEur: ExchangeRate = { from: 'USD', to: 'EUR', rate: 0.92, at, source: 'ecb' };

describe('convert', () => {
  test('records the rate and timestamp for audit', () => {
    const result = convert(money(1000, 'USD'), 'EUR', usdToEur);
    expect(result.amount).toEqual({ minor: 920, currency: 'EUR' });
    expect(result.source).toEqual({ minor: 1000, currency: 'USD' });
    expect(result.rate).toBe(0.92);
    expect(result.at).toBe('2026-03-14T00:00:00.000Z');
    expect(result.provider).toBe('ecb');
  });

  test('scales across different minor-unit exponents', () => {
    // $10.00 at 150 JPY/USD is ¥1,500 — 1500 minor units, not 150000.
    const result = convert(money(1000, 'USD'), 'JPY', {
      from: 'USD',
      to: 'JPY',
      rate: 150,
      at,
    });
    expect(result.amount).toEqual({ minor: 1500, currency: 'JPY' });
  });

  test('refuses a rate that does not match the pair', () => {
    expect(codeOf(() => convert(money(1000, 'GBP'), 'EUR', usdToEur))).toBe('X_RATE_MISSING');
    expect(codeOf(() => convert(money(1000, 'USD'), 'EUR', { ...usdToEur, rate: 0 }))).toBe(
      'X_RATE_MISSING',
    );
  });
});

describe('convertWith', () => {
  const provider = fixedRateProvider({ 'USD/EUR': 0.92 }, at, 'test-table');

  test('derives the inverse rate from one direction', async () => {
    const back = await convertWith(provider, money(920, 'EUR'), 'USD');
    expect(back.amount.currency).toBe('USD');
    expect(back.amount.minor).toBe(1000);
  });

  test('a missing pair throws instead of assuming parity', async () => {
    let code = 'no-throw';
    try {
      await convertWith(provider, money(1000, 'USD'), 'JPY');
    } catch (error) {
      code = String((error as { code?: unknown }).code);
    }
    expect(code).toBe('X_RATE_MISSING');
  });

  test('same-currency conversion is the identity, no provider call', async () => {
    const same = await convertWith(provider, money(1000, 'USD'), 'USD');
    expect(same.rate).toBe(1);
    expect(same.amount).toEqual({ minor: 1000, currency: 'USD' });
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
