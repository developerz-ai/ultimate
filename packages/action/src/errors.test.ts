// What a policy-missing failure hands the reader has to compile. `can()` takes a `Permission` —
// `` `${string}:${string}` `` — so `can('createPost')` is a snippet whose only outcome is a second
// error, and `assertPermission` refuses it the moment the app declares its own set. The action's
// NAME belongs in the cause, which is what finds the file; the PERMISSION's shape belongs in the fix.

import { describe, expect, test } from 'bun:test';
import { ActionPolicyMissingError } from './errors';

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
