import { describe, expect, test } from 'bun:test';
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
