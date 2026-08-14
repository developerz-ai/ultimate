// `permissions.ts` is the declaration + runtime-membership layer under every policy. These
// tests exercise the exports policy.test.ts only reaches indirectly through `can()`: the
// `PermissionSet` returned by `definePermissions`, the module-global registry functions, and
// the `resource:verb` parsing helpers.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  assertPermission,
  clearPermissions,
  definePermissions,
  isKnownPermission,
  knownPermissions,
  resourceOf,
  verbOf,
} from './permissions';

// The registry is process-global by design — one app, one permission set. Every test here
// must hand the process back the way it found it, or an unrelated file's `can()` throws
// X_PERMISSION_UNKNOWN for a permission this file forgot to declare.
beforeEach(() => {
  clearPermissions();
});

afterEach(() => {
  clearPermissions();
});

describe('definePermissions()', () => {
  const set = () =>
    definePermissions(['post:read', 'post:publish', 'post:delete', 'org:admin'] as const);

  test('.all lists every declared permission, in declaration order', () => {
    expect(set().all).toEqual(['post:read', 'post:publish', 'post:delete', 'org:admin']);
  });

  test('.has() narrows a known string and rejects an unknown one', () => {
    const permissions = set();
    expect(permissions.has('post:read')).toBe(true);
    expect(permissions.has('post:archive')).toBe(false);
  });

  test('.assert() returns a declared permission and throws X_PERMISSION_UNKNOWN otherwise', () => {
    const permissions = set();
    expect(permissions.assert('post:delete')).toBe('post:delete');
    expect(() => permissions.assert('post:archive')).toThrow(/X_PERMISSION_UNKNOWN/);
  });

  test('.byResource() filters to one resource, in declared order', () => {
    expect(set().byResource('post')).toEqual(['post:read', 'post:publish', 'post:delete']);
    expect(set().byResource('nothing')).toEqual([]);
  });

  test('.resources() lists every distinct resource, sorted', () => {
    expect(set().resources()).toEqual(['org', 'post']);
  });

  test('a second definePermissions() call adds to the same global registry', () => {
    definePermissions(['post:read'] as const);
    definePermissions(['comment:read'] as const);
    expect(knownPermissions()).toEqual(['comment:read', 'post:read']);
  });
});

describe('knownPermissions() / isKnownPermission()', () => {
  test('before any declaration, every string is provisionally known', () => {
    expect(isKnownPermission('anything:goes')).toBe(true);
    expect(knownPermissions()).toEqual([]);
  });

  test('once a set is declared, only its members are known', () => {
    definePermissions(['post:read'] as const);
    expect(isKnownPermission('post:read')).toBe(true);
    expect(isKnownPermission('post:archive')).toBe(false);
    expect(knownPermissions()).toEqual(['post:read']);
  });

  test('knownPermissions() is sorted, not declaration order', () => {
    definePermissions(['zeta:read', 'alpha:read'] as const);
    expect(knownPermissions()).toEqual(['alpha:read', 'zeta:read']);
  });
});

describe('assertPermission()', () => {
  test('returns the value unchanged when known', () => {
    definePermissions(['post:read'] as const);
    expect(assertPermission('post:read')).toBe('post:read');
  });

  test('throws with the exact typo and the fix command naming definePermissions', () => {
    definePermissions(['post:read'] as const);
    expect(() => assertPermission('post:raed')).toThrow(/post:raed/);

    let caught: unknown;
    try {
      assertPermission('post:raed');
    } catch (error) {
      caught = error;
    }
    // Asserted outside the catch: a call that stopped throwing would otherwise skip the block and
    // pass, which is the one outcome this case exists to catch.
    expect(caught).toMatchObject({ fix: expect.stringContaining('definePermissions') });
  });
});

describe('resourceOf() / verbOf()', () => {
  test('split a well-formed permission on its colon', () => {
    expect(resourceOf('post:publish')).toBe('post');
    expect(verbOf('post:publish')).toBe('publish');
  });

  test('a permission with no colon is the whole string as the resource, empty verb', () => {
    expect(resourceOf('malformed')).toBe('malformed');
    expect(verbOf('malformed')).toBe('');
  });
});

describe('clearPermissions()', () => {
  test('empties the registry back to "everything provisionally known"', () => {
    definePermissions(['post:read'] as const);
    expect(knownPermissions()).toEqual(['post:read']);
    clearPermissions();
    expect(knownPermissions()).toEqual([]);
    expect(isKnownPermission('post:anything')).toBe(true);
  });
});
