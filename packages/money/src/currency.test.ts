import { describe, expect, test } from 'bun:test';
import { isCurrencyCode } from '@ultimat3/schema';
import {
  CURRENCIES,
  currencyCodes,
  currencyInfo,
  exponentOf,
  isValidCurrency,
  registerCurrency,
  scaleOf,
} from './currency';
import { formatMoney } from './format';
import { fromDecimal, money, toDecimalString } from './money';

describe('currency table', () => {
  test('exponents match ISO-4217 for the currencies that trip people up', () => {
    expect(exponentOf('USD')).toBe(2);
    expect(exponentOf('EUR')).toBe(2);
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('KRW')).toBe(0);
    expect(exponentOf('VND')).toBe(0);
    expect(exponentOf('ISK')).toBe(0);
    expect(exponentOf('KWD')).toBe(3);
    expect(exponentOf('BHD')).toBe(3);
    expect(exponentOf('OMR')).toBe(3);
    expect(exponentOf('TND')).toBe(3);
  });

  test('scale is derived, never assumed', () => {
    expect(scaleOf('EUR')).toBe(100);
    expect(scaleOf('JPY')).toBe(1);
    expect(scaleOf('KWD')).toBe(1000);
  });

  test('the table is well formed', () => {
    const codes = CURRENCIES.map((info) => info.code);
    expect(new Set(codes).size).toBe(codes.length); // no duplicates
    expect(codes).toEqual([...codes].sort()); // sorted, so diffs stay readable
    for (const info of CURRENCIES) {
      // The bound is `@ultimat3/schema`'s, exactly as it is in `registerCurrency` — a shipped row
      // this predicate refuses is a code `t.money`, the OpenAPI `pattern` and the Postgres CHECK
      // would refuse too, so the table would ship a currency no amount could reach a row in. A
      // local `/^[A-Z]{3}$/` here was the last copy, and a copy only ever shows up once it drifts.
      expect([info.code, isCurrencyCode(info.code)]).toEqual([info.code, true]);
      expect([0, 2, 3]).toContain(info.exponent);
      // Intl must know every code we claim to support.
      expect(() =>
        new Intl.NumberFormat('en-US', { style: 'currency', currency: info.code }).format(1),
      ).not.toThrow();
    }
  });

  test('unknown codes are loud', () => {
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('usd')).toBe(false);
    expect(isValidCurrency('BTC')).toBe(false);
    expect(codeOf(() => currencyInfo('XYZ'))).toBe('X_CURRENCY_UNKNOWN');
  });
});

describe('registering a currency the shipped table does not have', () => {
  test('an unregistered well-formed code is still refused — the seam is opt-in', () => {
    expect(isValidCurrency('XZZ')).toBe(false);
    expect(codeOf(() => money(1, 'XZZ'))).toBe('X_CURRENCY_UNKNOWN');
  });

  test('the registered exponent drives the maths — never a silent 2', () => {
    registerCurrency({ code: 'XBT', exponent: 8, name: 'Bitcoin' });
    expect(exponentOf('XBT')).toBe(8);
    expect(scaleOf('XBT')).toBe(100_000_000);
    // The whole point: a default of 2 would read this as 1.23 and lose six digits.
    expect(fromDecimal('1.23456789', 'XBT').minor).toBe(123_456_789);
    expect(toDecimalString(money(123_456_789, 'XBT'))).toBe('1.23456789');
  });

  test('an exponent of 0 is kept, not treated as absent', () => {
    registerCurrency({ code: 'XLP', exponent: 0, name: 'Loyalty Point' });
    expect(exponentOf('XLP')).toBe(0);
    expect(fromDecimal('250', 'XLP').minor).toBe(250);
    // `money()` drops a `scale` that only restates the currency's own, so a zero-exponent
    // registration must reach that comparison as 0 and not as `undefined`.
    expect(money(250, 'XLP', 0).scale).toBeUndefined();
  });

  test('a registered currency formats — the seam reaches Intl, not just arithmetic', () => {
    registerCurrency({ code: 'XFM', exponent: 2, name: 'Framework Credit' });
    expect(formatMoney(money(129_900, 'XFM'), 'en-US')).toContain('1,299.00');
  });

  test('currencyCodes() answers for the process; CURRENCIES stays the shipped ISO table', () => {
    registerCurrency({ code: 'XCC', exponent: 2, name: 'Company Credit' });
    expect(currencyCodes()).toContain('XCC');
    expect(isValidCurrency('XCC')).toBe(true);
    expect(currencyInfo('XCC').name).toBe('Company Credit');
    expect(CURRENCIES.map((info) => info.code)).not.toContain('XCC');
  });

  test('an identical re-registration is a no-op, so a re-imported module is not a crash', () => {
    registerCurrency({ code: 'XID', exponent: 4, name: 'Idem' });
    expect(() => registerCurrency({ code: 'XID', exponent: 4, name: 'Idem' })).not.toThrow();
    expect(exponentOf('XID')).toBe(4);
  });

  test('a second exponent for one code is refused — it reinterprets every stored amount', () => {
    registerCurrency({ code: 'XRD', exponent: 2, name: 'Redef' });
    expect(codeOf(() => registerCurrency({ code: 'XRD', exponent: 3, name: 'Redef' }))).toBe(
      'X_CURRENCY_REDEFINED',
    );
    expect(exponentOf('XRD')).toBe(2);
  });

  test('a differing name for one code is refused too — one code, one answer', () => {
    registerCurrency({ code: 'XNM', exponent: 2, name: 'First' });
    expect(codeOf(() => registerCurrency({ code: 'XNM', exponent: 2, name: 'Second' }))).toBe(
      'X_CURRENCY_REDEFINED',
    );
    expect(currencyInfo('XNM').name).toBe('First');
  });

  test('a shipped ISO row cannot be redefined — those exponents are not the app’s to pick', () => {
    expect(codeOf(() => registerCurrency({ code: 'USD', exponent: 3, name: 'US Dollar' }))).toBe(
      'X_CURRENCY_REDEFINED',
    );
    expect(exponentOf('USD')).toBe(2);
  });

  test('a malformed code is refused, never coerced', () => {
    for (const code of ['btc', 'BITCOIN', 'XB', '', 'XB1', 'XB ']) {
      expect(codeOf(() => registerCurrency({ code, exponent: 2, name: 'Nope' }))).toBe(
        'X_CURRENCY_INVALID',
      );
    }
  });

  test('an exponent that is not a legal money scale is refused', () => {
    for (const exponent of [-1, 2.5, 16, Number.NaN]) {
      expect(codeOf(() => registerCurrency({ code: 'XEX', exponent, name: 'Bad' }))).toBe(
        'X_CURRENCY_INVALID',
      );
    }
    expect(isValidCurrency('XEX')).toBe(false);
  });

  test('an empty name is refused — currencyInfo(code).name is a rendered value', () => {
    expect(codeOf(() => registerCurrency({ code: 'XNN', exponent: 2, name: '  ' }))).toBe(
      'X_CURRENCY_INVALID',
    );
  });

  test('the refusals name a call that works, never one that throws again', () => {
    const fixOf = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return String((error as { fix?: unknown }).fix);
      }
      return 'no-throw';
    };
    // `decimalTooPrecise` learned this the hard way: a fix line echoing the rejected value back
    // is an instruction that raises the error it is answering.
    expect(fixOf(() => registerCurrency({ code: 'nope', exponent: 2, name: 'N' }))).not.toContain(
      "'nope'",
    );
    expect(fixOf(() => registerCurrency({ code: 'nope', exponent: 2, name: 'N' }))).toContain(
      'registerCurrency(',
    );
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

describe('the shipped rows are constants', () => {
  test('a row handed out by currencyInfo cannot be rewritten', () => {
    // `exponent` decides what every stored `minor` in that currency counts, so one write here
    // silently rescales every USD amount in the process by a power of ten — and `registerCurrency`
    // refuses exactly this change through its own door (`X_CURRENCY_REDEFINED`).
    const usd = currencyInfo('USD');
    // The compiler now refuses `usd.exponent = 3` outright; this is the caller that has no types
    // — plain JS, or a cast. A module is always strict, so the write THROWS rather than being
    // dropped in silence.
    const untyped = usd as { exponent: number; name: string };
    expect(() => {
      untyped.exponent = 3;
    }).toThrow(TypeError);
    expect(currencyInfo('USD').exponent).toBe(2);
    expect(fromDecimal('12.99', 'USD').minor).toBe(1299);
  });

  test('CURRENCIES is frozen, and so is every row in it', () => {
    // Both halves: a frozen array holding writable rows guards the LIST while leaving every value
    // in it open, which is the half that would have mattered.
    expect(Object.isFrozen(CURRENCIES)).toBe(true);
    expect(CURRENCIES.filter((row) => !Object.isFrozen(row))).toEqual([]);
  });
});
