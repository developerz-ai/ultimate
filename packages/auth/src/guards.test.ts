// Direct coverage for the http pipeline's auth assertions — untested until now despite being
// the gate every role/scope-shaped route calls before touching a policy.

import { describe, expect, test } from 'bun:test';
import { assert, createContext, runWithContext, userActor } from '@ultimat3/core';
import { AuthError } from './errors';
import { currentActor, requireActor, requireRole, requireScope } from './guards';

const asAnonymous = <T>(fn: () => T): T => runWithContext(createContext(), fn);

const asUser = <T>(roles: readonly string[], scopes: readonly string[], fn: () => T): T =>
  runWithContext(createContext({ actor: userActor({ id: 'user-1', roles, scopes }) }), fn);

const caught = (fn: () => unknown): AuthError => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  // An unexpected throw keeps its own stack; only "it returned" and "it threw something else"
  // become X_INVARIANT, so a green run can never mean the guard quietly let the call through.
  if (thrown !== undefined && !(thrown instanceof AuthError)) throw thrown;
  assert(
    thrown instanceof AuthError,
    'the guard under test returned instead of throwing an AuthError',
    'assert on the returned value directly instead of wrapping the call in caught()',
  );
  return thrown;
};

describe('requireActor', () => {
  test('throws X_UNAUTHENTICATED for an anonymous actor', () => {
    const error = asAnonymous(() => caught(() => requireActor()));
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });

  test('the surface name reaches the thrown error', () => {
    const error = asAnonymous(() => caught(() => requireActor('the admin panel')));
    expect(error.cause).toContain('the admin panel');
  });

  test('returns the actor when signed in', () => {
    const actor = asUser(['editor'], [], () => requireActor());
    expect(actor.id).toBe('user-1');
  });
});

describe('requireRole', () => {
  test('passes when the actor has the role', () => {
    const actor = asUser(['admin'], [], () => requireRole('admin'));
    expect(actor.id).toBe('user-1');
  });

  test('throws X_FORBIDDEN when the actor lacks the role', () => {
    const error = asUser(['editor'], [], () => caught(() => requireRole('admin')));
    expect(error.code).toBe('X_FORBIDDEN');
  });

  test('throws X_UNAUTHENTICATED (not X_FORBIDDEN) when anonymous', () => {
    const error = asAnonymous(() => caught(() => requireRole('admin')));
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });
});

describe('requireScope', () => {
  test('passes when the actor has the scope', () => {
    const actor = asUser([], ['posts:write'], () => requireScope('posts:write'));
    expect(actor.id).toBe('user-1');
  });

  test('throws X_FORBIDDEN when the actor lacks the scope', () => {
    const error = asUser([], ['posts:read'], () => caught(() => requireScope('posts:write')));
    expect(error.code).toBe('X_FORBIDDEN');
  });
});

describe('currentActor', () => {
  test('returns null when anonymous', () => {
    expect(asAnonymous(() => currentActor())).toBeNull();
  });

  test('returns the actor when signed in, and never throws', () => {
    const actor = asUser(['editor'], [], () => currentActor());
    expect(actor?.id).toBe('user-1');
  });
});
