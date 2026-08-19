// A fingerprint is a SHARING key over input a client chooses: it decides "same request, replay the
// stored response" (`@ultimat3/action`), which read-cache entry and which cursor scope two callers
// share (`@ultimat3/query`) and which subscribers are served out of one live window
// (`@ultimat3/realtime`). So two distinct inputs sharing one string is a leak, and its width is a
// security fact rather than a formatting one — FNV-1a/32, which two of the three copies started
// as, is 4x10^9 values and brute-forceable offline in seconds.

import { describe, expect, test } from 'bun:test';
import { canonicalJson, fingerprint } from './canonical-json';

describe('fingerprint', () => {
  test('is a 16-hex-character SHA-256 prefix over the canonical form', () => {
    const value = fingerprint({ amount: 100, currency: 'EUR' });
    expect(value).toMatch(/^[0-9a-f]{16}$/);
    // Computed here rather than through the function under test, so swapping the primitive under
    // it is a failing test instead of a green one that agrees with itself.
    expect(value).toBe(
      new Bun.CryptoHasher('sha256')
        .update(canonicalJson({ amount: 100, currency: 'EUR' }))
        .digest('hex')
        .slice(0, 16),
    );
  });

  test('is key-order independent, because a key must survive a re-serialization', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  test('two different payloads are two hashes', () => {
    expect(fingerprint({ amount: 100 })).not.toBe(fingerprint({ amount: 101 }));
  });

  test('keeps array order, which is data rather than spelling', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

/**
 * The values JSON cannot tell apart. `JSON.stringify` answers `"null"` for `NaN` and `±Infinity`,
 * which also collides with JSON `null` itself, and `"0"` for `-0` — so four distinct inputs shared
 * one idempotency record, one cache entry, one cursor scope and one live window.
 */
describe('canonicalJson is injective where JSON is not', () => {
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

  test('null is not the text that spells it', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('null')).toBe('"null"');
  });
});

/**
 * The other half, and the one an app hits first: `t.date` parses an input field into a `Date`,
 * which has no own enumerable key — so the object branch rendered it `{}`, and so did a `Map` and
 * a `Set`. In `@ultimat3/action` that was two calls under one `Idempotency-Key` with two DIFFERENT
 * dates handed one stored response; in `@ultimat3/query` it was every date window of one read
 * sharing a single cache entry, a single cursor scope and a single live query id.
 */
describe('canonicalJson is injective over the values a PARSED input holds', () => {
  test('two dates are two fingerprints, and neither is the empty object', () => {
    const early = { at: new Date('2020-01-01T00:00:00.000Z') };
    const late = { at: new Date('2021-06-30T12:00:00.000Z') };
    expect(fingerprint(early)).not.toBe(fingerprint(late));
    expect(fingerprint(early)).not.toBe(fingerprint({ at: {} }));
  });

  test('a date is not the number that spells its epoch, nor the string that spells it', () => {
    const at = new Date('2020-01-01T00:00:00.000Z');
    expect(fingerprint({ at })).not.toBe(fingerprint({ at: at.getTime() }));
    expect(fingerprint({ at })).not.toBe(fingerprint({ at: at.toISOString() }));
  });

  test('an Invalid Date is its own value, not the NaN it holds', () => {
    expect(fingerprint({ at: new Date(Number.NaN) })).not.toBe(fingerprint({ at: Number.NaN }));
  });

  test('a Map, a Set, an empty object and an empty array are four fingerprints', () => {
    const values: unknown[] = [
      { x: new Map([['a', 1]]) },
      { x: new Set([1, 2]) },
      { x: {} },
      { x: [] },
    ];
    expect(new Set(values.map(fingerprint)).size).toBe(4);
  });

  test('two maps differing only in a value are two fingerprints', () => {
    expect(fingerprint({ x: new Map([['a', 1]]) })).not.toBe(
      fingerprint({ x: new Map([['a', 2]]) }),
    );
  });

  test('insertion order is not what a map holds, so one payload stays one key', () => {
    const forward = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const backward = new Map<string, number>([
      ['b', 2],
      ['a', 1],
    ]);
    expect(fingerprint({ x: forward })).toBe(fingerprint({ x: backward }));
    expect(fingerprint({ x: new Set([1, 2]) })).toBe(fingerprint({ x: new Set([2, 1]) }));
  });
});

/**
 * What did NOT move when the three copies became this one. Every key already issued — an
 * idempotency record, a signed cursor's scope, a live query id — was produced by one of them over
 * a payload of exactly this shape, so the bytes are pinned literally rather than by agreeing with
 * whatever the function currently emits.
 */
describe('an ordinary payload is byte-for-byte what all three copies already emitted', () => {
  test('the wire shape a subscribe frame or a query string decodes to', () => {
    expect(canonicalJson({ orgId: 'org-a', limit: 50, ratio: 1.5, ok: true, tail: null })).toBe(
      '{"limit":50,"ok":true,"orgId":"org-a","ratio":1.5,"tail":null}',
    );
  });

  test('an undefined-valued key is dropped, exactly as an omitted key is', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(fingerprint({ a: undefined, b: 1 })).toBe(fingerprint({ b: 1 }));
  });

  test('a bigint is tagged text, because JSON has none', () => {
    expect(canonicalJson({ id: 7n })).toBe('{"id":"7n"}');
  });
});
