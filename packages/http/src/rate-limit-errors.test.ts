// The rate limit's own refusals: the one a CALLER sees and the ones only an operator ever does.
// The caller-facing half is the interesting one — a 429 is a response anyone can provoke, so what
// it says about the bucket it hit is disclosure.

import { describe, expect, test } from 'bun:test';
import { HttpError } from './errors';
import {
  rateLimited,
  rateLimitNotShared,
  rateLimitScopeUnset,
  rateLimitStoreUnavailable,
} from './rate-limit-errors';

describe('rateLimited', () => {
  // The KEY is `${routeName}|org:${orgId}` or `|actor:${actorId}`, and a 429 is a response any
  // caller can provoke — so an anonymous caller promoted to an org bucket used to learn the
  // internal org id from the body. It rides in `meta`, which `toProblem` does not render.
  test('the cause names the window and NEVER the key; the key is meta only', () => {
    const error = rateLimited('posts.create|org:o_9fd21', 7);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_RATE_LIMITED');
    expect(error.cause).not.toContain('o_9fd21');
    expect(error.cause).not.toContain('posts.create');
    expect(error.meta?.['key']).toBe('posts.create|org:o_9fd21');
    expect(error.cause).toContain('7s');
    expect(error.fix).toBe(
      'retry after the Retry-After header, or raise rateLimit.buckets in app.config.ts',
    );
    expect(error.docs).toBe('https://ultimate.dev/errors/X_RATE_LIMITED');
  });
});

describe('the declaration refusals', () => {
  // Both of these used to end at `createServer({ routes, rateLimitStore })` — a parameter name,
  // not a value, so the reader still had to find something to pass. There is now a shipped store.
  test("the fix names the store an app can actually pass, not a parameter's name", () => {
    expect(rateLimitNotShared('process').fix).toContain('postgresRateLimitStore(');
    expect(rateLimitScopeUnset().fix).toContain('postgresRateLimitStore(');
  });

  test('a store that answers nothing is a 500 with a statement to run, never a silent grant', () => {
    const error = rateLimitStoreUnavailable('take');
    expect(error.code).toBe('X_RATE_LIMIT_STORE_UNAVAILABLE');
    expect(error.cause).toContain('take');
    expect(error.fix).toContain('psql');
  });
});
