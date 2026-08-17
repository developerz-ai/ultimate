// The fingerprint is a SHARING key over client-chosen input — it decides "same request, replay
// the stored response" and which enqueued job is a duplicate — so its width is a security fact,
// not a formatting one. FNV-1a/32 was 4x10^9 values, brute-forceable offline in seconds.

import { describe, expect, test } from 'bun:test';
import { canonicalJson, fingerprint, stableStringify } from './stable';

describe('fingerprint', () => {
  test('is a 16-hex-character SHA-256 prefix, the width the other three packages chose', () => {
    const value = fingerprint({ amount: 100, currency: 'EUR' });
    expect(value).toMatch(/^[0-9a-f]{16}$/);
    expect(value).toBe(
      new Bun.CryptoHasher('sha256')
        .update(canonicalJson({ amount: 100, currency: 'EUR' }))
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

/**
 * The half `stableStringify` cannot do, and the reason there are two functions.
 *
 * A fingerprint is an IDENTITY: `requestHash` decides "same request, replay the stored response"
 * and `job-handle.ts` files an enqueue under it. Folding `NaN`, `±Infinity` and JSON `null` onto
 * one token is four requests sharing one idempotency record — one caller handed another's stored
 * response — and `String(-0)` is `"0"`, so `-0` and `0` were one record too.
 */
describe('canonicalJson is the HASH form, and it is injective where JSON is not', () => {
  test('the four values JSON folds onto `null` are four fingerprints', () => {
    const inputs = [
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { n: Number.NEGATIVE_INFINITY },
      { n: null },
    ];
    expect(new Set(inputs.map(fingerprint)).size).toBe(4);
  });

  test('-0 and 0 are two amounts, so they are two fingerprints', () => {
    expect(fingerprint({ amount: -0 })).not.toBe(fingerprint({ amount: 0 }));
  });

  test('a bare token cannot collide with the string that spells it', () => {
    const pairs = [
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [Number.NEGATIVE_INFINITY, '-Infinity'],
      [-0, '-0'],
    ] as const;
    for (const [number, text] of pairs) {
      expect(fingerprint({ n: number })).not.toBe(fingerprint({ n: text }));
    }
  });

  test('an ordinary payload is byte-identical to the document form, so no shipped record moves', () => {
    const input = { amount: 100, currency: 'EUR', items: [1, 2.5, null], ok: true, id: 7n };
    expect(canonicalJson(input)).toBe(stableStringify(input));
  });
});

/**
 * And the half `canonicalJson` may not do. `serializeOpenApi` publishes this string as
 * `openapi.json` and `json-schema.ts` re-reads it with `JSON.parse`, so the bare token `NaN` would
 * make a published spec unparseable — which is why the two duties are two functions and not one.
 */
describe('stableStringify keeps the DOCUMENT duty: what it emits is valid JSON', () => {
  test('a non-finite number is `null`, because `NaN` is not a JSON token', () => {
    const document = stableStringify({ maximum: Number.POSITIVE_INFINITY, minimum: Number.NaN }, 2);
    expect(JSON.parse(document)).toEqual({ maximum: null, minimum: null });
  });
});
