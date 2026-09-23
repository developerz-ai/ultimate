// The write digest and its server scope: the page and the node must compute the SAME name from one
// key, a frame must never carry the key itself, and the scope is a label — never a gate.

import { describe, expect, test } from 'bun:test';
import { isWriteDigest, WRITE_DIGEST_LENGTH, writeDigest } from './write-digest';
import { currentWriteOrigin, withWriteOrigin } from './write-origin';

describe('writeDigest', () => {
  test('is SHA-256 of the key, hex, cut to the declared length — the same on every runtime', async () => {
    const key = 'likePost:0192f0c4-0000-7000-8000-000000000001';
    const full = new Bun.CryptoHasher('sha256').update(key).digest('hex');
    const digest = await writeDigest(key);
    expect(digest).toBe(full.slice(0, WRITE_DIGEST_LENGTH));
    expect(digest?.includes('likePost')).toBe(false);
    expect(isWriteDigest(digest)).toBe(true);
  });

  test('two keys, two names', async () => {
    expect(await writeDigest('likePost:a')).not.toBe(await writeDigest('likePost:b'));
  });

  test('answers undefined where the runtime has no crypto.subtle', async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      expect(await writeDigest('likePost:a')).toBeUndefined();
    } finally {
      if (real !== undefined) Object.defineProperty(globalThis, 'crypto', real);
    }
  });

  test('isWriteDigest admits only the minted shape', () => {
    expect(isWriteDigest('a'.repeat(32))).toBe(true);
    expect(isWriteDigest('A'.repeat(32))).toBe(false);
    expect(isWriteDigest('a'.repeat(33))).toBe(false);
    expect(isWriteDigest('likePost:0192')).toBe(false);
    expect(isWriteDigest(undefined)).toBe(false);
  });
});

describe('withWriteOrigin', () => {
  test('names the write across an await, and nothing outside it', async () => {
    const digest = 'b'.repeat(32);
    expect(currentWriteOrigin()).toBeUndefined();
    const seen = await withWriteOrigin(digest, async () => {
      await Bun.sleep(0);
      return currentWriteOrigin();
    });
    expect(seen).toBe(digest);
    expect(currentWriteOrigin()).toBeUndefined();
  });

  test('a value that is not a digest runs the work unnamed, never refused', () => {
    expect(withWriteOrigin('likePost:raw-key', () => currentWriteOrigin())).toBeUndefined();
    expect(withWriteOrigin(undefined, () => currentWriteOrigin())).toBeUndefined();
  });
});
