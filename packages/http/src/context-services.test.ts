// Services ride ON the request context, not only under `ctx.services`. Split out of
// `context.test.ts` at the file ceiling.

import { describe, expect, test } from 'bun:test';
import { isAnonymous } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { asCtx, requestContext } from './context';

const config = defineHttpConfig({
  rateLimit: { scope: 'process' },
});

describe('services ride ON the context, not only under ctx.services', () => {
  // `CtxServices` exists to be augmented, so `ctx.posts` has to BE the service — core's
  // `ctxOf` has spread the bag onto the context since it shipped and this one did not, so
  // an app declaring `ctx.posts` the documented way read `undefined` over HTTP while `ctx.services`
  // beside it was populated.
  const posts = { byId: () => 'a post' };

  test('a passed service is reachable both ways', () => {
    const ctx = requestContext({
      url: new URL('https://app.test/x'),
      method: 'GET',
      role: 'web',
      config,
      services: { posts },
    });

    expect(ctx.services['posts']).toBe(posts);
    expect(ctx['posts']).toBe(posts);
  });

  test('a service can never shadow a framework field', () => {
    // Spread order is the guarantee: `actor`, `logger` and `signal` are the request's, whatever an
    // app named a service. The colliding service stays reachable under `ctx.services`.
    const impostor = { id: 'not-an-actor' };
    const ctx = requestContext({
      url: new URL('https://app.test/x'),
      method: 'GET',
      role: 'web',
      config,
      services: { actor: impostor },
    });

    expect(isAnonymous(ctx.actor)).toBe(true);
    expect(ctx.services['actor']).toBe(impostor);
  });

  test('a defineService factory installs on THIS surface too, not only in a job', async () => {
    // The half that made the bug total. The pipeline passes NO `services` at all
    // (`pipeline.ts:224`), and this file used to build its own bag from that argument alone — so a
    // `defineService('posts', …)` an app registered at boot was installed for a job, a task and a
    // CLI command and NOT for a request. `useService('posts')` threw `X_SERVICE_MISSING` on the
    // one surface an app spends its life on. Composing `ctxOf` is what fixed it: the
    // installer is core's, and this is core's constructor.
    const { defineService, resetServices, runWithContext, useService } = await import(
      '@ultimat3/core'
    );
    resetServices();
    const built = { kind: 'from-a-factory' };
    defineService('probeService', () => built);
    try {
      const ctx = requestContext({
        url: new URL('https://app.test/x'),
        method: 'GET',
        role: 'web',
        config,
      });
      expect(ctx['probeService']).toBe(built);
      // `useService<T>` has no inference site, so `T` widens to `unknown` and `toBe`'s overload
      // resolves against `undefined`. Named here rather than left to infer.
      expect(runWithContext(asCtx(ctx), () => useService<typeof built>('probeService'))).toBe(
        built,
      );
    } finally {
      resetServices();
    }
  });

  test('a context with no services and no factories carries an empty bag rather than nothing', () => {
    const ctx = requestContext({
      url: new URL('https://app.test/x'),
      method: 'GET',
      role: 'web',
      config,
    });

    expect(ctx.services).toEqual({});
    // `useService()` is what names the failure; a missing bag was a bare TypeError.
    expect(Object.isFrozen(ctx.services)).toBe(true);
  });
});
