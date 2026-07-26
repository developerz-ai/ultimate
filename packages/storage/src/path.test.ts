import { describe, expect, test } from 'bun:test';
import { isStorageError } from './errors';
import { assertSafeKey, isWithinOrg, joinKey, scopedKey } from './path';

/** The code, or a description of why there wasn't one — a failing assert then reads clearly. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
  }
  return 'no-error-thrown';
}

const UNSAFE = 'X_STORAGE_PATH_UNSAFE';

describe('assertSafeKey', () => {
  const cases: readonly [string, string][] = [
    ['parent traversal', '../secret.png'],
    ['nested traversal', 'org/o1/../../org/o2/secret.png'],
    ['percent-encoded traversal', '..%2fetc/passwd'],
    ['double-encoded dots', '%2e%2e/etc/passwd'],
    ['absolute key', '/etc/passwd'],
    ['backslash', 'org\\o1\\a.png'],
    ['empty segment', 'org//o1/a.png'],
    ['trailing slash', 'org/o1/'],
    ['empty key', ''],
    ['NUL byte', 'a\u0000.png'],
  ];

  for (const [label, key] of cases) {
    test(`rejects ${label}`, () => {
      expect(codeOf(() => assertSafeKey(key))).toBe(UNSAFE);
    });
  }

  test('accepts an ordinary nested key unchanged', () => {
    expect(assertSafeKey('org/org-1/avatars/a.png')).toBe('org/org-1/avatars/a.png');
  });

  test('accepts a dot inside a segment', () => {
    expect(assertSafeKey('org/org-1/a..b.png')).toBe('org/org-1/a..b.png');
  });
});

describe('scopedKey', () => {
  test('prefixes the tenant', () => {
    expect(scopedKey('org-1', 'avatars', 'a.png')).toBe('org/org-1/avatars/a.png');
  });

  test('validates segments inside a single part', () => {
    expect(scopedKey('org-1', 'avatars/2026/a.png')).toBe('org/org-1/avatars/2026/a.png');
  });

  test('cannot be walked out of the org prefix', () => {
    expect(codeOf(() => scopedKey('org-1', '..', '..', 'org', 'org-2', 'x.png'))).toBe(UNSAFE);
    expect(codeOf(() => scopedKey('org-1', '../org-2/x.png'))).toBe(UNSAFE);
    expect(codeOf(() => scopedKey('org-1', '..%2forg-2/x.png'))).toBe(UNSAFE);
    expect(codeOf(() => scopedKey('org-1/../org-2', 'x.png'))).toBe(UNSAFE);
  });

  test('an org id may not contain a separator', () => {
    expect(codeOf(() => scopedKey('org-1/org-2', 'x.png'))).toBe(UNSAFE);
    expect(codeOf(() => scopedKey('', 'x.png'))).toBe(UNSAFE);
  });
});

describe('isWithinOrg', () => {
  test('a key built for one org never belongs to another', () => {
    const key = scopedKey('org-1', 'avatars', 'a.png');
    expect(isWithinOrg(key, 'org-1')).toBe(true);
    expect(isWithinOrg(key, 'org-2')).toBe(false);
  });

  test('a prefix collision is not containment', () => {
    expect(isWithinOrg(scopedKey('org-10', 'a.png'), 'org-1')).toBe(false);
  });
});

describe('joinKey', () => {
  test('flattens parts that already contain separators', () => {
    expect(joinKey('a', 'b/c', 'd.png')).toBe('a/b/c/d.png');
  });
});
