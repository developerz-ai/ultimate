import { describe, expect, test } from 'bun:test';
import { instantMicros, microsToIso, pgInstantMicros, seekAlias } from './instant';

describe('pgInstantMicros', () => {
  test('reads every microsecond Postgres printed', () => {
    expect(pgInstantMicros('2026-01-01 00:00:00.123456')).toBe(1_767_225_600_123_456n);
  });

  test('pads a truncated fraction on the RIGHT — .1 is a tenth, not one microsecond', () => {
    expect(pgInstantMicros('2026-01-01 00:00:00.1')).toBe(1_767_225_600_100_000n);
    expect(pgInstantMicros('2026-01-01 00:00:00.000001')).toBe(1_767_225_600_000_001n);
  });

  test('an absent fraction is the whole second', () => {
    expect(pgInstantMicros('2026-01-01 00:00:00')).toBe(1_767_225_600_000_000n);
  });

  test('the fraction runs FORWARD from a pre-epoch second boundary', () => {
    // 1900-01-01T00:00:00Z is -2208988800s; the microseconds are later than that, never earlier.
    expect(pgInstantMicros('1900-01-01 00:00:00.000001')).toBe(-2_208_988_799_999_999n);
  });

  test('a year Date.UTC would fold into the 1900s is that year', () => {
    expect(pgInstantMicros('0044-03-15 00:00:00')).toBe(
      BigInt(Date.parse('0044-03-15T00:00:00Z')) * 1000n,
    );
  });

  test('text that is not an instant is undefined, never a guess', () => {
    for (const text of ['', 'now', '2026-01-01', '0044-03-15 00:00:00 BC', 42, null, undefined]) {
      expect(pgInstantMicros(text)).toBeUndefined();
    }
  });
});

describe('instantMicros', () => {
  test('a Date is milliseconds, so its microseconds are zero', () => {
    expect(instantMicros(new Date('2026-01-01T00:00:00.123Z'))).toBe(1_767_225_600_123_000n);
  });

  test('a bigint is already the answer', () => {
    expect(instantMicros(1_767_225_600_123_456n)).toBe(1_767_225_600_123_456n);
  });

  test('a decimal string is what a cursor carries', () => {
    expect(instantMicros('-2208988799999999')).toBe(-2_208_988_799_999_999n);
  });

  test('anything else is undefined', () => {
    for (const value of [new Date(Number.NaN), {}, 'x', 12.5, null, undefined]) {
      expect(instantMicros(value)).toBeUndefined();
    }
  });
});

describe('microsToIso', () => {
  test('round-trips every microsecond, which toISOString() alone cannot', () => {
    for (const micros of [
      1_767_225_600_123_456n,
      1_767_225_600_000_001n,
      1_767_225_600_000_000n,
      1_767_225_600_999_999n,
      -2_208_988_799_999_999n,
    ]) {
      expect(pgInstantMicros(microsToIso(micros).replace('T', ' ').replace('Z', ''))).toBe(micros);
    }
  });

  test('the fraction is always six digits', () => {
    expect(microsToIso(1_767_225_600_100_000n)).toBe('2026-01-01T00:00:00.100000Z');
    expect(microsToIso(1_767_225_600_000_000n)).toBe('2026-01-01T00:00:00.000000Z');
  });

  test('a pre-epoch instant floors to its own second, never toward zero', () => {
    expect(microsToIso(-2_208_988_799_999_999n)).toBe('1900-01-01T00:00:00.000001Z');
  });
});

describe('seekAlias', () => {
  test('carries a marker no physical column name can hold', () => {
    // Every physical name is lower case: `snake(property)` lower-cases and `assertColumnName`
    // refuses anything outside `[a-z_][a-z0-9_$]*`.
    expect(seekAlias('created_at')).toBe('created_at$US');
    expect(seekAlias('created_at')).not.toBe(seekAlias('created_at').toLowerCase());
  });
});
