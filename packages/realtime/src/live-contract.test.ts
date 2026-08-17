// What a `qid` has to be. It is derived from client-chosen input and then used as a SHARING key —
// `#entryFor` hands back an existing entry on a hit, and that entry carries the FIRST subscriber's
// input, its compiled window and its rows. So a second input that hashes to the same value is
// served another tenant's result set after passing `authorize` against its own input.

import { describe, expect, test } from 'bun:test';
import { canonicalJson, stableDigest } from './json';
import { qidOf } from './live-contract';

describe('qidOf', () => {
  test('is a cryptographic digest of the canonical input, not a 32-bit checksum', () => {
    const input = { orgId: 'o1', limit: 50 };
    // Hand-computed here rather than through `stableDigest`, so swapping the hash under it is a
    // failing test and not a green one that agrees with itself. 4x10^9 values is a collision an
    // attacker finds offline in seconds, and the qid is what decides whose window you are served.
    const expected = new Bun.CryptoHasher('sha256')
      .update(canonicalJson(input))
      .digest('hex')
      .slice(0, 16);

    expect(qidOf('liveFeed', input)).toBe(`liveFeed:${expected}`);
    expect(expected).toHaveLength(16);
  });

  test('is stable across property order and distinct per input and per query', () => {
    expect(qidOf('liveFeed', { a: 1, b: 2 })).toBe(qidOf('liveFeed', { b: 2, a: 1 }));
    expect(qidOf('liveFeed', { orgId: 'o1' })).not.toBe(qidOf('liveFeed', { orgId: 'o2' }));
    expect(qidOf('liveFeed', { orgId: 'o1' })).not.toBe(qidOf('otherFeed', { orgId: 'o1' }));
  });

  test('the name stays readable, so a log line still says which query', () => {
    expect(qidOf('liveFeed', null).startsWith('liveFeed:')).toBe(true);
  });
});

describe('stableDigest', () => {
  test('is 16 hex characters — 64 bits, the width entity cursors already chose', () => {
    expect(stableDigest('anything')).toMatch(/^[0-9a-f]{16}$/);
    expect(stableDigest('a')).not.toBe(stableDigest('b'));
    expect(stableDigest('a')).toBe(stableDigest('a'));
  });
});
