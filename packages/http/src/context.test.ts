// The request context is built once and read everywhere through core's ALS, so a wrong value
// here has no call site to blame it on — it is simply wrong in every handler. These tests pin
// what creation resolves and that the ALS hands the same object back, rather than a copy that
// drifts from what the pipeline decided.
import { describe, expect, test } from 'bun:test';
import {
  anonymousActor,
  createContext,
  isAnonymous,
  runWithContext,
  userActor,
  uuid,
} from '@ultimat3/core';
import { localeConfig } from '@ultimat3/i18n';
import { timeConfig } from '@ultimat3/time';
import { defineHttpConfig } from './config';
import {
  actorView,
  asCtx,
  createRequestContext,
  elapsedMs,
  useRequestContext,
  useRequestCookie,
  useRequestHeader,
  useRequestHeaders,
} from './context';

const config = defineHttpConfig({
  rateLimit: { scope: 'process' },
});

describe('createRequestContext', () => {
  test('builds the defaults for a plain https request', () => {
    const ctx = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });

    expect(ctx.method).toBe('GET');
    expect(ctx.https).toBe(true);
    expect(isAnonymous(ctx.actor)).toBe(true);
    expect(ctx.actor).toEqual(anonymousActor());
    expect(ctx.locale).toBe(localeConfig().fallback);
    expect(ctx.tz).toBe(timeConfig().defaultZone);
    expect(ctx.params).toEqual({});
    expect(ctx.route).toBeUndefined();
    // Core's meaning: the build this PROCESS serves. The CLIENT's claim is `clientBuildId`.
    expect(ctx.buildId).toBe('dev');
    expect(ctx.clientBuildId).toBeNull();
    expect(ctx.input).toBeUndefined();
    expect(ctx.authz).toBeUndefined();
    expect(ctx.rateLimit).toBeUndefined();
    expect(ctx.cache).toBeUndefined();
    expect(ctx.response).toBeUndefined();
    expect(ctx.error).toBeUndefined();
    expect(ctx.requestId.length).toBeGreaterThan(0);
    expect(ctx.traceId.length).toBeGreaterThan(0);
  });

  test('honors an explicit requestId and traceId', () => {
    const ctx = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
      requestId: 'req-fixed',
      traceId: 'trace-fixed',
    });
    expect(ctx.requestId).toBe('req-fixed');
    expect(ctx.traceId).toBe('trace-fixed');
  });

  test('generates a fresh id per call when none is passed', () => {
    const a = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    const b = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.traceId).not.toBe(b.traceId);
  });

  test('infers https from a plain http url', () => {
    const ctx = createRequestContext({
      url: new URL('http://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(ctx.https).toBe(false);
  });

  test('init.https overrides url-protocol inference', () => {
    const ctx = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
      https: false,
    });
    expect(ctx.https).toBe(false);
  });
});

describe('asCtx', () => {
  test('is an identity cast', () => {
    const ctx = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(Object.is(asCtx(ctx), ctx)).toBe(true);
  });
});

describe('useRequestContext', () => {
  test('throws outside any ambient context', () => {
    expect(() => useRequestContext()).toThrow();
  });

  test('round-trips the same context object through the ALS', () => {
    const ctx = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    const result = runWithContext(asCtx(ctx), () => useRequestContext());
    expect(Object.is(result, ctx)).toBe(true);
  });

  // A job, a task, a scheduler round and a CLI command all supply core's `Ctx` — none of them a
  // `RequestContext`. The unchecked cast handed those back with `undefined` in non-optional
  // fields, so the first reader failed as a bare `TypeError` from a PUBLIC API.
  test('refuses a context that is not an HTTP request, with an instruction', () => {
    const jobCtx = createContext({});

    expect(() => runWithContext(jobCtx, () => useRequestContext())).toThrow(/X_NO_REQUEST/);
    expect(() => runWithContext(jobCtx, () => useRequestContext().requestHeaders.get('cookie'))) //
      .not.toThrow(TypeError);
  });

  test('names what the caller was after in the refusal', () => {
    const jobCtx = createContext({});

    expect(() => runWithContext(jobCtx, () => useRequestContext('the session cookie'))).toThrow(
      /the session cookie was read outside an HTTP request/,
    );
  });
});

// Before these, `RequestContext` held the RESPONSE headers and no reference to the request at
// all — so an action could set a session cookie and nothing in the framework could ever read it
// back. Sign-in worked, and "signed in as X" was unreachable.
describe('the inbound headers on the context', () => {
  const withHeaders = (headers: HeadersInit) =>
    createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
      requestHeaders: headers,
    });

  test('a context built without them carries an empty Headers, never undefined', () => {
    const ctx = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(ctx.requestHeaders).toBeInstanceOf(Headers);
    expect(ctx.requestHeaders.get('cookie')).toBeNull();
  });

  test('useRequestHeader reads what the caller sent', () => {
    const ctx = withHeaders({ 'x-demo': 'yes' });
    expect(runWithContext(asCtx(ctx), () => useRequestHeader('X-Demo'))).toBe('yes');
    expect(runWithContext(asCtx(ctx), () => useRequestHeader('x-absent'))).toBeNull();
  });

  test('useRequestCookie decodes one cookie out of the header', () => {
    const ctx = withHeaders({ cookie: 'x-locale=de; session=abc%20def; other=1' });
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('session'))).toBe('abc def');
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('x-locale'))).toBe('de');
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('absent'))).toBeNull();
  });

  test('a cookie missing from a real request reads null, not a throw', () => {
    const ctx = withHeaders({});
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('session'))).toBeNull();
  });

  // "no request here" and "the caller sent no cookie" are different facts. Folding them into
  // one `null` is how a job would quietly run as nobody.
  test('X_NO_REQUEST inside a context that is not a request', () => {
    expect(() =>
      runWithContext(createContext({ role: 'worker' }), () => useRequestCookie('session')),
    ).toThrow('X_NO_REQUEST');
    expect(() =>
      runWithContext(createContext({ role: 'worker' }), () => useRequestHeaders()),
    ).toThrow('X_NO_REQUEST');
  });

  test('X_NO_CONTEXT outside any context at all — core answers that one', () => {
    expect(() => useRequestHeader('cookie')).toThrow('X_NO_CONTEXT');
  });
});

describe('elapsedMs', () => {
  test('is a non-negative finite number', () => {
    const ctx = createRequestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    const elapsed = elapsedMs(ctx);
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});

describe('actorView', () => {
  test('null actor reads as null', () => {
    expect(actorView(null)).toBeNull();
  });

  test('the anonymous actor reads as null', () => {
    expect(actorView(anonymousActor())).toBeNull();
  });

  test('a real actor narrows (by cast) to expose id and orgId', () => {
    const actor = userActor({ id: uuid(), orgId: 'org-1' });
    expect(isAnonymous(actor)).toBe(false);
    const view = actorView(actor);
    expect(view).not.toBeNull();
    expect(view?.id).toBe(actor.id);
    expect(view?.orgId).toBe('org-1');
    // it's a cast, not a copy, so identity is preserved
    expect(Object.is(view, actor)).toBe(true);
  });
});

describe('services ride ON the context, not only under ctx.services', () => {
  // `CtxServices` exists to be augmented, so `ctx.posts` has to BE the service — core's
  // `createContext` has spread the bag onto the context since it shipped and this one did not, so
  // an app declaring `ctx.posts` the documented way read `undefined` over HTTP while `ctx.services`
  // beside it was populated.
  const posts = { byId: () => 'a post' };

  test('a passed service is reachable both ways', () => {
    const ctx = createRequestContext({
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
    const ctx = createRequestContext({
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
    // one surface an app spends its life on. Composing `createContext` is what fixed it: the
    // installer is core's, and this is core's constructor.
    const { defineService, resetServices, runWithContext, useService } = await import(
      '@ultimat3/core'
    );
    resetServices();
    const built = { kind: 'from-a-factory' };
    defineService('probeService', () => built);
    try {
      const ctx = createRequestContext({
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
    const ctx = createRequestContext({
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
