// The request context is built once and read everywhere through core's ALS, so a wrong value
// here has no call site to blame it on — it is simply wrong in every handler. These tests pin
// what creation resolves and that the ALS hands the same object back, rather than a copy that
// drifts from what the pipeline decided.
import { describe, expect, test } from 'bun:test';
import { anonymousActor, isAnonymous, runWithContext, userActor, uuid } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { actorView, asCtx, createRequestContext, elapsedMs, useRequestContext } from './context';

const config = defineHttpConfig();

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
    expect(ctx.locale).toBe(config.locale.default);
    expect(ctx.tz).toBe(config.tz.default);
    expect(ctx.params).toEqual({});
    expect(ctx.route).toBeUndefined();
    expect(ctx.buildId).toBeNull();
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
