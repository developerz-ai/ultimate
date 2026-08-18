import { describe, expect, test } from 'bun:test';
import { MAX_CACHED_FORMATTERS } from '@ultimat3/core';
import { formatMoney, formatMoneyDecimal, formatMoneyParts } from './format';
import { fromDecimal, money } from './money';

/** Intl inserts narrow no-break spaces; compare on the digits, not the whitespace. */
const normalize = (value: string) => value.replace(/[  ]/g, ' ');

describe('formatMoney', () => {
  test('derives fraction digits from the currency exponent', () => {
    // JPY has no minor unit: 1200 minor units is ¥1,200, never ¥12.00.
    expect(normalize(formatMoney(money(1200, 'JPY'), 'en-US'))).toBe('¥1,200');
    expect(normalize(formatMoney(money(1200, 'KRW'), 'en-US'))).toBe('₩1,200');
    // KWD has three: 1234 minor units is 1.234 dinar.
    expect(normalize(formatMoney(money(1234, 'KWD'), 'en-US'))).toContain('1.234');
    expect(normalize(formatMoney(money(1, 'BHD'), 'en-US'))).toContain('0.001');
    expect(normalize(formatMoney(money(129900, 'USD'), 'en-US'))).toBe('$1,299.00');
  });

  test('respects the locale for separators and symbol placement', () => {
    expect(normalize(formatMoney(money(129900, 'EUR'), 'de-DE'))).toBe('1.299,00 €');
    expect(normalize(formatMoney(money(129900, 'EUR'), 'en-US'))).toBe('€1,299.00');
    expect(normalize(formatMoney(money(129900, 'EUR'), 'fr-FR'))).toBe('1 299,00 €');
  });

  test('a JPY round-trip through fromDecimal keeps the value', () => {
    expect(normalize(formatMoney(fromDecimal('1200', 'JPY'), 'ja-JP'))).toBe('￥1,200');
  });

  test('accounting negatives wrap in parentheses', () => {
    expect(normalize(formatMoney(money(-1299, 'USD'), 'en-US'))).toBe('-$12.99');
    expect(normalize(formatMoney(money(-1299, 'USD'), 'en-US', { accounting: true }))).toBe(
      '($12.99)',
    );
  });

  test('a finer scale is never served the coarser scale’s cached formatter', () => {
    // Order-dependent by construction: the formatter is memoised per currency, so the coarse
    // value has to be formatted FIRST for the collision to exist at all. A single-value
    // assertion passes against the broken cache and proves nothing.
    const trimmed = { trimZeroFraction: true } as const;
    expect(normalize(formatMoney(money(1299, 'EUR'), 'de-DE', trimmed))).toBe('12,99 €');
    expect(normalize(formatMoney(money(12_990_001, 'EUR', 6), 'de-DE', trimmed))).toBe(
      '12,990001 €',
    );
    // …and back again, so the finer entry cannot capture the coarser one either.
    expect(normalize(formatMoney(money(1299, 'EUR'), 'de-DE', trimmed))).toBe('12,99 €');
  });

  test('display modes and digit-only output', () => {
    expect(normalize(formatMoney(money(1299, 'USD'), 'en-US', { display: 'code' }))).toBe(
      'USD 12.99',
    );
    expect(formatMoneyDecimal(money(1234, 'KWD'), 'en-US')).toBe('1.234');
    expect(formatMoneyDecimal(money(1200, 'JPY'), 'en-US')).toBe('1200');
  });
});

describe('formatMoneyParts', () => {
  test('exposes the symbol separately so UI can style it', () => {
    const parts = formatMoneyParts(money(129900, 'USD'), 'en-US');
    expect(parts.find((part) => part.type === 'currency')?.value).toBe('$');
    expect(parts.find((part) => part.type === 'fraction')?.value).toBe('00');
    // JPY has no fraction part at all — a UI that assumes one renders "¥1,200." otherwise.
    const yen = formatMoneyParts(money(1200, 'JPY'), 'en-US');
    expect(yen.find((part) => part.type === 'fraction')).toBeUndefined();
  });
});

describe('one place decides the sign', () => {
  test('the parts and the string agree on an accounting negative', () => {
    const options = { accounting: true } as const;
    const joined = formatMoneyParts(money(-1299, 'EUR'), 'en-US', options)
      .map((part) => part.value)
      .join('');
    expect(normalize(joined)).toBe(normalize(formatMoney(money(-1299, 'EUR'), 'en-US', options)));
    expect(normalize(joined)).toBe('(€12.99)');
  });

  test('the parts and the string agree on a plain negative', () => {
    const joined = formatMoneyParts(money(-1299, 'EUR'), 'en-US')
      .map((part) => part.value)
      .join('');
    expect(normalize(joined)).toBe(normalize(formatMoney(money(-1299, 'EUR'), 'en-US')));
    expect(normalize(joined)).toBe('-€12.99');
  });

  test('sign placement belongs to the locale, not to a hand-rolled prefix', () => {
    // nl-NL puts the minus after the symbol; prefixing it here rendered a format Intl never emits.
    expect(normalize(formatMoney(money(-129900, 'EUR'), 'nl-NL'))).toBe(
      normalize(
        new Intl.NumberFormat('nl-NL', {
          style: 'currency',
          currency: 'EUR',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(-1299),
      ),
    );
  });
});

describe('the formatter cache', () => {
  test('is bounded — the oldest locale is evicted, not kept for the life of the process', () => {
    // `locale` is whatever `Accept-Language` sent. Keyed raw into an unbounded `Map`, 20,000
    // distinct-but-valid tags (`en-US-x-a0` …) through this function retained +55.1 MB of RSS
    // after `Bun.gc(true)` — memory the client chooses, at ~2.7 KB per `Intl.NumberFormat`.
    // The heap does not show it (ICU allocates natively), so the bound is asserted where it is
    // decided: the first key in is the first key out, and asking for it again rebuilds it.
    const amount = money(129900, 'EUR');
    const built: unknown[] = [];
    const real = Intl.NumberFormat;
    Intl.NumberFormat = new Proxy(real, {
      construct(target, args, newTarget) {
        built.push(args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      formatMoney(amount, 'en-US-x-oldest');
      for (let index = 0; index < MAX_CACHED_FORMATTERS; index += 1) {
        formatMoney(amount, `en-US-x-a${index}`);
      }
      built.length = 0;
      formatMoney(amount, 'en-US-x-oldest');
      expect(built).toEqual(['en-US-x-oldest']);
    } finally {
      Intl.NumberFormat = real;
    }
  });

  test('a locale still inside the cap is answered from the cache, never rebuilt', () => {
    const amount = money(129900, 'EUR');
    const built: unknown[] = [];
    const real = Intl.NumberFormat;
    formatMoney(amount, 'en-US-x-warm');
    Intl.NumberFormat = new Proxy(real, {
      construct(target, args, newTarget) {
        built.push(args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      // The canonical tag is the key AND what reaches `Intl`, so a header spelling one locale
      // three ways does not mint three permanent formatters.
      expect(formatMoney(amount, 'EN-us-X-WARM')).toBe(formatMoney(amount, 'en-US-x-warm'));
      expect(built).toEqual([]);
    } finally {
      Intl.NumberFormat = real;
    }
  });
});
