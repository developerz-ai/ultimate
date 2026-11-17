// The trailing-slash trim: what `/\/+$/` answered, in linear time on the input that made it slow.

import { describe, expect, test } from 'bun:test';
import { trimTrailingSlashes } from './trailing-slashes';

describe('unit · core · trimTrailingSlashes', () => {
  test('answers what the regex answered', () => {
    for (const value of ['', '/', '///', 'a', 'a/', 'a///', '/a/b/', 'https://x.test//', 'a/b']) {
      expect(trimTrailingSlashes(value)).toBe(value.replace(/\/+$/, ''));
    }
  });

  test('a long slash run followed by another character is linear', () => {
    const hostile = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
