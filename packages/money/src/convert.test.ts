import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
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

  test('the inverse is the swapped fraction, not the reciprocal double', async () => {
    // `1 / 0.92` is 1.0869565217391304, and expanding THAT decimal loses a minor unit: the table
    // named 23/25, so this direction is exactly 25/23 and nothing else was ever observed.
    const rate = await provider.rateFor('EUR', 'USD');
    expect(rate?.ratio).toEqual({ numerator: 100n, denominator: 92n });

    const big = await convertWith(provider, money(7_999_999_999_999_980, 'EUR'), 'USD');
    expect(big.amount.minor).toBe(8_695_652_173_913_022);
    // The audit trail still records the readable number a human recognises as the rate.
    expect(big.rate).toBe(1 / 0.92);
  });

  test('a direct rate carries its own decimal spelling as the fraction', async () => {
    const rate = await provider.rateFor('USD', 'EUR');
    expect(rate?.ratio).toEqual({ numerator: 92n, denominator: 100n });
  });

  test('a ratio that is not positive is a missing rate, never a negative conversion', () => {
    const poisoned: ExchangeRate = {
      ...usdToEur,
      ratio: { numerator: -92n, denominator: 100n },
    };
    expect(codeOf(() => convert(money(1000, 'USD'), 'EUR', poisoned))).toBe('X_RATE_MISSING');
    expect(
      codeOf(() =>
        convert(money(1000, 'USD'), 'EUR', {
          ...usdToEur,
          ratio: { numerator: 92n, denominator: 0n },
        }),
      ),
    ).toBe('X_RATE_MISSING');
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

  test('the identity stamps the clock it was asked at, never the epoch', async () => {
    // `ExchangeRate.at` is the audit trail. `new Date(0)` claimed the parity was observed on
    // 1970-01-01, which is a date nobody wrote into a ledger on purpose.
    const clock = frozenClock('2026-08-16T10:00:00.000Z');
    const same = await convertWith(provider, money(1000, 'USD'), 'USD', { clock });
    expect(same.at).toBe('2026-08-16T10:00:00.000Z');

    const asked = await convertWith(provider, money(1000, 'USD'), 'USD', {
      at: new Date('2020-01-01T00:00:00.000Z'),
      clock,
    });
    expect(asked.at).toBe('2020-01-01T00:00:00.000Z');
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

describe('conversion is exact', () => {
  // `10000 * 1.005` is 10049.999999999998; the exact 10050 must reach `half-up` whole.
  test('the rate is applied as the fraction it spells, not as a float product', () => {
    const rate: ExchangeRate = { from: 'EUR', to: 'USD', rate: 1.005, at };
    expect(convert(money(100, 'EUR'), 'USD', rate).amount).toEqual({
      minor: 101,
      currency: 'USD',
    });
    expect(convert(money(100, 'EUR'), 'USD', rate, { rounding: 'down' }).amount).toEqual({
      minor: 100,
      currency: 'USD',
    });
  });

  test('exactness survives the minor-unit exponent shift', () => {
    // USD (2 digits) -> JPY (0): 1005 cents at 1.005 is exactly 10.1002... major, so ¥10.
    const rate: ExchangeRate = { from: 'USD', to: 'JPY', rate: 1.005, at };
    expect(convert(money(1005, 'USD'), 'JPY', rate).amount).toEqual({
      minor: 10,
      currency: 'JPY',
    });
  });
});

describe('a value carrying its own scale', () => {
  // The sub-cent AI-cost case `MoneyValue.scale` exists for. Deriving the decimal shift from
  // `exponentOf(amount.currency)` reinterpreted $0.000002 as €0.02 — a 10,000x overstatement,
  // and the exact failure the field was added to prevent.
  test('converts at its own precision, not the currency exponent', () => {
    const parity: ExchangeRate = { from: 'USD', to: 'EUR', rate: 1, at };
    // $1.00 written in micros is €1.00, not €10,000.00.
    expect(convert(money(1_000_000, 'USD', 6), 'EUR', parity).amount).toEqual({
      minor: 1_000_000,
      currency: 'EUR',
      scale: 6,
    });
    expect(convert(money(2, 'USD', 6), 'EUR', parity).amount).toEqual({
      minor: 2,
      currency: 'EUR',
      scale: 6,
    });
  });

  test('keeps the scale across a minor-unit exponent change', () => {
    // $1.00 in micros at ¥100/$ is ¥100 — still counted in micros, because narrowing to JPY's
    // zero decimals is the silent precision loss `scale` exists to refuse.
    const usdToJpy: ExchangeRate = { from: 'USD', to: 'JPY', rate: 100, at };
    expect(convert(money(1_000_000, 'USD', 6), 'JPY', usdToJpy).amount).toEqual({
      minor: 100_000_000,
      currency: 'JPY',
      scale: 6,
    });
  });

  test('a deliberately coarser scale is kept too, exactly as money() keeps it', () => {
    // `money(5, 'USD', 0)` is five whole dollars; at parity that is five whole euros.
    const parity: ExchangeRate = { from: 'USD', to: 'EUR', rate: 1, at };
    expect(convert(money(5, 'USD', 0), 'EUR', parity).amount).toEqual({
      minor: 5,
      currency: 'EUR',
      scale: 0,
    });
  });
});

describe('fixedRateProvider and a historical ask', () => {
  const provider = fixedRateProvider({ 'USD/EUR': 0.92 }, at);

  test('an `at` the table cannot honour is undefined, never today stamped as then', async () => {
    // The provider holds one observation. Answering with it under another date repriced a
    // historical invoice at the wrong rate AND recorded a date nobody asked for.
    expect(await provider.rateFor('USD', 'EUR', new Date('2020-01-01T00:00:00.000Z'))).toBe(
      undefined,
    );
    expect(
      await codeOfAsync(() =>
        convertWith(provider, money(10000, 'USD'), 'EUR', {
          at: new Date('2020-01-01T00:00:00.000Z'),
        }),
      ),
    ).toBe('X_RATE_MISSING');
  });

  test('the instant the table records is honoured, and so is no instant at all', async () => {
    expect((await provider.rateFor('USD', 'EUR', new Date(at.getTime())))?.rate).toBe(0.92);
    const result = await convertWith(provider, money(10000, 'USD'), 'EUR');
    expect(result.amount).toEqual({ minor: 9200, currency: 'EUR' });
    expect(result.at).toBe(at.toISOString());
  });
});

async function codeOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'no-throw';
}
