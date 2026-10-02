import { describe, expect, test } from 'bun:test';
import { containsSecret } from './secret-scan';

describe('unit · containsSecret finds a secret in text without an early-exit compare', () => {
  test('a secret anywhere in the text is found', () => {
    expect(containsSecret('{"user":"a","pw":"hunter22"}', 'hunter22')).toBe(true);
    expect(containsSecret('hunter22 first', 'hunter22')).toBe(true);
    expect(containsSecret('last hunter22', 'hunter22')).toBe(true);
  });

  test('a prefix of the secret is not the secret', () => {
    expect(containsSecret('{"pw":"hunter2"}', 'hunter22')).toBe(false);
  });

  test('text shorter than the secret, and an empty secret, contain nothing', () => {
    expect(containsSecret('hun', 'hunter22')).toBe(false);
    expect(containsSecret('anything', '')).toBe(false);
  });
});
