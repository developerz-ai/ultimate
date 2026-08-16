// The boolean answer AND the property the answer cannot show. Every assertion below the first
// describe is read off the source text on purpose: an early `return` on the first differing
// character answers identically to the XOR accumulator, so the only thing that can tell them
// apart is the shape of the loop. A statistical timing test would be flaky and is not used.

import { describe, expect, test } from 'bun:test';
import { timingSafeEqual } from './timing-safe-equal';

const SOURCE = await Bun.file(`${import.meta.dir}/timing-safe-equal.ts`).text();
const DECLARATION = 'export function timingSafeEqual';
const start = SOURCE.indexOf(DECLARATION);
/** The function alone — a helper a later edit adds beside it is not part of this claim. */
const BODY = start === -1 ? '' : SOURCE.slice(start, SOURCE.indexOf('\n}', start) + 2);

describe('timingSafeEqual', () => {
  test('true for identical strings', () => {
    expect(timingSafeEqual('a-secret-token', 'a-secret-token')).toBe(true);
  });

  test('false when lengths differ', () => {
    expect(timingSafeEqual('short', 'longer-value')).toBe(false);
  });

  test('false for same-length strings that differ', () => {
    expect(timingSafeEqual('aaaaaaaa', 'aaaaaaab')).toBe(false);
  });

  test('true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  test('detects a difference at the very first character, not just the last', () => {
    expect(timingSafeEqual('zbbbbbbb', 'abbbbbbb')).toBe(false);
  });
});

describe('timingSafeEqual is branch-free, asserted from its source', () => {
  test('the module still declares the function this file reads', () => {
    expect(BODY).toStartWith(DECLARATION);
  });

  test('the loop accumulates with `diff |=`, so every character is read whatever the answer', () => {
    // Replacing this line with `if (a.charCodeAt(i) !== b.charCodeAt(i)) return false` survives
    // 1,108 tests across core + auth + storage, and restores the character-by-character oracle
    // on session tokens, api keys, verification tokens and storage signatures alike.
    expect(BODY).toContain('diff |= a.charCodeAt(index) ^ b.charCodeAt(index);');
  });

  test('the only `return false` is the length guard, and it sits above the loop', () => {
    expect(BODY.split('return false').length - 1).toBe(1);
    expect(BODY.indexOf('return false')).toBeLessThan(BODY.indexOf('for ('));
  });

  test('the comparison loop carries no branch and no early exit', () => {
    const loop = BODY.slice(BODY.indexOf('for ('), BODY.lastIndexOf('return'));
    for (const exit of ['return', 'break', 'continue', 'if (', '&&', '||', '?']) {
      expect(loop).not.toContain(exit);
    }
  });
});
