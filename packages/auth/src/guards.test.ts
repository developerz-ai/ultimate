// Direct coverage for the http pipeline's auth assertions, and the pin that keeps this module to
// authentication alone: an authorization decision belongs to `@ultimat3/policy` and nowhere else.

import { describe, expect, test } from 'bun:test';
import { assert, createContext, runWithContext, userActor } from '@ultimat3/core';
import { AuthError } from './errors';
import * as guards from './guards';
import { currentActor, requireActor } from './guards';

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

describe('the guard surface', () => {
  test('asserts authentication only — an authorization decision is a Policy', () => {
    // `requireRole` / `requireScope` lived here and decided a 403 outside `@ultimat3/policy`, with
    // zero callers repo-wide. The cost was not the duplication: a route gated that way reports
    // `policy: null` in `x routes`, in `framework.manifest.json` and in `openapi.json`, and
    // `x policy list` reports its permission unenforced — a route that ships guarded while every
    // introspection surface says it is not. Anything finer than "is somebody signed in" is
    // `can('post:publish')`, evaluated by policy, which is the one authz evaluator.
    expect(Object.keys(guards).sort()).toEqual(['currentActor', 'requireActor']);
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
