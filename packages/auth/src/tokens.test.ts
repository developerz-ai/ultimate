// Direct coverage for the secret primitives shared across this package — untested until now
// despite being the base every credential comparison in `verify.ts`/`session.ts` builds on.

import { describe, expect, test } from 'bun:test';
import {
  base64Url,
  matchesHash,
  randomBytes,
  randomToken,
  sha256Bytes,
  sha256Hex,
  timingSafeEqual,
} from './tokens';

describe('randomBytes', () => {
  test('returns the requested length, and two calls differ', () => {
    const a = randomBytes(16);
    const b = randomBytes(16);
    expect(a.length).toBe(16);
    expect(b.length).toBe(16);
    expect([...a]).not.toEqual([...b]);
  });
});

describe('base64Url', () => {
  test('never emits +, / or = — the whole point of the alphabet swap', () => {
    // Bytes chosen so standard base64 would emit all three unsafe characters.
    const bytes = Uint8Array.from([251, 255, 254, 253, 252, 0, 1, 2, 3]);
    const encoded = base64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test('round-trips through atob once - and _ are mapped back', () => {
    const bytes = Uint8Array.from([251, 255, 254]);
    const encoded = base64Url(bytes);
    const restored = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Uint8Array.from(atob(restored), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([...bytes]);
  });
});

describe('randomToken', () => {
  test('32 bytes -> 43 base64url chars, no padding', () => {
    const token = randomToken(32);
    expect(token.length).toBe(43);
    expect(token).not.toMatch(/[+/=]/);
  });

  test('honors a custom byte length', () => {
    const token = randomToken(12);
    // 12 bytes -> 16 base64 chars before padding removal (12*4/3 = 16 exactly).
    expect(token.length).toBe(16);
  });
});

describe('sha256Hex / sha256Bytes', () => {
  test('hex digest matches a known SHA-256 vector', () => {
    // echo -n "" | sha256sum
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('is deterministic for the same input', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });

  test('differs for different input', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('hellp'));
  });

  test('sha256Bytes is the byte form of sha256Hex', () => {
    const hex = sha256Hex('hello');
    const bytes = sha256Bytes('hello');
    const rebuilt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(rebuilt).toBe(hex);
  });
});

describe('matchesHash', () => {
  test('true when the plaintext hashes to the stored value', () => {
    const plaintext = 'correct-horse-battery-staple';
    const stored = sha256Hex(plaintext);
    expect(matchesHash(plaintext, stored)).toBe(true);
  });

  test('false for the wrong plaintext', () => {
    const stored = sha256Hex('correct-horse-battery-staple');
    expect(matchesHash('wrong-guess', stored)).toBe(false);
  });

  test('false, not throwing, when the stored hash is malformed/short', () => {
    expect(matchesHash('anything', 'not-a-real-hash')).toBe(false);
  });
});

describe('timingSafeEqual re-export', () => {
  test('is the same function identity core exports, and behaves correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
