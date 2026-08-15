// Single responsibility: pins the money value's accept/reject contract at the public `validate()`
// boundary. Its own file beside `money-value.ts`, and not a block inside `validators.test.ts`,
// because this is the one builtin whose shape other packages alias — so what it accepts is a
// contract three packages read, not one validator's behaviour.

import { describe, expect, test } from 'bun:test';
import { MAX_MONEY_SCALE } from './money-value';
import { validate } from './standard';
import { builtinT } from './validators';

describe('builtinT.money', () => {
  test('accepts a valid Money value', () => {
    const result = validate(builtinT.money, { minor: 1999, currency: 'EUR' });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual({ minor: 1999, currency: 'EUR' });
  });

  test('rejects a non-integer minor amount', () => {
    const result = validate(builtinT.money, { minor: 19.99, currency: 'EUR' });
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.path).toEqual(['minor']);
  });

  test('rejects a malformed currency code', () => {
    const result = validate(builtinT.money, { minor: 1999, currency: 'eur' });
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.path).toEqual(['currency']);
  });

  test('reports both issues together when minor and currency are both invalid', () => {
    const result = validate(builtinT.money, { minor: 19.99, currency: 'eur' });
    expect(result.issues?.length).toBe(2);
    expect(result.issues?.map((issue) => issue.path)).toEqual([['minor'], ['currency']]);
  });

  test('rejects a non-object', () => {
    expect(validate(builtinT.money, 'money').issues).toBeDefined();
  });

  test('the money node declares exactly minor, currency and an optional scale', () => {
    // The runtime half of `@ultimat3/entity`'s `type-pins.ts`: that file fails the build when the
    // TYPE grows a field, this fails the suite when the IR every generator reads does not grow
    // the same one. A field in one and not the other is a contract two surfaces disagree about.
    const properties = builtinT.money.node.properties ?? {};
    expect(Object.keys(properties)).toEqual(['minor', 'currency', 'scale']);
    expect(properties['scale']?.optional).toBe(true);
    expect(properties['minor']?.optional).toBeUndefined();
    expect(properties['currency']?.optional).toBeUndefined();
  });

  test('rejects a scale that is not a whole number of decimal places', () => {
    const result = validate(builtinT.money, { minor: 2, currency: 'USD', scale: 6.5 });
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.path).toEqual(['scale']);
    expect(validate(builtinT.money, { minor: 2, currency: 'USD', scale: -1 }).issues).toBeDefined();
    expect(
      validate(builtinT.money, { minor: 2, currency: 'USD', scale: '6' }).issues,
    ).toBeDefined();
  });

  test('rejects a scale past the representable maximum', () => {
    // 10^16 is not a safe integer, so a value at that scale could not name its own unit.
    expect(
      validate(builtinT.money, { minor: 2, currency: 'USD', scale: MAX_MONEY_SCALE + 1 }).issues,
    ).toBeDefined();
    expect(
      validate(builtinT.money, { minor: 2, currency: 'USD', scale: MAX_MONEY_SCALE }).issues,
    ).toBeUndefined();
  });

  test('carries an explicit scale through, and adds none to a value without one', () => {
    const scaled = validate(builtinT.money, { minor: 2, currency: 'USD', scale: 6 });
    expect(scaled.issues).toBeUndefined();
    // The sub-cent value the AI cost path could not express: $0.000002, not a rounded-up cent.
    if (scaled.issues === undefined) {
      expect(scaled.value).toEqual({ minor: 2, currency: 'USD', scale: 6 });
    }
    const plain = validate(builtinT.money, { minor: 1999, currency: 'EUR' });
    expect(plain.issues).toBeUndefined();
    if (plain.issues === undefined) expect(Object.keys(plain.value)).toEqual(['minor', 'currency']);
  });

  test('rejects a minor amount past the safe-integer range', () => {
    // `Number.isInteger(2**53)` is true and `money()`/`parseMinor` both refuse it, so accepting
    // it here turned a 422 with a field path into a 500 at the row write.
    const result = validate(builtinT.money, { minor: 9_007_199_254_740_992, currency: 'EUR' });
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.path).toEqual(['minor']);
    expect(
      validate(builtinT.money, { minor: -9_007_199_254_740_992, currency: 'EUR' }).issues,
    ).toBeDefined();
    // The largest amount that IS representable still passes.
    expect(
      validate(builtinT.money, { minor: Number.MAX_SAFE_INTEGER, currency: 'EUR' }).issues,
    ).toBeUndefined();
  });
});
