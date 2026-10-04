// FNV-1a/32 lives once: `@ultimat3/flags` buckets a rollout with it and `@ultimat3/testing` seeds a
// factory's id stream with it, and a second copy of a hash two nodes must agree on is a copy that
// can drift from the first.

import { describe, expect, test } from 'bun:test';
import { fnv1a } from './fnv1a';

describe('fnv1a', () => {
  test('is the published 32-bit FNV-1a, so two nodes agree without talking', () => {
    // Reference vectors from the FNV specification.
    expect(fnv1a('')).toBe(0x811c_9dc5);
    expect(fnv1a('a')).toBe(0xe40c_292c);
    expect(fnv1a('foobar')).toBe(0xbf9c_f968);
  });

  test('is an unsigned 32-bit integer for every input', () => {
    for (const text of ['x', 'posts', 'billing.export:org-42', '😀'.repeat(50)]) {
      const hash = fnv1a(text);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });
});
