// `canonicalDecimal`'s trailing-zero trim (sweep 8b-3, CodeQL js/polynomial-redos): `/0+$/` retried
// a zero run from each of its zeros, so a value of 100k zeros and a 1 cost 10.7 s on Bun. The trim
// is a loop now; the old spelling is kept here as the oracle the new one must agree with.

import { describe, expect, test } from 'bun:test';
import { canonicalDecimal } from './numeric-compare';

const OLD_PARTS = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** The function as it was before the loop, verbatim but for the trim under test. */
const oldCanonical = (text: string): string | undefined => {
  const parts = OLD_PARTS.exec(text.trim());
  if (parts === null) return undefined;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = parts;
  const shift = Number(exponent);
  if (whole.length + fraction.length === 0 || Math.abs(shift) > 1000) return undefined;
  const digits = whole + fraction;
  const point = whole.length + shift;
  const integer = point <= 0 ? '' : digits.slice(0, point).padEnd(point, '0');
  const rest = point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  const before = integer.replace(/^0+/, '') || '0';
  const after = rest.replace(/0+$/, '');
  const unsigned = after === '' ? before : `${before}.${after}`;
  return sign === '-' && unsigned !== '0' ? `-${unsigned}` : unsigned;
};

const strings = (alphabet: readonly string[], max: number): string[] => {
  const out = [''];
  let level = [''];
  for (let length = 1; length <= max; length += 1) {
    level = level.flatMap((head) => alphabet.map((one) => head + one));
    out.push(...level);
  }
  return out;
};

describe('canonicalDecimal trims trailing zeros in linear time, with the old answers', () => {
  test('every decimal spelling of up to 6 characters canonicalises as before', () => {
    for (const text of strings(['0', '1', '.', 'e', '-', '+'], 6)) {
      expect([text, canonicalDecimal(text)]).toEqual([text, oldCanonical(text)]);
    }
  });

  test('a fraction of 100k zeros and a 1 keeps its 1, in well under a second', () => {
    const started = performance.now();
    expect(canonicalDecimal(`0.${'0'.repeat(100_000)}1`)).toBe(`0.${'0'.repeat(100_000)}1`);
    expect(canonicalDecimal(`5.${'0'.repeat(100_000)}`)).toBe('5');
    expect(performance.now() - started).toBeLessThan(250);
  });
});
