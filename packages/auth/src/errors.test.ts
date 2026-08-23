/**
 * The two authorization refusals this package exports for its consumers to throw. They are the
 * public surface `@ultimat3/http` and an app's own guards raise, so their code, cause and fix are
 * the contract — a `fix:` is copied and run (axiom 4), and both of these name a runnable command.
 */

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL } from '@ultimat3/core';
import {
  AUTH_ERROR_CODES,
  AuthError,
  accountLocked,
  forbidden,
  kdfOverloaded,
  unauthenticated,
} from './errors';

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

// `AuthError` passes no `docs:`, so the link is whatever the registry resolved: one page for every
// code, declared once in `@ultimat3/core`. Pinned against the constant and never a literal — a
// hand-copied URL is how the dead `https://ultimate.dev/errors/<code>` host survived every suite in
// the tree, with the code interpolated into a fragment no page has ever had an anchor for.
describe('docs', () => {
  test('a constructed auth error points at the one page, never a per-code URL', () => {
    for (const error of [unauthenticated('POST /api/posts'), forbidden('deletePost', 'no grant')]) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      expect(error.docs).not.toContain(error.code);
    }
  });

  test('and every code auth throws resolves to that same link', () => {
    for (const code of AUTH_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
      expect(describeErrorCode(code).docs).not.toContain(code);
    }
  });
});

/**
 * `retryAfterSeconds` is the ONE machine-readable field a refusal built below the HTTP tier can
 * hand a header. `@ultimat3/http`'s `retryAfterOf` reads exactly `meta.retryAfterSeconds` and
 * nothing else, so a delay that only ever reached `cause` and `fix` is a 429 that tells a caller to
 * come back and never says when. Pinned on `meta`, never on the prose that also carries the number.
 */
describe('a refusal that computed a delay puts it where a header can read it', () => {
  test('accountLocked carries the seconds it was handed, in meta', () => {
    const error = accountLocked('ip:203.0.113.7', 30);
    expect(error.meta?.['retryAfterSeconds']).toBe(30);
  });

  test('kdfOverloaded carries one, in the same field — one shape, not two', () => {
    expect(kdfOverloaded(8, 64).meta?.['retryAfterSeconds']).toBe(1);
  });

  // The lockout key is an address or an email the caller chose. `cause` and `fix` escape it on
  // purpose; `meta` is published by nothing that renders `cause`, and putting it here would hand a
  // bucket key to a surface that drops the escaping. Only the number travels.
  test('and nothing else — the lockout key never reaches meta', () => {
    const error = accountLocked('email:ada@example.com', 30);
    expect(Object.keys(error.meta ?? {})).toEqual(['retryAfterSeconds']);
    expect(JSON.stringify(error.meta)).not.toContain('ada@example.com');
  });
});
