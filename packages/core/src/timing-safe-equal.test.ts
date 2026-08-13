import { describe, expect, test } from 'bun:test';
import { timingSafeEqual } from './timing-safe-equal';

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
