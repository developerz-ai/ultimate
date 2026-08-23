// What a policy-missing failure hands the reader has to compile. `can()` takes a `Permission` —
// `` `${string}:${string}` `` — so `can('createPost')` is a snippet whose only outcome is a second
// error, and `assertPermission` refuses it the moment the app declares its own set. The action's
// NAME belongs in the cause, which is what finds the file; the PERMISSION's shape belongs in the fix.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL } from '@ultimat3/core';
import {
  ActionDuplicateError,
  ActionPolicyMissingError,
  ActionUnregisteredError,
  IdempotencyConflictError,
  InputInvalidError,
} from './errors';

const CAN_ARGUMENT = /can\('(?<permission>[^']*)'\)/;

describe('unit · X_ACTION_POLICY_MISSING pastes a permission, never the action name', () => {
  test('the fix names a resource:verb pair', () => {
    const error = new ActionPolicyMissingError('createPost');
    const permission = CAN_ARGUMENT.exec(error.fix)?.groups?.['permission'];
    expect(permission).toBeDefined();
    expect(permission).not.toBe('createPost');
    expect(permission ?? '').toMatch(/^[^:]+:[^:]+$/);
  });

  test('the cause still names the action, because that is what finds the file', () => {
    const error = new ActionPolicyMissingError('createPost');
    expect(error.cause).toContain('createPost');
    expect(error.code).toBe('X_ACTION_POLICY_MISSING');
  });
});

// This package passes no `docs:` at any construction site, so the link is whatever the registry
// resolved: one page for every code, declared once in `@ultimat3/core`. Pinned against the
// constant and never a literal — a hand-copied URL is how the dead
// `https://ultimate.dev/errors/<code>` host survived every suite in the tree, with the code
// interpolated into a fragment no page has ever had an anchor for. `errors-idempotency.ts` is
// covered here too: it is the same rule in the file `errors.ts` split it into.
describe('unit · docs', () => {
  test('every action error points at the one page, never a per-code URL', () => {
    const errors = [
      new ActionPolicyMissingError('createPost'),
      new ActionUnregisteredError(),
      new ActionDuplicateError('publishPost'),
      new InputInvalidError('publishPost', 'postId is not a uuid'),
      new IdempotencyConflictError('k1', 'payload-mismatch'),
    ];
    for (const error of errors) {
      expect(error.docs, error.code).toBe(ERROR_DOCS_URL);
      expect(error.docs, error.code).not.toContain(error.code);
      expect(describeErrorCode(error.code).docs, error.code).toBe(ERROR_DOCS_URL);
    }
  });
});
