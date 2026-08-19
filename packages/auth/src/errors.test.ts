/**
 * The two authorization refusals this package exports for its consumers to throw. They are the
 * public surface `@ultimat3/http` and an app's own guards raise, so their code, cause and fix are
 * the contract — a `fix:` is copied and run (axiom 4), and both of these name a runnable command.
 */

import { describe, expect, test } from 'bun:test';
import { AuthError, forbidden, unauthenticated } from './errors';

describe('unauthenticated', () => {
  test('names the surface that needed an actor and how to resolve one', () => {
    const error = unauthenticated('POST /api/posts');
    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('X_UNAUTHENTICATED');
    expect(error.cause).toContain('POST /api/posts');
    expect(error.cause).toContain('ctx.actor is anonymous');
    expect(error.fix).toContain('__Host-x_session');
    expect(error.fix).toContain('readSessionCookie');
  });
});

describe('forbidden', () => {
  // The distinction is the whole point: `X_UNAUTHENTICATED` says "nobody is signed in" and
  // `X_FORBIDDEN` says "this actor is, and still may not" — two different next steps.
  test('carries the surface AND the reason, and its fix is the command that explains the grant', () => {
    const error = forbidden('deletePost', 'actor holds no posts:delete grant');
    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('X_FORBIDDEN');
    expect(error.cause).toContain('deletePost');
    expect(error.cause).toContain('actor holds no posts:delete grant');
    expect(error.fix).toContain('x policy explain --json');
  });

  test('is a different code from unauthenticated for the same surface', () => {
    expect(forbidden('deletePost', 'no grant').code).not.toBe(unauthenticated('deletePost').code);
  });

  test('the reason reaches the cause verbatim, so a policy can say what it denied on', () => {
    const error = forbidden('reports.read', 'org o1 is not the row’s tenant');
    expect(error.cause).toContain('org o1 is not the row’s tenant');
  });
});
