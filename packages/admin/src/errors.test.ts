// A registered error code is a contract: hasErrorCode() must see it, describeErrorCode()
// must render the title this package declared, and every code must resolve to its docs
// page. These tests are what keeps that contract from rotting silently.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import {
  ADMIN_BORROWED_ERROR_CODES,
  ADMIN_ERROR_CODES,
  ADMIN_ERROR_TITLES,
  ADMIN_OWNED_ERROR_CODES,
  AdminActionDuplicateError,
  AdminEntityUnknownError,
  AdminPolicyMissingError,
} from './errors';

describe('ADMIN_ERROR_TITLES', () => {
  test('titles exactly the codes admin owns — a borrowed code carries no title here', () => {
    expect(Object.keys(ADMIN_ERROR_TITLES).sort()).toEqual([...ADMIN_OWNED_ERROR_CODES].sort());
  });

  test('owned and borrowed are disjoint and together are every code admin throws', () => {
    const owned = new Set<string>(ADMIN_OWNED_ERROR_CODES);
    for (const code of ADMIN_BORROWED_ERROR_CODES) expect(owned.has(code)).toBe(false);
    expect([...ADMIN_ERROR_CODES].sort()).toEqual(
      [...ADMIN_OWNED_ERROR_CODES, ...ADMIN_BORROWED_ERROR_CODES].sort(),
    );
  });
});

describe('registration', () => {
  test('every declared code is registered in the framework-wide registry', () => {
    for (const code of ADMIN_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('describeErrorCode renders the title this package declared', () => {
    for (const code of ADMIN_OWNED_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(ADMIN_ERROR_TITLES[code]);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not re-registered by admin', () => {
    // admin declares no title for it, so the string below can only have come from core.
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
  });
});

// Admin passes no `docs:`, so the link is whatever the registry resolved: one page for every
// code, declared once in `@ultimat3/core`. Pinned against the constant and never a literal — a
// hand-copied URL is how the dead `https://ultimate.dev/errors/<code>` host survived every suite
// in the tree, with the code interpolated into a fragment no page has ever had an anchor for.
describe('docs', () => {
  test('every code resolves to the one docs page, never a per-code URL', () => {
    for (const code of ADMIN_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
      expect(describeErrorCode(code).docs).not.toContain(code);
    }
  });

  test('a constructed admin error carries that same link', () => {
    const errors = [
      new AdminEntityUnknownError({ entity: 'posts', known: [] }),
      new AdminPolicyMissingError({ subject: 'createPost', kind: 'action' }),
      new AdminActionDuplicateError({ name: 'publish', entities: ['posts'] }),
    ];
    for (const error of errors) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      expect(error.docs).not.toContain(error.code);
    }
  });
});

// The snippet a fix hands the reader has to compile. `can()` takes a `Permission` —
// `` `${string}:${string}` `` — and `subject` is an action's export name (`resource.ts` throws with
// `action.name`), so `can('createPost')` is a paste whose only outcome is a second error.
describe('X_ADMIN_POLICY_MISSING pastes a permission, never the subject name', () => {
  const CAN_ARGUMENT = /can\('(?<permission>[^']*)'\)/;
  const missing = (subject: string, kind: 'action' | 'resource'): AdminPolicyMissingError =>
    new AdminPolicyMissingError({ subject, kind });

  test('the fix names a resource:verb pair', () => {
    const permission = CAN_ARGUMENT.exec(missing('createPost', 'action').fix)?.groups?.[
      'permission'
    ];
    expect(permission).toBeDefined();
    expect(permission).not.toBe('createPost');
    expect(permission ?? '').toMatch(/^[^:]+:[^:]+$/);
  });

  test('the cause still names the subject, because that is what finds the file', () => {
    const error = missing('createPost', 'action');
    expect(error.cause).toContain('createPost');
    expect(error.code).toBe('X_ADMIN_POLICY_MISSING');
  });

  // Deliberately unlike action's and query's twin, which both offer `allow()`: an admin operation
  // with no policy is the open door this code exists to refuse, so there is no escape to name.
  test('it offers no allow() escape hatch', () => {
    expect(missing('posts', 'resource').fix).not.toContain('allow(');
  });
});
