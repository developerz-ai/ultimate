// Two vectors, per the original issue's own criterion — a short known-good string, and a
// production-length short URL of the shape an app actually mints. A version-1-only encoder
// passes the first and throws on the second; this file exists so that regression is caught here
// rather than on a real page.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { payloadCapacityBytes } from './qr-encode';
import { encodeQr, type QrMatrix, quietZoneOf } from './qr-matrix';

/** Every module in a finder pattern's core 3x3, at every one of the three corners, plus the
 *  single fixed dark module — the fastest structural check that placement ran at all. */
function darkCount(matrix: QrMatrix): number {
  return matrix.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}

describe('encodeQr', () => {
  test('a short known-good string encodes at version 1', () => {
    const matrix = encodeQr('HELLO WORLD');
    expect(matrix.version).toBe(1);
    expect(matrix.size).toBe(21);
    expect(matrix.modules).toHaveLength(21);
    expect(matrix.modules.every((row) => row.length === 21)).toBe(true);
    // Every finder pattern's center module (the darkest point of its concentric-square core) is
    // dark — the three corners a scanner locks onto first.
    for (const [row, col] of [
      [3, 3],
      [3, matrix.size - 4],
      [matrix.size - 4, 3],
    ] as const) {
      expect(matrix.modules[row]?.[col]).toBe(true);
    }
    expect(darkCount(matrix)).toBeGreaterThan(0);
  });

  test('a full-length short URL of the shape an app mints needs version 2 or 3', () => {
    const url = 'https://developerz.ai/a1b2c3';
    expect(url.length).toBeGreaterThanOrEqual(25);
    expect(url.length).toBeLessThanOrEqual(30);

    const matrix = encodeQr(url);
    // A version-1-only encoder throws here — version 1's byte-mode capacity at level M is 14
    // bytes, twelve short of this vector. This is the assertion that catches that regression.
    expect(matrix.version).toBeGreaterThanOrEqual(2);
    expect(matrix.version).toBeLessThanOrEqual(3);
    expect(matrix.size).toBe(4 * matrix.version + 17);
    expect(matrix.modules).toHaveLength(matrix.size);
  });

  test("a payload past version 3's ceiling is refused, not truncated", () => {
    const tooLong = `https://developerz.ai/${'a'.repeat(40)}`;
    expect(() => encodeQr(tooLong)).toThrow();
    try {
      encodeQr(tooLong);
    } catch (error) {
      expect(error).toBeUltimateError(UI_ERROR_CODES.qrCapacity);
      expect((error as { code: string }).code).toBe('X_UI_QR_CAPACITY');
      expect((error as { cause: string }).cause).toContain('62 bytes');
      expect((error as { cause: string }).cause).toContain('42-byte ceiling');
    }
  });

  test('the ceilings are 14, 26 and 42 bytes, and a value exactly at one still fits', () => {
    expect([1, 2, 3].map(payloadCapacityBytes)).toEqual([14, 26, 42]);
    expect(encodeQr('a'.repeat(14)).version).toBe(1);
    expect(encodeQr('a'.repeat(15)).version).toBe(2);
    expect(encodeQr('a'.repeat(42)).version).toBe(3);
    expect(() => encodeQr('a'.repeat(43))).toThrow();
  });

  test('the same text encodes identically every time — no clock, no randomness', () => {
    const a = encodeQr('https://developerz.ai/abcdef');
    const b = encodeQr('https://developerz.ai/abcdef');
    expect(a.modules).toEqual(b.modules);
  });
});

describe('quietZoneOf', () => {
  test('a whole non-negative count is kept; anything else is the default four', () => {
    expect(quietZoneOf(undefined)).toBe(4);
    expect(quietZoneOf(0)).toBe(0);
    expect(quietZoneOf(2)).toBe(2);
    expect(quietZoneOf(Number.NaN)).toBe(4);
    expect(quietZoneOf(-1)).toBe(4);
    expect(quietZoneOf(1.5)).toBe(4);
    expect(quietZoneOf(Number.POSITIVE_INFINITY)).toBe(4);
  });
});
