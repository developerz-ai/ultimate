// The fingerprint is a SHARING key over client-chosen input — it decides "same request, replay
// the stored response" and which enqueued job is a duplicate — so its width is a security fact,
// not a formatting one. FNV-1a/32 was 4x10^9 values, brute-forceable offline in seconds.

import { describe, expect, test } from 'bun:test';
import { fingerprint, stableStringify } from './stable';

describe('fingerprint', () => {
  test('is a 16-hex-character SHA-256 prefix, the width the other three packages chose', () => {
    const value = fingerprint({ amount: 100, currency: 'EUR' });
    expect(value).toMatch(/^[0-9a-f]{16}$/);
    expect(value).toBe(
      new Bun.CryptoHasher('sha256')
        .update(stableStringify({ amount: 100, currency: 'EUR' }))
        .digest('hex')
        .slice(0, 16),
    );
  });

  test('is key-order independent, because the request hash must survive a re-serialization', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  test('two different payloads are two hashes', () => {
    expect(fingerprint({ amount: 100 })).not.toBe(fingerprint({ amount: 101 }));
  });
});
