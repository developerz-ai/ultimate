// A fingerprint is a query's identity: the read-cache key and the scope a cursor is signed
// against. Two different inputs sharing one fingerprint is one caller served another's rows from
// the tier, and one read's cursor paging another's.

import { expect, test } from 'bun:test';
import { fingerprint, stableStringify } from './stable';

test('key order is not identity', () => {
  expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
});

test('the four values that used to fingerprint as null are four fingerprints', () => {
  const inputs = [
    { n: Number.NaN },
    { n: Number.POSITIVE_INFINITY },
    { n: Number.NEGATIVE_INFINITY },
    { n: null },
  ];
  expect(new Set(inputs.map(fingerprint)).size).toBe(4);
});

test('-0 and 0 are different keys, because they are different values', () => {
  expect(fingerprint({ n: -0 })).not.toBe(fingerprint({ n: 0 }));
});

test('a bare token cannot be spelled by a string, so nothing collides the other way', () => {
  for (const [number, text] of [
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
  ] as const) {
    expect(fingerprint({ n: number })).not.toBe(fingerprint({ n: text }));
  }
});

test('the canonical form is untouched — the digest changed, the serialization did not', () => {
  expect(stableStringify({ limit: 50, ratio: 1.5, cursor: 'abc' })).toBe(
    '{"cursor":"abc","limit":50,"ratio":1.5}',
  );
});

/**
 * A fingerprint is a SHARING key over input a client chooses — the read-cache entry two callers
 * may be served from, and the scope a cursor is bound to. 32 bits of FNV-1a is a collision anyone
 * finds offline in seconds, which is the same argument `@ultimat3/realtime` moved its `qid` on;
 * `stableDigest` there is the primitive this matches, not the code.
 */
test('a fingerprint is SHA-256, 64 bits wide — never a 32-bit non-cryptographic hash', () => {
  const digest = fingerprint({ q: 'all' });
  expect(digest).toMatch(/^[0-9a-f]{16}$/);
  expect(digest).toBe(
    new Bun.CryptoHasher('sha256')
      .update(stableStringify({ q: 'all' }))
      .digest('hex')
      .slice(0, 16),
  );
});
