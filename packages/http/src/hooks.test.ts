// `hooks.ts` is types plus one registry: the compiler proves a tier-3 implementation fits, but
// nothing proves the decision union still narrows at runtime, or that a promise is as acceptable
// as a plain value at either seam. The pipeline awaits both blindly, so these tests hold that
// half of the contract — the half no implementer of the interface can check for itself — and
// the last block holds the registry that finally gives `authenticate` a way to be filled.
import { afterEach, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { requestContext } from './context';
import { routeNotFound } from './errors';
import type { AuthzDecision, ServerHooks } from './hooks';
import {
  configureAuthenticator,
  configuredAuthenticator,
  configuredCredentialTtlMs,
  MAX_CREDENTIAL_TTL_MS,
  resetAuthenticator,
} from './hooks';
import { UltimateRequest } from './request';
import { textResponse } from './response';
import type { Route } from './router';

const config = defineHttpConfig({
  rateLimit: { scope: 'process' },
  dev: false,
  buildId: null,
  hostname: '127.0.0.1',
});

const ctx = requestContext({
  url: new URL('http://x.test/posts'),
  method: 'GET',
  role: 'web',
  config,
});

const request = new UltimateRequest(new Request('http://x.test/posts'), ctx);

const route: Route = {
  method: 'GET',
  path: '/posts',
  handler: () => textResponse('ok'),
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

  test('narrows to the denied branch', () => {
    const decision: AuthzDecision = { allowed: false, reason: 'no policy', code: 'X_FORBIDDEN' };
    expect(describeDecision(decision)).toBe('denied: no policy');
  });

  // What a denial's shape MAY leave out — `code` is optional, `reason` is not — is a claim about
  // the type, and it lives in `type-pins.ts`. Asserted here it read as coverage while running no
  // production code: the `if (!decision.allowed)` guard is statically true over a literal the test
  // wrote three lines above, and `tsconfig.json` excludes tests, so nothing checked the type either.
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

// The seam existed and had no way to be filled: nothing in the framework ever set
// `hooks.authenticate`, so `auth: 'required'` was unsatisfiable in every host. This is the
// declaration side; `packages/cli/src/dev-hooks.test.ts` is the wiring side.
describe('configureAuthenticator', () => {
  afterEach(resetAuthenticator);

  test('nothing is configured until an app says so', () => {
    expect(configuredAuthenticator()).toBeUndefined();
  });

  test('the configured function is what a host reads back, by identity', () => {
    const authenticate = () => userActor({ id: 'u-1' });
    configureAuthenticator(authenticate);
    expect(configuredAuthenticator()).toBe(authenticate);
  });

  test('it fits ServerHooks.authenticate without an adapter', async () => {
    const actor = userActor({ id: 'u-1' });
    configureAuthenticator((incoming) => (incoming.cookie('session') === 'ok' ? actor : null));
    const authenticate = configuredAuthenticator();
    // Narrowed rather than assigned through: `exactOptionalPropertyTypes` makes an ABSENT
    // `authenticate` and a present-`undefined` one different types, and what this pins is the
    // FUNCTION dropping into the slot unwrapped — which is what `devHooks()` relies on.
    expect(authenticate).toBeDefined();
    if (authenticate === undefined) return;
    const hooks: ServerHooks = { authenticate };
    const signedIn = new UltimateRequest(
      new Request('http://x.test/posts', { headers: { cookie: 'session=ok' } }),
      ctx,
    );
    expect(await hooks.authenticate?.(signedIn, ctx)).toBe(actor);
    expect(await hooks.authenticate?.(request, ctx)).toBeNull();
  });

  test('the last declaration wins — one identity per request, never two', () => {
    const first = () => null;
    const second = () => userActor({ id: 'u-2' });
    configureAuthenticator(first);
    configureAuthenticator(second);
    expect(configuredAuthenticator()).toBe(second);
  });

  // `RuntimeOverrides.syncAuthenticate` existed only to state a credential lifetime the sync node
  // could not learn; the lifetime is the AUTHENTICATOR's fact, so it is declared beside it.
  test('a credential lifetime is declared with the authenticator, and read back', () => {
    expect(configuredCredentialTtlMs()).toBeUndefined();
    configureAuthenticator(() => null, { credentialTtlMs: 60_000 });
    expect(configuredCredentialTtlMs()).toBe(60_000);
  });

  test('a later declaration without one forgets the earlier lifetime', () => {
    configureAuthenticator(() => null, { credentialTtlMs: 60_000 });
    configureAuthenticator(() => null);
    expect(configuredCredentialTtlMs()).toBeUndefined();
  });

  test('a lifetime that is not a whole number of at least 1ms is refused, and changes nothing', () => {
    const kept = () => null;
    configureAuthenticator(kept, { credentialTtlMs: 5_000 });
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => configureAuthenticator(() => null, { credentialTtlMs: bad })).toThrow(
        /X_ASSERTION_FAILED|credentialTtlMs/,
      );
    }
    expect(configuredAuthenticator()).toBe(kept);
    expect(configuredCredentialTtlMs()).toBe(5_000);
  });

  // A lifetime is a SHORTENING of how long a websocket grant stands, never a lengthening: a 30-day
  // token lifetime here would turn off the re-check that makes logout and revokeSession close the
  // socket. The ceiling is the sync node's own five minutes.
  test('a lifetime longer than the re-check window is refused, and changes nothing', () => {
    expect(MAX_CREDENTIAL_TTL_MS).toBe(5 * 60_000);
    configureAuthenticator(() => null, { credentialTtlMs: MAX_CREDENTIAL_TTL_MS });
    expect(configuredCredentialTtlMs()).toBe(MAX_CREDENTIAL_TTL_MS);
    expect(() =>
      configureAuthenticator(() => null, { credentialTtlMs: 30 * 24 * 60 * 60_000 }),
    ).toThrow(/X_INVARIANT[\s\S]*credentialTtlMs/);
    expect(configuredCredentialTtlMs()).toBe(MAX_CREDENTIAL_TTL_MS);
  });

  test('reset forgets the lifetime with the function', () => {
    configureAuthenticator(() => null, { credentialTtlMs: 60_000 });
    resetAuthenticator();
    expect(configuredCredentialTtlMs()).toBeUndefined();
  });
});
