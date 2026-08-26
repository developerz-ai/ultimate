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

  // The reservation was exact-case, so `.META/a.txt.json` was a legal key that `put()` wrote to
  // `<root>/.META/a.txt.json` — which on APFS or NTFS IS `<root>/.meta/a.txt.json`, the sidecar
  // for object `a.txt`. The whole attack the reservation closes, spelled with a shift key.
  // `isTenantScoped` folds for the same filesystem reason; this is that argument applied here.
  test('a case-folded .meta is the same reserved segment', () => {
    expect(codeOf(() => assertSafeKey('.META/a/b.json'))).toBe(UNSAFE);
    expect(codeOf(() => assertSafeKey('.Meta/a.txt.json'))).toBe(UNSAFE);
    expect(codeOf(() => assertSafeKey('.META'))).toBe(UNSAFE);
  });

  // The fold matches the SEGMENT, never a prefix of one: `.metadata/a.json` is asserted legal one
  // test up, and a `startsWith` would have made this fix delete a key space the tests already pin.
  test('and a segment that merely starts with .meta is still legal', () => {
    expect(assertSafeKey('.METADATA/a.json')).toBe('.METADATA/a.json');
    expect(assertSafeKey('.metaphor.txt')).toBe('.metaphor.txt');
  });
});

/**
 * "S3's own limit", says the constant — and S3's limit is 1,024 **UTF-8 bytes**, while the guard
 * counted UTF-16 code units and the message said "chars". Neither number is the one the store
 * enforces, and the two disagree in the dangerous direction: `.length` is never MORE than the
 * UTF-8 byte count, so a non-ASCII key over the real limit passed this check and was refused by
 * S3 at PUT time — the exact "keeping local and remote disks interchangeable requires the same
 * ceiling" this constant exists for. Same defect and same fix as `@ultimat3/cache`'s surrogate-key
 * guard, which measured a 1,024-BYTE CDN limit in code units.
 */
describe('the key ceiling is the one the store enforces: UTF-8 bytes', () => {
  test('a key under the limit in characters and over it in bytes is refused', () => {
    // 400 three-byte characters: 400 code units, 1,200 UTF-8 bytes.
    const key = '中'.repeat(400);
    expect(key.length).toBeLessThan(1024);
    expect(new TextEncoder().encode(key).byteLength).toBeGreaterThan(1024);
    expect(codeOf(() => assertSafeKey(key))).toBe(UNSAFE);
  });

  test('the refusal counts bytes and says bytes', () => {
    let message = '';
    try {
      assertSafeKey('中'.repeat(400));
    } catch (error) {
      message = isStorageError(error) ? error.cause : '';
    }
    expect(message).toContain('1200 bytes');
    expect(message).not.toContain('chars');
  });

  test('exactly at the limit passes, one byte over does not', () => {
    expect(codeOf(() => assertSafeKey('a'.repeat(1024)))).toBe('no-error-thrown');
    expect(codeOf(() => assertSafeKey('a'.repeat(1025)))).toBe(UNSAFE);
    // 1,023 ASCII + one two-byte character is 1,025 bytes and 1,024 code units.
    expect(codeOf(() => assertSafeKey(`${'a'.repeat(1023)}é`))).toBe(UNSAFE);
  });

  test('a multi-byte key that fits in bytes is still a key', () => {
    // 341 three-byte characters is 1,023 bytes: under the ceiling on the wire, so not this rule's.
    expect(codeOf(() => assertSafeKey('中'.repeat(341)))).toBe('no-error-thrown');
  });
});
