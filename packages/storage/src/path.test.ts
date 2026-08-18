import { describe, expect, test } from 'bun:test';
import { isStorageError } from './errors';
import { assertSafeKey, isTenantScoped, isWithinOrg, joinKey, META_DIR, scopedKey } from './path';

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

describe('isTenantScoped', () => {
  test('every key scopedKey builds is in the tenant namespace', () => {
    expect(isTenantScoped(scopedKey('org-1', 'avatars', 'a.png'))).toBe(true);
  });

  test('a key nobody scoped belongs to no tenant', () => {
    expect(isTenantScoped('brand/logo.png')).toBe(false);
    // `orgs/` is a different prefix, not a longer spelling of this one.
    expect(isTenantScoped('orgs/org-1/a.png')).toBe(false);
  });

  // `Org/o2/a.png` and `org/o2/a.png` are ONE file on a case-insensitive filesystem (APFS, NTFS),
  // so a case-folded prefix that answered `false` would hand a caller another tenant's object on
  // every macOS dev disk — and the fold is refused outright, because `org/` is the only spelling
  // `scopedKey` ever mints.
  test('a case-folded prefix is still the tenant namespace', () => {
    expect(isTenantScoped('Org/org-2/a.png')).toBe(true);
    expect(isTenantScoped('ORG/org-1/a.png')).toBe(true);
    expect(isWithinOrg('Org/org-1/a.png', 'org-1')).toBe(false);
  });

  test('the two guards together are what makes a foreign key unreadable', () => {
    const foreign = scopedKey('org-2', 'a.png');
    expect(isTenantScoped(foreign) && !isWithinOrg(foreign, 'org-1')).toBe(true);
  });
});

describe('joinKey', () => {
  test('flattens parts that already contain separators', () => {
    expect(joinKey('a', 'b/c', 'd.png')).toBe('a/b/c/d.png');
  });
});

describe('the sidecar namespace is reserved', () => {
  // `.meta/<key>.json` is where the local driver records an object's content type and etag. As a
  // legal key, `put('.meta/a/b.json', '{"contentType":"text/html","etag":"x"}')` overwrote the
  // sidecar for `a/b`, so `head('a/b')` reported text/html and a route serving that object
  // returned attacker HTML from the app's own origin.
  test('a key whose first segment is .meta is refused, on every driver', () => {
    expect(codeOf(() => assertSafeKey('.meta/a/b.json'))).toBe(UNSAFE);
    expect(codeOf(() => assertSafeKey('.meta'))).toBe(UNSAFE);
    expect(codeOf(() => assertSafeKey(joinKey(META_DIR, 'a', 'b.json')))).toBe(UNSAFE);
    expect(codeOf(() => assertSafeKey(scopedKey('o1', META_DIR, 'x.json')))).toBe(
      'no-error-thrown',
    );
  });

  test('.meta anywhere but the first segment is an ordinary key', () => {
    expect(assertSafeKey('org/o1/.meta/a.json')).toBe('org/o1/.meta/a.json');
    expect(assertSafeKey('.metadata/a.json')).toBe('.metadata/a.json');
  });
});
