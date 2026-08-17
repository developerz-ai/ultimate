// The one thing a policy-missing failure has to get right: what it tells the reader to paste. A
// query NAME is not a permission — `can()` takes `resource:verb`, so `can('postList')` does not
// compile, and `assertPermission` would refuse it the moment the app declares its own set. A fix
// line built from the name is therefore a snippet whose only possible outcome is a second failure.

import { describe, expect, test } from 'bun:test';
import { QueryPolicyMissingError } from './errors';

const CAN_ARGUMENT = /can\('(?<permission>[^']*)'\)/;

describe('unit · X_QUERY_POLICY_MISSING pastes a permission, never the query name', () => {
  test('the fix names a resource:verb pair', () => {
    const error = new QueryPolicyMissingError('postList');
    const permission = CAN_ARGUMENT.exec(error.fix)?.groups?.['permission'];
    expect(permission).toBeDefined();
    expect(permission).not.toBe('postList');
    // `Permission` is `${string}:${string}` — one colon, both halves non-empty.
    expect(permission ?? '').toMatch(/^[^:]+:[^:]+$/);
  });

  test('the cause still names the query, because that is what finds the file', () => {
    const error = new QueryPolicyMissingError('postList');
    expect(error.cause).toContain('postList');
    expect(error.code).toBe('X_QUERY_POLICY_MISSING');
  });
});
