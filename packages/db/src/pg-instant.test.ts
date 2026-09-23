// The one reader of Postgres' TEXT form of a timestamp. Both embedded and pooled drivers parsed it
// with `new Date(text)`-like logic: year `0099` came back as 1999, and under a non-UTC session an
// offset carrying seconds (`-04:56:02`, New York's local mean time before 1883) was Invalid Date —
// which `@ultimat3/entity` then refused as `X_INVARIANT_VIOLATED` on a whole-row read.

import { describe, expect, test } from 'bun:test';
import { parsePgTimestamp, parsePgTimestamptz } from './pg-instant';

const iso = (value: Date): string => value.toISOString();

describe('unit · parsePgTimestamptz', () => {
  test('the everyday form, with and without fractional seconds', () => {
    expect(iso(parsePgTimestamptz('2026-01-01 00:00:00+00'))).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(parsePgTimestamptz('2025-12-31 19:00:00.123456-05'))).toBe(
      '2026-01-01T00:00:00.123Z',
    );
    expect(iso(parsePgTimestamptz('2026-01-01 05:30:00+05:30'))).toBe('2026-01-01T00:00:00.000Z');
  });

  test('a year below 1000 is that year, never 19xx', () => {
    expect(iso(parsePgTimestamptz('0099-06-01 00:00:00+00'))).toBe('0099-06-01T00:00:00.000Z');
    expect(iso(parsePgTimestamptz('0001-01-01 00:00:00+00'))).toBe('0001-01-01T00:00:00.000Z');
  });

  test('an offset carrying seconds — local mean time — is the instant it names', () => {
    expect(iso(parsePgTimestamptz('0099-05-31 19:03:58-04:56:02'))).toBe(
      '0099-06-01T00:00:00.000Z',
    );
    expect(iso(parsePgTimestamptz('1900-01-01 12:19:32+00:19:32'))).toBe(
      '1900-01-01T12:00:00.000Z',
    );
  });

  test('BC is a negative astronomical year', () => {
    // 1 BC is astronomical year 0; 44 BC is -43.
    expect(parsePgTimestamptz('0044-03-15 12:00:00+00 BC').getUTCFullYear()).toBe(-43);
  });

  test('infinity is the far end of the Date range, never Invalid Date', () => {
    expect(parsePgTimestamptz('infinity').getTime()).toBe(8.64e15);
    expect(parsePgTimestamptz('-infinity').getTime()).toBe(-8.64e15);
  });
});

describe('unit · parsePgTimestamp (no zone)', () => {
  // `timestamp` carries no zone, so it is read as UTC — never through the host process's zone.
  test('is read as UTC whatever the host TZ', () => {
    expect(iso(parsePgTimestamp('2026-01-01 00:00:00'))).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(parsePgTimestamp('0099-06-01 00:00:00'))).toBe('0099-06-01T00:00:00.000Z');
  });
});
