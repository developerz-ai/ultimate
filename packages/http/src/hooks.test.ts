// `hooks.ts` is types only: the compiler proves a tier-3 implementation fits, but nothing
// proves the decision union still narrows at runtime, or that a promise is as acceptable as a
// plain value at either seam. The pipeline awaits both blindly, so these tests hold that half
// of the contract — the half no implementer of the interface can check for itself.
import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createRequestContext } from './context';
import { routeNotFound } from './errors';
import type { AuthzDecision, ServerHooks } from './hooks';
import { UltimateRequest } from './request';
import { text } from './response';
import type { Route } from './router';

const config = defineHttpConfig({ dev: false, buildId: null, hostname: '127.0.0.1' });

const ctx = createRequestContext({
  url: new URL('http://x.test/posts'),
  method: 'GET',
  role: 'web',
  config,
});

const request = new UltimateRequest(new Request('http://x.test/posts'), ctx);

const route: Route = {
  method: 'GET',
  path: '/posts',
  handler: () => text('ok'),
  meta: { name: 'posts.show', auth: 'required', policy: 'post:read' },
};

/** Proves the discriminated union holds at runtime, not just at the type level. */
const describeDecision = (decision: AuthzDecision): string => {
  if (decision.allowed) return 'allowed';
  return `denied: ${decision.reason}`;
};

describe('AuthzDecision', () => {
  test('narrows to the allowed branch', () => {
    const decision: AuthzDecision = { allowed: true };
    expect(describeDecision(decision)).toBe('allowed');
  });

  test('narrows to the denied branch and exposes reason/code', () => {
    const decision: AuthzDecision = { allowed: false, reason: 'no policy', code: 'X_FORBIDDEN' };
    expect(describeDecision(decision)).toBe('denied: no policy');
    if (!decision.allowed) {
      expect(decision.reason).toBe('no policy');
      expect(decision.code).toBe('X_FORBIDDEN');
    }
  });

  test('code is optional on a denial', () => {
    const decision: AuthzDecision = { allowed: false, reason: 'rate limited' };
    if (!decision.allowed) {
      expect(decision.code).toBeUndefined();
    }
  });
});

describe('ServerHooks', () => {
  test('authenticate may resolve anonymous synchronously with null', () => {
    const hooks: ServerHooks = {
      authenticate: (_request, _ctx) => null,
    };
    expect(hooks.authenticate?.(request, ctx)).toBeNull();
  });

  test('authenticate may resolve an actor via a promise', async () => {
    const actor = userActor({ id: 'u-1', roles: ['editor'] });
    const hooks: ServerHooks = {
      authenticate: (_request, _ctx) => Promise.resolve(actor),
    };
    const resolved = hooks.authenticate?.(request, ctx);
    expect(resolved).toBeInstanceOf(Promise);
    expect(await resolved).toBe(actor);
  });

  test('authenticate may resolve anonymous via a promise', async () => {
    const hooks: ServerHooks = {
      authenticate: (_request, _ctx) => Promise.resolve(null),
    };
    expect(await hooks.authenticate?.(request, ctx)).toBeNull();
  });

  test('authorize may return a decision synchronously', () => {
    const hooks: ServerHooks = {
      authorize: (_route, _request, _ctx) => ({ allowed: true }),
    };
    const decision = hooks.authorize?.(route, request, ctx);
    expect(decision).toEqual({ allowed: true });
  });

  test('authorize may return a decision via a promise', async () => {
    const hooks: ServerHooks = {
      authorize: (_route, _request, _ctx) =>
        Promise.resolve({ allowed: false, reason: 'no policy', code: 'X_FORBIDDEN' }),
    };
    const decision = await hooks.authorize?.(route, request, ctx);
    expect(decision).toEqual({ allowed: false, reason: 'no policy', code: 'X_FORBIDDEN' });
  });

  test('onError is a void sink the pipeline can call without awaiting', () => {
    let seen: unknown;
    const hooks: ServerHooks = {
      onError: (error, _ctx) => {
        seen = error;
      },
    };
    const error = routeNotFound('GET', '/missing');
    hooks.onError?.(error, ctx);
    expect(seen).toBe(error);
  });

  test('a fully-populated ServerHooks object satisfies the contract end to end', async () => {
    let errored = false;
    const hooks: ServerHooks = {
      authenticate: (_request, _ctx) => null,
      authorize: (_route, _request, _ctx) => ({ allowed: true }),
      onError: (_error, _ctx) => {
        errored = true;
      },
    };

    expect(hooks.authenticate?.(request, ctx)).toBeNull();
    expect(await hooks.authorize?.(route, request, ctx)).toEqual({ allowed: true });
    hooks.onError?.(routeNotFound('GET', '/gone'), ctx);
    expect(errored).toBe(true);
  });
});
